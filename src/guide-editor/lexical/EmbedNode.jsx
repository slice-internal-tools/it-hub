import { DecoratorNode } from 'lexical';
// PORTED: was '../PdfEmbed' (pdf.js canvases). Local stub renders a link —
// see PdfEmbed.jsx for why. Video/Doc embeds are unaffected.
import PdfEmbed from './PdfEmbed';
import { isAllowedEmbedSrc } from './embedUrls';

// Generic embed node — backs video (YouTube/Vimeo/Drive) embeds, Google Doc/
// Sheet/Slide embeds (iframe), and same-origin PDF-proxy embeds (rendered via
// pdf.js canvases, NOT an iframe — see PdfEmbed.jsx for why) in the Docs
// editor. Follows the ImageNode DecoratorNode pattern. `src` is an already-
// normalized URL (see embedUrls.js for video/doc; PDF-proxy URLs come from
// server/sync/policyDriveSync.js), `kind` is 'video' | 'doc' | 'pdf'.

function EmbedComponent({ src, kind, title }) {
  const isVideo = kind === 'video';
  const isPdf = kind === 'pdf';
  // Never iframe a host we don't know (see isAllowedEmbedSrc). PDFs render via
  // PdfEmbed — a link, not an iframe — so they keep their own path.
  if (!isPdf && !isAllowedEmbedSrc(src)) {
    return (
      <div className="lexical-embed my-3 block" data-embed-kind={kind}>
        <div className="rounded-lg border border-border px-4 py-3 text-sm text-text-muted">
          This embed isn't from a supported site, so it isn't shown.
        </div>
      </div>
    );
  }
  // PDFs read better tall (multi-page, internal scroll) than the squarish
  // 4:3 box used for Doc/Sheet embeds.
  const boxStyle = isVideo
    ? { aspectRatio: '16 / 9' }
    : isPdf
      ? { height: 780, maxWidth: 820 }
      : { aspectRatio: '4 / 3', maxWidth: 820 };
  return (
    <div className="lexical-embed my-3 block ml-6" data-embed-kind={kind}>
      <div
        className="relative w-full overflow-hidden rounded-lg border border-border bg-black/5"
        style={boxStyle}
      >
        {isPdf ? (
          <PdfEmbed src={src} title={title} />
        ) : (
          <iframe
            src={src}
            title={title || (isVideo ? 'Embedded video' : 'Embedded document')}
            className="absolute inset-0 w-full h-full"
            style={{ border: 0 }}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        )}
      </div>
    </div>
  );
}

export class EmbedNode extends DecoratorNode {
  __src;
  __embedKind;
  __title;

  static getType() { return 'embed'; }

  static clone(node) {
    return new EmbedNode(node.__src, node.__embedKind, node.__title, node.__key);
  }

  constructor(src, kind, title, key) {
    super(key);
    this.__src = src;
    this.__embedKind = kind || 'video';
    this.__title = title || '';
  }

  static importJSON(s) {
    return $createEmbedNode({ src: s.src, kind: s.kind, title: s.title });
  }

  exportJSON() {
    return {
      type: 'embed',
      version: 1,
      src: this.__src,
      kind: this.__embedKind,
      title: this.__title,
    };
  }

  createDOM() {
    return document.createElement('div');
  }

  updateDOM() { return false; }

  isInline() { return false; }

  decorate() {
    return <EmbedComponent src={this.__src} kind={this.__embedKind} title={this.__title} />;
  }
}

export function $createEmbedNode({ src, kind, title }) {
  return new EmbedNode(src, kind, title);
}

export function $isEmbedNode(node) {
  return node instanceof EmbedNode;
}
