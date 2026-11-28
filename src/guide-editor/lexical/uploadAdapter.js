// Upload seam for the ported Lexical editor.
//
// Upstream (slicedesk) this was `import { uploadApi } from '../../../api/apps'`
// — an axios client POSTing FormData to slicedesk's /api/upload. it-hub uploads
// differently (base64 JSON to /api/uploads; see public/admin.html's IMAGE UPLOAD
// HELPERS section and the note in nginx.client.conf:19-20 about 10 MB+ JSON
// envelopes), so the dependency is inverted instead of rewritten: the host app
// injects its own uploader at mount time.
//
// Deliberately keeps the axios-shaped `{ data: { url } }` return so the four
// existing call sites in LexicalEditor.jsx (675, 1161, 1478, 1530) — all of
// which do `const { data } = await uploadApi.upload(file)` — stay untouched.
// Fewer edits in an 1,800-line vendored file means fewer merge conflicts the
// next time it is re-synced from slicedesk.

let impl = null;

/** Register the host app's uploader. `fn(file)` must resolve to a URL string. */
export function setUploader(fn) {
  impl = typeof fn === 'function' ? fn : null;
}

export const uploadApi = {
  async upload(file, opts = {}) {
    if (!impl) {
      // Surfaces as "Image upload failed:" in the console via the callers'
      // existing try/catch, rather than silently inserting a broken image.
      throw new Error('GuideEditor: no uploader configured — pass onUpload to mount()');
    }
    // opts.quiet: the caller shows the error itself, so the host should not
    // also toast it.
    const url = await impl(file, opts);
    if (!url || typeof url !== 'string') {
      throw new Error('GuideEditor: onUpload must resolve to a URL string');
    }
    return { data: { url } };
  },
};
