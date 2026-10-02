// Knowledge index — what the chat assistant answers from.
//
// The Portal shows guides from SliceDesk Docs (guides-slicedesk.js), but chat
// retrieval searched the IT Hub's own legacy `guides` table. So in production
// an answer could be grounded on stale copy, and its "matching guide" cards
// carried that table's ids — which the SliceDesk-backed guide page resolves
// against a different id space, opening the wrong guide or nothing.
//
// When the module is paired with SliceDesk, this keeps an in-memory index of
// the live SliceDesk guides (refreshed every few minutes, only re-fetching
// guides whose updated_at moved) and ranks chunks with BM25. The ids it
// returns are the same numeric ids GET /api/guides/:id resolves, so a citation
// always opens the guide it quotes. Unpaired (local dev, DEV_LOCAL_GUIDES) it
// defers to the Postgres full-text search over the local table, unchanged.

const REFRESH_MS = 5 * 60 * 1000;
const FIRST_BUILD_WAIT_MS = 4000;
const DETAIL_CONCURRENCY = 4;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

const STOP = new Set(('a an and are as at be but by can could do does for from get got has have how i if in into is it its ' +
  'me my no not of on or our please should so that the their them then there this to too up us was we what when where which ' +
  'who why will with would you your hi hello hey thanks thank need want help cant cannot dont doesnt wont isnt im ive ' +
  // Filler that says nothing about WHICH guide: "my printer is not working
  // anymore" is about a printer, not about every guide containing "working".
  'keep keeps kept work working works worked issue issues problem problems still anymore trying try tried getting ' +
  'just really any some again same also something anything').split(' '));

// Slice's own vocabulary. People say "VPN"; the guide says "GlobalProtect".
// Expanded at query time, so a guide written either way is found.
const SYNONYMS = {
  vpn: ['globalprotect'], globalprotect: ['vpn'],
  mfa: ['onelogin', 'protect', '2fa'], '2fa': ['mfa', 'onelogin'], sso: ['onelogin'],
  password: ['onelogin'], login: ['onelogin', 'sign'], signin: ['onelogin', 'sign'],
  email: ['gmail', 'mail'], mail: ['gmail', 'email'], gmail: ['email'],
  calendar: ['google'], drive: ['google'], docs: ['google'],
  wifi: ['wireless', 'network'], internet: ['wifi', 'network'],
  headset: ['jabra', 'headphone', 'microphone'], headphone: ['jabra', 'headset'], mic: ['microphone', 'jabra'],
  microphone: ['mic', 'audio'], jabra: ['headset'],
  laptop: ['mac', 'macbook', 'computer'], mac: ['macbook', 'laptop'], macbook: ['mac', 'laptop'],
  phone: ['ccp', 'connect'], ccp: ['phone', 'softphone'],
  phish: ['phishing', 'suspicious'], phishing: ['suspicious', 'security'], scam: ['phishing'],
  weird: ['suspicious', 'phishing'], strange: ['suspicious', 'phishing'], fake: ['phishing', 'suspicious'],
  suspicious: ['phishing'], spam: ['phishing'], slow: ['performance', 'speed'], frozen: ['freezing', 'crash'],
};

// Light stemming: enough that "printer"/"printing"/"prints" meet, without a
// dictionary. Deliberately conservative — over-stemming merges unrelated words.
function stem(w) {
  if (w.length <= 4) return w;
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ers', 'er', 'ies', 'ied', 'es', 'ed', 'ly', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      if (suf === 'ies' || suf === 'ied') return w.slice(0, -3) + 'y';
      return w.slice(0, -suf.length);
    }
  }
  return w;
}

export function terms(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map(stem);
}

// Lexical JSON → plain text (fallback when SliceDesk sent no Markdown body).
function lexicalToText(raw) {
  try {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.text === 'string') out.push(n.text);
      if (Array.isArray(n.children)) {
        n.children.forEach(walk);
        if (['paragraph', 'heading', 'listitem', 'quote'].includes(n.type)) out.push('\n');
      }
    };
    walk(JSON.parse(raw).root);
    return out.join('').replace(/\n{3,}/g, '\n\n').trim();
  } catch { return ''; }
}

function chunk(text) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  if (!clean) return [];
  const sections = clean.split(/(?=^#{1,3} )/gm).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const sec of sections.length ? sections : [clean]) {
    if (sec.length <= CHUNK_SIZE * 1.4) { out.push(sec); continue; }
    for (let i = 0; i < sec.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      out.push(sec.slice(i, i + CHUNK_SIZE));
      if (i + CHUNK_SIZE >= sec.length) break;
    }
  }
  return out;
}

/**
 * Pure BM25 ranking over prepared docs — exported for tests.
 * docs: [{ guide, content, tf: Map, len }]
 */
