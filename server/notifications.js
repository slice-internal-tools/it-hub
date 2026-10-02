// Portal notifications — generated server-side, read state stored server-side,
// pushed live over Server-Sent Events.
//
// Why this exists (see schema.sql for the storage side): the bell and the My
// Tickets badges used to be computed in the browser from `updated_at` and
// remembered in localStorage. Inside the hub's cross-origin iframe that storage
// doesn't survive (partitioned / wiped), so "Mark all as read" came back on
// every login; and `updated_at` moves for things nobody should be pinged about
// (automations, the user's own reply), so even a working store would re-flag.
//
// How it works:
//   • sync(user) lists the user's tickets from the ticket module and diffs each
//     against portal_ticket_state — the last state we recorded for them. A real
//     change (status, approval, priority, a public reply from someone else)
//     becomes a row in portal_notifications. Then the snapshot moves forward.
//   • A user's very first sync records everything silently: nothing is "new"
//     to someone we have never tracked.
//   • The user's own actions through the portal (reply, close, reopen,
//     priority) refresh the snapshot right after they succeed with those
//     fields suppressed, so you are never notified about what you just did.
//     Replies are attributed by author, so your own never notify either.
//   • Live: a browser holding /api/notifications/stream gets new rows pushed
//     the moment a sync finds them. While at least one stream is open for a
//     user, their tickets are synced every LIVE_SYNC_MS. Without a stream the
//     same sync runs on demand (list fetches, the bell's fallback poll), so
//     nothing is lost — only delayed.

const LIVE_SYNC_MS = Number(process.env.NOTIF_LIVE_SYNC_MS) || 15000;
const MIN_SYNC_GAP_MS = 5000;          // don't re-list the same user faster than this
const MAX_DETAIL_FETCHES = 6;          // per sync; the rest are picked up next time
const STREAM_MAX_AGE_MS = 10 * 60 * 1000; // client reconnects (and re-auths) after this
const HEARTBEAT_MS = 20000;            // under every proxy's idle timeout
const RETENTION_DAYS = 90;

const lc = (v) => (v == null ? '' : String(v).toLowerCase());
const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const later = (a, b) => {
  const da = toDate(a); const db = toDate(b);
  if (!da) return db; if (!db) return da;
  return da > db ? da : db;
};

