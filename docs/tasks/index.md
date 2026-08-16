# Task Index

This file tracks all tasks, features, and changes made to the MiniClaw UI project.

## Active Tasks

- **[rename-clawpro-to-miniclaw](rename-clawpro-to-miniclaw.md)** (2026-08-16) — ✅ Completed. Rename entire project back from "Clawpro 1.2" to "MiniClaw UI v1.5" (version bump 1.2 → 1.5): binary `miniclaw-ui.js`, source, package files, scripts, systemd service, all docs, workspace files.

- **[rename-miniclaw-to-clawpro](rename-miniclaw-to-clawpro.md)** (2026-07-14) — ✅ Completed. Rename entire project from "MiniClaw UI" to "Clawpro 1.2": binary, source, package files, scripts, systemd service, all docs, workspace files.

- **[improve-tool-result-rendering](improve-tool-result-rendering.md)** (2026-06-02) — ✅ Completed. **memory_search header shows query + web_fetch gets dedicated renderer.** (A) `renderMemorySearchHeader` now looks up matching `tool_start` to extract query, shows `🔍 "query" · N results` instead of just `🔍 N results`. (B) New `renderWebFetchHeader` replaces generic fallback: header shows HTTP status badge, shortened clickable URL, duration, content size; expanded body uses `renderUdiffContent()` (same as read/write).

- **[prev-messages-scroll-button](prev-messages-scroll-button.md)** (2026-06-02) — ✅ Completed. Added "↑ N previous messages" button at top of messages panel, mirroring the existing "↓ N new messages" button. New `userScrolledDown` state, `scrollToTop()`, `updatePrevMsgButton()`, `countMessagesAbove()` functions.

- **[image-gen-result-link-and-viewer](image-gen-result-link-and-viewer.md)** (2026-06-02) — ✅ Completed. **Media Gen Result Filename Links + Image Viewer Support.** (A) `renderImageGenResult` / `renderVideoGenResult` / `renderMusicGenResult` headers: replaced opaque `task ea2ba2c9...` with clickable `.../filename.png` link to `/api/media/serve/<token>` (with `stopPropagation`) when `status=completed`. (B) One-shot file viewer now handles images: `detectFileType` detects PNG/JPG/GIF/WebP/SVG/BMP/ICO, viewer route reads as base64, `generateViewerPage` renders inline `<img>` with data URI, MIME badge, and Download button.

- **[minimal-filter-image-generate](minimal-filter-image-generate.md)** (2026-06-02) — Minimal filter now shows `tool_start` for `image_generate` (so users see the prompt) and only shows `image_generate` `tool_result` when `status: completed` (hides intermediate/running states).
- **[fix-streaming-tool-result-merge-corruption](fix-streaming-tool-result-merge-corruption.md)** (2026-06-02) — Streaming tool_result merge blindly concatenates result strings. When gateway sends `phase: 'update'` (partial text) then `phase: 'done'` (JSON envelope), the concatenated string is invalid JSON. `parseToolResult` fails, `details` is null, all per-tool renderers fall to raw text dumps. Fix: detect JSON envelopes in merge and replace instead of append.
- **[render-error-boundary-resilience](render-error-boundary-resilience.md)** (2026-06-02) — Research task: client halts on load when unhandled tool types (image_generate, message) trigger exceptions in the unprotected `renderEvent` pipeline. Needs per-event try-catch error boundaries + dedicated renderers for new tools. *(Note: image_generate and message renderers are now implemented, this task may be partially resolved.)*
- **[fix-session-sync-race-condition](fix-session-sync-race-condition.md)** (2026-06-02) — Fresh load during streaming events doesn't load correctly. Analysis complete: `session.sync` silently dropped due to `key` vs `sessionKey` mismatch, but fixing it causes massive payload freeze (3×2000 events). Needs hybrid approach: sync only last 100 events + REST fallback for full history.

## Completed Tasks

- **[markdown-editor-in-file-viewer](markdown-editor-in-file-viewer.md)** (2026-07-05) — ✅ Completed. **In-browser markdown editor with save-to-host.** Adds "✏️ Edit" button to markdown file viewer page that switches from rendered preview to raw-text `<textarea>`, allowing in-browser editing. "💾 Save" button POSTs content to new `/api/files/save` endpoint which validates path against allowed prefixes and writes atomically. Same-origin Basic Auth passthrough avoids separate token system. Includes Escape-to-cancel, Ctrl+S shortcut, and Download-in-edit-mode support.

