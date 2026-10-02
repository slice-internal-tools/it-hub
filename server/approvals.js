// Approval detail, normalised for the portal.
//
// The ticket module's GET /approvals/:id returns the workflow TEMPLATE's stages
// (approval_workflows.stages) and nothing else. Two things the module does at
// runtime never show up in that list:
//
//  1. "Request an additional approval" on an already-approved ticket appends a
//     stage to approval_requests.extra_stages and moves current_stage past the
//     template (approvalEngine.addAdditionalApprovalStage). The template still
//     ends where it ended, so the portal saw only the stages that were already
//     approved — "Approved by <manager>" — while the ticket was really waiting
//     on someone new. That is the "says approved while it's awaiting" bug.
//  2. An ad-hoc approval (an agent routes to a specific person by email) is a
//     one-stage workflow written WITHOUT an `order`. The engine treats a stage's
//     order as `stage.order || index + 1`; the module's detail route compares
//     `s.order === current_stage` strictly, so it found no current stage, sent
//     no current_approvers, and the portal printed the approver's raw hub id.
//
// This rebuilds the effective stage list exactly the way the engine walks it
// (approvalEngine.effectiveStages: template + extra_stages, order defaulting to
// position), works out each stage's state from the request + its recorded
// actions, and resolves specific-user approvers to names. The request row is
// spread whole into the module's response, so extra_stages is already there —
// no module change is needed for this to be correct.

const lc = (v) => (v == null ? '' : String(v).toLowerCase());

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  return [];
}

// Engine bookkeeping rows vs actual decisions (see approverLine in the client).
const APPROVE_ACTIONS = new Set(['approved', 'auto_approved']);

export function effectiveStages(data) {
  const base = parseList(data && data.workflow && data.workflow.stages);
  const extra = parseList(data && data.request && data.request.extra_stages);
  return [...base, ...extra].map((s, i) => ({ ...(s || {}), order: Number(s && s.order) || i + 1 }));
}

// state per stage: approved | pending | waiting | rejected | skipped | not_needed | withdrawn
export function stageStates(stages, request, actions) {
  const status = lc(request && request.status);
  const cur = Number(request && request.current_stage) || null;
  const acts = Array.isArray(actions) ? actions : [];
  const at = (order, pred) => acts.some((a) => a && Number(a.stage_order) === order && pred(lc(a.action)));
  return stages.map((s) => {
    const o = s.order;
    const approved = at(o, (x) => APPROVE_ACTIONS.has(x));
    const rejected = at(o, (x) => x === 'rejected');
    const skipped = at(o, (x) => x === 'stage_skipped');
    let state;
    if (status === 'approved') state = skipped && !approved ? 'skipped' : 'approved';
    else if (status === 'pending') {
      if (cur == null) state = 'waiting';
      else if (o < cur) state = skipped && !approved ? 'skipped' : 'approved';
      else if (o === cur) state = 'pending';
      else state = 'waiting';
    } else if (status === 'rejected' || status === 'auto_rejected') {
      if (rejected || (cur != null && o === cur)) state = 'rejected';
      else if (cur != null && o < cur) state = skipped && !approved ? 'skipped' : 'approved';
      else state = 'not_needed';
    } else if (status === 'cancelled') {
      state = (cur != null && o < cur && (approved || !skipped)) ? 'approved' : 'withdrawn';
    } else {
      state = approved ? 'approved' : 'waiting';
    }
    return state;
  });
}

const ROLE_LABEL = {
  requester_manager: 'Your manager',
  department_head: 'Department head',
  it_director: 'IT director',
  queue_lead: 'Queue lead',
};

// Short-lived id → {name,email} cache so a ticket polled every few seconds
// doesn't re-query the directory for the same approver each time.
const PERSON_TTL_MS = 10 * 60 * 1000;
const personCache = new Map();

