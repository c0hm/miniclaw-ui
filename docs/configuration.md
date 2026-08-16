# Configuration

## Environment Variables

MiniClaw UI is configured via environment variables.

## Server Configuration

### PORT

HTTP server port.

| Default | `1234` |
|---------|----------|
| Type | number |
| Example | `PORT=18804 node miniclaw-ui.js` |

### OPENCLAW_TOKEN

Token for authenticating to OpenClaw Gateway.

| Default | (empty) |
|---------|----------|
| Type | string |
| Example | `OPENCLAW_TOKEN=my_token node miniclaw-ui.js` |

When not set, auto-loads from `~/.openclaw/openclaw.json` → `gateway.auth.token`.

### MCPASS

Password for Basic Auth protection.

| Default | `miniclaw` |
|---------|----------|
| Type | string |
| Example | `MCPASS=mypassword node miniclaw-ui.js` |

**Auth is always enabled** (`authEnabled = true` unconditionally). `MCPASS` only changes the password value.

### DATA_DIR

Directory for session persistence.

| Default | `./data` (relative to script) |
|---------|----------|
| Type | path |
| Example | `DATA_DIR=/var/lib/miniclaw-ui/data node miniclaw-ui.js` |

## Gateway Configuration

### GW_URL

WebSocket URL for OpenClaw Gateway.

| Default | `ws://127.0.0.1:18789` |
|---------|----------|
| Type | string |

### GW_WSS

Toggle WSS (secure WebSocket) for gateway connection.

| Default | `false` |
|---------|----------|
| Type | boolean (`"true"` string) |
| Example | `GW_WSS=true node miniclaw-ui.js` |

When `GW_WSS=true`, connects via `wss://127.0.0.1:18789` instead of `ws://`.

## TLS / HTTPS

Auto-detected on startup. If both `fullchain.pem` and `privkey.pem` exist in the project root:

```
miniclaw-ui/
├── fullchain.pem     # TLS certificate chain
├── privkey.pem       # TLS private key
└── miniclaw-ui.js
```

The server starts as `https.createServer()`. Otherwise falls back to `http.createServer()`.

The startup log will show:
- `TLS certificates loaded - HTTPS enabled` (when certs found)
- `No TLS certificates found - running without HTTPS` (when certs missing)

## Configuration Precedence

1. Environment variables
2. Default values
3. Hardcoded constants (GW_URL host:port)

```javascript
const GW_URL = process.env.GW_WSS === 'true' ? 'wss://127.0.0.1:18789' : 'ws://127.0.0.1:18789';
const GW_TOKEN = process.env.OPENCLAW_TOKEN || autoLoadedFromOpenclawJson;
const PORT = process.env.PORT || 1234;
const DATA_DIR = path.join(__dirname, 'data');
const MCPASS = process.env.MCPASS || 'miniclaw';
const authEnabled = true;  // always on
```

## Example Configurations

### Development

```bash
# Minimal setup — uses all defaults
node miniclaw-ui.js
```

### Production

```bash
# Full configuration
PORT=1234 \
OPENCLAW_TOKEN=your_gateway_token \
MCPASS=strong_password \
DATA_DIR=/var/lib/miniclaw-ui/data \
node miniclaw-ui.js
```

### Gateway with TLS

```bash
# Connect to gateway over WSS
GW_WSS=true node miniclaw-ui.js
```

### Custom Gateway Host

To change the gateway host:port, edit line ~10 of `miniclaw-ui.js`:

```javascript
const GW_URL = process.env.GW_WSS === 'true'
  ? 'wss://127.0.0.1:18789'
  : 'ws://127.0.0.1:18789';
```

## Runtime Status

Check current configuration via the CLI:

```
> status
=== MiniClaw UI Status ===
Gateway: connected
Sessions: 3
Browser clients: 2
Data directory: /home/ju/miniclaw-ui/data
```

Or via the API:

```bash
curl -u :miniclaw http://localhost:1234/api/status
# {"gatewayReady":true,"sessionCount":3,"clientCount":2,"dataDir":"/home/ju/miniclaw-ui/data"}
```

## Related Documentation

- [Authentication](authentication.md)
- [CLI Commands](cli-commands.md)
- [Troubleshooting](troubleshooting.md)
