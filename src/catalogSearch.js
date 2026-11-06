/**
 * Relevance ranking for the service catalog — client-side copy.
 *
 * ⚠️ MIRROR of ticket-module's server/services/catalogSearch.js. The portal
 * loads the whole catalog once and filters it in the browser, so it has to
 * score locally; ticket-module scores the same rows server-side. Both must
 * agree on the order or the same query returns a different "best match"
 * depending on which surface you typed it into. If you change a weight or a
 * rule here, change it there in the same PR.
 *
 * Two entry points:
 *   rankItems     — a search box, where the whole input is the query.
 *   matchFromText — free text (a hero-search phrase, a ticket subject), where
 *                   the input is a sentence and most of it is noise.
 */

// ── Weights ────────────────────────────────────────────────────────────────
// Ordered by how strong a signal each is about intent. The gaps are wide on
// purpose: one exact-name hit should outrank any number of description hits,
// because "I typed the app's name" is not a close call.
const W = {
  NAME_EXACT: 1000,
  NAME_PREFIX: 700,
  TAG_EXACT: 620,        // an admin deliberately wrote this alias down
  NAME_WORD_PREFIX: 550, // "cloud" → "Adobe Creative Cloud"
  ACRONYM: 480,          // "gcp" → "Google Cloud Platform"
  TAG_PREFIX: 430,
  NAME_CONTAINS: 350,
  TAG_CONTAINS: 240,
  // Keywords are synced from the hub app's own "keywords" list — deliberate
  // search synonyms ("one password", "onepassword" → 1Password). Weighted just
  // under tags (admin-written per service item) and well under the name, so a
  // real name match always wins.
  KEYWORD_EXACT: 560,
  KEYWORD_PREFIX: 400,
  KEYWORD_CONTAINS: 220,
  CATEGORY: 150,
  DESC_WORD_PREFIX: 130,
  DESC_CONTAINS: 90,
  // Typo hits are deliberately worth less than their clean equivalents: a
  // real substring match should always win over a guess about what you meant.
  FUZZY_NAME: 300,
  FUZZY_TAG: 200,
  FUZZY_KEYWORD: 180,
};

