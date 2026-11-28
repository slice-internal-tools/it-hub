// AI assistant palette — rebuilt for Lexical.
//
// Replaces the TipTap-era "AI ASSISTANT MENU" that was deleted with that layer.
// Opens at the caret on ⌘J (or from the toolbar), filters as you type, runs the
// chosen action against the host's AI endpoint, and writes the result back.
//
// Two deliberate differences from the version it replaces:
//
//  1. NO FAKE TONE ACTIONS. The old menu offered "Make more professional" and
//     "Make friendlier", neither of which the server has a prompt for — every
//     call 400'd and silently fell through to regex string replacement
//     (`t.replace(/\bhi\b/gi,'Hello')…`) presented as AI. Both are gone. Every
//     action here maps to a real server prompt, and a failure says so.
//
//  2. NO SILENT LOCAL FALLBACKS. The old one caught server errors and quietly
//     substituted hand-written string transforms. Here an error surfaces as an
//     error, because "the AI is down" and "the AI rewrote your paragraph" should
//     never look the same.
//
// Block-producing actions (bullets/steps/table/summary/continue/brainstorm) get
// their Markdown result converted into real Lexical nodes via markdownImport,
// so "convert to table" yields an actual table rather than pipe characters.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $insertNodes,
  $parseSerializedNode,
} from 'lexical';
import { markdownToLexicalJson } from './markdownImport';

// `block: true` → the result is block-level Markdown and replaces the selected
// block(s) as nodes. Otherwise it is inline text swapped into the selection.
// `needsSelection: false` → operates on the whole document or the title.
export const AI_ACTIONS = [
  { group: 'Edit selection', action: 'improve', label: 'Improve writing', desc: 'Tighten and polish' },
  { group: 'Edit selection', action: 'shorter', label: 'Make shorter', desc: 'Half the length, same meaning' },
  { group: 'Edit selection', action: 'longer', label: 'Make longer', desc: 'Expand with details and examples' },
  { group: 'Edit selection', action: 'grammar', label: 'Fix grammar & spelling', desc: 'Light proofread' },

  { group: 'Transform', action: 'bullets', label: 'Convert to bullets', desc: 'Break a paragraph into a list', block: true },
  { group: 'Transform', action: 'steps', label: 'Convert to numbered steps', desc: 'For procedures', block: true },
  { group: 'Transform', action: 'table', label: 'Convert to table', desc: 'Turn "X | Y | Z" lines into a table', block: true },

  { group: 'Generate', action: 'summary', label: 'Summarize', desc: 'TL;DR of the whole guide', block: true, wholeDoc: true, needsSelection: false },
  { group: 'Generate', action: 'continue', label: 'Continue writing', desc: 'Pick up where you left off', block: true, wholeDoc: true, needsSelection: false, append: true },
  { group: 'Generate', action: 'brainstorm', label: 'Brainstorm sections', desc: 'Outline ideas from the title', block: true, needsSelection: false, append: true },
];

const GROUPS = ['Edit selection', 'Transform', 'Generate'];

