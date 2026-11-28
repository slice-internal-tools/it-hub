// ─── Status platform ───────────────────────────────────────────────────────
// Owns the service catalog, pollers, incidents, and HTTP routes for the
// /status surfaces (public + admin). A from-scratch StatusGator-style
// aggregator: it actually polls (and now also *receives*) status from many
// kinds of vendor source.
//
// Status sources supported:
//   - 'manual'     IT toggles state in admin; we do not poll.
//   - 'probe'      HTTP HEAD/GET against any URL — up/down by status code + latency.
//   - 'statuspage' Vendor status JSON. One parser sniffs the common shapes:
//                  Atlassian Statuspage.io summary.json (Cloudflare, GitHub,
//                  Figma, Stripe, OpenAI…), Slack's active_incidents feed,
//                  Heroku v4, Google Workspace incidents.json, and Apple's
//                  system_status — so one source covers most of the SaaS world.
//   - 'rss'        RSS / Atom incident feed (history.atom / history.rss). The
//                  newest entry's latest update drives the state. Unlocks any
//                  vendor that publishes a feed but no JSON API.
//   - 'page'       Plain web page keyword scan — degraded/down when the page
//                  mentions an outage. Last-resort for human-only status pages.
//   - 'webhook'    Push, not poll. We mint a per-service inbound URL; the
//                  vendor's Statuspage POSTs incident/component events to it in
//                  real time (see /api/status/webhook/:token).
import crypto from 'node:crypto';

// Default catalog — used the first time the server boots into an empty DB.
// Mirrors what the old localStorage mock seeded so users don't see the
// /status surface visibly reset on the deploy.
const DEFAULT_GROUPS = [
  {
    slug: 'identity', label: 'Identity & secrets',
    services: [
      { name: 'OneLogin',  vendor: 'SSO',     domain: 'onelogin.com',  source: 'manual' },
      { name: '1Password', vendor: 'Secrets', domain: '1password.com', source: 'manual' },
    ],
  },
  {
    slug: 'network', label: 'Network',
    services: [
      { name: 'Cloudflare', vendor: 'CDN / VPN', domain: 'cloudflare.com',
        source: 'statuspage', source_url: 'https://www.cloudflarestatus.com/api/v2/summary.json' },
      { name: 'GlobalProtect (Slice VPN)', vendor: 'VPN', domain: 'paloaltonetworks.com',
        source: 'manual' },
    ],
  },
  {
    slug: 'productivity', label: 'Productivity',
    services: [
      { name: 'Google Workspace', vendor: 'Mail & calendar', domain: 'workspace.google.com',
        source: 'statuspage', source_url: 'https://www.google.com/appsstatus/dashboard/incidents.json' },
      { name: 'Slack', vendor: 'Chat', domain: 'slack.com',
        source: 'statuspage', source_url: 'https://slack-status.com/api/v2.0.0/current' },
      { name: 'Zoom', vendor: 'Meetings', domain: 'zoom.us',
        source: 'statuspage', source_url: 'https://www.zoomstatus.com/api/v2/summary.json' },
    ],
  },
  {
    slug: 'dev', label: 'Build & design',
    services: [
      { name: 'GitHub', vendor: 'Source control', domain: 'github.com',
        source: 'statuspage', source_url: 'https://www.githubstatus.com/api/v2/summary.json' },
      { name: 'Figma',  vendor: 'Design', domain: 'figma.com',
        source: 'statuspage', source_url: 'https://www.figmastatus.com/api/v2/summary.json' },
    ],
  },
];

// Apps monitored on /status in addition to the seeded catalog above. Added
// idempotently at boot by ensureStatusServices (matched by name — never
// duplicates or overwrites). Verified Statuspage.io feeds get live status; the
// rest are 'manual' (visible, IT-toggled) until a per-vendor parser exists.
const MONITORED_EXTRA = [
  { name: 'Anthropic',    domain: 'anthropic.com', source: 'statuspage', source_url: 'https://status.claude.com/api/v2/summary.json' },
  { name: 'Claude',       domain: 'claude.ai',     source: 'statuspage', source_url: 'https://status.claude.com/api/v2/summary.json' },
  { name: 'Twilio',       domain: 'twilio.com',    source: 'statuspage', source_url: 'https://status.twilio.com/api/v2/summary.json' },
  { name: 'Datadog',      domain: 'datadoghq.com', source: 'statuspage', source_url: 'https://status.datadoghq.com/api/v2/summary.json' },
  { name: 'Atlassian',    domain: 'atlassian.com', source: 'statuspage', source_url: 'https://status.atlassian.com/api/v2/summary.json' },
  { name: 'Segment',      domain: 'segment.com',   source: 'statuspage', source_url: 'https://status.segment.com/api/v2/summary.json' },
  { name: 'SendGrid',     domain: 'sendgrid.com',  source: 'statuspage', source_url: 'https://status.sendgrid.com/api/v2/summary.json' },
  { name: 'Stripe',       domain: 'stripe.com',    source: 'statuspage', source_url: 'https://www.stripestatus.com/api/v2/summary.json' },
  { name: 'Jamf',         domain: 'jamf.com',      source: 'statuspage', source_url: 'https://status.jamf.com/api/v2/summary.json' },
  { name: 'Mailgun',      domain: 'mailgun.com',   source: 'statuspage', source_url: 'https://status.mailgun.com/api/v2/summary.json' },
  { name: 'GoDaddy',      domain: 'godaddy.com',   source: 'statuspage', source_url: 'https://status.godaddy.com/api/v2/summary.json' },
  { name: 'ShareFile',    domain: 'sharefile.com', source: 'statuspage', source_url: 'https://status.sharefile.com/api/v2/summary.json' },
  { name: 'Cisco Meraki', domain: 'meraki.com',    source: 'statuspage', source_url: 'https://status.meraki.net/api/v2/summary.json' },
  // Finance / back-office stack — all verified Atlassian Statuspage feeds.
  { name: 'NetSuite',     domain: 'netsuite.com',  source: 'statuspage', source_url: 'https://status.netsuite.com/api/v2/summary.json' },
  { name: 'Navan',        domain: 'navan.com',     source: 'statuspage', source_url: 'https://status.navan.com/api/v2/summary.json' },
  { name: 'Zip',          domain: 'ziphq.com',     source: 'statuspage', source_url: 'https://status.ziphq.com/api/v2/summary.json' },
  { name: 'Lob',          domain: 'lob.com',       source: 'statuspage', source_url: 'https://lob.statuspage.io/api/v2/summary.json' },
  { name: 'FloQast',      domain: 'floqast.com',   source: 'statuspage', source_url: 'https://status.floqast.com/api/v2/summary.json' },
  // No clean machine-readable feed yet → manual (IT toggles). Real auto-status
  // for these needs a per-vendor parser (AWS Health / Google / Apple formats).
  { name: 'AWS',               domain: 'aws.amazon.com',      source: 'manual' },
  { name: 'App Store Connect', domain: 'developer.apple.com', source: 'manual' },
  { name: 'OneLogin EU',       domain: 'onelogin.com',        source: 'manual' },
  { name: 'Adyen',             domain: 'adyen.com',           source: 'manual' },
  { name: 'PayPal',            domain: 'paypal.com',          source: 'manual' },
  { name: 'Chowly',            domain: 'chowly.com',          source: 'manual' },
];

// Idempotently add MONITORED_EXTRA to the live catalog (matched by name — never
// duplicates or overwrites admin rows). New entries land in a "More services"
// group. Also repoints Zoom to its current feed.
export async function ensureStatusServices(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let gr = await client.query(`SELECT id FROM status_groups WHERE slug = 'more'`);
    let groupId = gr.rows[0] && gr.rows[0].id;
    if (!groupId) {
      const ins = await client.query(
        `INSERT INTO status_groups (slug, label, position) VALUES ('more', 'More services', 99) RETURNING id`,
      );
      groupId = ins.rows[0].id;
    }
    let added = 0;
    for (const s of MONITORED_EXTRA) {
      const ex = await client.query(`SELECT 1 FROM status_services WHERE lower(name) = lower($1) LIMIT 1`, [s.name]);
      if (ex.rowCount) continue;
      await client.query(
        `INSERT INTO status_services (group_id, name, vendor, domain, source, source_url, position)
         VALUES ($1, $2, NULL, $3, $4, $5, 0)`,
        [groupId, s.name, s.domain || null, s.source || 'manual', s.source_url || null],
      );
      added++;
    }
    // Zoom moved its feed off status.zoom.us → repoint if a live row is stale.
    await client.query(
      `UPDATE status_services SET source_url = 'https://www.zoomstatus.com/api/v2/summary.json'
        WHERE name = 'Zoom' AND source_url LIKE '%status.zoom.us%'`,
    );
    await client.query('COMMIT');
    console.log(`[status] ensured monitored services (+${added} new)`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[status] ensure failed:', e.message);
  } finally {
    client.release();
  }
}

