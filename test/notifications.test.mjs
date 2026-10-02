/**
 * Approval normalisation + notification diffing, against payloads shaped the
 * way the ticket module actually produces them (routes/moduleApi.js
 * GET /approvals/:id spreads the approval_requests row, so extra_stages rides
 * along; routes/tickets.js writes ad-hoc stages with no `order`;
 * approvalEngine.addAdditionalApprovalStage appends to extra_stages and moves
 * current_stage past the template). Pure functions — no Postgres needed.
 *
 *   node --test test/*.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApproval, canViewApproval } from '../server/approvals.js';
import { diffTicket, excerptOf } from '../server/notifications.js';

const people = { 'u-priya': { id: 'u-priya', name: 'Priya Nair', email: 'priya@x' }, 'u-bob': { id: 'u-bob', name: 'Bob Ross', email: 'bob@x' } };
const lookupUsers = async (q) => Object.values(people).filter((p) => p.id.includes(q));
const states = (a) => a.workflow.stages.map((s) => [s.name, s.state]);

test('additional approval after approval reads as pending, not approved', async () => {
  const a = await normalizeApproval({
    request: { id: 17, status: 'pending', current_stage: 2,
      extra_stages: [{ order: 2, name: 'Additional Approval', type: 'sequential', approvers: [{ type: 'specific_user', value: 'u-priya' }] }] },
    workflow: { id: 2, name: 'Manager', stages: [{ order: 1, name: 'Manager approval', approvers: [{ type: 'role', value: 'requester_manager' }] }] },
    actions: [{ stage_order: 1, action: 'approved', approver_id: 'u-jane', approver_name: 'Jane' }],
    current_stage: null,           // the module's strict s.order === current_stage finds nothing
    current_approvers: [],
  }, { lookupUsers });
  assert.deepEqual(states(a), [['Manager approval', 'approved'], ['Additional Approval', 'pending']]);
  assert.equal(a.current_stage.name, 'Additional Approval');
  assert.deepEqual(a.current_approvers.map((p) => p.name), ['Priya Nair']);
  assert.deepEqual(a.workflow.stages[1].approver_labels, ['Priya Nair']);
  assert.equal(a.request.extra_stages, undefined);
});

test('ad-hoc approval (stage written without an order) finds its current stage', async () => {
  const a = await normalizeApproval({
    request: { id: 5, status: 'pending', current_stage: 1, extra_stages: [] },
    workflow: { stages: JSON.stringify([{ name: 'Specific Approver', type: 'sequential', approvers: [{ type: 'specific_user', value: 'u-bob' }] }]) },
    actions: [], current_stage: null, current_approvers: [],
  }, { lookupUsers });
  assert.deepEqual(states(a), [['Specific Approver', 'pending']]);
  assert.equal(a.workflow.stages[0].order, 1);
  assert.deepEqual(a.workflow.stages[0].approver_labels, ['Bob Ross']); // not the raw hub id
});

test('multi-stage: earlier approved, current pending, later waiting', async () => {
  const a = await normalizeApproval({
    request: { status: 'pending', current_stage: 2 },
    workflow: { stages: [{ order: 1, name: 'A' }, { order: 2, name: 'B' }, { order: 3, name: 'C' }] },
    actions: [{ stage_order: 1, action: 'approved', approver_name: 'X' }],
  });
  assert.deepEqual(states(a), [['A', 'approved'], ['B', 'pending'], ['C', 'waiting']]);
});

test('rejected and skipped stages', async () => {
  const r = await normalizeApproval({
    request: { status: 'rejected', current_stage: 2 },
    workflow: { stages: [{ order: 1, name: 'A' }, { order: 2, name: 'B' }, { order: 3, name: 'C' }] },
    actions: [{ stage_order: 1, action: 'approved' }, { stage_order: 2, action: 'rejected' }],
  });
  assert.deepEqual(states(r), [['A', 'approved'], ['B', 'rejected'], ['C', 'not_needed']]);
  const s = await normalizeApproval({
    request: { status: 'approved', current_stage: 2 },
    workflow: { stages: [{ order: 1, name: 'A' }, { order: 2, name: 'B' }] },
    actions: [{ stage_order: 1, action: 'stage_skipped' }, { stage_order: 2, action: 'approved' }],
  });
  assert.deepEqual(states(s), [['A', 'skipped'], ['B', 'approved']]);
});

test('approval visibility: requester and approvers only', () => {
  const data = { ticket: { requester_id: 'u-1', requester_email: 'one@x' }, request: { requested_by: 'u-1' },
    actions: [{ approver_id: 'u-jane' }], current_approvers: [{ id: 'u-priya' }], can_act: false };
  assert.equal(canViewApproval({ id: 'u-1', email: 'one@x' }, data), true);
  assert.equal(canViewApproval({ id: 'zz', email: 'ONE@x' }, data), true);
  assert.equal(canViewApproval({ id: 'u-jane' }, data), true);
  assert.equal(canViewApproval({ id: 'u-priya' }, data), true);
  assert.equal(canViewApproval({ id: 'u-stranger', email: 'stranger@x' }, data), false);
});

const me = { id: 'u-1', name: 'Dev User', email: 'dev@x' };
const base = { id: 9, ticket_number: 'IT-9', subject: 'VPN', status: 'open', priority: 'medium', approval_status: null,
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' };
const snapOf = (t) => ({ status: t.status, approval_status: t.approval_status, priority: t.priority,
  ticket_updated_at: new Date(t.updated_at), comments_seen_at: new Date(t.updated_at) });

test('IT reply notifies; my own reply and internal notes do not', () => {
  const t = { ...base, updated_at: '2026-10-01T11:00:00Z' };
  const detail = { comments: [
    { id: 1, author_id: 'agent-1', author_name: 'Dana', body: '<p>Try&nbsp;again</p>', is_internal: false, created_at: '2026-10-01T10:30:00Z' },
    { id: 2, author_id: 'u-1', author_name: 'Dev User', body: 'ok', is_internal: false, created_at: '2026-10-01T10:40:00Z' },
    { id: 3, author_id: 'contact:7', author_name: 'dev user', body: 'via email', is_internal: false, created_at: '2026-10-01T10:45:00Z' },
    { id: 4, author_id: 'agent-1', author_name: 'Dana', body: 'internal', is_internal: true, created_at: '2026-10-01T10:50:00Z' },
  ] };
  const { events, next } = diffTicket(me, t, snapOf(base), detail);
  assert.deepEqual(events.map((e) => [e.kind, e.actor_name, e.excerpt]), [['reply', 'Dana', 'Try again']]);
  assert.equal(next.comments_seen_at.toISOString(), '2026-10-01T10:45:00.000Z'); // public comments only
  // Running the same diff again from the new snapshot produces nothing.
  assert.equal(diffTicket(me, t, { ...snapOf(t), comments_seen_at: next.comments_seen_at }, detail).events.length, 0);
});

test('approval completing is ONE approval event, not an extra status change', () => {
  const before = { ...base, status: 'pending', approval_status: 'pending' };
  const after = { ...base, status: 'open', approval_status: 'approved', updated_at: '2026-10-01T12:00:00Z' };
  const { events } = diffTicket(me, after, snapOf(before), null);
  assert.deepEqual(events.map((e) => [e.kind, e.old_value, e.new_value]), [['approval', 'pending', 'approved']]);
});

test('additional approval requested (approved → pending) notifies', () => {
  const before = { ...base, status: 'open', approval_status: 'approved' };
  const after = { ...base, status: 'pending', approval_status: 'pending', updated_at: '2026-10-01T12:00:00Z' };
  const { events } = diffTicket(me, after, snapOf(before), null);
  assert.deepEqual(events.map((e) => [e.kind, e.old_value, e.new_value]), [['approval', 'approved', 'pending']]);
});

test('status and priority changes notify; suppressed when the user made them', () => {
  const after = { ...base, status: 'resolved', priority: 'high', updated_at: '2026-10-01T12:00:00Z' };
  const kinds = diffTicket(me, after, snapOf(base), null).events.map((e) => e.kind);
  assert.deepEqual(kinds, ['status', 'priority']);
  assert.equal(diffTicket(me, after, snapOf(base), { comments: [] }, { meta: true }).events.length, 0);
});

test('updated_at bump with nothing real changed (automation) is silent', () => {
  const after = { ...base, updated_at: '2026-10-01T13:00:00Z' };
  assert.equal(diffTicket(me, after, snapOf(base), { comments: [] }).events.length, 0);
});

test('a payload without approval_status keeps the known value', () => {
  const before = { ...base, status: 'pending', approval_status: 'pending' };
  const detail = { ...before, approval_status: undefined, comments: [] };
  const { events, next } = diffTicket(me, detail, snapOf(before), detail);
  assert.equal(events.length, 0);
  assert.equal(next.approval_status, 'pending');
});

test('a ticket IT raised for me notifies once as "created"', () => {
  const t = { ...base, requester_id: 'u-1', submitter_id: 'agent-1', submitter_name: 'Marcus' };
  const { events } = diffTicket(me, t, null, { comments: [] });
  assert.deepEqual(events.map((e) => [e.kind, e.actor_name]), [['created', 'Marcus']]);
  const mine = { ...base, requester_id: 'u-1', submitter_id: 'u-1' };
  assert.equal(diffTicket(me, mine, null, { comments: [] }).events.length, 0);
});

test('without the detail, a touched ticket keeps its old mark for next time', () => {
  const after = { ...base, updated_at: '2026-10-01T13:00:00Z' };
  const { next } = diffTicket(me, after, snapOf(base), null);
  assert.equal(next.ticket_updated_at.toISOString(), '2026-10-01T10:00:00.000Z');
});

test('excerpt strips html and truncates', () => {
  assert.equal(excerptOf('<p>Hello <b>there</b></p><p>x</p>'), 'Hello there x');
  assert.equal(excerptOf('a'.repeat(300)).length, 160);
});