async function resolvePerson(id, lookupUsers) {
  const key = String(id);
  const hit = personCache.get(key);
  // A miss is retried after a minute — a directory hiccup shouldn't leave an
  // approver nameless for the full TTL.
  if (hit && Date.now() - hit.at < (hit.person ? PERSON_TTL_MS : 60 * 1000)) return hit.person;
  let person = null;
  try {
    const users = await lookupUsers(key);
    const u = (users || []).find((x) => x && String(x.id) === key);
    if (u) person = { id: key, name: u.name || u.display_name || null, email: u.email || null };
  } catch { /* leave unresolved */ }
  personCache.set(key, { at: Date.now(), person });
  return person;
}

// `lookupUsers(q)` → array of { id, name, email } (the module's /users?q=).
export async function normalizeApproval(data, { lookupUsers } = {}) {
  if (!data || typeof data !== 'object' || !data.request) return data;
  const request = { ...data.request };
  delete request.extra_stages; // folded into workflow.stages below
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const stages = effectiveStages(data);
  const states = stageStates(stages, data.request, actions);
  const curOrder = Number(data.request.current_stage) || null;
  const current = stages.find((s) => s.order === curOrder) || null;

  // People: specific-user approvers by name, roles by their label.
  const named = await Promise.all(stages.map(async (s) => {
    const approvers = Array.isArray(s.approvers) ? s.approvers : [];
    const labels = [];
    for (const ap of approvers) {
      if (!ap) continue;
      const type = lc(ap.type);
      if (type === 'role' || ROLE_LABEL[ap.value]) labels.push(ROLE_LABEL[ap.value] || String(ap.value || 'Approver'));
      else if ((type === 'specific_user' || type === 'user') && ap.value != null && lookupUsers) {
        const p = await resolvePerson(ap.value, lookupUsers);
        labels.push((p && (p.name || p.email)) || 'A selected approver');
      } else if (type === 'group' || type === 'approval_group') labels.push(ap.name || 'An approval group');
      else if (ap.name) labels.push(String(ap.name));
      else labels.push('An approver');
    }
    return labels;
  }));

  let currentApprovers = Array.isArray(data.current_approvers) ? data.current_approvers.filter(Boolean) : [];
  // The module only resolves current approvers when IT found the stage, which
  // it doesn't for appended or order-less stages — fill those in ourselves.
  if (!currentApprovers.length && current && lc(request.status) === 'pending' && lookupUsers) {
    const ids = (current.approvers || [])
      .filter((ap) => ap && ['specific_user', 'user'].includes(lc(ap.type)) && ap.value != null)
      .map((ap) => ap.value);
    for (const id of ids) {
      const p = await resolvePerson(id, lookupUsers);
      if (p) currentApprovers.push(p);
    }
  }

  return {
    ...data,
    request,
    workflow: { ...(data.workflow || {}), stages: stages.map((s, i) => ({ ...s, state: states[i], approver_labels: named[i] })) },
    current_stage: current,
    current_approvers: currentApprovers,
    normalized: true,
  };
}

// May this signed-in user see this approval? The requester (by email or id),
// or anyone who is or was an approver on it. Everyone else gets a 403 — the
// route used to return any approval to any signed-in user who guessed its id.
export function canViewApproval(u, data) {
  if (!u || !data) return false;
  const uid = String(u.id ?? '').trim();
  const em = lc(u.email).trim();
  const t = data.ticket || {};
  if (em && lc(t.requester_email).trim() === em) return true;
  if (uid && String(t.requester_id ?? '') === uid) return true;
  if (uid && String((data.request && data.request.requested_by) ?? '') === uid) return true;
  if (data.can_act) return true;
  const acts = Array.isArray(data.actions) ? data.actions : [];
  if (uid && acts.some((a) => a && (String(a.approver_id ?? '') === uid || String(a.delegated_to ?? '') === uid))) return true;
  const cur = Array.isArray(data.current_approvers) ? data.current_approvers : [];
  if (uid && cur.some((p) => p && String(p.id ?? '') === uid)) return true;
  if (em && cur.some((p) => p && lc(p.email) === em)) return true;
  return false;
}