export async function bootstrapStatusServices(pool) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM status_services');
  if (rows[0].n > 0) return; // already seeded — never overwrite live data
  console.log('[status] seeding default service catalog');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let gi = 0; gi < DEFAULT_GROUPS.length; gi++) {
      const g = DEFAULT_GROUPS[gi];
      const gr = await client.query(
        `INSERT INTO status_groups (slug, label, position) VALUES ($1, $2, $3) RETURNING id`,
        [g.slug, g.label, gi],
      );
      const groupId = gr.rows[0].id;
      for (let si = 0; si < g.services.length; si++) {
        const s = g.services[si];
        await client.query(
          `INSERT INTO status_services (group_id, name, vendor, domain, source, source_url, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [groupId, s.name, s.vendor || null, s.domain || null, s.source || 'manual', s.source_url || null, si],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[status] seed failed:', e.message);
  } finally {
    client.release();
  }
}

// ── Pollers ────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 6000;
const PROBE_DEGRADED_MS = 2500;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Release a response body we don't need to read, so a server that returns a
// body on HEAD (or the GET fallback) doesn't leave a socket dangling.
function drain(r) {
  try { r.body?.cancel?.(); } catch { /* already consumed / no body */ }
}

// Defense-in-depth: source_url is admin-set, but never let the poller be aimed
// at loopback / link-local / private ranges or non-HTTP schemes. Returns an
// error string when the URL should not be fetched, or null when it's allowed.
const PRIVATE_IP_RE = /^(?:127\.|10\.|169\.254\.|192\.168\.|::1$|fe80:|fc00:|fd00:|172\.(?:1[6-9]|2\d|3[01])\.)/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
function probeUrlBlockedReason(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'invalid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http/https allowed';
  // Strip the [..] wrapper URL uses for IPv6 literals so [::1] tests as ::1.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return 'internal host blocked';
  // Only apply the private-range test to actual IP literals — otherwise a public
  // domain that merely starts with "10." (e.g. 10.example.com) would be blocked.
  const isIpLiteral = IPV4_RE.test(host) || host.includes(':');
  if (isIpLiteral && PRIVATE_IP_RE.test(host)) return 'private/loopback address blocked';
  return null;
}

async function probeHttp(service) {
  if (!service.source_url) {
    return { state: 'down', error: 'no source_url configured' };
  }
  const blocked = probeUrlBlockedReason(service.source_url);
  if (blocked) return { state: 'down', error: blocked };
  const t0 = Date.now();
  try {
    // HEAD first — many vendor status pages refuse HEAD, so fall back to GET.
    let r = await fetchWithTimeout(service.source_url, { method: 'HEAD' });
    if (r.status === 405 || r.status === 501 || r.status === 403) {
      drain(r);
      r = await fetchWithTimeout(service.source_url, { method: 'GET' });
    }
    const dt = Date.now() - t0;
    // 5xx = down. 408/429 (overloaded) and most 4xx = degraded. 401/403 mean the
    // endpoint is up but auth-gated, so they count as operational — a healthy
    // service behind auth shouldn't read as "degraded" forever. Slow = degraded.
    let state = 'operational';
    if (r.status >= 500) state = 'down';
    else if (r.status === 408 || r.status === 429) state = 'degraded';
    else if (r.status >= 400 && r.status !== 401 && r.status !== 403) state = 'degraded';
    else if (dt >= PROBE_DEGRADED_MS) state = 'degraded';
    drain(r);
    return { state, response_ms: dt, http_status: r.status };
  } catch (err) {
    return { state: 'down', error: err.message || 'fetch failed' };
  }
}

// ── Text helpers (shared by the JSON, feed, and page parsers) ────────────────
// Minimal, dependency-free XML/HTML decoding. Status feeds are small and well
// behaved, so a tolerant string parser beats pulling in an XML library.
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/gi, '&'); // last, so "&amp;lt;" doesn't double-decode
}
function stripTags(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function firstLine(s) {
  const t = stripTags(s);
  const i = t.search(/[.\n]/);
  return (i > 0 ? t.slice(0, i) : t).slice(0, 160);
}

// True when a parsed JSON body looks like one of the vendor status shapes we
// understand — used by the auto-detect resolver to pick 'statuspage'.
function looksLikeStatusJson(j) {
  if (!j || typeof j !== 'object') return false;
  if (Array.isArray(j)) return j.length > 0 && j[0] && ('service_name' in j[0] || 'external_desc' in j[0] || 'status_impact' in j[0]);
  if (j.status && typeof j.status === 'object' && 'indicator' in j.status) return true;
  if (Array.isArray(j.status)) return true;
  if (Array.isArray(j.active_incidents)) return true;
  if (Array.isArray(j.components)) return true;
  if (Array.isArray(j.services) && j.services[0] && 'events' in j.services[0]) return true;
  return false;
}

// Google Workspace appsstatus — a bare ARRAY of incidents. Ongoing ones have a
// null/absent `end`; severity is low|medium|high and status_impact carries words
// like SERVICE_OUTAGE / SERVICE_DISRUPTION.
function parseGoogleIncidents(arr) {
  const ongoing = arr.filter((i) => i && (i.end == null || i.end === ''));
  if (!ongoing.length) return { state: 'operational' };
  const sev = ongoing.map((i) => {
    const s = String(i.severity || '').toLowerCase();
    const impact = String(i.status_impact || '').toLowerCase();
    if (s === 'high' || /outage/.test(impact)) return 2;
    return 1; // medium/low/disruption → degraded
  });
  const first = ongoing[0];
  const note = `${first.service_name ? first.service_name + ': ' : ''}${firstLine(first.external_desc) || 'Ongoing incident'}`;
  return { state: Math.max(...sev) >= 2 ? 'down' : 'degraded', state_note: note };
}

// Apple system_status — { services: [ { serviceName, events: [ … ] } ] }. The
// JSON is loose, so treat any service carrying an unresolved issue event as bad.
function parseAppleServices(services) {
  const bad = [];
  for (const s of services) {
    const events = Array.isArray(s.events) ? s.events : [];
    for (const e of events) {
      const msgType = String(e.messageType || e.eventStatus || '').toLowerCase();
      const ongoing = !e.epochEndDate && !/resolved|completed/.test(msgType);
      const blob = `${msgType} ${String(e.statusType || '')} ${String(e.message || '')}`.toLowerCase();
      if (ongoing && /(outage|issue|degrad|disrupt|unavailable)/.test(blob)) {
        bad.push({ name: s.serviceName || 'Service', outage: /outage|unavailable/.test(blob) });
      }
    }
  }
  if (!bad.length) return { state: 'operational' };
  return { state: bad.some((b) => b.outage) ? 'down' : 'degraded', state_note: bad[0].name };
}

// Pull StatusGator-style detail out of a Statuspage summary.json: the active
// incident's headline (message), its latest update text (details), and the
// impacted component names. summary.json lists only UNRESOLVED incidents, so
// incidents[0] is the current one and incident_updates[0] its newest update.
// Purely descriptive — never affects the computed state; used to enrich Slack
// alerts only (state_note / status page / incidents stay exactly as they are).
function statuspageDetail(json, filter) {
  const clamp = (s, n) => { const t = stripTags(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  // When a region filter is set, scope the "Affected" component list to it too.
  const terms = String(filter || '').toLowerCase().split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const inScope = (name) => !terms.length || terms.some((t) => String(name).toLowerCase().includes(t));
  const inc = Array.isArray(json?.incidents) ? json.incidents[0] : null;
  const message = inc && inc.name ? clamp(inc.name, 160) : null;
  const ups = inc && Array.isArray(inc.incident_updates) ? inc.incident_updates : [];
  const details = ups[0] && ups[0].body ? clamp(ups[0].body, 300) : null;
  const impacted = (s) => s && s !== 'operational' && !/maintenance/i.test(s);
  let components = (Array.isArray(json?.components) ? json.components : [])
    .filter((c) => c && impacted(c.status) && inScope(c.name)).map((c) => c.name);
  if (!components.length && inc && Array.isArray(inc.components)) {
    components = inc.components.map((c) => c && c.name).filter((n) => inScope(n));
  }
  components = [...new Set(components.map((n) => stripTags(n)).filter(Boolean))].slice(0, 10);
  return { message, details, components };
}

// Vendor status JSON → effective state. Sniffs the shape and dispatches. Covers
// Atlassian Statuspage.io, Slack, Heroku v4, Google Workspace, and Apple.
// `filter` (a service's match_filter) optionally region-scopes statuspage eval.
function parseStatusJson(json, filter) {
  if (!json || typeof json !== 'object') return { state: 'operational' };

  // Google Workspace — top-level array of incidents.
  if (Array.isArray(json)) return parseGoogleIncidents(json);

  // Slack — { status:"ok"|"active", active_incidents:[ {title,status,services} ] }.
  // FIX: the old code treated status:"active" as healthy. The real signal is
  // active_incidents — a non-empty list of unresolved incidents means trouble.
  if (Array.isArray(json.active_incidents)) {
    const live = json.active_incidents.filter((i) => String(i && i.status || '').toLowerCase() !== 'resolved');
    if (!live.length) return { state: 'operational' };
    const blob = live.map((i) => `${i.title || i.name || ''} ${i.type || ''}`).join(' ').toLowerCase();
    const down = /outage|unavailable|down/.test(blob);
    return { state: down ? 'down' : 'degraded', state_note: live[0].title || live[0].name || 'Active incident reported' };
  }

  // Heroku v4 — { status: [ { system, status:"green"|"yellow"|"red" }, … ] }.
  if (Array.isArray(json.status)) {
    const colors = json.status.map((c) => String(c && c.status || '').toLowerCase());
    if (colors.includes('red'))    return { state: 'down', state_note: 'Vendor reports a major outage' };
    if (colors.some((c) => c === 'yellow' || c === 'orange')) return { state: 'degraded', state_note: 'Vendor reports degraded service' };
    return { state: 'operational' };
  }

  // Apple — { services: [ { serviceName, events:[…] } ] }.
  if (Array.isArray(json.services) && json.services[0] && 'events' in json.services[0]) {
    return parseAppleServices(json.services);
  }

  // Atlassian Statuspage.io summary.json — { status:{ indicator, description } }.
  // When the top-level indicator is clean, fall back to the worst component so a
  // partial outage that hasn't tripped the overall indicator still shows.
  const indicator = json?.status?.indicator;
  let description = json?.status?.description || null;
  // StatusGator-style extras (incident headline / latest update / impacted
  // components) for the Slack alert only — never affects state or state_note,
  // so the status page and incidents are untouched.
  const sp = statuspageDetail(json, filter);

  // Region scope (match_filter): when set, derive state from ONLY the components
  // whose name matches a term — ignoring the global indicator, which spans every
  // region. So e.g. NetSuite filtered to "Chicago" won't alert on a Frankfurt-only
  // outage. If the filter matches NO components (typo, or a vendor with no
  // per-region components), fall through to the unfiltered checks so it can't go blind.
  const fterms = String(filter || '').toLowerCase().split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (fterms.length) {
    const matched = (Array.isArray(json.components) ? json.components : [])
      .filter((c) => c && c.name && fterms.some((t) => c.name.toLowerCase().includes(t)));
    if (matched.length) {
      const mbad = matched.filter((c) => c.status && c.status !== 'operational' && !/_maintenance$/.test(c.status));
      const mmajor = mbad.find((c) => /major_outage/.test(c.status));
      if (mmajor)      return { state: 'down',     state_note: `${mmajor.name}: major outage`, ...sp };
      if (mbad.length) return { state: 'degraded', state_note: `${mbad[0].name}: ${mbad[0].status.replace(/_/g, ' ')}`, ...sp };
      return { state: 'operational', state_note: description };
    }
    // no component matched the filter → fall through to the unfiltered checks below
  }

  if (indicator === 'minor')                             return { state: 'degraded', state_note: description, ...sp };
  if (indicator === 'major' || indicator === 'critical') return { state: 'down', state_note: description, ...sp };
  if (indicator === 'none' || indicator == null) {
    const comps = Array.isArray(json.components) ? json.components : [];
    const bad = comps.filter((c) => c && c.status && c.status !== 'operational' && !/_maintenance$/.test(c.status));
    // Only a *major* outage is "down". partial_outage / degraded_performance are
    // "degraded" — never escalate a partial impact to a full outage in alerts.
    const major = bad.find((c) => /major_outage/.test(c.status));
    if (major) return { state: 'down', state_note: `${major.name}: major outage`, ...sp };
    if (bad.length) return { state: 'degraded', state_note: `${bad[0].name}: ${bad[0].status.replace(/_/g, ' ')}`, ...sp };
    return { state: 'operational', state_note: description };
  }
  return { state: 'operational', state_note: description };
}

// We couldn't READ a vendor's status (network error, timeout, HTTP error, bad
// payload). That says nothing about the vendor — it used to be recorded as
// Down/Degraded, so every blip on our side became a Slack "X is down" alert a
// few minutes before "X has recovered" (and Chowly flip-flopped down↔degraded).
// applyState keeps the last known state for these and only records the error.
// HTTP probes (source 'probe') are different — they test the service itself,
// so no answer there still means down.
function unreadable(error, extra = {}) {
  return { unreadable: true, error: error || 'check failed', ...extra };
}

async function probeStatuspage(service) {
  if (!service.source_url) return unreadable('no source_url configured');
  const blocked = probeUrlBlockedReason(service.source_url);
  if (blocked) return unreadable(blocked);
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(service.source_url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Slice-IT-Hub/1.0 status-poller' },
    });
    const dt = Date.now() - t0;
    if (!r.ok) {
      drain(r);
      return unreadable(`HTTP ${r.status}`, { response_ms: dt, http_status: r.status });
    }
    const json = await r.json();
    const parsed = parseStatusJson(json, service.match_filter);
    return { ...parsed, response_ms: dt, http_status: r.status };
  } catch (err) {
    return unreadable(err.message || 'fetch failed');
  }
}

// ── RSS / Atom incident feeds ────────────────────────────────────────────────
// StatusGator's core trick: most status pages publish a history feed even when
// they have no JSON API. We read the newest entries and infer current state from
// the latest update line. Statuspage feeds put the most-recent update FIRST in
// the entry body, wrapped in <strong>…</strong> (e.g. "<strong>Resolved</strong>
// - …"), so that word is the current status of that incident.
const FEED_ACTIVE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // only entries < 3 days old count as "active"

function feedTag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

// Parse RSS <item>s or Atom <entry>s into { title, date, content } records,
// newest-first as the feed presents them (capped so a huge feed can't blow up).
function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) && out.length < 25) {
    const block = m[0];
    const title = stripTags(feedTag(block, ['title']));
    const dateRaw = isAtom ? feedTag(block, ['updated', 'published']) : feedTag(block, ['pubDate', 'updated', 'dc:date']);
    const d = new Date(stripTags(dateRaw));
    // Keep the raw (entity-decoded but tag-bearing) body so we can read <strong>.
    const content = decodeEntities(isAtom ? feedTag(block, ['content', 'summary']) : feedTag(block, ['description', 'content:encoded', 'summary']));
    out.push({ title, date: Number.isNaN(d.getTime()) ? null : d, content });
  }
  return out;
}

// Be conservative about "down": only a clearly-major/complete outage or an
// explicit "is down/unavailable" counts. A bare or partial "outage", a
// "disruption", etc. are degraded — don't over-escalate to a full outage.
const FEED_DOWN_RE = /\b(major outage|complete outage|total outage|service unavailable|is down|are down|are unavailable)\b/;
const FEED_DEGRADED_RE = /\b(investigating|identified|monitoring|degraded|degradation|elevated|partial|disruption|outage|errors?|latency|slow|impact(ed|ing)?)\b/;
const FEED_RESOLVED_RE = /\b(resolved|completed|operational|recovered|back to normal)\b/;

function classifyFeed(items, filter) {
  if (!items.length) return { state: 'operational' };
  const sorted = items.slice().sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
  const now = Date.now();
  // Only entries inside the active window count. If EVERY dated entry is older
  // than that, nothing is current → operational. (Previously we fell back to the
  // single newest stale entry, which made AWS's all.rss — whose latest items are
  // weeks-old resolved incidents — read as a perpetual "degraded".)
  let scan = sorted.filter((it) => !it.date || (now - it.date.getTime()) <= FEED_ACTIVE_WINDOW_MS);
  // Optional scope filter (e.g. "us-east-1, us-east-2"): for a broad aggregate
  // feed like AWS all.rss, only consider entries that mention one of these terms,
  // so an incident in a region/service you don't use never fires.
  const terms = String(filter || '').toLowerCase().split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (terms.length) {
    scan = scan.filter((it) => {
      const t = `${it.title} ${stripTags(it.content)}`.toLowerCase();
      return terms.some((term) => t.includes(term));
    });
  }
  if (!scan.length) return { state: 'operational' };
  for (const it of scan) {
    // The first <strong> is the most-recent update label on Statuspage feeds.
    const head = ((it.content.match(/<strong>\s*([^<]+?)\s*<\/strong>/i) || [])[1] || it.title || '').toLowerCase();
    const title = (it.title || '').toLowerCase();
    const text = `${head} ${title} ${stripTags(it.content)}`.toLowerCase();
    // Resolved when the latest update label says so (Statuspage puts it in the
    // body as <strong>Resolved</strong>) OR the entry title is marked resolved
    // (Google prefixes its <title> with "RESOLVED:"). Either → this incident is
    // over, move on to older ones.
    if (FEED_RESOLVED_RE.test(head) || /\b(resolved|completed|recovered)\b/.test(title)) continue;
    // Maintenance, scheduled OR in progress: Statuspage only labels it
    // "Scheduled" before it starts — once running the label is "In progress"
    // and the word lives in the title (Twilio "… SMS Carrier Maintenance").
    if ((/\b(maintenance|scheduled)\b/.test(head) || /\bmaintenance\b/.test(title)) && !FEED_DOWN_RE.test(text)) continue;
    // Prefer the entry title, but many feeds (AWS) leave it blank and put the
    // detail in the body — fall back to the first line of the content so the
    // alert carries real information instead of a generic "incident".
    const note = it.title || firstLine(it.content) || null;
    if (FEED_DOWN_RE.test(text))     return { state: 'down', state_note: note || 'Outage reported' };
    if (FEED_DEGRADED_RE.test(text)) return { state: 'degraded', state_note: note || 'Incident reported' };
    return { state: 'degraded', state_note: note || 'Active incident' }; // unresolved + recent, unknown words
  }
  return { state: 'operational' };
}

async function probeFeed(service) {
  if (!service.source_url) return unreadable('no source_url configured');
  const blocked = probeUrlBlockedReason(service.source_url);
  if (blocked) return unreadable(blocked);
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(service.source_url, {
      method: 'GET',
      headers: {
        'Accept': 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        'User-Agent': 'Slice-IT-Hub/1.0 status-poller',
      },
    });
    const dt = Date.now() - t0;
    if (!r.ok) { drain(r); return unreadable(`HTTP ${r.status}`, { response_ms: dt, http_status: r.status }); }
    const xml = (await r.text()).slice(0, 500_000);
    const parsed = classifyFeed(parseFeed(xml), service.match_filter);
    return { ...parsed, response_ms: dt, http_status: r.status };
  } catch (err) {
    return unreadable(err.message || 'fetch failed');
  }
}

// ── Plain-page keyword scan ──────────────────────────────────────────────────
// Last resort for vendors with only a human-readable status page. Coarse by
// design: strip tags, then look for outage / degraded phrasing.
const PAGE_DOWN_RE = /(major outage|complete outage|service unavailable|all systems down|is currently down)/;
const PAGE_DEGRADED_RE = /(degraded|partial outage|partial service|some (users|customers)|elevated errors?|increased errors?|investigating|identified|monitoring|service disruption|intermittent|slow performance)/;

async function probePage(service) {
  if (!service.source_url) return unreadable('no source_url configured');
  const blocked = probeUrlBlockedReason(service.source_url);
  if (blocked) return unreadable(blocked);
  const t0 = Date.now();
  try {
    let r = await fetchWithTimeout(service.source_url, { method: 'GET', headers: { 'User-Agent': 'Slice-IT-Hub/1.0 status-poller', 'Accept': 'text/html,*/*' } });
    const dt = Date.now() - t0;
    if (!r.ok && r.status !== 401 && r.status !== 403) { drain(r); return unreadable(`HTTP ${r.status}`, { response_ms: dt, http_status: r.status }); }
    const text = stripTags((await r.text()).slice(0, 300_000)).toLowerCase();
    if (PAGE_DOWN_RE.test(text))     return { state: 'down', state_note: 'Status page reports an outage', response_ms: dt, http_status: r.status };
    if (PAGE_DEGRADED_RE.test(text)) return { state: 'degraded', state_note: 'Status page reports degraded service', response_ms: dt, http_status: r.status };
    return { state: 'operational', response_ms: dt, http_status: r.status };
  } catch (err) {
    return unreadable(err.message || 'fetch failed');
  }
}

// ── Auto-detect ──────────────────────────────────────────────────────────────
// Given any status URL an admin pasted, figure out the best machine-readable
// source: a Statuspage JSON, an Atom/RSS feed, or (failing that) a page scan.
async function resolveSource(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { error: 'invalid URL' }; }
  const blocked = probeUrlBlockedReason(u.href);
  if (blocked) return { error: blocked };

  // Candidates, in priority order: the pasted URL (honoring its extension), then
  // sibling files in the SAME directory — this is what makes sub-path dashboards
  // like Google's /appsstatus/dashboard/incidents.json resolve — then the
  // origin-root Statuspage.io conventions.
  const origin = u.origin;
  const dir = u.href.replace(/[^/]*(\?.*)?$/, ''); // strip filename + query → ".../"
  const path = u.pathname.toLowerCase();
  const cands = [];
  const json = (url) => cands.push({ kind: 'json', url });
  const feed = (url) => cands.push({ kind: 'feed', url });
  if (/\.json(\?|$)/.test(path)) json(u.href);
  // .rss/.atom/.xml extension, OR a path ending in /rss, /atom, /feed (no dot —
  // e.g. OneLogin's /pages/<id>/rss) → it's a feed.
  else if (/\.(atom|rss|xml)(\?|$)|\/(rss|atom|feed)\/?(\?|$)/.test(path)) feed(u.href);
  else { json(u.href); feed(u.href); }
  ['incidents.json', 'summary.json', 'status.json'].forEach((f) => json(dir + f));
  ['feed.atom', 'en/feed.atom', 'history.atom', 'history.rss'].forEach((f) => feed(dir + f));
  json(`${origin}/api/v2/summary.json`);
  feed(`${origin}/history.atom`);
  feed(`${origin}/history.rss`);
  const seen = new Set();
  const candidates = cands.filter((c) => !seen.has(c.url) && seen.add(c.url));

  for (const c of candidates) {
    try {
      const r = await fetchWithTimeout(c.url, {
        method: 'GET',
        headers: { 'Accept': c.kind === 'json' ? 'application/json' : 'application/atom+xml, application/xml, */*', 'User-Agent': 'Slice-IT-Hub/1.0 status-detect' },
        timeoutMs: 8000,
      });
      if (!r.ok) { drain(r); continue; }
      const body = await r.text();
      if (body.length > 8_000_000) continue; // sanity cap; don't choke on a huge doc
      if (c.kind === 'json') {
        // Parse the FULL body — vendor feeds can be large (Google's incidents.json
        // is ~420 KB); truncating it first makes JSON.parse fail and mislabels it.
        try { if (looksLikeStatusJson(JSON.parse(body))) return { source: 'statuspage', source_url: c.url }; } catch { /* not json */ }
      } else if (/<rss\b|<feed\b|<entry\b|<item\b/i.test(body.slice(0, 100_000))) {
        return { source: 'rss', source_url: c.url };
      }
    } catch { /* try next candidate */ }
  }
  // Nothing machine-readable found — fall back to a keyword scan of the page.
  return { source: 'page', source_url: u.href };
}

// How many consecutive agreeing readings we need before flipping the effective
// state. With a 60s cadence this rides out a single transient blip (a one-off
// timeout won't show the whole company a red banner) but confirms a real change
// within ~2 minutes. This is the flap-resistance an industry monitor expects.
const CONFIRM_SAMPLES = 2;
// Recovery (bad → operational) must hold this many consecutive samples before we
// declare it resolved + post the "recovered" alert. Longer than CONFIRM_SAMPLES so
// a flapping vendor (bouncing degraded↔operational every few minutes) stays ONE
// ongoing incident with ONE alert, instead of re-alerting on every blip back.
const RECOVER_SAMPLES = 5; // ~5 min at the 60s poll cadence

async function pollOne(pool, service) {
  // manual / webhook / render services aren't polled by the hub — their state is
  // admin-set (manual) or pushed in via the inbound webhook (webhook = the vendor,
  // render = our headless render worker). We still record a heartbeat sample of
  // the current state each pass so there's a recent check on file (the admin
  // Probes view reads these).
  if (service.source === 'manual' || service.source === 'webhook' || service.source === 'render') {
    await pool.query(
      `INSERT INTO status_checks (service_id, state) VALUES ($1, $2)`,
      [service.id, service.state],
    );
    return;
  }
  const observed =
    service.source === 'statuspage' ? await probeStatuspage(service) :
    service.source === 'rss'        ? await probeFeed(service) :
    service.source === 'page'       ? await probePage(service) :
    service.source === 'probe'      ? await probeHttp(service) :
    null;
  if (!observed) return;
  await applyState(pool, service, observed);
}

// Record the raw observation, then promote it to the effective state only once
// CONFIRM_SAMPLES consecutive readings agree. On a confirmed transition, open or
// resolve an auto-incident so monitoring drives the public timeline.
async function applyState(pool, service, observed) {
  if (observed.unreadable) {
    // Couldn't read the vendor's status: log the attempt with the LAST KNOWN
    // state (status_checks only allows operational/degraded/down, and the
    // public uptime bars read it) plus the error, so the admin's Health line
    // shows the failure. No state change, no incident, no Slack alert.
    await pool.query(
      `INSERT INTO status_checks (service_id, state, response_ms, http_status, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [service.id, service.state, observed.response_ms || null, observed.http_status || null, observed.error],
    );
    await pool.query(
      `UPDATE status_services SET last_checked_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $1`,
      [service.id, observed.error],
    );
    return;
  }
  await pool.query(
    `INSERT INTO status_checks (service_id, state, response_ms, http_status, error)
     VALUES ($1, $2, $3, $4, $5)`,
    [service.id, observed.state, observed.response_ms || null, observed.http_status || null, observed.error || null],
  );

  // Asymmetric confirmation: a bad→operational recovery must hold RECOVER_SAMPLES
  // consecutive readings; everything else confirms at CONFIRM_SAMPLES. This damps
  // flapping vendors — short blips back to operational don't flip the effective
  // state, so we don't re-open/re-alert. One alert when it breaks, one when stable.
  const recovering = observed.state === 'operational' && service.state !== 'operational';
  const needed = recovering ? RECOVER_SAMPLES : CONFIRM_SAMPLES;
  const recent = await pool.query(
    `SELECT state FROM status_checks WHERE service_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [service.id, needed],
  );
  const confirmed =
    recent.rows.length >= needed && recent.rows.every((r) => r.state === observed.state);
  const effective = confirmed ? observed.state : service.state;
  // Operational → no note. If the effective state matches what we just observed,
  // use the fresh note. If we're holding a prior (still-bad) state because the
  // new reading isn't confirmed yet, keep the prior note rather than blanking it.
  const note = effective === 'operational'
    ? null
    : (effective === observed.state ? (observed.state_note || null) : (service.state_note || null));

  await pool.query(
    `UPDATE status_services
        SET state = $2, state_note = $3, response_ms = $4,
            last_checked_at = NOW(), last_error = $5, updated_at = NOW()
      WHERE id = $1`,
    [service.id, effective, note, observed.response_ms || null, observed.error || null],
  );

  if (effective !== service.state) {
    // Carry the fresh note + the StatusGator-style extras (statuspage only) into
    // the alert. `note` is the just-computed note; observed.* are the parse extras.
    await handleAutoIncident(pool, service, service.state, effective, {
      note,
      message: observed.message,
      details: observed.details,
      components: observed.components,
    });
  }
}

const isBadState = (s) => s === 'degraded' || s === 'down';
const severityForState = (s) => (s === 'down' ? 'major' : 'minor');
const capitalize = (s) => { const t = String(s || ''); return t ? t[0].toUpperCase() + t.slice(1) : t; };

// Open a fresh auto-incident for a service, or escalate/append to the one that's
// already open. Returns { opened, incidentId }. Shared by the poller and the
// inbound webhook so both converge on a single incident per service.
async function raiseAutoIncident(pool, service, { toState, severity, body } = {}) {
  const open = await pool.query(
    `SELECT id FROM status_incidents
      WHERE service_id = $1 AND auto_created = true AND resolved_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [service.id],
  );
  const openId = open.rows[0]?.id;
  if (!openId) {
    const inc = await pool.query(
      `INSERT INTO status_incidents (service_id, title, severity, state, auto_created)
       VALUES ($1, $2, $3, 'investigating', true) RETURNING id`,
      [service.id, `${service.name} is ${toState}`, severity || severityForState(toState)],
    );
    await pool.query(
      `INSERT INTO status_incident_updates (incident_id, label, body) VALUES ($1, 'Identified', $2)`,
      [inc.rows[0].id, body || `Automated monitoring detected ${service.name} is ${toState}. The IT Team has been alerted.`],
    );
    return { opened: true, incidentId: inc.rows[0].id };
  }
  await pool.query(
    `UPDATE status_incidents SET severity = $2, updated_at = NOW() WHERE id = $1`,
    [openId, severity || severityForState(toState)],
  );
  await pool.query(
    `INSERT INTO status_incident_updates (incident_id, label, body) VALUES ($1, 'Update', $2)`,
    [openId, body || `${service.name} status changed to ${toState}.`],
  );
  return { opened: false, incidentId: openId };
}

// Resolve the open auto-incident for a service, if any. Returns its id or null.
async function clearAutoIncident(pool, service, { body } = {}) {
  const open = await pool.query(
    `SELECT id FROM status_incidents
      WHERE service_id = $1 AND auto_created = true AND resolved_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [service.id],
  );
  const openId = open.rows[0]?.id;
  if (!openId) return null;
  await pool.query(
    `UPDATE status_incidents SET state = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [openId],
  );
  await pool.query(
    `INSERT INTO status_incident_updates (incident_id, label, body) VALUES ($1, 'Resolved', $2)`,
    [openId, body || `Automated monitoring sees ${service.name} back to operational.`],
  );
  return openId;
}

// React to a confirmed state transition on a polled service: open/escalate or
// resolve the auto-incident, and fire the matching Slack alert. Only auto-created
// incidents are touched here — admin-authored ones are never mutated. (This is
// only ever called on an actual change, so fromState !== toState.)
async function handleAutoIncident(pool, service, fromState, toState, alert = {}) {
  if (isBadState(toState)) {
    const severity = severityForState(toState);
    const res = await raiseAutoIncident(pool, service, { toState, severity });
    if (await slackEventEnabled(pool, 'down')) {
      await notifyServiceAlert(pool, service, {
        state: toState, severity,
        // Fresh note (fixes the prior stale/empty note) + StatusGator-style extras.
        note: alert.note != null ? alert.note : service.state_note,
        message: alert.message, details: alert.details, components: alert.components,
        kind: res.opened ? 'opened' : 'changed',
      });
    }
  } else {
    const id = await clearAutoIncident(pool, service);
    if (id && await slackEventEnabled(pool, 'recovery')) {
      await notifyServiceAlert(pool, service, { state: 'operational', kind: 'recovery' });
    }
  }
}

// ── Inbound webhook ingest ───────────────────────────────────────────────────
// Map an Atlassian-Statuspage webhook payload to an effective state + an update
// note. Statuspage sends two event shapes — incident_update (has `incident`) and
// component_update (has `component`) — plus an unsigned validation ping on
// subscribe, which we treat as a no-op (returns null).
function parseStatuspageWebhook(body) {
  if (!body || typeof body !== 'object') return null;

  if (body.incident && typeof body.incident === 'object') {
    const inc = body.incident;
    const status = String(inc.status || '').toLowerCase(); // investigating|identified|monitoring|resolved|postmortem
    const impact = String(inc.impact || inc.impact_override || '').toLowerCase(); // none|minor|major|critical
    const updates = Array.isArray(inc.incident_updates) ? inc.incident_updates : [];
    const latest = updates[0] || {};
    const resolved = status === 'resolved' || status === 'completed' || status === 'postmortem';
    const state = resolved ? 'operational' : (impact === 'critical' || impact === 'major') ? 'down' : 'degraded';
    const severity = impact === 'critical' ? 'critical' : impact === 'major' ? 'major' : 'minor';
    return {
      state, severity,
      note: stripTags(inc.name || '') || 'Incident',
      body: stripTags(latest.body || inc.name || '') || `${inc.name || 'Incident'} — ${status}`,
      label: capitalize(status) || 'Update',
    };
  }

  if (body.component && typeof body.component === 'object') {
    const c = body.component;
    const st = String((body.component_update && body.component_update.new_status) || c.status || '').toLowerCase();
    const state = /major_outage/.test(st) ? 'down'
      : /partial_outage|degraded_performance/.test(st) ? 'degraded'
      : 'operational'; // operational / under_maintenance / unknown → operational
    const human = st.replace(/_/g, ' ');
    return {
      state, severity: severityForState(state),
      note: `${c.name || 'Component'}: ${human}`,
      body: `${c.name || 'Component'} is now ${human}.`,
      label: state === 'operational' ? 'Resolved' : 'Update',
    };
  }

  return null; // validation ping / shape we don't handle
}

// Apply a parsed webhook event. Pushes are authoritative (no confirm window):
// update state immediately, record a sample, drive the incident timeline with
// the vendor's own wording, and alert Slack.
async function ingestWebhookEvent(pool, service, ev) {
  const fromState = service.state;
  const toState = ev.state;

  await pool.query(`INSERT INTO status_checks (service_id, state) VALUES ($1, $2)`, [service.id, toState]);
  await pool.query(
    `UPDATE status_services
        SET state = $2, state_note = $3, last_checked_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [service.id, toState, toState === 'operational' ? null : (ev.note || null)],
  );

  if (toState === fromState) {
    // No state change. Keep an open incident's timeline live with the vendor's
    // latest note (e.g. "Monitoring" while still degraded) — but DEDUPE first.
    // Vendors' Statuspage re-POSTs component_update webhooks for a STATIC
    // incident every few minutes with an identical body ("X is now degraded
    // performance"). Only record + alert when this update actually differs from
    // the incident's most recent one, so a steady-state incident can't spam an
    // identical Slack "incident update" on a loop (the Adyen-every-5-min problem).
    if (isBadState(toState) && ev.body) {
      const open = await pool.query(
        `SELECT id FROM status_incidents WHERE service_id = $1 AND auto_created = true AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        [service.id],
      );
      if (open.rows[0]) {
        const incId = open.rows[0].id;
        const lbl = ev.label || 'Update';
        const last = await pool.query(
          `SELECT label, body FROM status_incident_updates WHERE incident_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [incId],
        );
        const dup = last.rows[0] && last.rows[0].label === lbl && last.rows[0].body === ev.body;
        if (!dup) {
          await pool.query(`INSERT INTO status_incident_updates (incident_id, label, body) VALUES ($1, $2, $3)`, [incId, lbl, ev.body]);
          await pool.query(`UPDATE status_incidents SET updated_at = NOW() WHERE id = $1`, [incId]);
          if (await slackEventEnabled(pool, 'manual')) {
            await notifyServiceAlert(pool, service, { state: toState, severity: ev.severity, note: ev.body, kind: 'update' });
          }
        }
      }
    }
    return;
  }

  if (isBadState(toState)) {
    const res = await raiseAutoIncident(pool, service, { toState, severity: ev.severity, body: ev.body || ev.note });
    if (await slackEventEnabled(pool, 'down')) {
      await notifyServiceAlert(pool, service, { state: toState, severity: ev.severity, note: ev.note, kind: res.opened ? 'opened' : 'changed' });
    }
  } else {
    const id = await clearAutoIncident(pool, service, { body: ev.body });
    if (await slackEventEnabled(pool, 'recovery')) {
      await notifyServiceAlert(pool, service, { state: 'operational', note: ev.note, kind: 'recovery' });
    }
  }
}

// ── Slack notifications ─────────────────────────────────────────────────────
// A status_config key/value bag holds the bot token (env SLACK_BOT_TOKEN wins)
// and the per-event on/off toggles (default on). Channels live in
// status_slack_channels; a service's alerts go to its connected channels plus
// any channel flagged is_global.

async function getConfig(pool, key) {
  const { rows } = await pool.query(`SELECT value FROM status_config WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}
async function setConfig(pool, key, value) {
  await pool.query(
    `INSERT INTO status_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}
async function getSlackToken(pool) {
  return process.env.SLACK_BOT_TOKEN || (await getConfig(pool, 'slack_bot_token')) || null;
}
// Event toggles default ON unless an admin explicitly turned them off.
async function slackEventEnabled(pool, key) {
  const v = await getConfig(pool, `slack_evt_${key}`);
  return v == null ? true : v === 'on';
}

// Slack mrkdwn plain text only needs &, <, > escaped. Run user-controlled
// values (service names, incident titles/bodies) through this before building
// a message so they can't break or spoof the formatting.
function slackText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Coloured status emoji used in the headline + plain-text fallback.
function stateEmoji(state) {
  return state === 'down' ? ':red_circle:' : state === 'degraded' ? ':large_yellow_circle:' : ':large_green_circle:';
}

// Public icon URL for a service, for the Slack thumbnail. Mirrors the web UI:
// admin-set icon_url wins, else Google's favicon service (public, key-less, so
// Slack can fetch it). sz=128 reads crisp at Slack's thumbnail size. Slack
// rejects a message whose image_url isn't a fetchable http(s) URL, so a custom
// icon_url that isn't (e.g. a data: URI) falls back to the favicon; returns ''
// only when there's nothing usable (caller then omits the image accessory).
function serviceIconForSlack(service) {
  if (service.icon_url && /^https?:\/\//i.test(service.icon_url)) return service.icon_url;
  const domain = service.domain || (service.name ? `${service.name.toLowerCase().replace(/\s+/g, '')}.com` : '');
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` : '';
}
function imageAccessory(service) {
  const url = serviceIconForSlack(service);
  return url ? { type: 'image', image_url: url, alt_text: service.name || 'service' } : undefined;
}

// Build the premium service alert — "clean header + icon + context": a bold
// headline, a divider, a section with the app icon as a thumbnail + the detail,
// and a subtle context footer. Returns { text, blocks } (text is the fallback
// used for notifications + accessibility). No colour bar, no button — by design.
function buildServiceAlert({ service, state, severity, note, kind, statusUrl, message, details, components }) {
  const emoji = stateEmoji(state);
  const stateWord = state === 'down' ? 'down' : state === 'degraded' ? 'degraded' : 'operational';
  const name = slackText(service.name);
  const headline =
    kind === 'recovery' ? `${emoji}  *${name}* has recovered`
    : kind === 'update'  ? `${emoji}  *${name}* — incident update`
    : kind === 'changed' ? `${emoji}  *${name}* is now *${stateWord}*`
    :                      `${emoji}  *${name}* is *${stateWord}*`;

  const sub = service.vendor ? ` _(${slackText(service.vendor)})_` : '';
  // StatusGator-style body. When the vendor feed gave us an incident headline
  // (message), its latest update (details), and/or impacted components, surface
  // them; otherwise fall back to the prior single-line note + generic fallback.
  // Link the service name to the status page (Slack can't hyperlink the icon
  // image itself, so the name next to it is the click target; the footer links too).
  const linkedName = statusUrl ? `<${statusUrl}|${name}>` : name;
  const bodyLines = [`*${linkedName}*${sub}`];
  if (message) bodyLines.push(`*${slackText(message)}*`);
  const detailBody = details ? slackText(details)
    : note ? slackText(note)
    : state === 'operational' ? 'All checks are passing again.'
    : message ? null
    : 'Reported by status monitoring.';
  if (detailBody) bodyLines.push(detailBody);
  if (Array.isArray(components) && components.length) {
    bodyLines.push(`*Affected:* ${components.map((c) => slackText(c)).join(', ')}`);
  }

  const ts = Math.floor(Date.now() / 1000);
  const when = `<!date^${ts}^{time}|just now>`;
  const sevLabel = state === 'operational' ? null : (severity === 'major' || severity === 'critical') ? 'Major' : 'Minor';
  const lead =
    kind === 'recovery' ? `Recovered ${when}`
    : kind === 'update'  ? `Updated ${when}${sevLabel ? ` · ${sevLabel}` : ''}`
    :                      `Detected ${when}${sevLabel ? ` · ${sevLabel}` : ''}`;
  const footer = statusUrl ? `<${statusUrl}|Slice IT Hub> · status monitoring` : 'Slice IT Hub · status monitoring';

  const svcSection = { type: 'section', text: { type: 'mrkdwn', text: bodyLines.join('\n') } };
  const acc = imageAccessory(service);
  if (acc) svcSection.accessory = acc;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    { type: 'divider' },
    svcSection,
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${lead}  ·  ${footer}` }] },
  ];
  const stateLabel = state === 'down' ? 'Down' : state === 'degraded' ? 'Degraded' : 'Operational';
  const compTail = (Array.isArray(components) && components.length) ? ` (affected: ${components.join(', ')})` : '';
  const text = `${emoji} ${service.name} is ${stateLabel}${message ? ` — ${message}` : note ? ` — ${note}` : ''}${compTail}`;
  return { text, blocks };
}

// Build an alert for an admin-authored incident (created / updated / resolved).
// Same visual language; shows the linked service's icon when there is one.
function buildIncidentAlert({ service, title, severity, state, body, kind, statusUrl }) {
  const resolved = state === 'resolved';
  const emoji = resolved ? ':large_green_circle:' : kind === 'created' ? ':rotating_light:' : ':speech_balloon:';
  const t = slackText(title);
  const headline =
    kind === 'created' ? `${emoji}  *New incident:* ${t}`
    : resolved         ? `${emoji}  *Resolved:* ${t}`
    :                    `${emoji}  *Incident update:* ${t}`;
  const sevLabel = severity ? capitalize(severity) : null;
  const ts = Math.floor(Date.now() / 1000);
  const lead = `${resolved ? 'Resolved' : 'Updated'} <!date^${ts}^{time}|just now>${sevLabel ? ` · ${sevLabel}` : ''}${state ? ` · ${capitalize(state)}` : ''}`;
  const footer = statusUrl ? `<${statusUrl}|Slice IT Hub> · status monitoring` : 'Slice IT Hub · status monitoring';

  const section = {
    type: 'section',
    text: { type: 'mrkdwn', text: body ? slackText(body) : t },
  };
  if (service && service.name) { const acc = imageAccessory(service); if (acc) section.accessory = acc; }

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    { type: 'divider' },
    section,
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${lead}  ·  ${footer}` }] },
  ];
  const text = `${emoji} ${title}${body ? ` — ${body}` : ''}`;
  return { text, blocks };
}

