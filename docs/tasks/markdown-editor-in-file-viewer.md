# Task: In-Browser Markdown Editor with Save-to-Host

**Created:** 2026-07-05
**Completed:** 2026-07-05
**Status:** completed

## Goal

Add an "Edit" toggle to the markdown file viewer (`/api/files/view/:token`) that switches from rendered preview to a raw-text editor, allowing in-browser editing and saving changes back to the host filesystem.

## Deep Analysis

### Current Architecture (Pre-Change)

```
Frontend chat UI                  Backend (miniclaw-ui.js)
─────────────────                 ─────────────────────────
viewFile(filePath)
  │
  ▼
POST /api/files/share             → Creates one-shot token { path }
  { filePath }                    → File validated against ALLOWED_PREFIXES
  │                               → File read from disk
  ▼                               
window.open(viewUrl)              
  │
  ▼
GET /api/files/view/:token        → Token consumed (deleted from Map)
                                   → File read: max 2MB, utf8 for text
                                   → generateViewerPage(filePath, content, title)
                                   → Returns standalone HTML page

Standalone HTML page loads:
  • marked.js from CDN → renders markdown into #md-view
  • window.__FC__ = raw file content (JSON-encoded)
  • window.__FN__ = filename
  • "⬇ Download" → client-side Blob download
  • "✕ Close" → window.close()
  • ⚠ NO knowledge of original file path
  • ⚠ NO connection back to server for writes
```

### Key Design Constraints

| Constraint | Detail |
|-----------|--------|
| **One-shot token** | The view token is consumed on page load. After that, the server has no record of which file was being viewed. |
| **Standalone page** | The viewer is a completely independent HTML page (not part of the SPA). It shares no JS state with the main app. |
| **No file path on client** | `window.__FC__` contains the content, `window.__FN__` contains the filename — but the full path is not embedded. |
| **Same-origin auth** | The viewer page is served from the same origin (port 1234). The browser automatically sends cached HTTP Basic Auth credentials on all same-origin fetch() calls. This means we DON'T need a separate auth token for writes. |
| **Security boundary** | The save endpoint must re-validate the file path against `FILE_SHARE_ALLOWED_PREFIXES` server-side. Client-supplied paths are untrusted. |
| **Server-side file writes** | The backend is the only party that can write to disk. The viewer page must POST content back to the server, which performs the actual write. |

### Decision: No Separate Write Token Needed

The viewer page shares the origin (`localhost:1234`) with the main app. The browser's HTTP Basic Auth cache means any `fetch()` from the viewer page to `/api/files/save` will automatically include the `Authorization` header. This simplifies the design:

- **Design rejected:** Separate write-token system (adds complexity: new Map, TTL management, cleanup)
- **Design chosen:** Embed original file path in viewer page, add save endpoint that re-validates auth + path, use existing Basic Auth for authentication

### Security Model

```
Viewer page sends:  POST /api/files/save   { filePath: "/home/ju/some/file.md", content: "..." }
                       │
                       ▼
Server validates:
  1. Basic Auth header ✓  (same as all other endpoints)
  2. filePath starts with FILE_SHARE_ALLOWED_PREFIXES  ✓  (path traversal defense)
  3. filePath resolves to an existing file  ✓  (no arbitrary file creation)
  4. Atomic write: temp file → fs.rename  ✓  (no partial writes)
```

## Implementation Plan

### 1. Backend: Embed file path in markdown viewer page

**File:** `miniclaw-ui.js` — `generateViewerPage()` markdown branch (~L357)

**Change:** Add `window.__FP__` with the original file path (JSON-encoded for safety) alongside the existing `window.__FC__` and `window.__FN__`.

```js
// Current:
<script>window.__FC__=${encodedContent};window.__FN__=${JSON.stringify(title)};...

// New:
<script>window.__FP__=${JSON.stringify(filePath)};window.__FC__=${encodedContent};window.__FN__=${JSON.stringify(title)};...
```

`filePath` is the validated, resolved path already passed to `generateViewerPage(filePath, content, title)`. It was validated by the share endpoint before the function was called.

### 2. Backend: New save endpoint `POST /api/files/save`

**File:** `miniclaw-ui.js` — `handleRequest()` (before the `/api/status` catch-all)

**Location:** After the existing file viewer route (~L1644, before `if (parsedUrl.pathname === '/api/status')`)

**Implementation:**

