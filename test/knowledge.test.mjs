/**
 * Chat retrieval ranking (server/knowledge.js): BM25 with a title boost,
 * Slice-specific synonyms, filler-word stopwords and a relative noise floor.
 *
 *   node --test test/*.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankChunks, terms } from '../server/knowledge.js';

const guide = (id, title, body, extra = {}) => ({ guide: { id, title, helpful_count: 0, ...extra }, content: body });
function prep(list) {
  return list.map(({ guide: g, content }, i) => {
    const toks = terms(g.title + ' ' + content);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { guide: g, content, tf, len: toks.length || 1, titleTerms: new Set(terms(g.title)), chunkIndex: i };
  });
}
const DOCS = prep([
  guide(1, 'Connect to GlobalProtect VPN', 'Open GlobalProtect, enter the portal address, sign in with OneLogin. If it disconnects, quit and reconnect.'),
  guide(2, "Slack keeps disconnecting or won't load", 'Quit Slack. Check your Wi-Fi. Step 6: check VPN, Slack works without it.'),
  guide(3, 'Reset my OneLogin password', 'Go to the OneLogin login page and choose Forgot password.'),
  guide(4, 'Phishing email — what to do', 'Suspicious email asking for your password? Do not click. Report it to Security.'),
  guide(5, 'Laptop running slow', 'Close heavy apps, restart, check storage.'),
  guide(6, "Wi-Fi isn't working", 'Toggle Wi-Fi, forget the network and rejoin.'),
]);
const top = (q) => rankChunks(DOCS, q, { limit: 3 }).map((r) => r.guide.id);

test('the guide the question is about outranks one that merely mentions the word', () => {
  assert.equal(top('vpn keeps disconnecting')[0], 1);   // not the Slack guide
});

test('synonyms: "weird email" finds the phishing guide, "mac is slow" the slow-laptop one', () => {
  assert.equal(top('got a weird email asking for my password')[0], 4);
  assert.equal(top('my mac is slow')[0], 5);
});

test('filler words alone match nothing (no noise for an unknown topic)', () => {
  assert.deepEqual(top('printer not working'), []);
  assert.deepEqual(top('it keeps not working still'), []);
});

test('results far behind the best are dropped', () => {
  const r = top('reset my onelogin password');
  assert.equal(r[0], 3);
  assert.ok(!r.includes(6) && !r.includes(5));
});

test('at most two chunks per guide', () => {
  const many = prep([1, 2, 3].map((i) => guide(9, 'VPN guide', `vpn part ${i}`)).map((x, i) => ({ ...x, content: x.content + ' ' + i })));
  assert.equal(rankChunks(many, 'vpn', { limit: 5 }).length, 2);
});

test('terms(): lowercases, strips accents and punctuation, light stemming', () => {
  assert.deepEqual(terms('Printers PRINTING café!'), ['print', 'print', 'cafe']);
});