// Post a message (string or { text, blocks }) to one channel.
async function postToSlack(token, channel, message) {
  const payload = typeof message === 'string' ? { text: message } : message;
  const r = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, unfurl_links: false, unfurl_media: false, ...payload }),
    timeoutMs: 8000,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || `slack HTTP ${r.status}`);
  return j;
}

// Resolve the target channels for a service (its connected channels ∪ every
// global channel) and post `message` to each. No-ops silently when Slack isn't
// configured or no channel is wired up, so it's always safe to call.
async function notifySlack(pool, { serviceId, message, text }) {
  try {
    const token = await getSlackToken(pool);
    if (!token) return;
    const { rows } = await pool.query(
      `SELECT DISTINCT c.channel_id
         FROM status_slack_channels c
         LEFT JOIN status_service_channels sc ON sc.channel_id = c.id
        WHERE c.enabled = true
          AND (c.is_global = true OR sc.service_id = $1)`,
      [serviceId || null],
    );
    if (rows.length === 0) return;
    const msg = message || { text };
    await Promise.allSettled(rows.map((r) =>
      postToSlack(token, r.channel_id, msg).catch((e) => {
        console.warn(`[status] slack post to ${r.channel_id} failed: ${e.message}`);
      })));
  } catch (e) {
    console.warn('[status] notifySlack failed:', e.message);
  }
}

