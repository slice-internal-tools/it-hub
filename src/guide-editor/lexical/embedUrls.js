// URL → embeddable iframe src. Ported from the training module's editor so the
// Docs editor supports the same Google Doc/Drive embeds and video embeds.

// Video: YouTube (watch/embed/shorts/youtu.be), Vimeo, Google Drive file preview.
export function toEmbedUrl(raw) {
  if (!raw) return null;
  const url = raw.trim();

  // YouTube
  let m =
    url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;

  // Vimeo
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;

  // Loom (share or embed links) — the usual tool for IT screen recordings.
  m = url.match(/loom\.com\/(?:share|embed)\/([a-f0-9]{16,})/i);
  if (m) return `https://www.loom.com/embed/${m[1]}`;

  // Google Drive file
  m = url.match(/drive\.google\.com\/(?:file\/d\/|[^]*[?&]id=)([\w-]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;

  return null;
}

// Google Docs / Sheets / Slides → embeddable iframe src.
//
// IMPORTANT: SliceDesk is a *different origin* from docs.google.com, so the doc
// is loaded as a third-party iframe. When the browser blocks third-party
// cookies (Safari always, Chrome increasingly), Google can't see the viewer's
// signed-in session inside the iframe → it shows a "sign in" wall even for
// documents the viewer legitimately has access to. The only rendering that
// works *without* a Google session is the "Publish to web" form (File → Share →
// Publish to web), which serves a public, cookieless snapshot. So we normalize
// to the publish-to-web embed URLs. (Docs restricted to specific people/org
// therefore must be Published to web to embed — surfaced as a hint in the
// editor's embed dialog.)
export function toDocEmbedUrl(raw) {
  if (!raw) return null;
  const url = raw.trim();

  // Already a Publish-to-web / pre-embedded URL — pass through unchanged.
  // Published URLs use the opaque /d/e/<pubId>/ form (which can't be derived
  // from the normal doc id), and carry /pub, /pubhtml or embedded=true.
  // Only when it really is docs.google.com over https: matching "/pubhtml" or
  // "embedded=true" anywhere let ANY site through as an iframe.
  if (
    isGoogleDocsHost(url) && (
      /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/e\//.test(url) ||
      /\/pubhtml/.test(url) ||
      /[?&]embedded=true/.test(url)
    )
  ) {
    return url;
  }

  let m = url.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  if (m) return `https://docs.google.com/document/d/${m[1]}/pub?embedded=true`;

  m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/pubhtml?widget=true&headers=false`;

  m = url.match(/docs\.google\.com\/presentation\/d\/([\w-]+)/);
  if (m) return `https://docs.google.com/presentation/d/${m[1]}/embed?start=false&loop=false`;

  // Plain Google Drive folder/file as a doc embed fallback.
  m = url.match(/drive\.google\.com\/(?:file\/d\/|[^]*[?&]id=)([\w-]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;

  return null;
}

function isGoogleDocsHost(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'docs.google.com';
  } catch { return false; }
}

// The only hosts an embed iframe may point at. Checked when the block RENDERS
// (EmbedNode), not just when it is inserted from the toolbar: guide content is
// stored JSON shared with SliceDesk Docs, so a src can arrive from elsewhere.
const EMBED_HOSTS = new Set([
  'www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com',
  'www.loom.com', 'docs.google.com', 'drive.google.com',
]);
export function isAllowedEmbedSrc(src) {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && EMBED_HOSTS.has(u.hostname);
  } catch { return false; }
}

// Human label for the embed panel's "Recognised: …" line, or null.
export function describeEmbed(raw) {
  const r = resolveEmbed(raw);
  if (!r) return null;
  const s = r.src;
  if (s.includes('youtube.com')) return 'YouTube video';
  if (s.includes('vimeo.com')) return 'Vimeo video';
  if (s.includes('loom.com')) return 'Loom video';
  if (s.includes('/document/')) return 'Google Doc';
  if (s.includes('/spreadsheets/')) return 'Google Sheet';
  if (s.includes('/presentation/')) return 'Google Slides';
  if (s.includes('drive.google.com')) return 'Google Drive file';
  return r.kind === 'video' ? 'Video' : 'Document';
}

// Resolve any supported URL → { src, kind } or null.
export function resolveEmbed(raw) {
  const doc = toDocEmbedUrl(raw);
  if (doc) return { src: doc, kind: 'doc' };
  const video = toEmbedUrl(raw);
  if (video) return { src: video, kind: 'video' };
  return null;
}
