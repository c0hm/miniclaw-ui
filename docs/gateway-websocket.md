# Gateway WebSocket Protocol

## Connection

```javascript
const GW_URL = process.env.GW_WSS === 'true' ? 'wss://127.0.0.1:18789' : 'ws://127.0.0.1:18789';
const GW_TOKEN = process.env.OPENCLAW_TOKEN || autoLoadedFromOpenclawConfig;
```

**Auto-load token:** reads `~/.openclaw/openclaw.json` → `gateway.auth.token`.

**TLS toggle:** Set `GW_WSS=true` to use `wss://` instead of `ws://`.

**Origin header:** Derived from `GW_URL` — `ws://` → `http://`, `wss://` → `https://`.

## Auth Flow

### 1. Connect → Receive Challenge

On WebSocket open, gateway sends a `connect.challenge` event:

```json
{ "type": "event", "event": "connect.challenge", "payload": { "nonce": "...", "ts": 1234567890 } }
```

### 2. Sign Challenge with Device Identity (v3 Protocol)

Device identity is loaded from `~/.openclaw/identity/device.json` and `device-auth.json` at startup.

**`loadDeviceIdentity()`** — reads and validates:
- `device.json` → `deviceId`, `publicKeyPem`, `privateKeyPem`
- `device-auth.json` → `tokens.operator.token` (used as `operatorToken`)

If identity files are missing or fields incomplete, `deviceIdentity` is `null` and auth **falls back to token-only** — the UI connects using just `auth: { token: GW_TOKEN }` without device signing. A warning is logged: `"No device identity available, using token-only auth"`. Token-only auth requires `gateway.remote.token` in `openclaw.json` to match `gateway.auth.token`.

**Payload construction** (`buildDeviceAuthPayloadV3()`):

```javascript
const payload = [
  'v3',                                    // protocol version
  deviceId,                                // from device.json
  'openclaw-control-ui',                   // clientId
  'webchat',                               // clientMode
  'operator',                              // role
  scopesStr,                               // comma-joined scope list
  String(signedAtMs),                      // Date.now() at signing time
  operatorToken,                           // from device-auth.json
  nonce,                                   // from challenge
  process.platform,                        // runtime OS (e.g. 'linux', 'darwin')
  ''                                       // deviceFamily (currently empty)
].join('|');
```

**Signing** (`signDevicePayload()`):
- Creates `crypto.createPrivateKey(privateKeyPem)`
- Signs the `v3|...` payload bytes with Ed25519
- Returns base64url-encoded signature

**Public key extraction** (`publicKeyRawBase64UrlFromPem()`):
- Creates `crypto.createPublicKey(publicKeyPem)`
- Exports SPKI DER format
- Strips the 10-byte ED25519 OID prefix (`302a300506032b6570032100`)
- Returns raw 32-byte public key as base64url

### 3. Send Connect Request (protocol v4)

```json
{
  "type": "req",
  "id": "connectRespId",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
    "client": {
      "id": "openclaw-control-ui",
      "version": "1.0.0",
      "platform": "linux",
      "mode": "webchat"
    },
    "scopes": [
      "operator.read", "operator.write", "operator.admin",
      "sessions.subscribe", "sessions.unsubscribe",
      "sessions.list", "sessions.history",
      "sessions.send", "sessions.reset", "sessions.create"
    ],
    "caps": ["tool-events", "llm-events"],
    "auth": {
      "token": "GW_TOKEN_VALUE"
    },
    "role": "operator",
    "userAgent": "miniclaw-ui/1.5"
  }
}
```

**When device identity IS available**, the following additional fields are included:

```json
{
  "auth": {
    "token": "GW_TOKEN_VALUE",
    "deviceToken": "operatorToken"
  },
  "device": {
    "id": "device_uuid",
    "publicKey": "base64url_raw_ed25519_key",
    "signature": "base64url_ed25519_sig",
    "signedAt": 1700000000000,
    "nonce": "challenge_nonce"
  }
}
```

**Key fields:**
- `minProtocol`/`maxProtocol`: **4** (not 3)
- `client.platform`: `process.platform` — runtime OS value (`linux`, `darwin`, etc.)
- `client.mode`: `webchat`
- `auth.token`: `GW_TOKEN` env var or auto-loaded from `openclaw.json` (always sent)
- `auth.deviceToken`: only sent when `deviceIdentity` is non-null (set to `operatorToken` from device-auth.json)
- `role`: `'operator'` — top-level param, not nested in `auth`
- `device`: only sent when `deviceIdentity` is non-null; includes `id`, `publicKey`, `signature`, `signedAt`, `nonce`

### 4. Receive Auth Response

- `res` with matching `id` where `msg.ok === true` → auth successful
- Sets `gwReady = true`, broadcasts `gateway.connected` to all browser clients
- Clears `deletedSessions` tracking on fresh connection