// Convenience wrappers — fetch the optional public status URL (for the footer
// link), build the premium message, and route it. Used by the poller, the
// webhook ingest, and the admin incident routes so every alert looks the same.
// The "Slice IT Hub" footer link and the linked service name in alerts point
// here. Admins can override via the public_status_url setting; absent that, we
// fall back to the production status page so alerts always link somewhere useful.
const DEFAULT_STATUS_URL = 'https://slicedesk.slice.services/portal/status';
async function notifyServiceAlert(pool, service, opts) {
  const statusUrl = (await getConfig(pool, 'public_status_url')) || DEFAULT_STATUS_URL;
  await notifySlack(pool, { serviceId: service.id, message: buildServiceAlert({ service, statusUrl, ...opts }) });
}
async function notifyIncidentAlert(pool, { serviceId, service, ...opts }) {
  const statusUrl = (await getConfig(pool, 'public_status_url')) || DEFAULT_STATUS_URL;
  await notifySlack(pool, { serviceId, message: buildIncidentAlert({ service, statusUrl, ...opts }) });
}

// Minimal service row (id/name/vendor/domain/icon_url) for building an incident
// alert's icon when the incident is tied to a service. Returns null when not.
async function serviceLite(pool, id) {
  if (!id) return null;
  const { rows } = await pool.query(`SELECT id, name, vendor, domain, icon_url FROM status_services WHERE id = $1`, [id]);
  return rows[0] || null;
}

