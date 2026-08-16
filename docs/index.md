# MiniClaw UI — LLM-Optimized Reference

## What It Is

Real-time web dashboard for OpenClaw Gateway. Connects via WebSocket, streams session events to browser, serves SPA on port 1234.

**Binary:** `miniclaw-ui.js` (Node.js server) + `index.html` (vanilla JS SPA)
**Port:** 1234 (default)
**Gateway:** ws://127.0.0.1:18789 (WSS with `GW_WSS=true`)

---

## Architecture

```
Gateway (ws://127.0.0.1:18789)
    │ WebSocket client (gwSocket)
    ▼
miniclaw-ui.js ───────────────────────────────────────────────
  ├─ HTTP/HTTPS Server (REST API on /api/*)                    │
  ├─ File Sharing: one-shot token URLs + CodeMirror viewer     │
  ├─ Browser WebSocket Server (wss) ─── index.html (browser)   │
  └─ SessionState: in-memory Map + JSON disk persistence      │
       └─ data/session-{key}.json                              │
```

**Event flow:** Gateway → miniclaw-ui.js → browser (WebSocket) + REST polling fallback

**Stack:** Node.js, `ws` (WebSocket), vanilla JS SPA, CSS custom properties (dark theme)

---

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | 1234 | HTTP server port |
| `OPENCLAW_TOKEN` | auto-loaded | Gateway auth token (or from `~/.openclaw/openclaw.json`) |
| `MCPASS` | `miniclaw` | UI password (always enabled) |
| `DATA_DIR` | `./data` | Session storage directory |
| `GW_WSS` | `false` | Use `wss://` for gateway connection |

---

## Session Key Format

Pattern: `agent:{instance}:{name}`

Examples: `agent:main:main`, `agent:personal:main`

---

## Frontend Event Types

All events rendered by `renderEvent()` in `index.html`.

| Type | Badge | Color | Description | Key Fields |
|------|-------|-------|-------------|-----------|
| `tool_start` | 🔧 TOOL START | amber | Tool execution began | `toolName`, `input`, `toolCallId`, `runId` |
| `tool_result` | ✅ TOOL RESULT | amber | Tool completed | `toolName`, `result`, `isError`, `toolCallId`, `runId` |
| `run_start` | ▶ LLM START | cyan | LLM call began | `model`, `inputTokens`, `outputTokens`, `totalTokens` |
| `run_end` | ■ LLM DONE | green | LLM call ended | `stopReason`, `runId` |
| `run_error` | ✖ ERROR | red | Error occurred | `error`, `runId` |
| `assistant_text` | 🤖 RESPONSE | purple | Model response | `text`, `runId`, `source`, `isFinal`, `isIntermediate`, `hasToolCalls` |
| `user_text` | 👤 USER | green | User message (no truncation) | `text`, `runId`, `source` |
| `thinking` | 💭 THINKING | purple | Model reasoning (muted) | `text`, `runId` |

**Truncation:** `assistant_text` → 3000 chars, `thinking` → 2000 chars, `user_text` → none, `tool_result` → 200px height

### Server → Client Protocol Events

Additional events sent from server to browser (not from Gateway):

| Type | Description |
|------|-------------|
| `session.sync` | Full session sent on browser connect (includes all events/messages) |
| `event.added` | Single event pushed in real-time to all browser clients |
| `session.summary` | Lightweight session overview (eventCount, messageCount, tokens) |
| `session.cleared` | After `/api/session/:key/clear-events` is called |
| `session.messages` | Delta of new messages (not re-sends historical) |
| `session.tokens` | Token update broadcast |
| `sessions.changed` | Session state change (created/ended/deleted) |
| `status` | Gateway + session + client counts on browser connect |
| `gateway.connected` | Gateway auth successful |
| `gateway.disconnected` | Gateway dropped (includes code + reason) |
| `chat_ack` | Immediate acknowledgment after message send |
| `chat_delivered` | Delivery confirmation after gateway processes message |

---

## SessionState (in-memory)

```javascript
class SessionState {
  key;            // Session key
  sessionId;      // Gateway-assigned ID
  events = [];    // Array of frontend events
  messages = [];  // User/assistant messages
  tokens = {      // Token tracking
    inputTokens, outputTokens, totalTokens, totalTokensFresh,
    contextTokens, estimatedCostUsd, model, modelProvider, status
  };
  lastTs;         // Last activity timestamp
  createdAt;
}
```

