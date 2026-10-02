// guides-slicedesk.js
// ─────────────────────────────────────────────────────────────────────────
// Repoints the IT Hub's guide endpoints at SliceDesk Docs (how_to_guides) so
// SliceDesk is the single source of truth. Reads, feedback AND writes all proxy
// there; the local portal2.guides CRUD stays shadowed so the two never diverge.
//
// Writes (create / update / soft-delete / duplicate) forward the signed-in Hub
// admin's identity, and SliceDesk authorizes THAT PERSON with its own per-doc
// rules — the module key says which module may write, not who may write what.
//
// Content: SliceDesk stores Lexical JSON and its portal feed also renders a
// Markdown `body`. toGuide() hands the RAW Lexical through when it is available
// (see the note there) so nothing round-trips through Markdown and loses blocks
// Markdown cannot express; legacy non-Lexical rows still use the Markdown body.
//
// Identity: SliceDesk guides are addressed by `slug`. We surface the slug as
// the opaque `id` the Portal frontend already passes around — no frontend
// change needed for read/feedback.
//
// Auth: calls SliceDesk /api/ext/portal/* with the module key
// (Authorization: Bearer <moduleConfig.apiKey>). That key MUST have the
// `portal` scope on SliceDesk. Only public + active + IT-tagged docs are
// returned (the SliceDesk-side gate).
//
// Integration (in server/index.js):
//   1. DELETE the inline `app.*('/api/guides...'` route handlers.
//   2. import { registerGuideRoutes } from './guides-slicedesk.js';
//   3. After auth middleware is defined:
//        registerGuideRoutes(app, { requireSliceUser, requireSliceAdmin });
//
// NOTE: not testable from a standalone SliceDesk checkout — verify on the box
// after deploy (list renders, a guide opens with Markdown, 👍/👎 increments
// and the same count shows in SliceDesk Docs).

import { moduleConfig } from './module-config.js';