// A single shared in-flight pass. The 60s tick and the admin "poll now" / "Test"
// routes all funnel through here; if a pass is already running, callers join it
// instead of starting a second concurrent pass (which would double-write checks
// and race the auto-incident open/resolve logic).
let pollPassInFlight = null;
function runOnePollPass(pool) {
  if (pollPassInFlight) return pollPassInFlight;
  pollPassInFlight = (async () => {
    // Includes manual + webhook services so they get a heartbeat sample each
    // pass. vendor/domain/icon_url come along so Slack alerts can render the
    // app icon + label without a second query.
    const { rows } = await pool.query(
      `SELECT id, name, vendor, domain, icon_url, source, source_url, state, state_note, match_filter FROM status_services`,
    );
    if (rows.length === 0) return;
    // Parallel — each service has its own 6s timeout, so a single slow vendor
    // can't block the cycle. Promise.allSettled so one failure doesn't kill
    // the rest.
    await Promise.allSettled(rows.map((s) => pollOne(pool, s)));
  })().finally(() => { pollPassInFlight = null; });
  return pollPassInFlight;
}

// We only display a 10-day window (and the admin probe panel reads the last 50
// samples), so retaining far beyond that is pure waste. Keep 30 days for a
// little headroom in case the display window is widened later.
async function pruneOldChecks(pool) {
  await pool.query(`DELETE FROM status_checks WHERE checked_at < NOW() - INTERVAL '30 days'`);
}

