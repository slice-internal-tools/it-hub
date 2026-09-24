// Local-dev ticket fixtures.
//
// In real deployments the portal owns NO ticket data — every ticket call proxies
// to the ticket module through the hub (see ticketModuleFetch in index.js). In
// local dev there's no hub, so those calls would 503 ("Module is not configured
// to reach the hub") and the Tickets UI shows an error. This in-memory store
// stands in for the ticket module so the UI has something to render.
//
// Enabled when DEV_TICKETS is truthy; defaults ON whenever DEV_BYPASS_AUTH is set
// (i.e. local dev). In-memory only — resets on server restart, reseeding these
// rows. Mirrors the ticket module's envelope shapes that index.js expects.
//
// SAFE FOR PROD: never runs there. Prod sets hubApiBase + apiKey (so the real
// proxy path is taken) AND doesn't set DEV_BYPASS_AUTH (so this is disabled).

import zlib from 'node:zlib';

const onFlag = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

export const devTicketsEnabled = process.env.DEV_TICKETS != null
  ? onFlag(process.env.DEV_TICKETS)
  : onFlag(process.env.DEV_BYPASS_AUTH);

const DEV_USER = { id: 'dev', name: 'Dev User', email: 'dev@local' };
const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();

// The signed-in dev user (DEV_BYPASS_AUTH) is both requester and submitter, so
// these all land in "My tickets". On-brand Slice scenarios (GlobalProtect,
// 1Password, Jabra/CCP) covering an open incident, a request pending approval,
// and a resolved incident with a back-and-forth.
let seq = 90013;
const tickets = [
  {
    id: 90012,
    ticket_number: 'IT-90012',
    type: 'incident',
    status: 'open',
    priority: 'high',
    subject: "Can't connect to the VPN (GlobalProtect)",
    description:
      'GlobalProtect just spins on "Connecting…" and never finishes. Tried quitting and reopening, same thing. I\'m on home Wi-Fi.',
    requester_id: DEV_USER.id, requester_name: DEV_USER.name, requester_email: DEV_USER.email,
    submitter_id: DEV_USER.id, submitter_name: DEV_USER.name, submitter_email: DEV_USER.email,
    created_at: ago(95), updated_at: ago(40),
    comments: [
      { id: 'c1-90012', author_name: 'IT Team', body: "Thanks for the report — can you confirm GlobalProtect is on the latest version? We pushed an update via Jamf this morning. Try reconnecting and let us know.", is_internal: false, created_at: ago(40) },
      // Internal note + its file: must never reach the browser (forRequester).
      { id: 'c2-90012', author_name: 'Dana Brooks', body: 'Internal: Jamf policy 214 failed on this Mac — check the log.', is_internal: true, created_at: ago(35) },
      { id: 'c3-90012', author_name: 'Dana Brooks', body: '<p>Here’s where the portal address goes — screenshot below and attached.</p>', is_internal: false, created_at: ago(30) },
    ],
    attachments: [
      { id: 7001, comment_id: 'c3-90012', file_name: 'globalprotect-settings.png', mime_type: 'image/png', file_size: 0, uploaded_by_name: 'Dana Brooks', created_at: ago(30) },
      { id: 7002, comment_id: 'c2-90012', file_name: 'jamf-policy-214.log', mime_type: 'text/plain', file_size: 0, uploaded_by_name: 'Dana Brooks', created_at: ago(35) },
      { id: 7003, comment_id: null, file_name: 'vpn-steps.txt', mime_type: 'text/plain', file_size: 0, uploaded_by_name: 'Dana Brooks', created_at: ago(28) },
    ],
  },
  {
    id: 90008,
    ticket_number: 'IT-90008',
    type: 'service_request',
    status: 'pending',
    approval_status: 'pending',
    priority: 'medium',
    subject: 'Access request: 1Password "Payments" vault',
    description: 'I need access to the Payments vault in 1Password to pull the Adyen test credentials for the billing work.',
    requester_id: DEV_USER.id, requester_name: DEV_USER.name, requester_email: DEV_USER.email,
    submitter_id: DEV_USER.id, submitter_name: DEV_USER.name, submitter_email: DEV_USER.email,
    created_at: ago(1500), updated_at: ago(1500),
    comments: [],
  },
  // Declined by the approvers, but still filed as resolved (how tickets
  // declined before rejection → 'cancelled' look) — must offer no Reopen/Close.
  {
    id: 90004,
    ticket_number: 'IT-90004',
    type: 'service_request',
    status: 'resolved',
    approval_status: 'rejected',
    priority: 'medium',
    subject: 'Request: Claude',
    description: 'Requesting a Claude seat for drafting release notes.',
    requester_id: DEV_USER.id, requester_name: DEV_USER.name, requester_email: DEV_USER.email,
    submitter_id: DEV_USER.id, submitter_name: DEV_USER.name, submitter_email: DEV_USER.email,
    created_at: ago(3000), updated_at: ago(2900),
    comments: [],
  },
  // Two tickets the dev user opened ON BEHALF OF someone else (submitter = dev,
  // requester = the beneficiary) — exercises the "Requested for" facet, the
  // "For ‹name›" chip, and (IT-90010, replied-to) the per-row unseen badge.
  {
    id: 90010,
    ticket_number: 'IT-90010',
    type: 'service_request',
    status: 'open',
    priority: 'medium',
    subject: 'New starter laptop: MacBook Pro 14" for Arben',
    description: 'Arben joins the Payments team on Monday — needs the standard engineering MacBook Pro 14" build with the Jamf baseline.',
    requester_id: 'u-arben', requester_name: 'Arben Krasniqi', requester_email: 'arben@local',
    submitter_id: DEV_USER.id, submitter_name: DEV_USER.name, submitter_email: DEV_USER.email,
    created_at: ago(400), updated_at: ago(25),
    comments: [
      { id: 'c1-90010', author_name: 'IT Team', body: 'Laptop is imaged and ready — it\'ll be on Arben\'s desk Monday 9am. Can you confirm which desk he\'s sitting at?', is_internal: false, created_at: ago(60) },
      { id: 'c2-90010', author_name: 'IT Team', body: 'Also added him to the standard engineering 1Password groups while we were at it.', is_internal: false, created_at: ago(25) },
    ],
  },
  {
    id: 90006,
    ticket_number: 'IT-90006',
    type: 'service_request',
    status: 'resolved',
    priority: 'low',
    subject: 'Figma seat for Elira',
    description: 'Elira is picking up the design reviews for the portal work and needs a full Figma seat instead of a viewer one.',
    requester_id: 'u-elira', requester_name: 'Elira Hoxha', requester_email: 'elira@local',
    submitter_id: DEV_USER.id, submitter_name: DEV_USER.name, submitter_email: DEV_USER.email,
    created_at: ago(4300), updated_at: ago(4100),
    comments: [
      { id: 'c1-90006', author_name: 'IT Team', body: 'Seat upgraded — Elira has full editor access now.', is_internal: false, created_at: ago(4100) },
    ],
  },
  {
    id: 90001,
    ticket_number: 'IT-90001',
    type: 'incident',
    status: 'resolved',
    priority: 'low',
    subject: 'Jabra headset mic not picking up in CCP',
    description: 'Customers say they can hear me very faintly on Amazon Connect (CCP) calls. Speaker is fine, just the mic.',
    requester_id: DEV_USER.id, requester_name: DEV_USER.name, requester_email: DEV_USER.email,
    submitter_id: DEV_USER.id, submitter_name: DEV_USER.name, submitter_email: DEV_USER.email,
    created_at: ago(7200), updated_at: ago(6800),
    comments: [
      { id: 'c1-90001', author_name: 'IT Team', body: 'Sounds like the wrong input device is selected. In CCP → Settings, set both Microphone and Speaker to the "Jabra" USB device, not the built-in mic.', is_internal: false, created_at: ago(7000) },
      { id: 'c2-90001', author_name: 'Dev User', body: 'That was it — switched the input to the Jabra and the mic is loud and clear now. Thanks!', is_internal: false, created_at: ago(6850) },
      { id: 'c3-90001', author_name: 'IT Team', body: 'Great — marking this resolved. Reopen any time if it comes back.', is_internal: false, created_at: ago(6800) },
    ],
  },
];