// A token shorter than this is never fuzzy-matched — at 3 chars almost
// everything is within edit distance 1 of everything else ("vpn" → "van",
// "cpu"), which produces confident nonsense.
const FUZZY_MIN_LEN = 4;

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
function normalise(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenise(s) {
  const n = normalise(s);
  return n ? n.split(' ') : [];
}

/**
 * `tags` is JSONB in Postgres (already parsed) but legacy rows and some
 * import paths left a JSON *string* behind, and CatalogAdmin has historically
 * written at least one corrupted shape ('["[]"]'). Be liberal.
 */
function toTags(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[')) { try { v = JSON.parse(s); } catch { return [s]; } }
    else return s.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t && t !== '[]' && t !== '[""]');
}

/**
 * Damerau-Levenshtein, abandoned as soon as it exceeds `max`.
 *
 * The early exit is what makes it safe to call across a whole catalog on
 * every keystroke: for the overwhelming majority of pairs (which are nothing
 * like each other) it bails on the first row instead of filling an m×n table.
 */
function editDistanceWithin(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length <= max ? b.length : max + 1;
  if (!b.length) return a.length <= max ? a.length : max + 1;

  let prev2 = null;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Transposition — "recieve"/"receive", the single most common typo.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1; // nothing in this row can recover
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How wrong we're willing to let a token be, by its length. */
function fuzzyBudget(token) {
  if (token.length < FUZZY_MIN_LEN) return 0;
  if (token.length <= 6) return 1;
  return 2;
}

/**
 * First letters of each word — "Google Cloud Platform" → "gcp".
 * Only meaningful for multi-word names, and only worth checking for short
 * queries (nobody types a 9-letter acronym).
 */
function acronymOf(words) {
  return words.length >= 2 ? words.map((w) => w[0]).join('') : '';
}

/**
 * Precompute the per-item strings the scorer reads, so a scan over N items
 * doesn't re-normalise the same rows on every keystroke.
 *
 * Pass the result as `item.__idx`; `scoreItem` builds it on demand if absent.
 */
function indexItem(item) {
  const name = normalise(item.name);
  const nameWords = name ? name.split(' ') : [];
  const tags = toTags(item.tags).map(normalise).filter(Boolean);
  const keywords = toTags(item.keywords).map(normalise).filter(Boolean);
  return {
    name,
    nameWords,
    acronym: acronymOf(nameWords),
    tags,
    keywords,
    category: normalise(item.category_name),
    // Long descriptions are truncated: past a couple of hundred characters a
    // substring hit says almost nothing about relevance, and scanning the
    // whole body on every keystroke is the one part of this that could get
    // expensive.
    desc: normalise(String(item.description || '').slice(0, 400)),
    descWords: null, // built lazily — most items never need it
  };
}

function descWordsOf(idx) {
  if (idx.descWords === null) idx.descWords = idx.desc ? idx.desc.split(' ') : [];
  return idx.descWords;
}

/**
 * Best score any single token achieves against one item.
 *
 * `noFuzzy` asks the CLEAN question only — did this token actually appear
 * somewhere — which matchFromText uses to tell a misspelling apart from a
 * real word that merely resembles a product name.
 */
function scoreToken(idx, token, noFuzzy) {
  let best = 0;
  const hit = (v) => { if (v > best) best = v; };

  if (idx.name) {
    if (idx.name === token) hit(W.NAME_EXACT);
    else if (idx.name.startsWith(token)) hit(W.NAME_PREFIX);
    else if (idx.name.includes(token)) hit(W.NAME_CONTAINS);
    for (const w of idx.nameWords) {
      if (w === token) { hit(W.NAME_PREFIX); break; }
      if (w.startsWith(token)) hit(W.NAME_WORD_PREFIX);
    }
  }

  if (idx.acronym && idx.acronym === token) hit(W.ACRONYM);

  for (const t of idx.tags) {
    if (t === token) { hit(W.TAG_EXACT); break; }
    if (t.startsWith(token)) hit(W.TAG_PREFIX);
    else if (t.includes(token)) hit(W.TAG_CONTAINS);
  }

  for (const k of idx.keywords) {
    if (k === token) { hit(W.KEYWORD_EXACT); break; }
    if (k.startsWith(token)) hit(W.KEYWORD_PREFIX);
    else if (k.includes(token)) hit(W.KEYWORD_CONTAINS);
  }

  if (idx.category && (idx.category === token || idx.category.includes(token))) hit(W.CATEGORY);

  if (idx.desc && idx.desc.includes(token)) {
    hit(W.DESC_CONTAINS);
    for (const w of descWordsOf(idx)) {
      if (w.startsWith(token)) { hit(W.DESC_WORD_PREFIX); break; }
    }
  }

  // Only reach for fuzzy when nothing matched cleanly — a token that already
  // hit a real substring doesn't need us guessing at what else it could be.
  if (best === 0 && !noFuzzy) {
    const budget = fuzzyBudget(token);
    if (budget > 0) {
      let bestDist = budget + 1;
      for (const w of idx.nameWords) {
        const d = editDistanceWithin(token, w, budget);
        if (d < bestDist) bestDist = d;
        if (bestDist === 1) break;
      }
      if (bestDist <= budget) {
        // Scale by how wrong it was: distance 1 keeps most of the weight.
        hit(Math.round(W.FUZZY_NAME / bestDist));
      } else {
        let matched = false;
        for (const t of idx.tags) {
          const d = editDistanceWithin(token, t, budget);
          if (d <= budget) { hit(Math.round(W.FUZZY_TAG / d)); matched = true; break; }
        }
        if (!matched) {
          for (const k of idx.keywords) {
            const d = editDistanceWithin(token, k, budget);
            if (d <= budget) { hit(Math.round(W.FUZZY_KEYWORD / d)); break; }
          }
        }
      }
    }
  }

  return best;
}

/**
 * Score one item against a query.
 *
 * @returns {number} 0 when the item is not a match at all.
 */
function scoreItem(item, query, opts = {}) {
  const tokens = opts.tokens || tokenise(query);
  if (!tokens.length) return 0;

  const idx = item.__idx || (item.__idx = indexItem(item));
  const full = opts.full != null ? opts.full : normalise(query);

  // Whole-query pass first. "google workspace" typed in full should beat an
  // item that happens to contain both words scattered in its description.
  let score = 0;
  if (full && tokens.length > 1) {
    if (idx.name === full) score += W.NAME_EXACT;
    else if (idx.name.startsWith(full)) score += W.NAME_PREFIX;
    else if (idx.name.includes(full)) score += W.NAME_CONTAINS;
    if (idx.tags.includes(full)) score += W.TAG_EXACT;
    else if (idx.keywords.includes(full)) score += W.KEYWORD_EXACT;
  }

  // Every token must contribute something. A query is a conjunction: if you
  // typed two words, an item matching only one of them is usually the wrong
  // answer, and letting it through is how "adobe photoshop" ends up
  // returning every Adobe product AND every item mentioning photoshop.
  let matched = 0;
  for (const tok of tokens) {
    const s = scoreToken(idx, tok);
    if (s > 0) { matched++; score += s; }
  }
  if (matched === 0) return 0;

  // One unmatched token out of several is tolerated but heavily penalised —
  // people do type a stray word ("adobe photoshop licence"), and dropping to
  // zero results is worse than a demoted-but-present answer.
  if (matched < tokens.length) {
    const coverage = matched / tokens.length;
    if (coverage < 0.5) return 0;
    score = Math.round(score * coverage * 0.5);
  }

  // Popularity as a nudge, not a lever: enough to separate two items that
  // scored identically, never enough to move one past a better text match.
  const pop = Number(item.request_count) || 0;
  if (pop > 0) score += Math.min(40, Math.log10(pop + 1) * 20);

  // Shorter names win ties. "Slack" should beat "Slack Connect Guest Access"
  // for the query "slack".
  if (idx.name) score += Math.max(0, 12 - idx.name.length / 8);

  return score;
}

/**
 * Rank `items` against `query`, dropping non-matches.
 *
 * @param {Array} items      already-authorised candidate rows
 * @param {string} query
 * @param {{limit?: number, minScore?: number}} [opts]
 * @returns {Array} matching items, best first, each with `_score`
 */
function rankItems(items, query, opts = {}) {
  const tokens = tokenise(query);
  if (!tokens.length) return [];
  const full = normalise(query);
  const minScore = opts.minScore || 0;

  const out = [];
  for (const item of items) {
    const score = scoreItem(item, query, { tokens, full });
    if (score > minScore) out.push({ item, score });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = Number(a.item.request_count) || 0;
    const bp = Number(b.item.request_count) || 0;
    if (bp !== ap) return bp - ap;
    return String(a.item.name || '').localeCompare(String(b.item.name || ''));
  });

  const limited = opts.limit ? out.slice(0, opts.limit) : out;
  return limited.map(({ item, score }) => {
    // Don't leak the memo onto the response body.
    const { __idx, ...rest } = item;
    return { ...rest, _score: Math.round(score) };
  });
}

/**
 * Confidence bands for "did you mean this app?" flows.
 *
 * The absolute numbers only mean anything relative to the weights above:
 *   strong  — an exact name/tag hit, or a clean prefix. Safe to preselect.
 *   likely  — a solid partial. Show it first, but ask.
 *   weak    — a fuzzy or description-only hit. Offer as one of several.
 */
function confidenceOf(score, runnerUpScore = 0) {
  if (score >= W.NAME_EXACT) return 'strong';
  if (score >= W.TAG_EXACT) return runnerUpScore && score - runnerUpScore < 120 ? 'likely' : 'strong';
  if (score >= W.NAME_CONTAINS) return 'likely';
  return 'weak';
}

// ── Matching a catalog item out of free text ──────────────────────────────
//
// `rankItems` is for a SEARCH BOX, where the whole input is the query and
// treating it as a conjunction is right. A ticket is the opposite: the input
// is a sentence someone wrote ("Hi, could I please get access to Figma for
// the new brand work?"), so requiring every token to match returns nothing —
// the coverage floor in scoreItem would zero out every candidate.
//
// So this mode scores an item by its BEST-matching token instead, after
// throwing away the words that appear in every IT request and say nothing
// about which app is wanted.

const REQUEST_STOPWORDS = new Set([
  // politeness and request framing
  'hi','hello','hey','please','thanks','thank','you','kind','regards','dear','team',
  'could','can','would','will','shall','may','might','need','needs','needed','want',
  'wants','wanted','like','get','getting','give','required','require','requires',
  'request','requesting','requested','asking','ask','raise','raised','ticket','issue',
  'help','support','urgent','asap','morning','afternoon',
  // access vocabulary — present in nearly every one of these tickets
  'access','account','accounts','licence','license','licenses','licences','seat','seats',
  'permission','permissions','login','log','sign','signin','set','setup','install',
  'installed','installation','add','added','adding','new','user','users','create',
  'created','enable','enabled','activate','grant','granted','provision','onboard',
  // generic glue
  'a','an','the','to','for','of','on','in','at','and','or','my','me','our','we','us',
  'is','are','be','been','it','this','that','with','from','into','as','by','so','if',
  'do','does','did','have','has','had','was','were','am','not','no','yes','also',
  'work','working','use','using','used','plea','asap','today','tomorrow','week',
]);

/**
 * Tokens from free text that could plausibly name a product.
 *
 * Single characters and pure numbers go too — "1Password" survives because
 * `normalise` keeps digits inside a word, but a bare "2" from "2 seats"
 * is noise that would fuzzy-match its way into something.
 */
function extractQueryTerms(text) {
  const seen = new Set();
  const out = [];
  for (const tok of tokenise(text)) {
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (REQUEST_STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Find the catalog item a piece of free text is asking for.
 *
 * @param {Array}  items  already-authorised candidate rows
 * @param {string} text   ticket subject + description, or any free text
 * @param {{limit?: number}} [opts]
 * @returns {{terms: string[], candidates: Array}} candidates carry `_score`
 *          and `_confidence` ('strong' | 'likely' | 'weak'), best first.
 */
function matchFromText(items, text, opts = {}) {
  const terms = extractQueryTerms(text);
  if (!terms.length) return { terms: [], candidates: [] };

  // Adjacent pairs, so a two-word product name ("adobe photoshop", "google
  // workspace") can score as one unit rather than as two weaker singles.
  const pairs = [];
  for (let i = 0; i < terms.length - 1; i++) pairs.push(terms[i] + ' ' + terms[i + 1]);

  const indexed = items.map((item) => item.__idx || (item.__idx = indexItem(item)));

  // Pass 1 — which terms match something CLEANLY anywhere in the catalog?
  //
  // This is what separates a typo from an ordinary word. "slak" appears
  // nowhere, so one edit from "slack" means the person meant Slack and
  // mistyped it. "password" DOES appear (inside "1Password", and as the tag
  // "passwords"), so it is a real word that merely resembles a product — and
  // "please reset my password" must not turn into a 1Password request.
  const cleanlyMatched = new Set();
  for (const tok of terms) {
    for (const idx of indexed) {
      if (scoreToken(idx, tok, true) > 0) { cleanlyMatched.add(tok); break; }
    }
  }

  const scored = [];
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    const idx = indexed[n];

    let best = 0;
    for (const tok of terms) {
      const s = scoreToken(idx, tok);
      if (s > best) best = s;
    }

    // A term that matched nothing anywhere, but sits one edit from this
    // item's own name, is a misspelling of it. Scored as a name hit — the
    // generic FUZZY_NAME weight has to stay low so it can never outrank a
    // real substring inside a search box, which puts it under the noise
    // floor below and would drop these entirely.
    for (const tok of terms) {
      if (tok.length < 4 || cleanlyMatched.has(tok)) continue;
      for (const w of idx.nameWords) {
        if (w.length < 4) continue;
        if (editDistanceWithin(tok, w, 1) <= 1) { best = Math.max(best, W.NAME_PREFIX); break; }
      }
      if (best >= W.NAME_PREFIX) break;
    }
    // A pair that matches the name outright is much stronger evidence than
    // either half alone.
    for (const pair of pairs) {
      if (idx.name === pair) best = Math.max(best, W.NAME_EXACT);
      else if (idx.name.includes(pair)) best = Math.max(best, W.NAME_PREFIX);
      else if (idx.tags.includes(pair)) best = Math.max(best, W.TAG_EXACT);
      else if (idx.keywords.includes(pair)) best = Math.max(best, W.KEYWORD_EXACT);
    }

    // Below a word-prefix hit we're into description and fuzzy noise —
    // "the design work" should not surface a product called "Work".
    if (best < W.NAME_WORD_PREFIX) continue;

    // A second distinct term also hitting the same item corroborates it.
    let hits = 0;
    for (const tok of terms) if (scoreToken(idx, tok) >= W.NAME_WORD_PREFIX) hits++;
    if (hits > 1) best += 60 * Math.min(hits - 1, 2);

    scored.push({ item, score: best });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = Number(a.item.request_count) || 0;
    const bp = Number(b.item.request_count) || 0;
    if (bp !== ap) return bp - ap;
    return String(a.item.name || '').localeCompare(String(b.item.name || ''));
  });

  const limited = scored.slice(0, opts.limit || 6);
  return {
    terms,
    candidates: limited.map(({ item, score }, i) => {
      const { __idx, ...rest } = item;
      return {
        ...rest,
        _score: Math.round(score),
        _confidence: confidenceOf(score, i === 0 ? (limited[1]?.score || 0) : 0),
      };
    }),
  };
}

export {
  rankItems,
  scoreItem,
  indexItem,
  tokenise,
  normalise,
  toTags,
  editDistanceWithin,
  confidenceOf,
  matchFromText,
  extractQueryTerms,
  W as WEIGHTS,
};