export function runStatusPollers(pool, { intervalMs = 60_000 } = {}) {
  let stopped = false;
  let inProgress = false;
  let pruneCounter = 0;

  const tick = async () => {
    if (stopped || inProgress) return; // skip if the previous pass is still running
    inProgress = true;
    try {
      await runOnePollPass(pool);
      pruneCounter += 1;
      if (pruneCounter >= 60) { // hourly prune
        pruneCounter = 0;
        await pruneOldChecks(pool);
      }
    } catch (e) {
      console.warn('[status] poll cycle failed:', e.message);
    } finally {
      inProgress = false;
    }
  };

  // Kick one off ~3s after boot so the server is responsive first, then on
  // the configured interval.
  setTimeout(tick, 3000);
  const handle = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(handle); };
}

// ── Routes ────────────────────────────────────────────────────────────────

async function fetchStatusPayload(pool) {
  const groups = await pool.query(
    `SELECT id, slug, label, position FROM status_groups ORDER BY position, id`,
  );
  const services = await pool.query(
    `SELECT id, group_id, name, vendor, domain, icon_url, source, source_url,
            state, state_note, response_ms, last_checked_at, last_error, position,
            links, webhook_last_at, match_filter
       FROM status_services
       ORDER BY group_id, position, id`,
  );
  const incidents = await pool.query(
    `SELECT i.id, i.service_id, s.name AS service_name, i.title, i.severity,
            i.state, i.started_at, i.resolved_at, i.auto_created,
            COALESCE(json_agg(json_build_object(
              'id', u.id, 'label', u.label, 'body', u.body, 'created_at', u.created_at
            ) ORDER BY u.created_at) FILTER (WHERE u.id IS NOT NULL), '[]'::json) AS updates
       FROM status_incidents i
       LEFT JOIN status_services s ON s.id = i.service_id
       LEFT JOIN status_incident_updates u ON u.incident_id = i.id
      WHERE i.started_at >= NOW() - INTERVAL '10 days'
      GROUP BY i.id, s.name
      ORDER BY i.started_at DESC`,
  );

  const groupsOut = groups.rows.map((g) => ({
    id: g.id,
    slug: g.slug,
    label: g.label,
    position: g.position,
    services: services.rows
      .filter((s) => s.group_id === g.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        vendor: s.vendor,
        domain: s.domain,
        icon_url: s.icon_url,
        source: s.source,
        source_url: s.source_url,
        state: s.state,
        state_note: s.state_note,
        response_ms: s.response_ms,
        last_checked_at: s.last_checked_at,
        last_error: s.last_error,
        position: s.position,
        links: Array.isArray(s.links) ? s.links : [],
        webhook_last_at: s.webhook_last_at,
        match_filter: s.match_filter,
      })),
  }));
  // Strays — services whose group was deleted — get bucketed at the end.
  const orphan = services.rows.filter((s) => !groupsOut.some((g) => g.id === s.group_id));
  if (orphan.length > 0) {
    groupsOut.push({
      id: 0, slug: 'other', label: 'Other', position: 9999,
      services: orphan.map((s) => ({
        id: s.id, name: s.name, vendor: s.vendor, domain: s.domain,
        icon_url: s.icon_url, source: s.source, source_url: s.source_url,
        state: s.state, state_note: s.state_note, response_ms: s.response_ms,
        last_checked_at: s.last_checked_at, last_error: s.last_error,
        position: s.position,
        links: Array.isArray(s.links) ? s.links : [],
        webhook_last_at: s.webhook_last_at,
        match_filter: s.match_filter,
      })),
    });
  }

  return {
    groups: groupsOut,
    incidents: incidents.rows.map((i) => ({
      id: i.id,
      service_id: i.service_id,
      service_name: i.service_name,
      title: i.title,
      severity: i.severity,
      state: i.state,
      started_at: i.started_at,
      resolved_at: i.resolved_at,
      auto_created: i.auto_created || false,
      updates: i.updates || [],
    })),
    server_time: new Date().toISOString(),
  };
}

const VALID_STATES = new Set(['operational', 'degraded', 'down']);
const VALID_SOURCES = new Set(['manual', 'probe', 'statuspage', 'rss', 'page', 'webhook', 'render']);
// Sources that need a URL on the service. 'render' carries the page URL the
// headless render worker loads (the hub never polls it directly). 'manual' is
// admin-set and 'webhook' is push-driven, so neither needs a source_url.
const SOURCES_NEEDING_URL = new Set(['probe', 'statuspage', 'rss', 'page', 'render']);
const VALID_SEVERITIES = new Set(['minor', 'major', 'critical']);
const VALID_INC_STATES = new Set(['investigating', 'identified', 'monitoring', 'resolved']);
const VALID_LINK_KINDS = new Set(['status', 'rss', 'help', 'docs', 'twitter', 'other']);

// Mint an unguessable inbound-webhook secret. This token IS the auth for the
// public /api/status/webhook/:token endpoint (Statuspage webhooks aren't
// signed), so it must be long + URL-safe.
function genWebhookToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Validate + normalise the admin-supplied reference-links array. Caps count and
// field lengths, drops anything without a usable http(s) URL.
function sanitizeLinks(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const url = String(raw.url || '').trim().slice(0, 500);
    if (!/^https?:\/\//i.test(url)) continue;
    const kind = VALID_LINK_KINDS.has(raw.kind) ? raw.kind : 'other';
    const label = String(raw.label || '').trim().slice(0, 60) || ({
      status: 'Status page', rss: 'RSS feed', help: 'Help center', docs: 'Docs', twitter: 'Updates on X', other: 'Link',
    }[kind]);
    out.push({ label, url, kind });
  }
  return out;
}