- **[remember-scroll-position-on-session-switch](remember-scroll-position-on-session-switch.md)** (2026-06-02) — ✅ Session switch remembers scroll position. `showSession()` saves outgoing `_scrollTop`, scroll handler updates it in real time, `showSessionContent()` restores on `prevCount===0` (session switch), `clearSessionEvents()` resets it.

- **[fix-load-older-events-scroll-anchoring](fix-load-older-events-scroll-anchoring.md)** (2026-06-02) — ✅ Fixed scroll anchoring when clicking "⬆ Load older events". Replaced proportional scroll preservation with anchor-to-content formula (`scrollTop += newHeight - oldHeight`) so the visible content stays in place while older events appear above.

- **[remove-connect-disconnect-button](remove-connect-disconnect-button.md)** (2026-06-02) — ✅ Removed Connect/Disconnect toggle button. Auto-connect on page load, always retry on disconnect. Removed `_manualDisconnect`, `disconnect()`, `toggleConnection()` functions. Status dot + text retained for connection status display.
- **[filter-completion-delivery-events](filter-completion-delivery-events.md)** (2026-06-02) — ✅ Filter noisy `message` tool_start/tool_result events that are internal delivery plumbing for async generation completions. Backend filter in `handleGatewayMessage` — Pattern A detection runs before `addEvent`, completion delivery `toolCallId`s tracked in `completionDeliveryCallIds` Set, matching `tool_result` filtered.
- **[virtual-image-gen-tool-result](virtual-image-gen-tool-result.md)** (2026-06-02) — ✅ Virtual `tool_result` injection for async image/video/music generation. Core feature tested end-to-end: image_generate → started → completion arrives via message tool → virtual result pairs back to original call with inline image, caption, media token. Auto-expand, LLM caption, and media token cleanup also done. Remaining: reference images, video/music testing, error formatting.
- **[improve-image-gen-rendering](improve-image-gen-rendering.md)** (2026-06-02) — Analyzed image_generate async lifecycle from session data. Rewrote `renderImageGenCall` (16 params incl. action modes, openai/fal nested, reference images) and `renderImageGenResult` (structured provider table for list, progress for status, enhanced async details). Applied same improvements to video_generate and music_generate.
- **[udiff-format-for-read-write-results](udiff-format-for-read-write-results.md)** (2026-06-02) — Made `read`/`write` tool results use the same `.udiff` container format as `edit` when expanded. Moved `tr-actions` inside `.udiff-file` header bar (right side via flexbox). Added `trActionsHtml(idx)` helper, `renderUdiffContent()` for plain file content. Refactored all renderers to use `trActionsHtml` for consistency.

- **[side-by-side-diff-for-edit-results](side-by-side-diff-for-edit-results.md)** (2026-06-01) — Replaced CSS Grid side-by-side diff with clean single-column unified diff for edit results. Removed `parseUnifiedPatch()` + `renderSideBySideDiff()`, added `renderUnifiedDiff()`.

- **[fix-new-session-optimistic-stuck](fix-new-session-optimistic-stuck.md)** (2026-06-01) — Fixed new session sidebar stuck in "Creating..." status after modal creation. Sidebar was not re-rendering when `sessions.changed` cleared the optimistic flag.
- **[dynamic-agent-list-in-modal](dynamic-agent-list-in-modal.md)** (2026-06-01) — Replaced hardcoded agent dropdown in "Start New Session" modal with dynamic list fetched from `/api/agents`. Backend now returns `sessionKey` for each agent; frontend caches list on WS open and populates on modal open.
- **[fix-sessions-create-reason-field](fix-sessions-create-reason-field.md)** (2026-06-01) — Fixed "Start new session" dialog failing after gateway updated `sessions.changed` payload from `state` to `reason` field.
- **[add-download-button-to-viewer](add-download-button-to-viewer.md)** (2026-05-31) — Client-side Download button in file viewer tabs (code + markdown). Uses Blob from embedded page content for instant download without re-fetching.
- **[agent-specific-theming](agent-specific-theming.md)** (2026-05-31) — Subtle per-agent accent color theming. Each agent gets a deterministic hue from the blue-purple range (225-255°) applied via CSS `--accent` variable on session switch. Persisted in localStorage.
- **[fix-agent-tool-events](fix-agent-tool-events.md)** (2026-05-31) — Fixed tool events not rendering after OpenClaw v2026.5.28 update. Tools now arrive via `agent` event (not `session.tool`) when miniclaw-ui is registered as a `toolEventRecipient`.

---

*Add new tasks by creating files in this directory. Update this index after each task completes.*