**Limits:** max 2000 events, max 500 messages per session (oldest dropped).

---

## Disk Persistence

- File: `data/session-{key}.json`
- Atomic write: temp file → rename
- Load on first access if not in memory

---

## Gateway WebSocket Protocol

### Connection Flow

1. Connect → receive `connect.challenge` event with `nonce`
2. Send `connect` request with `clientId`, `scopes`, `auth.token`
3. Receive `ok` → send `sessions.subscribe`
4. Send `sessions.list` → receive session array

### Key Methods (requests)

| Method | Params | Description |
|--------|--------|-------------|
| `sessions.send` | `{ key, message }` | Send message |
| `sessions.create` | `{ key }` | Create session |
| `sessions.reset` | `{ key, reason }` | Reset session |
| `sessions.abort` | `{ key }` | Abort running |
| `sessions.list` | `{}` | List all sessions |

### Gateway Events Received

| Event | Stream | Phase | Description |
|-------|--------|-------|-------------|
| `session.tool` | `tool` | `start/done/result/update` | Tool lifecycle |
| `session.tool` | `lifecycle` | `start/end/error` | LLM run lifecycle |
| `session.tool` | `assistant/user` | — | Text deltas |
| `session.message` | — | — | User/assistant messages |
| `sessions.tokens` | — | — | Token updates |
| `sessions.changed` | — | `created/loaded` | Session created/reset |

### Scopes Required

```
operator.read, operator.write, operator.admin,
sessions.subscribe, sessions.unsubscribe,
sessions.list, sessions.history,
sessions.send, sessions.reset, sessions.create
```

### Device Identity (v3 protocol)

If `~/.openclaw/identity/device.json` and `device-auth.json` exist, use Ed25519 device signing:
- `loadDeviceIdentity()`: reads `deviceId`, `publicKeyPem`, `privateKeyPem`, `operatorToken` from identity files
- `buildDeviceAuthPayloadV3()`: builds pipe-delimited payload `v3|{deviceId}|{clientId}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}|{platform}|{deviceFamily}`
- `signDevicePayload()`: signs payload with Ed25519 `crypto.createPrivateKey` → base64url
- `publicKeyRawBase64UrlFromPem()`: extracts raw ED25519 public key bytes from SPKI DER (strips 10-byte OID prefix)
- Sends `device` object in connect params: `{ id, publicKey, signature, signedAt, nonce }`
- Also sends `role: 'operator'` at top-level connect params
- Fails fast (closes socket) if deviceIdentity is `null` when challenge arrives

---

## Message Conversion (Backend)

`convertToFrontendEvent(rawMsg)` → frontend event (or `null` to drop)

**Input:** raw gateway `session.tool`, `session.message`, `sessions.tokens` events
**Output:** frontend event object or `null`

### Signature Deduplication

```javascript
// Signature: role + '|' + hashString(content.trim())
// hashString = 32-bit rolling hash → base36
// Full-content hash — identical messages always dedup regardless of time
// Stored per-session, max 500 entries (trim to 250 oldest when exceeded)
```

### Metadata Garbage Filter

Drop user messages matching: `/^(Sender|System|\[Mon|\[Tue|\[Wed)/`

Note: `^[` catch-all intentionally removed — real messages can start with brackets.

### parseMessageContent()

Extract text blocks from content array, ignore metadata blocks:
```javascript
// Input: [{type:'text',text:'hi'},{type:'thinking',thinking:'...'}]
// Output: 'hi'
```

---

## HTTP REST API

Base: `http://localhost:1234`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | UI HTML page |
| GET | `/api/status` | `{ gatewayReady, sessionCount, clientCount, dataDir }` |
| GET | `/api/sessions` | Array of session summaries |
| GET | `/api/session/:key` | Full session (events + messages + tokens) |
| GET | `/api/events/:key?limit=100` | Events only |
| GET | `/api/agents` | Available agents from gateway config |
| POST | `/api/session/:key/reset` | Reset session (any HTTP method accepted) |
| POST | `/api/session/:key/delete` | Delete session (any HTTP method accepted) |
| POST | `/api/session/:key/clear-events` | Clear intermediate/tool-call events (keeps final + user) |
| POST | `/api/files/share` | Generate one-shot file share token → `{ url, viewUrl, filename }` |
| GET | `/api/files/serve/:token` | One-shot file download (token consumed on access) |
| GET | `/api/files/view/:token` | One-shot inline viewer (CodeMirror 5 / marked.js) |