export function mountStatusRoutes(app, pool, { requireSliceUser, requireSliceAdmin }) {
  // Public-style read endpoint — anyone signed in can hit it.
  app.get('/api/status', requireSliceUser, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await fetchStatusPayload(pool));
    } catch (e) { next(e); }
  });

  // Manual on-demand re-poll (admin only) — runs one cycle and returns fresh data.
  app.post('/api/admin/status/poll', requireSliceAdmin, async (req, res, next) => {
    try {
      await runOnePollPass(pool);
      res.json(await fetchStatusPayload(pool));
    } catch (e) { next(e); }
  });

  // Group CRUD
  app.post('/api/admin/status/groups', requireSliceAdmin, async (req, res, next) => {
    try {
      const { slug, label, position } = req.body || {};
      if (!slug || !label) return res.status(400).json({ error: 'slug and label required' });
      const r = await pool.query(
        `INSERT INTO status_groups (slug, label, position) VALUES ($1, $2, $3) RETURNING *`,
        [String(slug).slice(0, 60), String(label).slice(0, 120), Number(position) || 0],
      );
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });
  app.patch('/api/admin/status/groups/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      const { label, position } = req.body || {};
      const r = await pool.query(
        `UPDATE status_groups SET
           label = COALESCE($2, label),
           position = COALESCE($3, position)
         WHERE id = $1 RETURNING *`,
        [req.params.id, label != null ? String(label).slice(0, 120) : null,
         position != null ? Number(position) : null],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });
  app.delete('/api/admin/status/groups/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      await pool.query(`DELETE FROM status_groups WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Service CRUD
  app.post('/api/admin/status/services', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ error: 'name required' });
      const source = VALID_SOURCES.has(b.source) ? b.source : 'manual';
      const state = VALID_STATES.has(b.state) ? b.state : 'operational';
      // Polled sources are useless without a URL; manual is admin-set and webhook
      // is push-driven, so neither carries one.
      if (SOURCES_NEEDING_URL.has(source) && !(b.source_url && String(b.source_url).trim())) {
        return res.status(400).json({ error: 'source_url is required for probe, vendor-status, RSS, and page sources' });
      }
      const sourceUrl = SOURCES_NEEDING_URL.has(source) ? String(b.source_url).slice(0, 500) : null;
      // webhook (vendor push) and render (our worker pushes after headless-rendering
      // the page) both receive state via the inbound webhook, so both get a token.
      const webhookToken = (source === 'webhook' || source === 'render') ? genWebhookToken() : null;
      const links = sanitizeLinks(b.links);
      const r = await pool.query(
        `INSERT INTO status_services
           (group_id, name, vendor, domain, icon_url, source, source_url, state, state_note, position, links, webhook_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
        [
          b.group_id || null,
          String(b.name).slice(0, 120),
          b.vendor ? String(b.vendor).slice(0, 80) : null,
          b.domain ? String(b.domain).slice(0, 120) : null,
          b.icon_url ? String(b.icon_url).slice(0, 500) : null,
          source,
          sourceUrl,
          state,
          b.state_note ? String(b.state_note).slice(0, 200) : null,
          Number(b.position) || 0,
          JSON.stringify(links),
          webhookToken,
        ],
      );
      // Seed an initial sample so there's a check on file from the start.
      await pool.query(`INSERT INTO status_checks (service_id, state) VALUES ($1, $2)`, [r.rows[0].id, state]);
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });
  app.patch('/api/admin/status/services/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const source = b.source != null && VALID_SOURCES.has(b.source) ? b.source : null;
      const state = b.state != null && VALID_STATES.has(b.state) ? b.state : null;
      const linksJson = b.links !== undefined ? JSON.stringify(sanitizeLinks(b.links)) : null;
      const r = await pool.query(
        `UPDATE status_services SET
           group_id    = COALESCE($2, group_id),
           name        = COALESCE($3, name),
           vendor      = COALESCE($4, vendor),
           domain      = COALESCE($5, domain),
           icon_url    = COALESCE($6, icon_url),
           source      = COALESCE($7, source),
           source_url  = COALESCE($8, source_url),
           state       = COALESCE($9, state),
           state_note  = COALESCE($10, state_note),
           position    = COALESCE($11, position),
           links       = COALESCE($12::jsonb, links),
           match_filter = COALESCE($13, match_filter),
           updated_at  = NOW()
         WHERE id = $1 RETURNING *`,
        [
          req.params.id,
          b.group_id != null ? Number(b.group_id) : null,
          b.name ? String(b.name).slice(0, 120) : null,
          b.vendor != null ? String(b.vendor).slice(0, 80) : null,
          b.domain != null ? String(b.domain).slice(0, 120) : null,
          b.icon_url != null ? String(b.icon_url).slice(0, 500) : null,
          source,
          b.source_url != null ? String(b.source_url).slice(0, 500) : null,
          state,
          b.state_note != null ? String(b.state_note).slice(0, 200) : null,
          b.position != null ? Number(b.position) : null,
          linksJson,
          b.match_filter != null ? String(b.match_filter).slice(0, 200) : null,
        ],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const row = r.rows[0];
      // Manual + webhook services don't poll a URL — keep the field clean so the
      // admin UI and pollers don't get confused.
      if ((row.source === 'manual' || row.source === 'webhook') && row.source_url) {
        await pool.query(`UPDATE status_services SET source_url = NULL WHERE id = $1`, [req.params.id]);
        row.source_url = null;
      }
      // Switching to "webhook" (or "render") mints the inbound token on demand —
      // webhook so the admin has a URL to paste into the vendor's status page,
      // render so the render worker has a target to push to.
      if ((row.source === 'webhook' || row.source === 'render') && !row.webhook_token) {
        const tok = genWebhookToken();
        await pool.query(`UPDATE status_services SET webhook_token = $2 WHERE id = $1`, [req.params.id, tok]);
        row.webhook_token = tok;
      }
      // For manual services, record the admin's toggle as a sample so the recent
      // check on file reflects it immediately rather than waiting for the heartbeat.
      if (row.source === 'manual' && state) {
        await pool.query(`INSERT INTO status_checks (service_id, state) VALUES ($1, $2)`, [req.params.id, row.state]);
      }
      res.json(row);
    } catch (e) { next(e); }
  });
  app.delete('/api/admin/status/services/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      await pool.query(`DELETE FROM status_services WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Incident composer
  app.post('/api/admin/status/incidents', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.title) return res.status(400).json({ error: 'title required' });
      const severity = VALID_SEVERITIES.has(b.severity) ? b.severity : 'minor';
      const state = VALID_INC_STATES.has(b.state) ? b.state : 'investigating';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inc = await client.query(
          `INSERT INTO status_incidents (service_id, title, severity, state)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [b.service_id || null, String(b.title).slice(0, 200), severity, state],
        );
        // Optional first update so the timeline isn't empty on creation.
        if (b.first_update) {
          await client.query(
            `INSERT INTO status_incident_updates (incident_id, label, body) VALUES ($1, $2, $3)`,
            [inc.rows[0].id, 'Identified', String(b.first_update).slice(0, 1000)],
          );
        }
        await client.query('COMMIT');
        const created = inc.rows[0];
        if (await slackEventEnabled(pool, 'manual')) {
          const svc = await serviceLite(pool, created.service_id);
          await notifyIncidentAlert(pool, {
            serviceId: created.service_id, service: svc,
            title: created.title, severity: created.severity, state: created.state,
            body: b.first_update ? String(b.first_update).slice(0, 1000) : null, kind: 'created',
          });
        }
        res.json(created);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) { next(e); }
  });
  app.patch('/api/admin/status/incidents/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const severity = b.severity != null && VALID_SEVERITIES.has(b.severity) ? b.severity : null;
      const state = b.state != null && VALID_INC_STATES.has(b.state) ? b.state : null;
      const isResolving = state === 'resolved';
      const r = await pool.query(
        `UPDATE status_incidents SET
           title       = COALESCE($2, title),
           service_id  = COALESCE($3, service_id),
           severity    = COALESCE($4, severity),
           state       = COALESCE($5, state),
           resolved_at = CASE WHEN $6::boolean AND resolved_at IS NULL THEN NOW() ELSE resolved_at END,
           updated_at  = NOW()
         WHERE id = $1 RETURNING *`,
        [
          req.params.id,
          b.title ? String(b.title).slice(0, 200) : null,
          b.service_id != null ? Number(b.service_id) : null,
          severity,
          state,
          isResolving,
        ],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const updated = r.rows[0];
      // Notify on an admin state change (e.g. manually resolving an incident) so
      // it mirrors the automated recovery path.
      if (state && await slackEventEnabled(pool, 'manual')) {
        const svc = await serviceLite(pool, updated.service_id);
        await notifyIncidentAlert(pool, {
          serviceId: updated.service_id, service: svc,
          title: updated.title, severity: updated.severity, state: updated.state,
          kind: state === 'resolved' ? 'resolved' : 'update',
        });
      }
      res.json(updated);
    } catch (e) { next(e); }
  });
  app.delete('/api/admin/status/incidents/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      await pool.query(`DELETE FROM status_incidents WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  // Add a timeline update to an existing incident (the "Post update" button).
  app.post('/api/admin/status/incidents/:id/updates', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.body) return res.status(400).json({ error: 'body required' });
      const label = String(b.label || 'Update').slice(0, 40);
      const body = String(b.body).slice(0, 1000);
      const r = await pool.query(
        `INSERT INTO status_incident_updates (incident_id, label, body) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.id, label, body],
      );
      // Bump the parent so /api/status sorts correctly when this update lands.
      await pool.query(`UPDATE status_incidents SET updated_at = NOW() WHERE id = $1`, [req.params.id]);
      if (await slackEventEnabled(pool, 'manual')) {
        const inc = await pool.query(`SELECT service_id, title, severity, state FROM status_incidents WHERE id = $1`, [req.params.id]);
        const row = inc.rows[0];
        if (row) {
          const svc = await serviceLite(pool, row.service_id);
          await notifyIncidentAlert(pool, {
            serviceId: row.service_id, service: svc,
            title: row.title, severity: row.severity, state: row.state,
            body: `${label}: ${body}`, kind: row.state === 'resolved' ? 'resolved' : 'update',
          });
        }
      }
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });

  // Probes panel — last 50 checks per service for the admin diagnostic view.
  app.get('/api/admin/status/probes', requireSliceAdmin, async (req, res, next) => {
    try {
      const r = await pool.query(
        `SELECT s.id, s.name, s.source, s.source_url, s.state, s.last_checked_at, s.last_error, s.webhook_last_at,
                (SELECT json_agg(row_to_json(t) ORDER BY t.checked_at DESC)
                   FROM (
                     SELECT state, response_ms, http_status, error, checked_at
                       FROM status_checks
                      WHERE service_id = s.id
                      ORDER BY checked_at DESC
                      LIMIT 50
                   ) t) AS recent
           FROM status_services s
          WHERE s.source IN ('probe','statuspage','rss','page','webhook','render')
          ORDER BY s.name`,
      );
      res.json({ probes: r.rows });
    } catch (e) { next(e); }
  });

  // ── Slack notification config ─────────────────────────────────────────────
  // Snapshot for the admin Slack panel. Never returns the token itself — only
  // whether one is set, plus the channel list, toggles, and per-service routing.
  app.get('/api/admin/status/slack', requireSliceAdmin, async (req, res, next) => {
    try {
      const token = await getSlackToken(pool);
      const channels = await pool.query(
        `SELECT id, label, channel_id, is_global, enabled FROM status_slack_channels ORDER BY id`,
      );
      const map = await pool.query(`SELECT service_id, channel_id FROM status_service_channels`);
      const serviceChannels = {};
      for (const r of map.rows) (serviceChannels[r.service_id] ||= []).push(r.channel_id);
      res.json({
        token_set: !!token,
        token_from_env: !!process.env.SLACK_BOT_TOKEN,
        channels: channels.rows,
        toggles: {
          down: await slackEventEnabled(pool, 'down'),
          recovery: await slackEventEnabled(pool, 'recovery'),
          manual: await slackEventEnabled(pool, 'manual'),
        },
        service_channels: serviceChannels,
        // Optional public URLs. public_status_url → the "Slice IT Hub" footer
        // link in alerts. public_base_url → overrides the origin used when
        // composing inbound webhook URLs (for when the portal sits behind a
        // different public hostname than the admin page).
        public_status_url: await getConfig(pool, 'public_status_url'),
        public_base_url: await getConfig(pool, 'public_base_url'),
      });
    } catch (e) { next(e); }
  });

  // Set / clear the bot token (empty string clears the DB-stored value; the
  // SLACK_BOT_TOKEN env var, if present, still wins and can't be cleared here).
  app.put('/api/admin/status/slack/token', requireSliceAdmin, async (req, res, next) => {
    try {
      const token = typeof (req.body || {}).token === 'string' ? req.body.token.trim() : '';
      await setConfig(pool, 'slack_bot_token', token || null);
      res.json({ ok: true, token_set: !!(process.env.SLACK_BOT_TOKEN || token) });
    } catch (e) { next(e); }
  });

  app.put('/api/admin/status/slack/toggles', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      for (const k of ['down', 'recovery', 'manual']) {
        if (b[k] != null) await setConfig(pool, `slack_evt_${k}`, b[k] ? 'on' : 'off');
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Optional public URLs for the status surface. Both accept '' to clear, and
  // only http(s) values are stored (so a bad paste can't smuggle a javascript:
  // URL into a Slack footer link).
  app.put('/api/admin/status/settings', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const clean = (v) => {
        const s = String(v == null ? '' : v).trim();
        if (!s) return null;
        return /^https?:\/\//i.test(s) ? s.slice(0, 300).replace(/\/$/, '') : undefined; // undefined → reject
      };
      for (const k of ['public_status_url', 'public_base_url']) {
        if (b[k] !== undefined) {
          const v = clean(b[k]);
          if (v === undefined) return res.status(400).json({ error: `${k} must be an http(s) URL` });
          await setConfig(pool, k, v);
        }
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/status/slack/channels', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.label || !b.channel_id) return res.status(400).json({ error: 'label and channel_id required' });
      const r = await pool.query(
        `INSERT INTO status_slack_channels (label, channel_id, is_global) VALUES ($1, $2, $3) RETURNING *`,
        [String(b.label).slice(0, 80), String(b.channel_id).slice(0, 60), !!b.is_global],
      );
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });
  app.patch('/api/admin/status/slack/channels/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const r = await pool.query(
        `UPDATE status_slack_channels SET
           label      = COALESCE($2, label),
           channel_id = COALESCE($3, channel_id),
           is_global  = COALESCE($4, is_global),
           enabled    = COALESCE($5, enabled)
         WHERE id = $1 RETURNING *`,
        [
          req.params.id,
          b.label != null ? String(b.label).slice(0, 80) : null,
          b.channel_id != null ? String(b.channel_id).slice(0, 60) : null,
          b.is_global != null ? !!b.is_global : null,
          b.enabled != null ? !!b.enabled : null,
        ],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });
  app.delete('/api/admin/status/slack/channels/:id', requireSliceAdmin, async (req, res, next) => {
    try {
      await pool.query(`DELETE FROM status_slack_channels WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Set the channels a service routes to (replaces the full set for that service).
  app.put('/api/admin/status/services/:id/channels', requireSliceAdmin, async (req, res, next) => {
    const client = await pool.connect();
    try {
      const ids = Array.isArray((req.body || {}).channel_ids) ? req.body.channel_ids.map(Number).filter(Number.isInteger) : [];
      await client.query('BEGIN');
      await client.query(`DELETE FROM status_service_channels WHERE service_id = $1`, [req.params.id]);
      for (const cid of ids) {
        await client.query(
          `INSERT INTO status_service_channels (service_id, channel_id) VALUES ($1, $2)
           ON CONFLICT (service_id, channel_id) DO NOTHING`,
          [req.params.id, cid],
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, channel_ids: ids });
    } catch (e) {
      await client.query('ROLLBACK'); next(e);
    } finally { client.release(); }
  });

  // Send a test message to one channel (or all enabled channels when no id given).
  app.post('/api/admin/status/slack/test', requireSliceAdmin, async (req, res, next) => {
    try {
      const token = await getSlackToken(pool);
      if (!token) return res.status(400).json({ error: 'No Slack bot token configured yet.' });
      const id = (req.body || {}).id;
      const q = id
        ? await pool.query(`SELECT channel_id, label FROM status_slack_channels WHERE id = $1`, [id])
        : await pool.query(`SELECT channel_id, label FROM status_slack_channels WHERE enabled = true`);
      if (q.rows.length === 0) return res.status(400).json({ error: 'No channel to test.' });
      // Send the test in the real alert layout so the admin sees exactly what a
      // live status change will look like (icon + context footer included).
      const statusUrl = await getConfig(pool, 'public_status_url');
      const ts = Math.floor(Date.now() / 1000);
      const footer = statusUrl ? `<${statusUrl}|Slice IT Hub> · status monitoring` : 'Slice IT Hub · status monitoring';
      const testMsg = {
        text: ':wave: Test from the Slice IT Hub status page — Slack notifications are wired up.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: ':wave:  *Slack notifications are wired up*' } },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Slice IT Hub* _(Status monitoring)_\nThis is a test. Real status changes land here with the app’s icon, severity, and a timestamp.' },
            accessory: { type: 'image', image_url: serviceIconForSlack({ domain: 'slicelife.com' }), alt_text: 'Slice IT Hub' },
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent <!date^${ts}^{time}|just now>  ·  ${footer}` }] },
        ],
      };
      const results = await Promise.allSettled(q.rows.map((c) => postToSlack(token, c.channel_id, testMsg)));
      const failed = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message || r.reason));
      if (failed.length) return res.status(502).json({ error: `Slack rejected ${failed.length}/${results.length}: ${failed.join('; ')}` });
      res.json({ ok: true, sent: results.length });
    } catch (e) { next(e); }
  });

  // ── Inbound webhooks (per service) ────────────────────────────────────────

  // Admin snapshot of webhook tokens + last-received times, keyed by service id.
  // Deliberately NOT folded into /api/status (every signed-in user can read
  // that) — the token is a secret, so only admins ever see it.
  app.get('/api/admin/status/webhooks', requireSliceAdmin, async (req, res, next) => {
    try {
      const r = await pool.query(`SELECT id, webhook_token, webhook_last_at FROM status_services WHERE webhook_token IS NOT NULL`);
      const webhooks = {};
      for (const row of r.rows) webhooks[row.id] = { token: row.webhook_token, last_at: row.webhook_last_at };
      res.json({ webhooks });
    } catch (e) { next(e); }
  });

  // Mint (or rotate) a service's inbound webhook token. Returns the new token so
  // the admin can copy the full URL. Rotating invalidates the previous URL.
  app.post('/api/admin/status/services/:id/webhook', requireSliceAdmin, async (req, res, next) => {
    try {
      const tok = genWebhookToken();
      const r = await pool.query(`UPDATE status_services SET webhook_token = $2, updated_at = NOW() WHERE id = $1 RETURNING id`, [req.params.id, tok]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, webhook_token: tok });
    } catch (e) { next(e); }
  });
  // Disable inbound webhooks for a service (clears the token → the old URL 404s).
  app.delete('/api/admin/status/services/:id/webhook', requireSliceAdmin, async (req, res, next) => {
    try {
      await pool.query(`UPDATE status_services SET webhook_token = NULL, updated_at = NOW() WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Auto-detect the best machine-readable source for a pasted status URL.
  app.post('/api/admin/status/resolve-source', requireSliceAdmin, async (req, res, next) => {
    try {
      const url = String((req.body || {}).url || '').trim();
      if (!url) return res.status(400).json({ error: 'url required' });
      const out = await resolveSource(url);
      if (out && out.error) return res.status(400).json({ error: out.error });
      res.json(out);
    } catch (e) { next(e); }
  });

  // ── Public inbound webhook receiver ───────────────────────────────────────
  // The vendor's Statuspage POSTs incident/component events here. Auth IS the
  // unguessable token in the path — Statuspage webhooks aren't signed — so there
  // is intentionally no requireSliceUser: a third party must be able to reach
  // it. We always answer 2xx on our own errors so a transient failure doesn't
  // make the vendor auto-disable the subscription; only an unknown token 404s.
  app.post('/api/status/webhook/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (token.length < 12) return res.status(404).json({ error: 'unknown webhook' });
      const q = await pool.query(`SELECT * FROM status_services WHERE webhook_token = $1 LIMIT 1`, [token]);
      const service = q.rows[0];
      if (!service) return res.status(404).json({ error: 'unknown webhook' });
      await pool.query(`UPDATE status_services SET webhook_last_at = NOW() WHERE id = $1`, [service.id]);
      const ev = parseStatuspageWebhook(req.body || {});
      if (!ev) return res.json({ ok: true, ignored: true }); // validation ping / shape we don't handle
      await ingestWebhookEvent(pool, service, ev);
      res.json({ ok: true });
    } catch (e) {
      console.warn('[status] webhook ingest failed:', e.message);
      res.status(200).json({ ok: false });
    }
  });
}
