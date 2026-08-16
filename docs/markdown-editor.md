# Markdown Editor in File Viewer

## Overview

When viewing a markdown file through the file sharing system, an **Edit toggle** allows switching from rendered preview to a raw-text `<textarea>` editor. Changes can be saved back to the host filesystem with atomic writes. All authentication flows through the existing HTTP Basic Auth — the viewer page is same-origin, so the browser automatically sends cached credentials.

## Architecture

```
Frontend (viewer page)                         Backend (miniclaw-ui.js)
──────────────────────                         ─────────────────────────

POST /api/files/share                         Token created, file read
{ filePath: "/tmp/notes.md" }                 generateViewerPage() called
  │                                              │
  ▼                                              ▼
GET /api/files/view/:token                    Token consumed, page served
  │                                           window.__FP__ = filePath
  ▼                                           window.__FC__ = content
Standalone HTML page loads:                   window.__FN__ = filename
  • marked.js renders #md-view
  • "✏️ Edit" button → toggleEdit()
  • textarea appears with raw content
  • "💾 Save" button →                                    
  │                                                       
  ▼                                                       
POST /api/files/save                          Validates path + auth
{ filePath, content }                         Atomic write: tmp → rename
  │                                           200 { saved: true }
  ▼                                                       
Re-renders marked.js with new content
```

## Security Model

### Path Validation (Defense in Depth)

The save endpoint performs full re-validation of the supplied `filePath`. The client is untrusted — a user could modify `window.__FP__` in the browser console.

```
Client sends:   POST /api/files/save  { filePath: "/home/ju/...", content: "..." }
Server checks:
  1. Basic Auth header ✓          (same as every other endpoint)
  2. filePath starts with         (blocks path traversal and
     FILE_SHARE_ALLOWED_PREFIXES     access to non-whitelisted dirs)
  3. File exists on disk          (edit-only: no file creation)
  4. Path is a regular file       (no directories, symlinks to devices)
  5. Content ≤ 2MB                (prevents oversized writes)
  6. Atomic write                 (temp file + rename prevents corruption)
```

### Authentication

The viewer page is served from the same origin (`localhost:1234`). The browser's HTTP Basic Auth cache means any `fetch()` from the viewer page to `/api/files/save` automatically includes the `Authorization` header. **No separate write token is needed.**

### Atomic Write

```javascript
const tempPath = resolved + '.tmp.' + crypto.randomUUID();
fs.writeFileSync(tempPath, content, 'utf8');
fs.renameSync(tempPath, resolved);
```

Write to a temp file first, then atomically rename. This prevents:
- Partial writes from crashing the server mid-save
- Other processes reading a half-written file
- Corruption if two tabs save concurrently (last write wins, but each individual write is all-or-nothing)

## UI States

| State | Button | Badge | Main Area | Behavior |
|-------|--------|-------|-----------|----------|
| **Preview** (default) | ✏️ Edit (amber) | Markdown | Rendered HTML via `marked.js` | Read-only view |
| **Editing** | 💾 Save (red) | Editing | Raw text in `<textarea>` | Content loaded from `window.__FC__` |
| **Saving** | Saving... (green, disabled) | Editing | Raw text (read-only during save) | `fetch()` in progress |
| **After save** | ✏️ Edit (amber) | Markdown | Re-rendered preview with new content | `window.__FC__` updated |
| **Save error** | 💾 Save (red) | Editing | Raw text (preserved) | Alert shown, content intact |

### Button Color Semantics

- **Amber** (`#f9e2af`): Safe action — going to edit mode
- **Red** (`#f38ba8`): Destructive potential — you have unsaved edits, clicking will save
- **Green** (`#a6e3a1`): In progress — save is happening, button is disabled (`pointer-events:none`, 50% opacity)

## Keyboard Shortcuts

| Shortcut | State | Action |
|----------|-------|--------|
| `Ctrl+S` / `Cmd+S` | Editing | Save and return to preview |
| `Escape` | Editing | Discard edits, return to preview (no prompt) |

Both are handled by a `keydown` event listener on the `<textarea>` element.

## Data Flow During Save

```
1. User clicks "💾 Save" (or presses Ctrl+S)
2. Textarea content read: content = document.getElementById('md-editor').value
3. POST /api/files/save with { filePath: window.__FP__, content: content }
4. On success:
   a. window.__FC__ = content          ← cached content updated
   b. md-view.innerHTML = marked.parse(content)  ← preview re-rendered
   c. textarea hidden, preview shown
   d. Button returns to "✏️ Edit" amber state
5. On failure:
   a. alert('Save failed: ' + error)
   b. Button returns to "💾 Save" red state
   c. Textarea content preserved (no data loss)
```

## Download Behavior While Editing

When the user clicks "⬇ Download" while in edit mode, the download function checks `_editing` flag:

```javascript
function downloadFile() {
  var c = _editing
    ? document.getElementById('md-editor').value   // current edit content
    : window.__FC__;                                 // original/saved content
  // ... Blob download ...
}
```