### Auth

HTTP Basic Auth **always required**. Default password: `miniclaw`.

---

## Browser WebSocket Protocol

Client → Server messages:

```javascript
// Chat
{ type: 'chat', message: '...', sessionKey: 'agent:main:main' }
// Request
{ type: 'req', method: 'sessions.abort', params: { key: '...' } }
// Ping
{ type: 'ping' }
```

Server → Client events (forwarded from gateway):

```javascript
{ type: 'event', event: 'session.sync', payload: {...} }  // Full session on connect
{ type: 'event', event: 'session.tokens', payload: {...} }
{ type: 'event', event: 'sessions.changed', payload: {...} }
{ type: 'event', event: 'session.message', payload: {...} }
{ type: 'event', event: 'gateway.disconnected', payload: {...} }
```

---

## UI Components

- **Header:** title, sidebar-toggle, connection dot (green=gateway connected, red=disconnected)
- **Sidebar:** session list (click to select, X to delete, + for new session modal)
- **Messages:** scrollable event list, "↓ New messages" button when scrolled up
- **Filters:** text search + buttons (All/LLM/Tools/Errors) + Clear All
- **Chat input:** textarea + Send, resize handle, Enter sends, Shift+Enter newline
- **Stats bar:** Sessions / LLM Calls / Tool Calls / Errors counts

### Theme (CSS custom properties)

```
--bg #0f1117   --panel #161922   --border #2a2d3a
--text #e4e4e7 --muted #71717a    --accent #6366f1
--user #22c55e --assistant #818cf8 --tool #f59e0b
--error #ef4444 --info #38bdf8
```

---

## CLI Commands

When running with stdin:

```
status     → gateway/sessions/clients status
sessions   → list all sessions with event+message counts
events     → last 5 events per session
gc         → remove sessions inactive >1hr
reset      → clear all in-memory sessions (disk untouched)
help       → show commands
```

---

## Tool Input Reference

### `read`
```json { "path": "/file.md", "offset": 1, "limit": 100 }
```
- `path` (required): absolute or relative file path
- `offset`: 1-indexed line number
- `limit`: max lines

### `write`
```json { "path": "/file.md", "content": "..." }
```

### `edit`
```json { "path": "/file.md", "edits": [{ "oldText": "...", "newText": "..." }] }
```
- `oldText` must be unique in file
- All `oldText` matched simultaneously (non-overlapping)

### `exec`
```json { "command": "...", "workdir": "/dir", "background": false, "yieldMs": 10000, "timeout": 60, "pty": false, "elevated": false }
```

### `process`
```json { "action": "list|poll|log|write|kill|submit", "sessionId": "..." }
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Connecting to gateway..." stuck | Check Gateway on 18789; check `GW_WSS` if TLS |
| 401 Unauthorized | Use password `miniclaw` (or `MCPASS` env value) |
| Sessions not showing | Send a message to trigger session creation |
| Empty events | Send a message — events stream via WebSocket push, not on-click fetch |
| High memory | Run `gc` CLI command, delete old `data/*.json` files |
| Corrupted session | Use `/api/session/:key/delete` (also clears in-memory state) |

---

## Related Docs

- [event-types-reference.md](event-types-reference.md) — Full event data samples + tool reference
- [gateway-websocket.md](gateway-websocket.md) — Detailed gateway protocol
- [session-management.md](session-management.md) — SessionState details + disk I/O
- [message-processing.md](message-processing.md) — Conversion + deduplication code
- [http-api.md](http-api.md) — REST API reference
- [event-rendering.md](event-rendering.md) — Event HTML rendering code
- [websocket-client.md](websocket-client.md) — Browser WS client details
- [ui-components.md](ui-components.md) — UI component code
- [authentication.md](authentication.md) — Basic Auth setup
- [cli-commands.md](cli-commands.md) — CLI details
- [configuration.md](configuration.md) — Env vars reference
- [troubleshooting.md](troubleshooting.md) — Issue guide
- [file-sharing.md](file-sharing.md) — One-shot file share + viewer
- [markdown-editor.md](markdown-editor.md) — In-browser markdown editor with save-to-host
- [glossary.md](glossary.md) — Domain terms
- [contributing.md](contributing.md) — Contribution guidelines