```js
// Save edited file content
if (parsedUrl.pathname === '/api/files/save' && req.method === 'POST') {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { filePath, content } = JSON.parse(body);
      if (!filePath || content === undefined || content === null) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'filePath and content are required' }));
        return;
      }

      // Re-validate path against allowed prefixes (defense in depth)
      const resolved = path.resolve(filePath);
      const allowed = FILE_SHARE_ALLOWED_PREFIXES.some(prefix => resolved.startsWith(prefix));
      if (!allowed) {
        log('warn', `File save rejected (path not allowed): ${resolved}`);
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `File path not allowed: ${resolved}` }));
        return;
      }

      // Verify file exists (edit-only, no creation)
      if (!fs.existsSync(resolved)) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      try {
        if (!fs.statSync(resolved).isFile()) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Path is not a regular file' }));
          return;
        }
      } catch (statErr) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Cannot stat file: ' + statErr.message }));
        return;
      }

      // Enforce size limit (same as viewer: 2MB)
      const MAX_SAVE_SIZE = 2 * 1024 * 1024;
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > MAX_SAVE_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Content exceeds 2MB limit' }));
        return;
      }

      // Atomic write: write to temp file, then rename
      const tempPath = resolved + '.tmp.' + crypto.randomUUID();
      fs.writeFileSync(tempPath, content, 'utf8');
      fs.renameSync(tempPath, resolved);

      log('info', `File saved via editor: ${resolved} (${contentBytes} bytes)`);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ saved: true, path: resolved, size: contentBytes }));
    } catch (e) {
      log('error', `File save failed: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return;
}
```

**Auth:** No change needed. The existing Basic Auth check at the top of `handleRequest()` applies to all routes. The viewer page is same-origin, so the browser automatically sends the cached credentials.

### 3. Frontend: Edit/Preview/Save UI in viewer page

**File:** `miniclaw-ui.js` — `generateViewerPage()` markdown branch (~L357)

**Current markdown viewer output:**

```html
<div id="bar">
  <span class="name">📝 filename.md</span>
  <span class="spacer"></span>
  <span style="...">Markdown</span>
  <button class="dl" onclick="downloadFile()">⬇ Download</button>
  <button class="close" onclick="window.close()">✕</button>
</div>
<div id="main"><div id="md-view"></div></div>
<script src="...marked.min.js"></script>
<script>
  document.getElementById('md-view').innerHTML = marked.parse(content);
</script>
<script>
  window.__FC__ = content; window.__FN__ = filename;
  function downloadFile() { /* Blob download */ }
</script>
```

**New markdown viewer output:**

```html
<div id="bar">
  <span class="name">📝 filename.md</span>
  <span class="spacer"></span>
  <span id="mode-badge" style="...">Markdown</span>
  <button id="btn-edit" class="dl" onclick="toggleEdit()" style="background:#f9e2af;color:#1e1e2e">✏️ Edit</button>
  <button class="dl" onclick="downloadFile()">⬇ Download</button>
  <button class="close" onclick="window.close()">✕</button>
</div>
<div id="main">
  <div id="md-view"></div>
  <textarea id="md-editor" style="display:none"></textarea>
</div>

<!-- Inline CSS for editor -->
<style>
#md-editor {
  position:absolute; inset:0;
  background:#11111b; color:#cdd6f4;
  border:none; padding:24px 32px;
  font-family:'SF Mono','Fira Code',monospace;
  font-size:13px; line-height:1.7;
  resize:none; outline:none;
  tab-size:2;
}
#btn-edit.danger { background:#f38ba8; }
#btn-edit.saving { background:#a6e3a1; opacity:0.5; pointer-events:none; }
</style>

<script src="...marked.min.js"></script>
<script>
window.__FP__ = "<encoded filePath>";
window.__FC__ = <encoded content>;
window.__FN__ = <encoded filename>;
var _editing = false;

function downloadFile() {
  var content = _editing ? document.getElementById('md-editor').value : window.__FC__;
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type:'application/octet-stream'}));
  a.download = window.__FN__;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function toggleEdit() {
  var mdView = document.getElementById('md-view');
  var editor = document.getElementById('md-editor');
  var btn = document.getElementById('btn-edit');
  var badge = document.getElementById('mode-badge');
  var main = document.getElementById('main');

  if (!_editing) {
    // Enter edit mode
    editor.value = window.__FC__;
    mdView.style.display = 'none';
    editor.style.display = '';
    btn.textContent = '💾 Save';
    btn.classList.add('danger');
    badge.textContent = 'Editing';
    _editing = true;
  } else {
    // Save
    var content = editor.value;
    btn.textContent = 'Saving...';
    btn.classList.add('saving');
    btn.classList.remove('danger');

    fetch('/api/files/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: window.__FP__, content: content })
    })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(e) { throw new Error(e.error); });
      return r.json();
    })
    .then(function(data) {
      // Update cached content, return to preview
      window.__FC__ = content;
      mdView.innerHTML = marked.parse(content);
      mdView.style.display = '';
      editor.style.display = 'none';
      btn.textContent = '✏️ Edit';
      btn.classList.remove('saving', 'danger');
      badge.textContent = 'Markdown';
      _editing = false;
    })
    .catch(function(err) {
      alert('Save failed: ' + err.message);
      btn.textContent = '💾 Save';
      btn.classList.remove('saving');
      btn.classList.add('danger');
    });
  }
}