// One pending approval awaiting the dev user, so the Approvals tab badge + the
// approve/reject flow are exercisable offline. Drops off when acted on.
const approvals = [
  {
    request_id: 'APR-5001',
    ticket_number: 'IT-90020',
    subject: 'Access request: Salesforce admin role',
    requester_name: 'Priya Nair',
    workflow_name: 'Access approval',
    current_stage_name: 'Manager approval',
    requested_at: ago(180),
    updated_at: ago(180),
  },
];

// Offices + per-user office membership, backing GET /locations and
// GET /locations/office-for/:userId (the office_location field type).
const locations = [
  { id: 12, name: 'New York Office', code: 'NY', country: 'United States' },
  { id: 14, name: 'London Office', code: 'LDN', country: 'United Kingdom' },
  { id: 17, name: 'Prishtina Office', code: 'PRN', country: 'Kosovo' },
];
const userOffice = { [DEV_USER.id]: 12, 'u-arben': 14, 'u-elira': 17 };

// Backing GET /agents/directory (the "Already talked to an agent?" picker).
const agentsDirectory = [
  { user_id: 'agent-dana', display_name: 'Dana Brooks' },
  { user_id: 'agent-marcus', display_name: 'Marcus Reed' },
];

// Placeholder app marks for local dev — a coloured square with a glyph, as an
// inline SVG data URI, so the catalog tiles, "Most popular" and the icon
// stacks can be previewed without network access. Not the real brand logos.
const appIcon = (bg, fg, glyph, size = 30) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/>` +
  `<text x="32" y="${32 + size * 0.36}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${size}" fill="${fg}">${glyph}</text></svg>`,
);
const simpleForm = (label = 'What do you need it for?') => [{ key: 'use_case', label, type: 'text', required: false }];

// Catalog items incl. the spec's conditional-fields example (Headset): the
// Delivery answer decides whether the office picker or the address fields show,
// and Office location is the office_location field type (dropdown + pre-select).
const catalogItems = [
  {
    id: 501,
    name: 'Headset',
    icon_url: appIcon('#211E1E', '#FDC831', '🎧', 30),
    request_count: 41,
    description: 'A Jabra Evolve2 headset, delivered to your office or home.',
    category_name: 'Hardware',
    approval_required: false,
    justify_required: false,
    request_form_fields: [
      { key: 'model', label: 'Model', type: 'select', required: true, options: ['Jabra Evolve2 40 (wired)', 'Jabra Evolve2 65 (wireless)'] },
      // Multiselect controller: "Case color" only shows while "Carrying case"
      // is among the selected accessories (spec addendum — includes-check).
      { key: 'accessories', label: 'Accessories', type: 'multiselect', options: ['Carrying case', 'Spare ear cushions', 'USB-C dongle'] },
      { key: 'case_color', label: 'Case color', type: 'select', required: true, options: ['Black', 'Sand'], show_if: { field: 'accessories', value: 'Carrying case' } },
      { key: 'delivery', label: 'Delivery', type: 'select', required: true, options: ['Office', 'Home / Remote'] },
      { key: 'office_location', label: 'Office location', type: 'office_location', required: true, show_if: { field: 'delivery', value: 'Office' } },
      { key: 'address_note', label: 'We only ship to addresses in countries where Slice has an entity.', type: 'static_text', show_if: { field: 'delivery', value: 'Home / Remote' } },
      { key: 'street', label: 'Street address', type: 'text', required: true, show_if: { field: 'delivery', value: 'Home / Remote' } },
      { key: 'city', label: 'City', type: 'text', required: true, show_if: { field: 'delivery', value: 'Home / Remote' } },
      { key: 'postcode', label: 'Postcode', type: 'text', required: true, show_if: { field: 'delivery', value: 'Home / Remote' } },
    ],
  },
  {
    id: 502,
    name: '1Password vault access',
    icon_url: appIcon('#0A6CFF', '#FFFFFF', '1', 36),
    request_count: 57,
    description: 'Access to a shared 1Password vault.',
    category_name: 'Access',
    approval_required: true,
    justify_required: true,
    request_form_fields: [
      { key: 'vault', label: 'Which vault?', type: 'text', required: true },
    ],
  },
];

// Bytes for the fixture attachments above, standing in for the module's
// content endpoint (a small generated PNG, or text).
function makePng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function devAttachmentBytes(attId) {
  for (const t of tickets) {
    const a = (t.attachments || []).find((x) => String(x.id) === String(attId));
    if (!a) continue;
    if (a.mime_type === 'image/png') return { buffer: makePng(320, 180, [253, 200, 49]), mime: 'image/png' };
    return { buffer: Buffer.from(`Fixture file ${a.file_name}\n`), mime: a.mime_type };
  }
  return null;
}

// More apps so the catalog grid, category chips and "Most popular" look like
// the real thing locally.
catalogItems.push(
  { id: 503, name: 'Slack', description: 'Join the Slice workspace, or get added to a private channel.', category_name: 'Communication', icon_url: appIcon('#4A154B', '#FFFFFF', '#', 38), request_count: 88, approval_required: false, justify_required: false, request_form_fields: simpleForm('Which channel or workspace?') },
  { id: 504, name: 'Figma', description: 'Editor seat for design files, prototypes and FigJam boards.', category_name: 'Design', icon_url: appIcon('#1E1E1E', '#A259FF', 'F', 36), request_count: 73, approval_required: true, justify_required: true, request_form_fields: simpleForm('Which team or project?') },
  { id: 505, name: 'Zoom', description: 'Licensed account for meetings over 40 minutes and webinars.', category_name: 'Communication', icon_url: appIcon('#2D8CFF', '#FFFFFF', 'Z', 36), request_count: 34, approval_required: false, justify_required: false, request_form_fields: [] },
  { id: 506, name: 'GitHub', description: 'Access to the slice-internal-tools organisation and its repos.', category_name: 'Engineering', icon_url: appIcon('#181717', '#FFFFFF', 'GH', 26), request_count: 49, approval_required: true, justify_required: true, request_form_fields: simpleForm('Which repositories?') },
  { id: 507, name: 'Jira', description: 'Board and project access for sprint planning and issue tracking.', category_name: 'Engineering', icon_url: appIcon('#0052CC', '#FFFFFF', 'J', 36), request_count: 26, approval_required: false, justify_required: false, request_form_fields: simpleForm('Which project?') },
  { id: 508, name: 'Notion', description: 'Workspace access for docs, wikis and team spaces.', category_name: 'Productivity', icon_url: appIcon('#FFFFFF', '#111111', 'N', 38), request_count: 31, approval_required: false, justify_required: false, request_form_fields: [] },
  { id: 509, name: 'Google Workspace', description: 'Shared drives, group mailboxes and calendar resources.', category_name: 'Productivity', icon_url: appIcon('#FFFFFF', '#4285F4', 'G', 38), request_count: 22, approval_required: false, justify_required: false, request_form_fields: simpleForm('Which drive, group or calendar?') },
  { id: 510, name: 'Adobe Creative Cloud', description: 'Photoshop, Illustrator, InDesign and Acrobat Pro.', category_name: 'Design', icon_url: appIcon('#DA1F26', '#FFFFFF', 'Cc', 28), request_count: 18, approval_required: true, justify_required: true, request_form_fields: simpleForm('Which apps do you need?') },
  { id: 511, name: 'Claude', description: 'Team seat for Claude — drafting, research and code.', category_name: 'Productivity', icon_url: appIcon('#D97757', '#FFFFFF', '✳', 38), request_count: 64, approval_required: true, justify_required: true, request_form_fields: simpleForm() },
  { id: 513, name: 'Salesforce Sales Cloud — Enterprise Edition (Read-only reporting)', description: 'Dashboards and reports for the revenue team; no record editing.', category_name: 'Sales', icon_url: appIcon('#00A1E0', '#FFFFFF', 'S', 36), request_count: 0, approval_required: true, justify_required: false, request_form_fields: [] },
  { id: 512, name: 'MacBook Pro 14"', description: 'Standard engineering build with the Jamf baseline.', category_name: 'Hardware', icon_url: appIcon('#E8E8ED', '#1D1D1F', '⌘', 34), request_count: 12, approval_required: true, justify_required: true, request_form_fields: [] },
);
// Point the fixture tickets at their app so the list rows show its icon.
for (const [ticketId, itemId] of [[90008, 502], [90004, 511], [90006, 504], [90010, 512], [90001, 501]]) {
  const t = tickets.find((x) => x.id === ticketId);
  if (t) t.catalog_item_id = itemId;
}

const findTicket = (idOrNum) => {
  const key = decodeURIComponent(String(idOrNum));
  return tickets.find((t) => String(t.id) === key || String(t.ticket_number) === key);
};
const ok = (data, status = 200) => ({ ok: true, status, data });
const notFound = () => ({ ok: false, status: 404, data: { error: 'Not found (dev-tickets)' } });

// Mirrors the real ticket module: talked_to_agent_id is validated against the
// agent directory and silently dropped (never fails the request) if it
// doesn't match — so a bad id in dev just yields talked_to: [].
const talkedToFromBody = (body) => {
  const agentId = body && body.talked_to_agent_id;
  if (!agentId || !agentsDirectory.some((a) => a.user_id === agentId)) return [];
  return [{ agent_id: agentId, added_by: (body && body.submitter_id) || DEV_USER.id, added_at: new Date().toISOString() }];
};

// Stand in for ticketModuleFetch(method, subPath, body) → { ok, status, data }.
export function handleDevTicket(method, subPath, body) {
  const [pathOnly, qs] = String(subPath).split('?');
  const params = new URLSearchParams(qs || '');
  const parts = pathOnly.split('/').filter(Boolean); // ['tickets'] | ['tickets', id] | ['tickets', id, 'comments'] | ['approvals','pending']

  // GET /tickets?requester_id=… | submitter_id=…  → the dev user's tickets
  if (method === 'GET' && parts[0] === 'tickets' && parts.length === 1) {
    const reqId = params.get('requester_id');
    const subId = params.get('submitter_id');
    const list = tickets.filter(
      (t) => (reqId && String(t.requester_id) === reqId) || (subId && String(t.submitter_id || '') === subId),
    );
    return ok({ tickets: list, total: list.length });
  }
  // GET /tickets/:id
  if (method === 'GET' && parts[0] === 'tickets' && parts.length === 2) {
    const t = findTicket(parts[1]);
    return t ? ok(t) : notFound();
  }
  // GET /tickets/:id/attachments
  if (method === 'GET' && parts[0] === 'tickets' && parts[2] === 'attachments' && parts.length === 3) {
    const t = findTicket(parts[1]);
    return t ? ok({ attachments: t.attachments || [] }) : notFound();
  }
  // POST /tickets  (create)
  if (method === 'POST' && parts[0] === 'tickets' && parts.length === 1) {
    const id = ++seq;
    const ts = new Date().toISOString();
    const t = {
      id,
      ticket_number: 'IT-' + id,
      type: body.type || 'incident',
      status: 'open',
      priority: body.priority || 'medium',
      subject: body.subject,
      description: body.description || '',
      requester_id: body.requester_id, requester_name: body.requester_name, requester_email: body.requester_email,
      submitter_id: body.submitter_id, submitter_name: body.submitter_name, submitter_email: body.submitter_email,
      talked_to: talkedToFromBody(body),
      created_at: ts, updated_at: ts,
      comments: [],
    };
    tickets.unshift(t);
    return ok({ status: 'created', ticket: t }, 201);
  }
  // POST /tickets/:id/comments
  if (method === 'POST' && parts[0] === 'tickets' && parts[2] === 'comments') {
    const t = findTicket(parts[1]);
    if (!t) return notFound();
    const ts = new Date().toISOString();
    const c = {
      id: `c${t.comments.length + 1}-${t.id}`,
      author_name: body.author_name || DEV_USER.name,
      body: body.body,
      is_internal: !!body.is_internal,
      created_at: ts,
    };
    t.comments.push(c);
    t.updated_at = ts;
    return ok({ status: 'ok', comment: c }, 201);
  }
  // PATCH /tickets/:id  (status changes — close/reopen)
  if (method === 'PATCH' && parts[0] === 'tickets' && parts.length === 2) {
    const t = findTicket(parts[1]);
    if (!t) return notFound();
    if (body && body.status) t.status = body.status;
    if (body && body.priority) t.priority = body.priority;
    t.updated_at = new Date().toISOString();
    return ok({ status: 'updated', ticket: t });
  }
  // GET /locations  |  GET /locations/office-for/:userId
  if (method === 'GET' && parts[0] === 'locations' && parts.length === 1) {
    return ok(locations);
  }
  if (method === 'GET' && parts[0] === 'locations' && parts[1] === 'office-for' && parts.length === 3) {
    const locId = userOffice[decodeURIComponent(parts[2])];
    return ok(locations.find((l) => l.id === locId) || null);
  }

  // GET /catalog  |  GET /catalog/:id
  if (method === 'GET' && parts[0] === 'catalog' && parts.length === 1) {
    return ok({ items: catalogItems });
  }
  if (method === 'GET' && parts[0] === 'catalog' && parts.length === 2) {
    const it = catalogItems.find((c) => String(c.id) === decodeURIComponent(parts[1]));
    return it ? ok(it) : notFound();
  }
  // POST /catalog/:id/request → a service_request ticket (pending if the item
  // needs approval), mirroring the module's envelope.
  if (method === 'POST' && parts[0] === 'catalog' && parts[2] === 'request') {
    const it = catalogItems.find((c) => String(c.id) === decodeURIComponent(parts[1]));
    if (!it) return notFound();
    const id = ++seq;
    const ts = new Date().toISOString();
    const responses = (body && body.form_responses) || {};
    const t = {
      id,
      ticket_number: 'IT-' + id,
      type: 'service_request',
      status: it.approval_required ? 'pending' : 'open',
      ...(it.approval_required ? { approval_status: 'pending' } : {}),
      priority: 'medium',
      subject: 'Request: ' + it.name,
      description: Object.entries(responses).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'),
      catalog_item_id: it.id,
      form_responses: responses,
      requester_id: body.requester_id, requester_name: body.requester_name, requester_email: body.requester_email,
      submitter_id: body.submitter_id, submitter_name: body.submitter_name, submitter_email: body.submitter_email,
      talked_to: talkedToFromBody(body),
      created_at: ts, updated_at: ts,
      comments: [],
    };
    tickets.unshift(t);
    return ok({ status: 'created', ticket: t }, 201);
  }

  // GET /agents/directory
  if (method === 'GET' && parts[0] === 'agents' && parts[1] === 'directory') {
    return ok({ agents: agentsDirectory });
  }

  // GET /approvals/pending
  if (method === 'GET' && parts[0] === 'approvals' && parts[1] === 'pending') {
    return ok({ pending: approvals });
  }
  // GET /approvals/:id
  if (method === 'GET' && parts[0] === 'approvals' && parts.length === 2 && parts[1] !== 'pending') {
    const ap = approvals.find((a) => String(a.request_id) === decodeURIComponent(parts[1]));
    if (!ap) return notFound();
    return ok({
      request: { id: ap.request_id, requested_at: ap.requested_at, updated_at: ap.updated_at },
      ticket: { ticket_number: ap.ticket_number, subject: ap.subject, requester_name: ap.requester_name },
      current_stage: { name: ap.current_stage_name, order: 1 },
      workflow: { stages: [
        { order: 1, name: 'Manager approval', type: 'role' },
        { order: 2, name: 'IT Director', type: 'role' },
      ] },
      actions: [],
      can_act: true,
    });
  }
  // POST /approvals/:id/respond  (approve/reject → drops out of the pending list)
  if (method === 'POST' && parts[0] === 'approvals' && parts[2] === 'respond') {
    const i = approvals.findIndex((a) => String(a.request_id) === decodeURIComponent(parts[1]));
    if (i >= 0) approvals.splice(i, 1);
    return ok({ status: 'ok' });
  }

  return { ok: false, status: 404, data: { error: `dev-tickets: unhandled ${method} ${subPath}` } };
}