This ensures the user downloads their latest edits, not stale cached content.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Save fails (network error) | Alert + button returns to "💾 Save" state, content preserved |
| Save fails (403 — path not allowed) | Alert with server message |
| Save fails (404 — file deleted mid-edit) | Alert, content preserved in textarea |
| File > 2MB | Rejected by server with 413 |
| User clicks Download while editing | Downloads current textarea content (not original) |
| User presses Escape while editing | Discards edits, returns to preview |
| User closes tab while editing | Content lost (browser-native behavior) |
| Concurrent edits (two tabs, same file) | Last save wins — atomic writes prevent corruption |
| User hacks `window.__FP__` in console | Server re-validates path; 403 if not in allowed prefixes |
| Non-markdown files | No Edit button appears (code files use separate CodeMirror viewer) |

## API Reference

### POST /api/files/save

Writes edited markdown content back to disk.

**Request:**
```json
{
  "filePath": "/home/ju/deepclaw-ui/docs/README.md",
  "content": "# Updated content\n\nNew paragraph."
}
```

**Success response (200):**
```json
{
  "saved": true,
  "path": "/home/ju/deepclaw-ui/docs/README.md",
  "size": 40
}
```

**Error responses:**

| Code | Condition | Response |
|------|-----------|----------|
| 400 | Missing `filePath` or `content` | `{ "error": "filePath and content are required" }` |
| 400 | Path is not a regular file | `{ "error": "Path is not a regular file" }` |
| 403 | Path not in `FILE_SHARE_ALLOWED_PREFIXES` | `{ "error": "File path not allowed: /path" }` |
| 404 | File does not exist | `{ "error": "File not found" }` |
| 413 | Content exceeds 2MB | `{ "error": "Content exceeds 2MB limit" }` |
| 500 | Unexpected error | `{ "error": "<message>" }` |

All responses include `Access-Control-Allow-Origin: *`.

## Client-Side State

Three global variables are embedded in the viewer page at generation time:

| Variable | Source | Description |
|----------|--------|-------------|
| `window.__FP__` | `filePath` parameter to `generateViewerPage()` | Full original file path (JSON-encoded). Used as `filePath` in save POST. |
| `window.__FC__` | `content` parameter to `generateViewerPage()` | Original file content. Used as initial textarea value and re-updated after successful save. |
| `window.__FN__` | `title` parameter to `generateViewerPage()` | Display filename. Used for the Download filename. |

One runtime flag:

| Variable | Type | Description |
|----------|------|-------------|
| `_editing` | `boolean` | Tracks whether the editor is in edit mode. Controls button behavior, download source, and Escape handling. |

## Code Reference

### Backend: generateViewerPage() (markdown branch)

**File:** `miniclaw-ui.js` — `generateViewerPage()` function (~L357)

Responsible for:
- Embedding `window.__FP__`, `window.__FC__`, `window.__FN__` in the viewer page
- Injecting inline CSS for editor styling (Catppuccin Mocha dark theme)
- Injecting `toggleEdit()`, `downloadFile()` functions
- Injecting `Ctrl+S`/`Escape` keydown handler
- Injecting `marked.js` CDN script tag
- Initial call to `marked.parse(window.__FC__)` for first render

### Backend: POST /api/files/save handler

**File:** `miniclaw-ui.js` — `handleRequest()` function (~L1638)

Responsible for:
- JSON body parsing
- Path validation against `FILE_SHARE_ALLOWED_PREFIXES`
- File existence and type checks
- Size limit enforcement (2MB)
- Atomic temp-file write + rename
- JSON response with `{ saved, path, size }`

### Frontend: toggleEdit()

**File:** `miniclaw-ui.js` — inline `<script>` in `generateViewerPage()` markdown branch (~L371)

Two code paths depending on `_editing` state:
1. **Enter edit mode** (`!_editing`): Copy `window.__FC__` into textarea, hide preview, show editor, change button to "💾 Save" (red)
2. **Save** (`_editing`): Read textarea value, POST to `/api/files/save`, on success update `window.__FC__`, re-render marked.js, return to preview

## Limitations (Out of Scope)

- **Syntax highlighting in editor:** Uses a plain `<textarea>`. Future: integrate CodeMirror 5 (already loaded for code files) for markdown syntax highlighting, line numbers, and better editing UX.
- **Unsaved changes warning:** No `beforeunload` event — closing the tab silently discards edits.
- **Code file editing:** Edit button only appears for markdown files (`.md`/`.markdown`). Code files use a read-only CodeMirror viewer.
- **File creation:** Only supports editing existing files. Cannot create new files from the viewer.
- **Auto-save / drafts:** No localStorage persistence of unsaved edits.

## Related

- [file-sharing.md](file-sharing.md) — Full file sharing system documentation
- [http-api.md](http-api.md) — REST API endpoint reference
- [index.md](index.md) — Architecture overview
- [tasks/markdown-editor-in-file-viewer.md](tasks/markdown-editor-in-file-viewer.md) — Original task plan