export function rankChunks(docs, query, { limit = 5, perGuide = 2 } = {}) {
  const base = [...new Set(terms(query))];
  if (!base.length || !docs.length) return [];
  // Synonyms count, but less than the words actually typed.
  const weight = new Map(base.map((t) => [t, 1]));
  for (const t of base) for (const syn of (SYNONYMS[t] || [])) {
    const st = stem(syn);
    if (!weight.has(st)) weight.set(st, 0.7);
  }
  const q = [...weight.keys()];
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = new Map();
  for (const t of q) {
    let n = 0;
    for (const d of docs) if (d.tf.has(t)) n++;
    df.set(t, n);
  }
  const k1 = 1.4, b = 0.72;
  const scored = [];
  for (const d of docs) {
    let s = 0;
    let hit = 0;
    for (const t of q) {
      const f = d.tf.get(t) || 0;
      if (!f) continue;
      const w = weight.get(t);
      if (w === 1) hit++;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avg))));
      // Title words are the strongest signal of what a guide is about.
      if (d.titleTerms.has(t)) s += w * idf * 2.2;
    }
    if (!s) continue;
    // Prefer chunks that cover more of the question, and a little for
    // guides people have marked helpful.
    s *= 1 + 0.35 * (hit / base.length);
    s *= 1 + Math.min(0.25, (d.guide.helpful_count || 0) / 80);
    scored.push({ d, s });
  }
  scored.sort((x, y) => y.s - x.s);
  // Far behind the best match is noise, not a second opinion.
  const floor = scored.length ? scored[0].s * 0.32 : 0;
  const perCount = new Map();
  const out = [];
  for (const { d, s } of scored) {
    if (s < floor) break;
    const n = perCount.get(d.guide.id) || 0;
    if (n >= perGuide) continue;
    perCount.set(d.guide.id, n + 1);
    out.push({ ...d, score: s });
    if (out.length >= limit) break;
  }
  return out;
}

function prepare(guide, text) {
  const titleTerms = new Set(terms(guide.title));
  return chunk(text).map((content, i) => {
    const toks = terms(guide.title + ' ' + content);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { guide, content, tf, len: toks.length || 1, titleTerms, chunkIndex: i };
  });
}

export function createKnowledge({ ftsSearch, pool, source, log = console }) {
  // source: { enabled(): bool, list(): Promise<guide[]>, text(slug): Promise<{body, content, updated_at}> }
  let docs = [];
  let guides = [];
  const texts = new Map(); // guide id → { updated_at, text }
  let builtAt = 0;
  let building = null;

  async function build() {
    if (building) return building;
    building = (async () => {
      try {
        const list = await source.list();
        const live = new Set();
        const stale = [];
        for (const g of list) {
          live.add(String(g.id));
          const have = texts.get(String(g.id));
          if (!have || String(have.updated_at || '') !== String(g.updated_at || '')) stale.push(g);
        }
        for (let i = 0; i < stale.length; i += DETAIL_CONCURRENCY) {
          await Promise.all(stale.slice(i, i + DETAIL_CONCURRENCY).map(async (g) => {
            try {
              const t = await source.text(g.slug);
              const text = (t.body && t.body.trim()) ? t.body : lexicalToText(t.content);
              texts.set(String(g.id), { updated_at: g.updated_at, text });
            } catch (err) {
              log.warn('[knowledge] could not fetch', g.slug, err.message);
            }
          }));
        }
        for (const id of [...texts.keys()]) if (!live.has(id)) texts.delete(id);
        guides = list;
        docs = list.flatMap((g) => {
          const t = texts.get(String(g.id));
          return t && t.text ? prepare(g, t.text) : [];
        });
        builtAt = Date.now();
        log.log(`[knowledge] indexed ${list.length} SliceDesk guides → ${docs.length} chunks`);
      } catch (err) {
        log.warn('[knowledge] index build failed:', err.message);
      } finally {
        building = null;
      }
    })();
    return building;
  }

  if (source.enabled()) {
    build();
    const t = setInterval(build, REFRESH_MS);
    if (t.unref) t.unref();
  }

  const ready = () => docs.length > 0;

  // Same row shape as index.js#ftsSearch, so callers don't care which ran.
  async function search(query, { limit = 5 } = {}) {
    if (source.enabled()) {
      if (!ready()) await Promise.race([build(), new Promise((r) => setTimeout(r, FIRST_BUILD_WAIT_MS))]);
      else if (Date.now() - builtAt > REFRESH_MS * 2) build();
      if (ready()) {
        return rankChunks(docs, query, { limit }).map((r) => ({
          chunk_id: `${r.guide.id}:${r.chunkIndex}`,
          content: r.content,
          guide_id: r.guide.id,
          title: r.guide.title,
          category: r.guide.category,
          source_type: r.guide.source_type || 'guide',
          helpful_count: r.guide.helpful_count || 0,
        }));
      }
    }
    return ftsSearch(query);
  }

  async function titles() {
    if (source.enabled() && guides.length) {
      return guides.map((g) => ({ id: g.id, title: g.title, category: g.category }));
    }
    const r = await pool.query('SELECT id, title, category FROM guides WHERE deleted_at IS NULL ORDER BY title');
    return r.rows;
  }

  // Chunks of specific guides, in the order the ids were given (the screenshot
  // grounder asks for the guides its vision pass picked). null → not indexed
  // here, caller should use the local table.
  function chunksFor(ids, limit = 8) {
    if (!source.enabled() || !ready()) return null;
    const out = [];
    for (const id of ids) {
      for (const d of docs) {
        if (String(d.guide.id) !== String(id)) continue;
        out.push({ content: d.content, guide_id: d.guide.id, title: d.guide.title });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  return { search, titles, chunksFor, ready, stats: () => ({ guides: guides.length, chunks: docs.length, builtAt }) };
}