// `actingUser` is the signed-in Hub admin, forwarded to SliceDesk so a WRITE is
// authorized as that person rather than as the module. SliceDesk re-reads their
// role from its own tables and ignores anything we assert (its "Contract A"), so
// this is an identity claim, not a permission claim — we cannot escalate by
// lying here. Reads pass no identity: they are already gated to public + active
// + IT-tagged docs on the SliceDesk side.
async function hubFetch(path, { method = 'GET', body, actingUser } = {}) {
  if (!moduleConfig.hubApiBase || !moduleConfig.apiKey) {
    const e = new Error('module not paired with the hub (hubApiBase/apiKey missing)');
    e.status = 503;
    throw e;
  }
  const payload = actingUser
    ? { ...(body || {}), acting_user: { id: String(actingUser.id ?? ''), email: String(actingUser.email ?? '') } }
    : body;
  const res = await fetch(`${moduleConfig.hubApiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${moduleConfig.apiKey}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (!res.ok) {
    // Carry SliceDesk's own message through. Without this every failure reached
    // the admin as a bare "hub 403" and the actual reason ("you do not have edit
    // access to this doc", "acting_user could not be resolved") was discarded.
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* non-JSON body */ }
    const e = new Error(detail || `hub ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const parseTags = (t) => {
  if (Array.isArray(t)) return t;
  try { return JSON.parse(t || '[]'); } catch { return []; }
};

// The Portal frontend addresses guides by NUMERIC id (it only loads content when
// /^\d+$/ matches). SliceDesk's portal feed is keyed by slug, so we expose the
// numeric how_to_guides id and keep an id→slug map (populated from the list) to
// resolve detail/feedback calls back to the slug.
let _idToSlug = new Map();
async function slugForId(id) {
  const key = String(id);
  if (_idToSlug.has(key)) return _idToSlug.get(key);
  const rows = await hubFetch('/api/ext/portal/howto'); // refresh the map
  _idToSlug = new Map((rows || []).map((g) => [String(g.id), g.slug]));
  return _idToSlug.get(key) || null;
}

// Local copy of the client's isLexicalJson (src/guide-editor/lexical/lexicalUtils.js).
// Deliberately duplicated rather than imported: server/Dockerfile builds from the
// server/ directory alone, so `../src/...` does not exist in the container and an
// import would crash the server at boot. Keep the two in sync.
function isLexicalJson(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === 'object' && obj.root !== undefined;
  } catch { return false; }
}

// SliceDesk portal feed row → IT Hub guide shape.
function toGuide(g, { withBody = false } = {}) {
  return {
    // Number(), NOT g.id verbatim. how_to_guides.id is BIGSERIAL (int8), and
    // node-postgres serialises int8 as a STRING to avoid precision loss — so
    // SliceDesk's feed sends "30", not 30. The admin console hard-asserts
    // `typeof snapshot.id === 'number'` before it will open a guide
    // (public/admin.html startEditGuide), so a string here made every guide
    // fail to open with "Server returned an invalid guide." The Portal SPA is
    // equally strict: it only loads content when /^\d+$/ matches.
    //
    // Safe: BIGSERIAL starts at 1, so these ids are nowhere near 2^53 where a
    // JS number would start losing precision. This is also the single choke
    // point for every read — list, detail and pins all build rows through here.
    id: Number(g.id),
    title: g.title,
    category: g.category,
    tags: parseTags(g.tags),
    source_type: g.source_type || 'guide',
    helpful_count: g.helpful_count || 0,
    unhelpful_count: g.unhelpful_count || 0,
    created_at: g.created_at,
    updated_at: g.updated_at,
    metadata: {},
    // Prefer the RAW Lexical content over SliceDesk's Markdown rendering.
    //
    // SliceDesk stores Lexical JSON and also renders a Markdown `body` for
    // Markdown consumers. Handing the Markdown to the editor made every save a
    // round trip (Lexical → Markdown → Lexical) which silently flattens exactly
    // the blocks that Markdown has no syntax for: callouts, toggles, columns and
    // @mentions. The reader has the same problem — src/app.jsx picks its renderer
    // with isLexicalJson(body), so a Markdown body never reaches LexicalViewer
    // and those blocks are invisible to readers.
    //
    // Legacy rows whose content is not Lexical still fall back to the Markdown
    // body, and the editor migrates them on open.
    ...(withBody ? { body: isLexicalJson(g.content) ? g.content : (g.body || '') } : {}),
  };
}

// Read access for the knowledge index (knowledge.js), which answers chat
// questions from the SAME guides the Portal shows. The list carries metadata;
// a guide's text needs its detail call. Ids are the numeric how_to_guides ids
// the Portal links with (see toGuide).
export async function listPortalGuides() {
  const rows = await hubFetch('/api/ext/portal/howto');
  _idToSlug = new Map((rows || []).map((g) => [String(g.id), g.slug]));
  return (rows || []).map((g) => ({ ...toGuide(g), slug: g.slug }));
}
export async function getPortalGuideText(slug) {
  const g = await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}`);
  // SliceDesk renders a Markdown `body` for Markdown consumers; that's the
  // right input for retrieval. Lexical JSON is only the fallback.
  return { body: g.body || '', content: g.content || '', updated_at: g.updated_at || null };
}
export const guidesFromSliceDesk = () => !!(moduleConfig.hubApiBase && moduleConfig.apiKey);

export function registerGuideRoutes(app, { requireSliceUser, requireSliceAdmin }) {
  // LIST
  app.get('/api/guides', requireSliceUser, async (req, res, next) => {
    try {
      const qs = req.query.search ? `?search=${encodeURIComponent(req.query.search)}` : '';
      const rows = await hubFetch(`/api/ext/portal/howto${qs}`);
      // Keep the id→slug map warm so guide detail/feedback resolve without a refetch.
      _idToSlug = new Map((rows || []).map((g) => [String(g.id), g.slug]));
      res.json((rows || []).map((g) => toGuide(g)));
    } catch (e) { next(e); }
  });

  // PINS — proxied to the SHARED SliceDesk pin list (user_pinned_docs), so
  // pinning here shows up in SliceDesk Docs / profile / home widget and
  // vice versa. Registered BEFORE /api/guides/:id so 'pins' isn't captured
  // as a guide id.
  app.get("/api/guides/pins", requireSliceUser, async (req, res, next) => {
    try {
      const rows = await hubFetch(`/api/ext/portal/pins?user_id=${encodeURIComponent(String(req.user.id))}`);
      for (const g of rows || []) _idToSlug.set(String(g.id), g.slug);
      res.json((rows || []).map((g) => toGuide(g)));
    } catch (e) { next(e); }
  });

  app.post("/api/guides/:id/pin", requireSliceUser, async (req, res, next) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: "not found" });
      await hubFetch("/api/ext/portal/pins", { method: "POST", body: { user_id: String(req.user.id), slug } });
      res.status(201).json({ pinned: true });
    } catch (e) { next(e); }
  });

  app.delete("/api/guides/:id/pin", requireSliceUser, async (req, res, next) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: "not found" });
      await hubFetch(`/api/ext/portal/pins?user_id=${encodeURIComponent(String(req.user.id))}&slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      res.json({ pinned: false });
    } catch (e) { next(e); }
  });

  // EXPORT — md | html | pdf, generated by SliceDesk and streamed through.
  app.get("/api/guides/:id/export", requireSliceUser, async (req, res, next) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: "not found" });
      const fmt = encodeURIComponent(String(req.query.format || "md"));
      const upstream = await fetch(`${moduleConfig.hubApiBase}/api/ext/portal/howto/${encodeURIComponent(slug)}/export?format=${fmt}`, {
        headers: { Authorization: `Bearer ${moduleConfig.apiKey}` },
      });
      if (!upstream.ok) {
        const body = await upstream.json().catch(() => ({}));
        return res.status(upstream.status).json({ error: body.error || `hub ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Content-Disposition", upstream.headers.get("content-disposition") || "attachment");
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) { next(e); }
  });

  // DETAIL (id === numeric how_to_guides id → resolve to slug)
  app.get('/api/guides/:id', requireSliceUser, async (req, res, next) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: 'not found' });
      const g = await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}`);
      res.json(toGuide(g, { withBody: true }));
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: 'not found' });
      next(e);
    }
  });

  // FEEDBACK → shared SliceDesk counters (single source of truth)
  app.post('/api/guides/:id/feedback', requireSliceUser, async (req, res, next) => {
    const { rating } = req.body ?? {};
    if (rating !== 1 && rating !== -1) return res.status(400).json({ error: 'rating must be 1 or -1' });
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: 'guide not found' });
      const r = await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}/feedback`, {
        method: 'POST', body: { rating },
      });
      res.json({ id: req.params.id, helpful_count: r.helpful_count, unhelpful_count: r.unhelpful_count });
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: 'guide not found' });
      next(e);
    }
  });

  // FEEDBACK DETAIL — SliceDesk tracks aggregate counters only (no per-vote log).
  app.get('/api/guides/:id/feedback-detail', requireSliceUser, async (req, res, next) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: 'guide not found' });
      const g = await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}`);
      res.json({ helpful_count: g.helpful_count || 0, unhelpful_count: g.unhelpful_count || 0, items: [] });
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: 'guide not found' });
      next(e);
    }
  });

  // ── WRITES → SliceDesk Docs ────────────────────────────────────────────────
  // The Hub admin's guide editor saves through here. A guide authored in the Hub
  // lands in SliceDesk Docs and comes straight back out of the portal feed above,
  // so there is one copy of it and no sync step.
  //
  // Every write forwards the signed-in admin (see hubFetch's `actingUser`), and
  // SliceDesk applies its own per-doc permissions to that person — so a Hub admin
  // can only change what they could already change in Docs.
  //
  // Errors are returned as JSON on EVERY path, never bare status codes: the admin
  // console parses the response body before it checks res.ok, so a bodiless error
  // surfaces to the user as "Unexpected end of JSON input" instead of the reason.
  const actingUserFor = (req) => ({ id: req.user?.id, email: req.user?.email });
  const writeFailed = (res, e) => res
    .status(e?.status && e.status >= 400 && e.status < 600 ? e.status : 502)
    .json({ error: e?.message || 'Save failed upstream.' });

  // The editor posts { title, category, source_type, body, tags }. SliceDesk's
  // column is `content`, the Hub's is `body` — the rename happens here and only
  // here. `body` is Lexical JSON produced by GuideEditor.getValue().
  const toUpstream = (b) => ({
    title: b?.title,
    category: b?.category,
    source_type: b?.source_type,
    tags: b?.tags,
    content: b?.body ?? '',
  });

  // CREATE
  app.post('/api/guides', requireSliceAdmin, async (req, res) => {
    try {
      const row = await hubFetch('/api/ext/portal/howto', {
        method: 'POST',
        actingUser: actingUserFor(req),
        body: toUpstream(req.body),
      });
      if (row?.slug) _idToSlug.set(String(row.id), row.slug);
      // Number(): the admin console refuses to reopen a guide whose id is not a
      // JS number (it hard-asserts typeof === 'number').
      res.status(201).json({ ...toGuide(row, { withBody: true }), id: Number(row.id) });
    } catch (e) { writeFailed(res, e); }
  });

  // UPDATE
  app.put('/api/guides/:id', requireSliceAdmin, async (req, res) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: 'Guide not found' });
      const row = await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        actingUser: actingUserFor(req),
        body: toUpstream(req.body),
      });
      res.json({ ...toGuide(row, { withBody: true }), id: Number(row.id) });
    } catch (e) { writeFailed(res, e); }
  });

  // DELETE (soft — moves to the Docs trash)
  app.delete('/api/guides/:id', requireSliceAdmin, async (req, res) => {
    try {
      // The admin console's Trash screen still reads the LOCAL guides table, so a
      // SliceDesk-backed guide never appears there and purging one from the Hub
      // is not reachable. Say so rather than pretending to permanently delete.
      if (String(req.query.hard || '') === '1') {
        return res.status(400).json({
          error: 'Permanent deletion happens in SliceDesk Docs. This removes it from the Portal only.',
        });
      }
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: 'Guide not found' });
      const u = actingUserFor(req);
      const qs = `acting_user_id=${encodeURIComponent(String(u.id ?? ''))}`
        + `&acting_user_email=${encodeURIComponent(String(u.email ?? ''))}`;
      await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}?${qs}`, { method: 'DELETE' });
      _idToSlug.delete(String(req.params.id));
      res.json({ ok: true, soft: true });
    } catch (e) { writeFailed(res, e); }
  });

  // DUPLICATE — read the original, then create a copy. Needs no extra SliceDesk
  // endpoint, and the copy is created as the acting admin like any other new doc.
  app.post('/api/guides/:id/duplicate', requireSliceAdmin, async (req, res) => {
    try {
      const slug = await slugForId(req.params.id);
      if (!slug) return res.status(404).json({ error: 'Guide not found' });
      const src = await hubFetch(`/api/ext/portal/howto/${encodeURIComponent(slug)}`);
      const row = await hubFetch('/api/ext/portal/howto', {
        method: 'POST',
        actingUser: actingUserFor(req),
        body: {
          title: `${src.title} (copy)`,
          category: src.category,
          source_type: src.source_type,
          tags: parseTags(src.tags),
          description: src.description,
          content: src.content ?? '',
        },
      });
      if (row?.slug) _idToSlug.set(String(row.id), row.slug);
      res.status(201).json({ ...toGuide(row, { withBody: true }), id: Number(row.id) });
    } catch (e) { writeFailed(res, e); }
  });

  // RESTORE — unreachable for SliceDesk-backed guides: the Trash screen lists
  // rows from the local table, which these are not. Kept registered so the route
  // returns a clear reason instead of falling through to the dead local handler.
  app.post('/api/guides/:id/restore', requireSliceAdmin, (_req, res) => res.status(400).json({
    error: 'Restore happens in SliceDesk Docs — open the Docs trash there.',
  }));
}