// Initial render
document.getElementById('md-view').innerHTML = marked.parse(window.__FC__);
</script>
```

### 4. Frontend: Keyboard shortcut for save

Add a `keydown` handler on the textarea so `Ctrl+S` / `Cmd+S` triggers save (same as clicking the Save button):

```js
editor.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    toggleEdit(); // re-enters save path since _editing is true
  }
  // Escape to cancel edit
  if (e.key === 'Escape') {
    e.preventDefault();
    // Discard edits, return to preview
    mdView.style.display = '';
    editor.style.display = 'none';
    btn.textContent = '✏️ Edit';
    btn.classList.remove('danger', 'saving');
    badge.textContent = 'Markdown';
    _editing = false;
  }
});
```

### UI Behavior Summary

| State | Button | Badge | Main Area |
|-------|--------|-------|-----------|
| **Preview** (default) | ✏️ Edit (amber) | Markdown | Rendered HTML via marked.js |
| **Editing** | 💾 Save (red) | Editing | Raw text in `<textarea>` |
| **Saving** | Saving... (green, disabled) | Editing | Raw text (read-only while saving) |
| **After save** | ✏️ Edit (amber) | Markdown | Re-rendered preview with new content |

### Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Save fails (network error) | Alert + button returns to "💾 Save" state, content preserved in textarea |
| Save fails (403 - path not allowed) | Alert with server message |
| Save fails (404 - file deleted) | Alert, content preserved |
| File > 2MB | Rejected by server with 413 |
| User clicks Download while editing | Downloads current textarea content (not original) |
| User presses Escape while editing | Discards edits, returns to preview |
| User presses Ctrl+S while editing | Triggers save |
| User closes tab while editing | Content lost (browser-native behavior, no prompt) |
| Concurrent edits (two tabs) | Last save wins — atomic writes prevent corruption |

## Files Changed

| File | Section(s) | Change |
|------|-----------|--------|
| `miniclaw-ui.js` | `generateViewerPage` markdown branch (~L357) | Add `window.__FP__`, edit button, textarea, toggleEdit/downloadFile logic, inline CSS |
| `miniclaw-ui.js` | `handleRequest` (~L1644, before `/api/status`) | Add `POST /api/files/save` endpoint |

## Out of Scope (Future Enhancements)

- **CodeMirror editor:** Using a `<textarea>` for MVP. Future: integrate CodeMirror 5 (already loaded for code files) for syntax highlighting, line numbers, and better editing UX in markdown mode.
- **Unsaved changes warning:** `beforeunload` event to prompt user when exiting with unsaved edits.
- **Edit button for code files:** This feature is scoped to markdown files. Code files could follow the same pattern later.
- **File creation:** Currently only supports editing existing files. Creating new files from the viewer is not in scope.
- **Auto-save / drafts:** No localStorage persistence of unsaved edits.

## Verification Checklist

- [x] Open any `.md` file via "View" button in chat → page loads with markdown preview
- [x] Click "✏️ Edit" → switches to raw text `<textarea>` with file content
- [x] Modify content in textarea
- [x] Click "💾 Save" → button shows "Saving..." → returns to preview with updated content
- [x] Verify file on disk reflects the saved changes
- [x] Click "✏️ Edit" again → textarea shows the updated (saved) content
- [x] Press Escape while editing → discards edits, returns to preview with original content
- [x] Press Ctrl+S while editing → saves and returns to preview
- [x] Click Download while editing → downloads current editor content (not original)
- [x] Try saving a file outside allowed prefixes (hack `window.__FP__` in console) → 403 error
- [x] Try saving a non-existent file path → 404 error
- [x] Try saving content > 2MB → 413 error
- [x] Network disconnect during save → alert shown, editor state preserved
- [x] Non-markdown files (code, binary) → no Edit button appears (unchanged)
- [x] `window.__FP__` correctly embeds the full original file path
- [x] `POST /api/files/save` endpoint validates all inputs before writing
- [x] Atomic write (temp file → rename) prevents partial/corrupt saves
- [x] Basic Auth passthrough works (same-origin viewer page sends cached credentials)