## Subscribe + List

After auth success (100ms and 200ms delays respectively):
1. Send `sessions.subscribe` request
2. Send `sessions.list` request → receive array of session summaries

## Gateway Events Received

| Event | Description | Key Payload Fields |
|-------|-------------|-------------------|
| `session.tool` | Tool/LLM lifecycle | `sessionKey`, `runId`, `stream`, `data.{phase,name,args,result,error}` |
| `session.message` | User/assistant messages | `sessionKey`, `message.{role,content}` |
| `agent.turn` | Agent turn events | `sessionKey`, `role`, `content` |
| `sessions.tokens` | Token updates | `sessionKey`, `tokens.{inputTokens,outputTokens,totalTokens,...}` |
| `agent` | Agent events (v2026.5.28+) | `sessionKey`, `runId`, `stream`, `data` — tool events directed to `toolEventRecipients` |
| `sessions.changed` | Session create/reset/end | `sessionKey`, `reason` (`create`/`send`/`steer`/`deleted`), enriched with full session row data |
| `connect.challenge` | Auth challenge | `nonce`, `ts` |

### session.tool stream values

| Stream | Phases | Meaning |
|--------|--------|---------|
| `tool` | `start`, `done`, `result`, `update` | Tool execution |
| `lifecycle` | `start`, `end`, `error` | LLM run |
| `assistant` | — | Assistant text delta |
| `thinking` | — | Thinking/reasoning delta |
| `user` | — | **User text delta (SILENCED — never stored)** |

> ⚠ **User stream echo:** Gateway echoes user text via `session.tool` with `stream='user'`. This is **intentionally dropped** (`return null` in `convertToFrontendEvent`). The canonical user text is stored when the browser sends a `chat` message, not from gateway echoes.

### Sessions Sync (sessions.list response)

When `sessions.list` response arrives:
- Gateway sessions not in local memory → removed from memory + disk
- Sessions explicitly deleted by user (`deletedSessions` Set) are skipped even if still in gateway response
- For each remaining session, `calculateActualContext()` computes context tokens from local events (sum of text lengths / 4), preferring local calculation over gateway's value

## Chat Request/Response Flow

### Browser → Server (WebSocket)

```json
{ "type": "chat", "sessionKey": "agent:main:main", "message": "Hello" }
```

### Processing

1. Server creates a `chatReqId` (random 8-char base36)
2. Records `chatReqId → { ws, sessionKey }` in `chatRequests` Map
3. Creates canonical `user_text` event via `session.addEvent()`
4. Forwards to gateway: `sessions.send` with `{ key, message }`
5. Sends immediate `chat_ack` to browser:

```json
{ "type": "chat_ack", "ok": true, "sessionKey": "agent:main:main", "ts": 1700000000000 }
```

### Gateway Response

When gateway responds with matching `id`:
- Looks up `chatRequests` entry
- Sends `chat_delivered` to the originating browser client:

```json
{ "type": "chat_delivered", "ok": true, "sessionKey": "agent:main:main", "ts": 1700000000000 }
```

- Removes entry from `chatRequests`

### Per-Request Routing

`chatRequests` is keyed by request ID (not session key), allowing multiple concurrent chats from different browser clients to be routed correctly without races.

## Reconnection

On `close` event:
- Sets `gwReady = false`
- Clears `connectResponseId` and `pendingSubId`
- Broadcasts `gateway.disconnected` event with `{ code, reason }`
- Retries connection in **3 seconds** (`setTimeout(connectGateway, 3000)`)

## Scopes Required

```
operator.read, operator.write, operator.admin,
sessions.subscribe, sessions.unsubscribe,
sessions.list, sessions.history,
sessions.send, sessions.reset, sessions.create
```

## Key Methods (sent to Gateway)

| Method | Params | Description |
|--------|--------|-------------|
| `connect` | `{ minProtocol, maxProtocol, client, scopes, caps, auth, role, device }` | Authenticate and connect |
| `sessions.subscribe` | `{}` | Subscribe to session events |
| `sessions.list` | `{}` | List all gateway sessions |
| `sessions.send` | `{ key, message }` | Send chat message |
| `sessions.create` | `{ key }` | Create new session |
| `sessions.reset` | `{ key, reason }` | Reset session (clear events) |
| `sessions.abort` | `{ key }` | Abort running LLM |
| `sessions.delete` | `{ key }` | Delete session permanently |

## Related

- [index.md](index.md) — Architecture overview
- [session-management.md](session-management.md) — Session lifecycle
- [message-processing.md](message-processing.md) — Event conversion
- [authentication.md](authentication.md) — UI auth
- [file-sharing.md](file-sharing.md) — File share system