export default function AiAssistantPlugin({ onAiAction, getTitle }) {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [hasSelection, setHasSelection] = useState(false);
  const inputRef = useRef(null);

  const configured = typeof onAiAction === 'function';

  const filtered = AI_ACTIONS.filter((a) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return a.label.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q) || a.action.includes(q);
  });

  const openAt = useCallback(() => {
    // Anchor to the live selection rectangle so the palette appears where the
    // author is working rather than at a fixed spot.
    const domSel = window.getSelection();
    let top = null, left = null, selected = false;
    if (domSel && domSel.rangeCount > 0) {
      const rect = domSel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.top || rect.left)) {
        top = rect.bottom + 8;
        left = rect.left;
      }
      selected = !domSel.isCollapsed;
    }
    // No caret to anchor to (e.g. opened from the toolbar with nothing
    // selected): drop it under the AI button rather than at a fixed 120,120,
    // which put it in the page margin. Always keep it fully on screen.
    if (top == null) {
      const btn = document.querySelector('.lexical-ai-btn');
      const r = btn && btn.getBoundingClientRect();
      top = r ? r.bottom + 8 : 120;
      left = r ? r.right - 320 : 120;
    }
    left = Math.max(12, Math.min(left, window.innerWidth - 332));
    top = Math.max(12, Math.min(top, window.innerHeight - 160));
    setPos({ top, left });
    setHasSelection(selected);
    setQuery('');
    setCursor(0);
    setError('');
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 20);
  }, []);

  // ⌘J / Ctrl+J
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        openAt();
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    // Capture phase: admin.html also binds ⌘-shortcuts on window.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, openAt]);

  // Toolbar button dispatches this instead of reaching into component state.
  useEffect(() => {
    const onOpenEvent = () => openAt();
    window.addEventListener('guide-editor:open-ai', onOpenEvent);
    return () => window.removeEventListener('guide-editor:open-ai', onOpenEvent);
  }, [openAt]);

  const run = async (item) => {
    if (!configured) { setError('No AI endpoint configured for this editor.'); return; }
    setError('');
    setBusy(item.action);

    // Gather the input text on the editor thread.
    let input = '';
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if (item.wholeDoc || !$isRangeSelection(sel) || sel.isCollapsed()) {
        input = $getRoot().getTextContent();
      } else {
        input = sel.getTextContent();
      }
    });

    if (item.needsSelection !== false && !input.trim()) {
      setBusy(null);
      setError('Select some text first.');
      return;
    }

    try {
      const result = await onAiAction(item.action, { text: input, title: getTitle?.() || '' });
      const out = String(result || '').trim();
      if (!out) throw new Error('The AI returned nothing.');

      editor.update(() => {
        const sel = $getSelection();

        if (!item.block) {
          // Inline rewrite: swap the selected text for the result.
          if ($isRangeSelection(sel) && !sel.isCollapsed()) sel.insertText(out);
          else if ($isRangeSelection(sel)) sel.insertText(out);
          return;
        }

        // Block result: convert the Markdown the server returns into real nodes
        // (lists, tables, headings) rather than pasting raw pipes and dashes.
        //
        // markdownToLexicalJson runs a headless editor, so we get serialized
        // JSON back and rehydrate it with $parseSerializedNode — the supported
        // way to turn one serialized subtree into a live node. (Reading nodes
        // out of a second editor's state and re-using them across editors is
        // not: they carry that editor's keys.)
        const json = markdownToLexicalJson(out);
        let nodes = null;
        if (json) {
          try {
            const children = JSON.parse(json)?.root?.children || [];
            nodes = children.map((c) => $parseSerializedNode(c)).filter(Boolean);
          } catch { nodes = null; }
        }
        if (!nodes || !nodes.length) {
          // Fall back to plain paragraphs — still the model's text, just unstyled.
          nodes = out.split(/\n{2,}/).map((para) => {
            const p = $createParagraphNode();
            p.append($createTextNode(para.replace(/\n/g, ' ').trim()));
            return p;
          });
        }
        if (item.append) {
          $getRoot().append(...nodes);
        } else if ($isRangeSelection(sel)) {
          $insertNodes(nodes);
        } else {
          $getRoot().append(...nodes);
        }
      });
      setOpen(false);
    } catch (err) {
      // Deliberately surfaced, not swallowed into a regex "fallback".
      setError(err?.message || 'The AI request failed.');
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="lexical-ai-scrim" onMouseDown={() => setOpen(false)} />
      <div
        className="lexical-ai-menu"
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="lexical-ai-input"
          value={query}
          placeholder="Ask AI to…"
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (filtered[cursor]) run(filtered[cursor]); }
            else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          }}
        />

        {error && <div className="lexical-ai-error">{error}</div>}
        {!hasSelection && !error && (
          <div className="lexical-ai-hint">No selection — “Edit selection” actions need some text.</div>
        )}

        <div className="lexical-ai-list">
          {filtered.length === 0 && <div className="lexical-ai-empty">No matching action.</div>}
          {GROUPS.map((g) => {
            const items = filtered.filter((a) => a.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="lexical-ai-group">{g}</div>
                {items.map((item) => {
                  const idx = filtered.indexOf(item);
                  const disabled = item.needsSelection !== false && !hasSelection;
                  return (
                    <button
                      key={item.action}
                      type="button"
                      className={`lexical-ai-item${idx === cursor ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => { if (!disabled) run(item); }}
                      disabled={!!busy || disabled}
                    >
                      <span className="lexical-ai-label">{item.label}</span>
                      <span className="lexical-ai-desc">
                        {busy === item.action ? 'Working…' : item.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