// HTML comment body → one short plain-text line for the bell.
export function excerptOf(html, max = 160) {
  const text = String(html || '')
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function isOwnComment(u, c) {
  if (!u || !c) return false;
  const uid = String(u.id ?? '').trim();
  if (uid && String(c.author_id ?? '').trim() === uid) return true;
  const name = lc(u.name).trim();
  if (name && lc(c.author_name).trim() === name) return true;
  const email = lc(u.email).trim();
  if (email && lc(c.author_email).trim() === email) return true;
  return false;
}

const isInternal = (c) => c && (c.is_internal === true || c.is_internal === 1 || c.is_internal === 'true');

// Who raised this ticket, if not the user themselves (an agent filing for
// them, a manager on their behalf). null for a self-raised ticket.
function raisedBySomeoneElse(u, t) {
  const uid = String(u.id ?? '');
  const sub = t.submitter_id != null ? String(t.submitter_id) : '';
  if (t.raised_by && t.raised_by.id != null && String(t.raised_by.id) !== uid) return t.raised_by.name || 'Someone';
  if (sub && sub !== uid && String(t.requester_id ?? '') === uid) return t.submitter_name || 'Someone';
  return null;
}

const normApproval = (v) => {
  const s = lc(v);
  if (s === 'auto_rejected') return 'rejected';
  return s || null;
};

// Pure diff of one ticket against its last snapshot → events + next snapshot.
// `detail` (the full ticket with comments) is optional; without it replies
// aren't examined and comments_seen_at doesn't move. `suppress` silences the
// field changes the user made themselves.
export function diffTicket(u, t, snap, detail, suppress = {}) {
  const events = [];
  const status = lc(t.status) || null;
  // undefined = "this payload doesn't carry it" (the module's detail route has
  // no approval_status): keep what we had rather than diffing against nothing.
  const approval = t.approval_status === undefined ? (snap ? snap.approval_status : null) : normApproval(t.approval_status);
  const priority = t.priority === undefined ? (snap ? snap.priority : null) : (lc(t.priority) || null);
  const updatedAt = toDate(t.updated_at || t.created_at);
  const base = {
    ticket_id: String(t.id),
    ticket_number: t.ticket_number || null,
    subject: t.subject || null,
  };
  const prev = snap || {
    status, approval_status: approval, priority,
    ticket_updated_at: toDate(t.created_at) || updatedAt,
    comments_seen_at: toDate(t.created_at) || updatedAt,
  };
  const stamp = updatedAt ? updatedAt.toISOString() : 'na';

  if (!snap) {
    const by = raisedBySomeoneElse(u, t);
    if (by) events.push({ ...base, kind: 'created', actor_name: by, dedupe_key: `created:${t.id}`, event_at: toDate(t.created_at) || updatedAt });
  }

  const approvalChanged = approval !== (prev.approval_status || null) && !(approval == null && prev.approval_status == null);
  if (approvalChanged && approval && approval !== 'cancelled' && !suppress.meta) {
    events.push({
      ...base, kind: 'approval', old_value: prev.approval_status || null, new_value: approval,
      dedupe_key: `approval:${t.id}:${approval}:${stamp}`, event_at: updatedAt,
    });
  }
  // A status move that's just the approval's consequence (pending while it
  // waits, open once approved, cancelled when declined) is already said by the
  // approval event — only a real finish (resolved / closed) is worth its own.
  const statusChanged = status && status !== (prev.status || null);
  if (statusChanged && !suppress.meta && !(approvalChanged && !['resolved', 'closed'].includes(status))) {
    events.push({
      ...base, kind: 'status', old_value: prev.status || null, new_value: status,
      dedupe_key: `status:${t.id}:${status}:${stamp}`, event_at: updatedAt,
    });
  }
  if (priority && prev.priority && priority !== prev.priority && !suppress.meta) {
    events.push({
      ...base, kind: 'priority', old_value: prev.priority, new_value: priority,
      dedupe_key: `priority:${t.id}:${priority}:${stamp}`, event_at: updatedAt,
    });
  }

  let commentsSeenAt = toDate(prev.comments_seen_at);
  if (detail && Array.isArray(detail.comments)) {
    const mark = commentsSeenAt;
    for (const c of detail.comments) {
      if (!c || isInternal(c)) continue;
      const at = toDate(c.created_at);
      if (!at) continue;
      commentsSeenAt = later(commentsSeenAt, at);
      if (mark && at <= mark) continue;
      if (isOwnComment(u, c)) continue;
      events.push({
        ...base, kind: 'reply', actor_name: c.author_name || 'IT Team', excerpt: excerptOf(c.body),
        dedupe_key: `reply:${t.id}:${c.id != null ? c.id : at.toISOString()}`, event_at: at,
      });
    }
  }

  const next = {
    status: status || prev.status || null,
    approval_status: approval,
    priority: priority || prev.priority || null,
    // Only advance past an update we actually examined. Without the detail,
    // a touched ticket's replies are still unchecked — keep the old mark so
    // the next sync (which will fetch it) still sees the gap.
    ticket_updated_at: detail ? later(prev.ticket_updated_at, updatedAt) : toDate(prev.ticket_updated_at),
    comments_seen_at: commentsSeenAt,
  };
  return { events, next };
}

export function createNotifications({ pool, listUserTickets, loadTicketForUser, log = console }) {
  const perUser = new Map();     // userId → { last, inflight, user }
  const streams = new Map();     // userId → Set<send>
  const loops = new Map();       // userId → interval

  const state = (uid) => {
    let s = perUser.get(uid);
    if (!s) { s = { last: 0, inflight: null, user: null }; perUser.set(uid, s); }
    return s;
  };

  function broadcast(uid, event, data) {
    const set = streams.get(uid);
    if (!set) return;
    for (const send of set) { try { send(event, data); } catch { /* dropped on close */ } }
  }

  async function counts(uid) {
    const r = await pool.query(
      `SELECT ticket_id, COUNT(*)::int AS n FROM portal_notifications
        WHERE user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL GROUP BY ticket_id`, [uid]);
    const byTicket = {};
    let total = 0;
    for (const row of r.rows) { byTicket[row.ticket_id] = row.n; total += row.n; }
    return { unread_count: total, unread_by_ticket: byTicket };
  }

  const dto = (r) => ({
    id: String(r.id), ticket_id: r.ticket_id, ticket_number: r.ticket_number, subject: r.subject,
    kind: r.kind, actor_name: r.actor_name, excerpt: r.excerpt, old_value: r.old_value, new_value: r.new_value,
    event_at: r.event_at, read: !!r.read_at,
  });

  async function loadSnapshots(uid) {
    const r = await pool.query('SELECT * FROM portal_ticket_state WHERE user_id = $1', [uid]);
    const m = new Map();
    for (const row of r.rows) m.set(String(row.ticket_id), row);
    return m;
  }

  async function saveSnapshot(uid, ticketId, n) {
    await pool.query(
      `INSERT INTO portal_ticket_state (user_id, ticket_id, status, approval_status, priority, ticket_updated_at, comments_seen_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (user_id, ticket_id) DO UPDATE SET
         status = EXCLUDED.status, approval_status = EXCLUDED.approval_status, priority = EXCLUDED.priority,
         ticket_updated_at = EXCLUDED.ticket_updated_at, comments_seen_at = EXCLUDED.comments_seen_at, updated_at = NOW()`,
      [uid, String(ticketId), n.status, n.approval_status, n.priority, n.ticket_updated_at, n.comments_seen_at]);
  }

  async function insertEvents(uid, events) {
    const out = [];
    for (const e of events) {
      const r = await pool.query(
        `INSERT INTO portal_notifications
           (user_id, ticket_id, ticket_number, subject, kind, actor_name, excerpt, old_value, new_value, dedupe_key, event_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, NOW()))
         ON CONFLICT (user_id, dedupe_key) DO NOTHING
         RETURNING *`,
        [uid, e.ticket_id, e.ticket_number, e.subject, e.kind, e.actor_name || null, e.excerpt || null,
          e.old_value || null, e.new_value || null, e.dedupe_key, e.event_at || null]);
      if (r.rows[0]) out.push(r.rows[0]);
    }
    return out;
  }

  // After a sync: push what's NEW to this user's open streams. Only new
  // notification rows are announced — never "a snapshot was rewritten" —
  // because the browser answers an announcement by reloading tickets, and a
  // ticket reload runs a sync. Rows are unique per (user, dedupe_key), so a
  // second pass over the same change inserts nothing and the loop can't feed
  // itself.
  async function publish(uid, inserted) {
    if (!inserted.length) return;
    const c = await counts(uid);
    const ids = [...new Set(inserted.map((r) => String(r.ticket_id)))];
    broadcast(uid, 'notifications', { items: inserted.map(dto), ...c, changed_ticket_ids: ids });
  }

  async function seed(uid, tickets) {
    // Everything up to each ticket's current updated_at counts as seen. Kept
    // on the module's own clock (not ours) so clock skew can't hide a reply.
    for (const t of tickets) {
      const upd = toDate(t.updated_at || t.created_at);
      await saveSnapshot(uid, t.id, {
        status: lc(t.status) || null, approval_status: normApproval(t.approval_status), priority: lc(t.priority) || null,
        ticket_updated_at: upd, comments_seen_at: upd,
      });
    }
    await pool.query('INSERT INTO portal_notification_users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
  }

  async function runSync(u, provided) {
    const uid = String(u.id);
    const tickets = provided || await listUserTickets(u);
    if (tickets.partial) throw new Error('ticket list incomplete (module error) — skipping this sync');
    const seeded = await pool.query('SELECT 1 FROM portal_notification_users WHERE user_id = $1', [uid]);
    if (!seeded.rowCount) { await seed(uid, tickets); return { inserted: [], changed: [] }; }
    const snaps = await loadSnapshots(uid);
    let detailBudget = MAX_DETAIL_FETCHES;
    const inserted = [];
    const changed = [];
    for (const t of tickets) {
      if (!t || t.id == null) continue;
      const snap = snaps.get(String(t.id)) || null;
      const upd = toDate(t.updated_at || t.created_at);
      const touched = !snap || (upd && (!snap.ticket_updated_at || upd > toDate(snap.ticket_updated_at)));
      const metaMoved = snap && (
        lc(t.status) !== lc(snap.status) ||
        (t.approval_status !== undefined && normApproval(t.approval_status) !== (snap.approval_status || null)) ||
        (t.priority !== undefined && lc(t.priority) !== lc(snap.priority)));
      if (!touched && !metaMoved) continue;
      let detail = null;
      if (touched && detailBudget > 0) {
        detailBudget--;
        try { detail = await loadTicketForUser(u, t.id, { withApproval: false }); } catch { detail = null; }
      }
      // A brand-new ticket with no activity since creation has nothing to read.
      if (!snap && !detail && upd && toDate(t.created_at) && upd <= toDate(t.created_at)) detail = { comments: [] };
      const { events, next } = diffTicket(u, t, snap, detail);
      await saveSnapshot(uid, t.id, next);
      changed.push(String(t.id));
      if (events.length) inserted.push(...await insertEvents(uid, events));
    }
    return { inserted, changed };
  }

  // Throttled, de-duplicated per user. `tickets` (from the list route) skips
  // the re-list; `force` skips the throttle.
  async function syncUser(u, { tickets, force } = {}) {
    if (!u || u.id == null || u._bot) return { inserted: [], changed: [] };
    const uid = String(u.id);
    const s = state(uid);
    s.user = u;
    if (s.inflight) return s.inflight;
    if (!force && !tickets && Date.now() - s.last < MIN_SYNC_GAP_MS) return { inserted: [], changed: [] };
    s.inflight = (async () => {
      try {
        const res = await runSync(u, tickets);
        await publish(uid, res.inserted);
        return res;
      } catch (err) {
        log.warn('[notifications] sync failed for', uid, err.message);
        return { inserted: [], changed: [] };
      } finally {
        s.last = Date.now();
        s.inflight = null;
      }
    })();
    return s.inflight;
  }

  // One ticket the user is looking at (or just changed) — diff it with full
  // detail so a reply that arrived is recorded before it's marked read.
  async function syncTicket(u, ticket, { suppress } = {}) {
    if (!u || u.id == null || !ticket || ticket.id == null) return;
    const uid = String(u.id);
    const seeded = await pool.query('SELECT 1 FROM portal_notification_users WHERE user_id = $1', [uid]);
    if (!seeded.rowCount) return; // the user's first full sync seeds everything
    const r = await pool.query('SELECT * FROM portal_ticket_state WHERE user_id = $1 AND ticket_id = $2', [uid, String(ticket.id)]);
    const snap = r.rows[0] || null;
    const { events, next } = diffTicket(u, ticket, snap, ticket, suppress ? { meta: true } : {});
    await saveSnapshot(uid, ticket.id, next);
    const inserted = events.length ? await insertEvents(uid, events) : [];
    await publish(uid, inserted);
  }

  // Re-read a ticket after the user changed it through the portal and record
  // the result as seen — their own change must not come back as a notification.
  function afterSelfChange(u, ticketId) {
    Promise.resolve()
      .then(() => loadTicketForUser(u, ticketId, { withApproval: true }))
      .then((t) => t && syncTicket(u, t, { suppress: true }))
      .catch((err) => log.warn('[notifications] self-change refresh failed:', err.message));
  }

  async function markRead(uid, { all, ids, ticketId } = {}) {
    let r;
    if (all) {
      r = await pool.query(`UPDATE portal_notifications SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL`, [uid]);
    } else if (ticketId != null) {
      r = await pool.query(`UPDATE portal_notifications SET read_at = NOW()
        WHERE user_id = $1 AND ticket_id = $2 AND read_at IS NULL`, [uid, String(ticketId)]);
    } else if (Array.isArray(ids) && ids.length) {
      const clean = ids.map(String).filter((x) => /^\d+$/.test(x)).slice(0, 500);
      if (!clean.length) return 0;
      r = await pool.query(`UPDATE portal_notifications SET read_at = NOW()
        WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`, [uid, clean]);
    } else return 0;
    if (r.rowCount) broadcast(uid, 'read', await counts(uid));
    return r.rowCount;
  }

  function ensureLoop(uid) {
    if (loops.has(uid)) return;
    const iv = setInterval(() => {
      const s = perUser.get(uid);
      if (!streams.get(uid) || !streams.get(uid).size) { clearInterval(iv); loops.delete(uid); return; }
      if (s && s.user) syncUser(s.user).catch(() => {});
    }, LIVE_SYNC_MS);
    if (iv.unref) iv.unref();
    loops.set(uid, iv);
  }

  async function prune() {
    try {
      await pool.query(`DELETE FROM portal_notifications WHERE event_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
    } catch (err) { log.warn('[notifications] prune failed:', err.message); }
  }
  prune();
  const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  function registerRoutes(app, requireUser) {
    // The bell, the Notifications page and the My Tickets badges all read this.
    app.get('/api/notifications', requireUser, async (req, res) => {
      const u = req.user;
      const uid = String(u.id);
      res.set('Cache-Control', 'no-store');
      try {
        // Fold in anything that changed since last time, but never make the
        // bell wait on a slow ticket module for more than a moment.
        await Promise.race([syncUser(u), new Promise((r) => setTimeout(r, 4000))]);
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
        const rows = await pool.query(
          `SELECT * FROM portal_notifications WHERE user_id = $1 AND dismissed_at IS NULL
            ORDER BY event_at DESC, id DESC LIMIT $2`, [uid, limit]);
        res.json({ items: rows.rows.map(dto), ...(await counts(uid)) });
      } catch (err) {
        log.warn('[notifications] list failed:', err.message);
        res.status(500).json({ error: 'Could not load notifications.' });
      }
    });

    // { all: true } | { ticket_id } | { ids: [...] }
    app.post('/api/notifications/read', requireUser, async (req, res) => {
      const uid = String(req.user.id);
      const b = req.body || {};
      try {
        const n = await markRead(uid, { all: b.all === true, ids: b.ids, ticketId: b.ticket_id });
        res.json({ updated: n, ...(await counts(uid)) });
      } catch (err) {
        log.warn('[notifications] read failed:', err.message);
        res.status(500).json({ error: 'Could not update notifications.' });
      }
    });

    app.post('/api/notifications/:id/dismiss', requireUser, async (req, res) => {
      const uid = String(req.user.id);
      if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: 'Bad id.' });
      try {
        await pool.query(`UPDATE portal_notifications SET dismissed_at = NOW(), read_at = COALESCE(read_at, NOW())
          WHERE user_id = $1 AND id = $2`, [uid, req.params.id]);
        const c = await counts(uid);
        broadcast(uid, 'read', c);
        res.json(c);
      } catch (err) {
        res.status(500).json({ error: 'Could not dismiss.' });
      }
    });

    // Server-Sent Events. Read by the client with fetch() (not EventSource),
    // because EventSource can't send the X-Hub-Token header the hub auth needs.
    app.get('/api/notifications/stream', requireUser, (req, res) => {
      const u = req.user;
      const uid = String(u.id);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx (ours and the hub's) buffers proxied responses by default,
        // which would hold every event until the buffer fills.
        'X-Accel-Buffering': 'no',
      });
      if (res.flushHeaders) res.flushHeaders();
      const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      res.write('retry: 5000\n\n');
      send('hello', { live_sync_ms: LIVE_SYNC_MS });
      if (!streams.has(uid)) streams.set(uid, new Set());
      streams.get(uid).add(send);
      state(uid).user = u;
      ensureLoop(uid);
      syncUser(u).catch(() => {});
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, HEARTBEAT_MS);
      const maxAge = setTimeout(() => { try { send('bye', { reason: 'max_age' }); res.end(); } catch {} }, STREAM_MAX_AGE_MS);
      req.on('close', () => {
        clearInterval(hb); clearTimeout(maxAge);
        const set = streams.get(uid);
        if (set) { set.delete(send); if (!set.size) streams.delete(uid); }
      });
    });
  }

  return { syncUser, syncTicket, afterSelfChange, markRead, registerRoutes };
}
