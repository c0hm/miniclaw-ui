const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const crypto = require('crypto');

// Gateway URL: use WSS if gateway has TLS configured, otherwise use WS
const GW_URL = process.env.GW_WSS === 'true' ? 'wss://127.0.0.1:18789' : 'ws://127.0.0.1:18789';
// Gateway auth token: use env var, or read from openclaw.json
const GW_TOKEN = process.env.OPENCLAW_TOKEN || (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
})();
const PORT = process.env.PORT || 1234;
const DATA_DIR = path.join(__dirname, 'data');

const MCPASS = process.env.MCPASS || process.env.DCPASS || 'miniclaw';
const authEnabled = true;

// Shared Basic Auth validation — used by both HTTP and WebSocket paths
function validateBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  const base64Credentials = authHeader.split(' ')[1];
  try {
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const [, password] = credentials.split(':');
    return password === MCPASS;
  } catch {
    return false;
  }
}

// --- Device Identity ---
const IDENTITY_DIR = path.join(os.homedir(), '.openclaw', 'identity');
const DEVICE_JSON_PATH = path.join(IDENTITY_DIR, 'device.json');
const DEVICE_AUTH_JSON_PATH = path.join(IDENTITY_DIR, 'device-auth.json');

function loadDeviceIdentity() {
  try {
    const deviceData = JSON.parse(fs.readFileSync(DEVICE_JSON_PATH, 'utf8'));
    const authData = JSON.parse(fs.readFileSync(DEVICE_AUTH_JSON_PATH, 'utf8'));
    const operatorToken = authData.tokens?.operator?.token;
    if (!deviceData.deviceId || !deviceData.privateKeyPem || !operatorToken) {
      throw new Error('Missing device identity fields');
    }
    return {
      deviceId: deviceData.deviceId,
      publicKeyPem: deviceData.publicKeyPem,
      privateKeyPem: deviceData.privateKeyPem,
      operatorToken
    };
  } catch (e) {
    log('error', 'Failed to load device identity:', e.message);
    return null;
  }
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function normalizeTrimmedMetadata(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed : '';
}

function normalizeDeviceMetadataForAuth(value) {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) return '';
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function buildDeviceAuthPayloadV3(params) {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily
  ].join('|');
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const payloadBytes = Buffer.from(payload, 'utf8');
  const signature = crypto.sign(null, payloadBytes, key);
  return base64UrlEncode(signature);
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  // ED25519 OID prefix is 10 bytes: 302a300506032b6570032100
  const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return base64UrlEncode(spki.subarray(ED25519_SPKI_PREFIX.length));
  }
  return base64UrlEncode(spki);
}

const deviceIdentity = loadDeviceIdentity();

let clients = new Set();
let sessions = new Map();
const deletedSessions = new Set(); // Keys that were explicitly deleted; block re-creation from in-flight events
let gwSocket = null;
let gwReady = false;
let connectResponseId = null;
let pendingSubId = null;
let chatRequests = new Map(); // id -> { ws, sessionKey } (per-request, avoids race between multiple browser clients)

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function now() {
  return Date.now();
}

function log(level, ...args) {
  console.log(`[${now()}] [${level}]`, ...args);
}

function getSessionDataPath(sk) {
  return path.join(DATA_DIR, `session-${sk}.json`);
}

function parseMessageContent(content) {
  // Extract ONLY text blocks from content array, ignore metadata blocks
  if (!content) return '';
  if (typeof content === 'string') {
    // Try to parse as JSON array
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(block => block?.type === 'text')
          .map(block => block.text || '')
          .join('\n')
          .trim();
      }
    } catch {}
    // Not JSON, return as-is
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(block => block?.type === 'text')
      .map(block => block.text || '')
      .join('\n')
      .trim();
  }
  return String(content);
}

// Deduplication: track message signatures to avoid duplicates
const messageSignatures = new Map(); // sk -> Set of signatures

// One-shot file serving: token → { path, timeoutHandle }
const fileShareTokens = new Map();
// ── Media token store (reusable, for virtual tool results) ────────────────
// Token → { path, mimeType }. Registered on media generation completion
// and re-registered from persisted virtual events on server restart.
const mediaTokens = new Map();
const completedMediaTaskIds = new Set(); // taskId → true (runtime dedup)
// Track toolCallIds of completion delivery message calls so we can
// filter both the tool_start and tool_result from display.
const completionDeliveryCallIds = new Set();

const FILE_SHARE_TTL_MS = 60_000; // 60s expiry for unclaimed links
const FILE_SHARE_ALLOWED_PREFIXES = [
  os.homedir(),
  '/tmp'
];

// File viewer: extension → CodeMirror 5 mode name
const CM_MODES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'javascript', tsx: 'javascript', // CM5 uses typescript mode
  json: 'application/json',
  css: 'css', scss: 'css', less: 'css',
  html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml', svg: 'xml',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown',
  java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', hpp: 'clike', cs: 'clike',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'clike', kts: 'clike',
  scala: 'clike',
  r: 'r',
  toml: 'toml', ini: 'properties', cfg: 'properties', conf: 'properties',
  dockerfile: 'dockerfile',
  diff: 'diff', patch: 'diff',
};

function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return { kind: 'code', mode: 'dockerfile' };
  if (basename === 'makefile' || basename === 'gemfile') return { kind: 'code', mode: 'null' };
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', mode: null };
  if (CM_MODES[ext]) return { kind: 'code', mode: CM_MODES[ext] };
  // Image types
  const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon' };
  if (IMG_MIME[ext]) return { kind: 'image', mime: IMG_MIME[ext] };
  // Try to detect if it's text - read first 1KB and check for null bytes
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) return { kind: 'binary', mode: null };
    }
    return { kind: 'code', mode: 'null' }; // text but unknown - show plain with CodeMirror
  } catch {
    return { kind: 'binary', mode: null };
  }
}

function htmlEncode(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateViewerPage(filePath, content, title) {
  const type = detectFileType(filePath);
  // Escape </ that would break embedded <script> tags (e.g. in HTML files)
  const safeContent = content.replace(/<\//g, '<\\/');
  const encodedContent = JSON.stringify(safeContent);
  const encodedTitle = htmlEncode(title);

  // Map CodeMirror mode name → CDN script URL (relative to mode/ dir)
  // Some modes are composites (e.g., htmlmixed depends on xml + javascript)
  const MODE_CDN = {
    javascript: 'javascript/javascript.min.js',
    jsx: 'jsx/jsx.min.js',
    css: 'css/css.min.js',
    xml: 'xml/xml.min.js',
    htmlmixed: 'htmlmixed/htmlmixed.min.js',
    python: 'python/python.min.js',
    shell: 'shell/shell.min.js',
    yaml: 'yaml/yaml.min.js',
    sql: 'sql/sql.min.js',
    clike: 'clike/clike.min.js',
    rust: 'rust/rust.min.js',
    go: 'go/go.min.js',
    ruby: 'ruby/ruby.min.js',
    php: 'php/php.min.js',
    swift: 'swift/swift.min.js',
    r: 'r/r.min.js',
    toml: 'toml/toml.min.js',
    properties: 'properties/properties.min.js',
    dockerfile: 'dockerfile/dockerfile.min.js',
    diff: 'diff/diff.min.js',
  };
  // Dependencies: mode → list of modes that must load first
  const MODE_DEPS = {
    htmlmixed: ['xml', 'javascript', 'css'],
    jsx: ['javascript'],
    php: ['clike', 'xml', 'javascript', 'css', 'htmlmixed'],
  };

  const baseCdn = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16';

  const headerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${encodedTitle}</title>
<link rel="stylesheet" href="${baseCdn}/codemirror.min.css">
<link rel="stylesheet" href="${baseCdn}/theme/material-darker.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1e1e2e;color:#cdd6f4;font-family:'SF Mono','Fira Code',monospace;font-size:13px}
#bar{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#181825;border-bottom:1px solid #313244}
#bar .name{font-weight:600;color:#89b4fa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bar .spacer{flex:1}
#bar button{padding:6px 14px;border-radius:4px;font-size:11px;cursor:pointer;border:none;font-family:inherit}
#bar .dl{background:#a6e3a1;color:#1e1e2e}#bar .dl:hover{background:#94e2d5}
#bar .close{background:#313244;color:#cdd6f4}#bar .close:hover{background:#45475a}
#main{overflow:auto;position:absolute;top:42px;bottom:0;left:0;right:0}
.CodeMirror{height:100%!important;font-size:13px}
#md-view{padding:24px 32px;max-width:900px;margin:0 auto;line-height:1.7}
#md-view h1,#md-view h2,#md-view h3{color:#89b4fa;margin:24px 0 12px}
#md-view h1{font-size:1.5em;border-bottom:1px solid #313244;padding-bottom:8px}
#md-view h2{font-size:1.3em}#md-view h3{font-size:1.1em}
#md-view p{margin:8px 0}
#md-view code{background:#313244;padding:2px 6px;border-radius:3px;font-size:12px;color:#f5c2e7}
#md-view pre{background:#11111b;padding:16px;border-radius:6px;overflow-x:auto;margin:12px 0}
#md-view pre code{background:none;padding:0}
#md-view blockquote{border-left:3px solid #89b4fa;padding-left:16px;color:#a6adc8;margin:12px 0}
#md-view a{color:#89b4fa}
#md-view table{border-collapse:collapse;margin:12px 0;width:100%}
#md-view td,#md-view th{border:1px solid #313244;padding:6px 12px;text-align:left}
#md-view th{background:#181825;font-weight:600}
#md-view ul,#md-view ol{padding-left:24px;margin:8px 0}
#plain-view{padding:16px 20px;white-space:pre-wrap;font-family:inherit;line-height:1.6;overflow:auto;position:absolute;inset:0}
#binary-msg{display:flex;align-items:center;justify-content:center;height:100%;color:#a6adc8;font-size:14px;flex-direction:column;gap:12px}
#img-view{display:flex;align-items:center;justify-content:center;height:100%;padding:16px}
#img-view img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,0.4)}
</style>`;

  // Image files - render inline
  if (type.kind === 'image') {
    const dataUri = `data:${type.mime};base64,${content}`;
    return headerHtml + `</head><body>
<div id="bar"><span class="name">🖼️ ${encodedTitle}</span><span class="spacer"></span><span style="font-size:10px;color:#585b70">${htmlEncode(type.mime || 'image')}</span><button class="dl" onclick="downloadFile()">⬇ Download</button><button class="close" onclick="window.close()">✕</button></div>
<div id="main"><div id="img-view"><img src="${dataUri}" alt="${encodedTitle}" /></div></div>
<script>function downloadFile(){var a=document.createElement('a');a.href='${dataUri}';a.download=${JSON.stringify(title)};document.body.appendChild(a);a.click();document.body.removeChild(a)}</` + `script>
</body></html>`;
  }

  // Binary files - can't preview
  if (type.kind === 'binary') {
    return headerHtml + `</head><body>
<div id="bar"><span class="name">📄 ${encodedTitle}</span><span class="spacer"></span><span style="font-size:10px;color:#585b70">Binary</span><button class="close" onclick="window.close()">✕</button></div>
<div id="main"><div id="binary-msg">⚠ Binary file - cannot preview<br><span style="font-size:11px;color:#585b70">Use the Download button on the previous page to save</span></div></div>
</body></html>`;
  }

  // Markdown - render with marked.js + edit/save toggle
  if (type.kind === 'markdown') {
    const encodedPath = JSON.stringify(filePath);
    return headerHtml + `</head><body>
<div id="bar"><span class="name">📝 ${encodedTitle}</span><span class="spacer"></span><span id="mode-badge" style="font-size:10px;color:#585b70">Markdown</span><button id="btn-edit" class="dl" onclick="toggleEdit()" style="background:#f9e2af;color:#1e1e2e">✏️ Edit</button><button class="dl" onclick="downloadFile()">⬇ Download</button><button class="close" onclick="window.close()">✕</button></div>
<div id="main"><div id="md-view"></div><textarea id="md-editor" style="display:none"></textarea></div>
<style>
#md-editor{position:absolute;inset:0;background:#11111b;color:#cdd6f4;border:none;padding:24px 32px;font-family:'SF Mono','Fira Code',monospace;font-size:13px;line-height:1.7;resize:none;outline:none;tab-size:2}
#btn-edit.danger{background:#f38ba8}
#btn-edit.saving{background:#a6e3a1;opacity:0.5;pointer-events:none}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></` + `script>
<script>
window.__FP__=${encodedPath};window.__FC__=${encodedContent};window.__FN__=${JSON.stringify(title)};
var _editing=false;
function downloadFile(){var c=_editing?document.getElementById('md-editor').value:window.__FC__;var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([c],{type:'application/octet-stream'}));a.download=window.__FN__;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href)}
function toggleEdit(){var md=document.getElementById('md-view');var ed=document.getElementById('md-editor');var btn=document.getElementById('btn-edit');var badge=document.getElementById('mode-badge');if(!_editing){ed.value=window.__FC__;md.style.display='none';ed.style.display='';btn.textContent='💾 Save';btn.classList.add('danger');badge.textContent='Editing';_editing=true}else{var content=ed.value;btn.textContent='Saving...';btn.classList.add('saving');btn.classList.remove('danger');fetch('/api/files/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filePath:window.__FP__,content:content})}).then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error(e.error)});return r.json()}).then(function(){window.__FC__=content;md.innerHTML=marked.parse(content);md.style.display='';ed.style.display='none';btn.textContent='✏️ Edit';btn.classList.remove('saving','danger');badge.textContent='Markdown';_editing=false}).catch(function(err){alert('Save failed: '+err.message);btn.textContent='💾 Save';btn.classList.remove('saving');btn.classList.add('danger')})}}
document.getElementById('md-view').innerHTML=marked.parse(window.__FC__);
document.getElementById('md-editor').addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();toggleEdit()}if(e.key==='Escape'&&_editing){e.preventDefault();var md=document.getElementById('md-view');var ed=document.getElementById('md-editor');var btn=document.getElementById('btn-edit');var badge=document.getElementById('mode-badge');md.style.display='';ed.style.display='none';btn.textContent='✏️ Edit';btn.classList.remove('danger','saving');badge.textContent='Markdown';_editing=false}});
</` + `script>
</body></html>`;
  }

  // Code file - CodeMirror 5 with syntax highlighting
  const mode = type.mode || 'null';

  // Collect unique mode scripts with dependency ordering
  const modeScripts = new Set();
  function addMode(m) {
    if (!m || m === 'null' || modeScripts.has(m)) return;
    // Add dependencies first
    if (MODE_DEPS[m]) MODE_DEPS[m].forEach(addMode);
    if (MODE_CDN[m]) modeScripts.add(m);
  }
  addMode(mode);

  const modeScriptTags = Array.from(modeScripts)
    .map(m => `<script src="${baseCdn}/mode/${MODE_CDN[m]}"></` + 'script>')
    .join('\n');

  return headerHtml + `</head><body>
<div id="bar"><span class="name">📄 ${encodedTitle}</span><span class="spacer"></span><span style="font-size:10px;color:#585b70">${mode === 'null' ? 'Plain Text' : mode}</span><button class="dl" onclick="downloadFile()">⬇ Download</button><button class="close" onclick="window.close()">✕</button></div>
<div id="main"></div>
<script src="${baseCdn}/codemirror.min.js"></` + `script>
${modeScriptTags}
<script>
CodeMirror(document.getElementById('main'),{
  value:${encodedContent},
  mode:'${mode}',
  theme:'material-darker',
  readOnly:true,
  lineNumbers:true,
  lineWrapping:false,
  viewportMargin:Infinity
}).setSize('100%','100%')
</` + `script>
<script>window.__FC__=${encodedContent};window.__FN__=${JSON.stringify(title)};function downloadFile(){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([window.__FC__],{type:'application/octet-stream'}));a.download=window.__FN__;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href)}</` + `script>
</body></html>`;
}

// Debounced disk saves: avoid writing on every single event
const saveTimers = new Map(); // sk -> setTimeout handle
const SAVE_DEBOUNCE_MS = 1000; // batch saves within 1 second

function scheduleSave(sk, session) {
  if (saveTimers.has(sk)) {
    clearTimeout(saveTimers.get(sk));
  }
  saveTimers.set(sk, setTimeout(() => {
    saveTimers.delete(sk);
    session._doSave();
  }, SAVE_DEBOUNCE_MS));
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

function getMessageSignature(msg) {
  const role = msg.role || 'user';
  const content = (msg.content || '').trim();
  if (!content) return null;
  // Content-only hash - two messages with same role+content are duplicates
  // regardless of when they were received
  return role + '|' + hashString(content);
}

function isDuplicateMessage(sk, msg) {
  if (!messageSignatures.has(sk)) {
    messageSignatures.set(sk, new Set());
  }
  const sigs = messageSignatures.get(sk);
  const sig = getMessageSignature(msg);
  if (!sig) return false; // empty content - don't dedup on it
  if (sigs.has(sig)) return true;
  sigs.add(sig);
  // Keep window large: after 500 entries, trim to 250 most recent
  if (sigs.size > 500) {
    const arr = Array.from(sigs);
    arr.slice(0, arr.length - 250).forEach(s => sigs.delete(s));
  }
  return false;
}

function convertToFrontendEvent(rawMsg) {
  const { event, payload } = rawMsg;
  const sk = payload?.sessionKey || rawMsg.sessionKey;
  const runId = payload?.runId || rawMsg.runId || makeId();

  // agent events carry tool/lifecycle/thinking/assistant streams when the
  // gateway registers this connection as a tool event recipient (v2026.5.28+).
  // Without this handler, tools from miniclaw-ui-initiated runs are dropped
  // because the connection is excluded from the session.tool broadcast.
  if (event === 'agent') {
    const stream = payload?.stream || '';
    if (stream === 'tool') {
      const data = payload?.data || {};
      const phase = data?.phase || '';
      const toolName = data?.name || data?.tool || '';
      const toolCallId = data?.toolCallId || '';
      const toolInput = data?.args || data?.input || data?.arguments || payload?.args || payload?.input || {};
      const toolResultRaw = data?.result || data?.meta || data?.output || payload?.result || payload?.meta || payload?.output || '';
      const toolResult = typeof toolResultRaw === 'string' ? toolResultRaw : JSON.stringify(toolResultRaw);
      const isError = data?.error || (typeof toolResult === 'string' && toolResult.startsWith('Error:'));

      if (phase === 'start') {
        return { type: 'tool_start', runId, toolName, input: toolInput, toolCallId, ts: Date.now() };
      } else if (phase === 'done' || phase === 'result' || phase === 'update') {
        if (toolResult || phase === 'done') {
          return { type: 'tool_result', runId, toolName, input: toolInput, result: toolResult, isError, toolCallId, ts: Date.now() };
        }
      }
    }
    // Non-tool agent streams (lifecycle, thinking, assistant) arrive through
    // other gateway paths - don't convert here to avoid duplicates.
    return null;
  }

  if (event === 'session.tool') {
    const stream = payload?.stream || '';
    const data = payload?.data || {};
    const phase = data?.phase || '';
    const toolName = data?.name || data?.tool || '';
    const toolCallId = data?.toolCallId || '';
    const toolInput = data?.args || data?.input || data?.arguments || payload?.args || payload?.input || {};
    const toolResultRaw = data?.result || data?.meta || data?.output || payload?.result || payload?.meta || payload?.output || '';
    const toolResult = typeof toolResultRaw === 'string' ? toolResultRaw : JSON.stringify(toolResultRaw);
    const isError = data?.error || (typeof toolResult === 'string' && toolResult.startsWith('Error:'));

    if (stream === 'tool') {
      if (phase === 'start') {
        return { type: 'tool_start', runId, toolName, input: toolInput, toolCallId, ts: Date.now() };
      } else if (phase === 'done' || phase === 'result' || phase === 'update') {
        if (toolResult || phase === 'done') {
          return { type: 'tool_result', runId, toolName, input: toolInput, result: toolResult, isError, toolCallId, ts: Date.now() };
        }
      }
    } else if (stream === 'lifecycle') {
      if (phase === 'start') {
        return { type: 'run_start', runId, model: data?.model || '', ts: Date.now() };
      } else if (phase === 'end') {
        return { type: 'run_end', runId, stopReason: data?.stopReason || 'completed', ts: Date.now() };
      } else if (phase === 'error') {
        return { type: 'run_error', runId, error: data?.error || '', ts: Date.now() };
      }
    } else if (stream === 'thinking') {
      const text = data?.text || data?.content || '';
      if (text) {
        return { type: 'thinking', runId, text, ts: Date.now() };
      }
    } else if (stream === 'assistant' || stream === 'user') {
      const text = data?.text || data?.content || '';
      if (text) {
        if (stream === 'user') return null; // gateway echo - never persist user_text from stream
        return { type: 'assistant_text', runId, text, ts: Date.now(), source: 'stream' };
      }
    }
  }

  if (event === 'session.message') {
    const msgData = payload?.message || payload || {};
    const role = msgData?.role || 'user';
    const contentArr = msgData?.content || msgData?.text || [];
    let thinking = '';
    let textContent = '';

    if (Array.isArray(contentArr)) {
      contentArr.forEach(block => {
        if (block?.type === 'thinking') thinking += block.thinking || '';
        if (block?.type === 'text') textContent += block.text || '';
      });
    }

    if (role === 'assistant') {
      const tokenData = payload?.session || payload || {};
      let textContent = '';
      let hasToolCalls = false;
      if (Array.isArray(contentArr)) {
        textContent = contentArr.map(block => {
          if (block?.type === 'text') return block.text || '';
          if (block?.type === 'toolCall') { hasToolCalls = true; return `[tool: ${block.name}]`; }
          return '';
        }).join('\n');
      }

      const runStartEvent = {
        type: 'run_start',
        runId,
        model: msgData?.model || tokenData?.model || '',
        inputTokens: tokenData?.inputTokens || 0,
        outputTokens: tokenData?.outputTokens || 0,
        totalTokens: tokenData?.totalTokens || 0,
        contextTokens: tokenData?.contextTokens || 0,
        estimatedCostUsd: tokenData?.estimatedCostUsd || 0,
        // thinking is now a separate event for consistency with streaming
        ts: Date.now()
      };

      const events = [runStartEvent];
      // Emit thinking as a standalone event (matches streaming behavior)
      if (thinking) {
        events.push({ type: 'thinking', runId, text: thinking, ts: Date.now() });
      }
      if (textContent) {
        events.push({ type: 'assistant_text', runId, text: textContent, ts: Date.now(), source: 'message', hasToolCalls, isIntermediate: hasToolCalls || undefined });
      }
      // Emit run_end to bookend the run (was missing - run_end rendering was dead code)
      events.push({
        type: 'run_end', runId,
        stopReason: 'end_turn',
        inputTokens: tokenData?.inputTokens || 0,
        outputTokens: tokenData?.outputTokens || 0,
        totalTokens: tokenData?.totalTokens || 0,
        contextTokens: tokenData?.contextTokens || 0,
        estimatedCost: tokenData?.estimatedCostUsd || 0,
        ts: Date.now()
      });
      return events;
    }

    // Only extract text blocks, ignore metadata blocks for user messages
    if (role === 'user' && textContent) {
      // Skip system-internal metadata messages (but NOT messages starting with [ - those can be real)
      if (textContent.startsWith('Sender') || textContent.startsWith('System')) {
        return null;
      }
      // Gateway echo - never persist. The canonical user_text is stored by the
      // chat handler (browser→server WS), not from gateway echoes.
      return null;
    }
  }

  if (event === 'sessions.tokens') {
    const tokenData = payload?.tokens || payload || {};
    return {
      type: 'tokens_update',
      inputTokens: tokenData?.inputTokens || 0,
      outputTokens: tokenData?.outputTokens || 0,
      totalTokens: tokenData?.totalTokens || 0,
      contextTokens: tokenData?.contextTokens || 0,
      estimatedCostUsd: tokenData?.estimatedCostUsd || 0,
      model: tokenData?.model || '',
      ts: Date.now()
    };
  }

  return null;
}

// ── Media path extraction (format-agnostic) ───────────────────────────────
// Message tool input formats are not under our control. This helper tries
// every known structure to find a file path. Add new strategies here as
// delivery formats evolve — never delete old ones.
function extractMediaPath(input) {
  if (!input || typeof input !== 'object') return '';

  // Strategy 1: direct filePath (old flat format)
  if (typeof input.filePath === 'string' && input.filePath) return input.filePath;

  // Strategy 2: attachments array (rich format)
  if (Array.isArray(input.attachments)) {
    for (const att of input.attachments) {
      if (att && typeof att.path === 'string' && att.path) return att.path;
    }
  }

  // Strategy 3: single attachment object
  if (input.attachment && typeof input.attachment.path === 'string' && input.attachment.path)
    return input.attachment.path;

  // Strategy 4: deep search (recursive, limited depth) — catch-all for
  // unknown future formats that nest a "path" field somewhere
  const search = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return '';
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (key === 'path' && typeof v === 'string' && v) return v;
      if (typeof v === 'object' && !Array.isArray(v)) {
        const found = search(v, depth + 1);
        if (found) return found;
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === 'object') {
            const found = search(item, depth + 1);
            if (found) return found;
          }
        }
      }
    }
    return '';
  };
  return search(input, 1);
}

// ── Async Media Completion Detection ──────────────────────────────────────
// When image_generate / video_generate / music_generate completes
// asynchronously, the agent receives a new run with runId pattern
// "<tool>_generate:<taskId>:ok" (or :error). Two delivery patterns exist:
//
// Pattern A (message tool): newer — tool_start for "message" carries
//   filePath in input → extract directly. Most common path.
// Pattern B (exec cp): older — exec cp"SRC" "DST" → parse command.
//
// This function detects either pattern, pairs back to the original generate
// call, and injects a virtual tool_result with the completed media.
function tryDetectMediaCompletion(ev, session) {
  let match, mediaType, taskId, status;
  let mediaPath = '', mediaFilename = '', caption = '';

  // ── Pattern A: message tool_start with filePath ─────────────────────
  if (ev.type === 'tool_start' && ev.toolName === 'message') {
    match = (ev.runId || '').match(
      /^(image_generate|video_generate|music_generate):([^:]+):(ok|error)$/
    );
    if (!match) return;
    [, mediaType, taskId, status] = match;

    // Extract filePath and message (LLM caption) from message input.
    // Uses format-agnostic helper: tries filePath, attachments[],
    // and deep-search as fallback for unknown future formats.
    const inp = typeof ev.input === 'string'
      ? (() => { try { return JSON.parse(ev.input); } catch { return {}; } })()
      : (ev.input || {});
    mediaPath = extractMediaPath(inp);
    if (mediaPath) mediaFilename = path.basename(mediaPath);
    caption = inp.message || '';
  }
  // ── Pattern B: exec tool_result after cp command ──────────────────
  else if (ev.type === 'tool_result' && ev.toolName === 'exec') {
    // Find matching exec tool_start (the cp command) — always recent
    let execStart = null;
    for (let i = session.events.length - 1; i >= 0 && i >= session.events.length - 50; i--) {
      if (session.events[i].type === 'tool_start' &&
          session.events[i].toolName === 'exec' &&
          session.events[i].toolCallId === ev.toolCallId) {
        execStart = session.events[i];
        break;
      }
    }
    if (!execStart) return;

    match = (execStart.runId || '').match(
      /^(image_generate|video_generate|music_generate):([^:]+):(ok|error)$/
    );
    if (!match) return;
    [, mediaType, taskId, status] = match;

    // Guard: only proceed if exec_start is actually a cp command.
    // Non-cp exec events (grep, read, etc.) happen in completion runs
    // but are NOT the file delivery — skip them to avoid bogus
    // virtual results with empty paths.
    const cmd = typeof execStart.input === 'string'
      ? execStart.input
      : (execStart.input?.command || '');
    const cpMatch = cmd.match(/cp\s+"([^"]+)"\s+"([^"]+)"/);
    if (!cpMatch) return;

    if (status === 'ok') {
      const srcPath = cpMatch[1];
      const dstPath = cpMatch[2];
      if (fs.existsSync(dstPath)) {
        mediaPath = dstPath;
      } else if (fs.existsSync(srcPath)) {
        mediaPath = srcPath;
      }
      mediaFilename = path.basename(mediaPath);
    }
  } else {
    return;
  }

  // ── Common pipeline (same for both patterns) ─────────────────────────────

  // Idempotency — runtime
  if (completedMediaTaskIds.has(taskId)) return;
  completedMediaTaskIds.add(taskId);

  // Idempotency — persistent (already on disk after restart)
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ve = session.events[i];
    if (ve.isVirtual && ve.toolName === mediaType) {
      try {
        const p = JSON.parse(ve.result);
        if (p?.details?.taskId === taskId) return;
      } catch {}
    }
  }

  // Find original generate tool_result (by taskId, last 300 events)
  let origResult = null;
  for (let i = session.events.length - 1; i >= 0 && i >= session.events.length - 300; i--) {
    const se = session.events[i];
    if (se.type === 'tool_result' && se.toolName === mediaType) {
      try {
        const p = JSON.parse(se.result);
        if (p?.details?.taskId === taskId) {
          origResult = se;
          break;
        }
      } catch {}
    }
  }
  if (!origResult) return;

  // Find original generate tool_start (same toolCallId)
  let origStart = null;
  for (let i = session.events.length - 1; i >= 0 && i >= session.events.length - 300; i--) {
    if (session.events[i].type === 'tool_start' &&
        session.events[i].toolName === mediaType &&
        session.events[i].toolCallId === origResult.toolCallId) {
      origStart = session.events[i];
      break;
    }
  }
  if (!origStart) return;

  // Validate media path exists (for ok status)
  if (status === 'ok' && mediaPath && !fs.existsSync(mediaPath)) {
    // File not found — try common container path as fallback
    const containerPath = path.join(
      os.homedir(), '.openclaw', 'media', 'tool-image-generation',
      path.basename(mediaPath)
    );
    if (fs.existsSync(containerPath)) {
      mediaPath = containerPath;
      mediaFilename = path.basename(mediaPath);
    } else {
      mediaPath = '';
      mediaFilename = '';
    }
  }

  // Create media token
  let mediaToken = '';
  if (mediaPath && fs.existsSync(mediaPath)) {
    mediaToken = crypto.randomUUID();
    const ext = path.extname(mediaPath).toLowerCase();
    const MIME_MAP = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4'
    };
    const now = Date.now();
    mediaTokens.set(mediaToken, {
      path: mediaPath,
      mimeType: MIME_MAP[ext] || 'application/octet-stream',
      createdAt: now,
      lastAccessed: now
    });
    // LRU eviction: keep at most 100 entries, evict oldest by creation time
    if (mediaTokens.size > 100) {
      let oldest = null;
      for (const [k, v] of mediaTokens) {
        if (!oldest || v.createdAt < oldest.createdAt) oldest = { key: k, createdAt: v.createdAt };
      }
      if (oldest) mediaTokens.delete(oldest.key);
    }
  }

  // Extract original prompt/size/format from tool_start input
  let origPrompt = '', origSize = '', origFormat = '';
  try {
    const inp = typeof origStart.input === 'string'
      ? JSON.parse(origStart.input) : origStart.input;
    if (inp) {
      origPrompt = inp.prompt || '';
      origSize = inp.size || '';
      origFormat = inp.outputFormat || '';
    }
  } catch {}

  // Build virtual tool_result
  const details = {
    status: status === 'ok' ? 'completed' : 'failed',
    async: true,
    taskId,
    prompt: origPrompt,
    size: origSize,
    outputFormat: origFormat
  };
  if (mediaToken) details.mediaToken = mediaToken;
  if (mediaPath) details.mediaPath = mediaPath;
  if (mediaFilename) details.filename = mediaFilename;
  if (caption) details.caption = caption;

  const virtualResult = {
    type: 'tool_result',
    runId: origStart.runId,
    toolName: mediaType,
    toolCallId: origResult.toolCallId,
    result: JSON.stringify({
      content: [{ type: 'text', text: status === 'ok' ? `${mediaType} completed → ${mediaFilename || 'file'}` : `${mediaType} failed` }],
      details
    }),
    isError: status !== 'ok',
    isVirtual: true,
    ts: new Date()
  };

  session.addEvent(virtualResult);
  log('info', `Virtual ${mediaType} result injected: taskId=${taskId}, status=${status}, path=${mediaPath || 'none'}`);
}

class SessionState {
  constructor(key, loadedFromDisk = false) {
    this.key = key;
    this.sessionId = '';
    this.events = [];
    this.messages = [];
    this._seenEventKeys = new Set(); // dedup: "type|runId|contentHash"
    this.tokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: false,
      contextTokens: 0,
      estimatedCostUsd: 0,
      model: '',
      modelProvider: '',
      status: ''
    };
    this.lastTs = new Date();
    this.createdAt = loadedFromDisk ? null : new Date();
    this._lastMsgBroadcastCount = 0;

    if (loadedFromDisk) {
      this.load();
    }
  }

  _makeEventKey(ev) {
    // Build a dedup key from event type + runId + content.
    // Includes result hash so virtual completion events (same toolCallId but
    // different result content) are NOT deduped against the original "started" result.
    const parts = [ev.type || '', ev.runId || ''];
    if (ev.text) parts.push(hashString(ev.text));
    if (ev.toolName) parts.push(ev.toolName);
    if (ev.toolCallId) parts.push(ev.toolCallId);
    if (ev.input) parts.push(hashString(typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input)));
    if (ev.result) parts.push(hashString(typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result)));
    return parts.join('|');
  }

  addEvent(ev) {
    ev.ts = new Date();
    ev.id = ev.id || makeId();

    // Dedup: skip if we've seen this exact event before
    const key = this._makeEventKey(ev);
    if (this._seenEventKeys.has(key)) return;
    this._seenEventKeys.add(key);

    // Keep dedup set bounded
    if (this._seenEventKeys.size > 2000) {
      const arr = Array.from(this._seenEventKeys);
      this._seenEventKeys = new Set(arr.slice(-1000));
    }

    this.events.push(ev);
    this.lastTs = ev.ts;

    if (this.events.length > 2000) {
      this.events = this.events.slice(-2000);
    }

    this.save();

    // Push event to all browser clients in real-time
    broadcastToClients({
      type: 'event',
      event: 'event.added',
      payload: { ...ev, sessionKey: this.key }
    });
  }

  addMessage(msg) {
    msg.ts = msg.ts || Date.now();
    msg.id = msg.id || makeId();
    this.messages.push(msg);

    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-500);
    }

    this.lastTs = new Date();
    this.save();
  }

  updateTokens(tokens, broadcast = true) {
    const prevTokens = { ...this.tokens };
    this.tokens = { ...this.tokens, ...tokens };
    this.save();

    if (broadcast) {
      broadcastToClients({
        type: 'event',
        event: 'session.tokens',
        payload: {
          sessionKey: this.key,
          tokens: this.tokens,
          prevTokens,
          ts: Date.now()
        }
      });
    }
  }

  // Debounced save: called on every event, batches writes
  save() {
    scheduleSave(this.key, this);
  }

  load() {
    const filePath = getSessionDataPath(this.key);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.sessionId = data.sessionId || '';
        this.events = data.events || [];
        this.messages = data.messages || [];
        this.tokens = data.tokens || this.tokens;
        this.createdAt = data.createdAt || null;
        // Rebuild dedup set from loaded events
        this._seenEventKeys = new Set();
        for (const ev of this.events) {
          this._seenEventKeys.add(this._makeEventKey(ev));
        }
        // Re-register media tokens from persisted virtual tool_result events
        // so completed images/video/audio survive server restarts.
        const mediaDir = path.join(os.homedir(), '.openclaw', 'media');
        for (const ev of this.events) {
          if (ev.isVirtual && ev.toolName &&
              /^(image_generate|video_generate|music_generate)$/.test(ev.toolName)) {
            try {
              const parsed = JSON.parse(ev.result);
              const d = parsed?.details;
              if (d?.mediaToken && d?.mediaPath) {
                const resolved = path.resolve(d.mediaPath);
                if (fs.existsSync(resolved) && resolved.startsWith(mediaDir)) {
                  const ext = path.extname(resolved).toLowerCase();
                  const MIME_MAP = {
                    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
                    '.bmp': 'image/bmp',
                    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
                    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
                    '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4'
                  };
                  const now = Date.now();
                  mediaTokens.set(d.mediaToken, {
                    path: resolved,
                    mimeType: MIME_MAP[ext] || 'application/octet-stream',
                    createdAt: now,
                    lastAccessed: now
                  });
                  // LRU eviction
                  if (mediaTokens.size > 100) {
                    let oldest = null;
                    for (const [k, v] of mediaTokens) {
                      if (!oldest || v.createdAt < oldest.createdAt) oldest = { key: k, createdAt: v.createdAt };
                    }
                    if (oldest) mediaTokens.delete(oldest.key);
                  }
                }
              }
            } catch {}
          }
        }
        // Reset message broadcast pointer so we don't re-send historical messages
        this._lastMsgBroadcastCount = this.messages.length;
        // DO NOT restore message signatures from disk across restarts.
        // Persisted hashes cause new messages (e.g. repeated test phrases)
        // to be incorrectly flagged as duplicates after a server restart.
        // messageSignatures is an in-memory runtime construct only.
        log('info', `Loaded session ${this.key} from disk: ${this.events.length} events, ${this.messages.length} messages`);
      } catch (e) {
        log('error', `Failed to load session ${this.key}:`, e.message);
      }
    }
  }

  // Immediate save: for critical operations (reset, delete, shutdown)
  _doSave() {
    const filePath = getSessionDataPath(this.key);
    try {
      const data = {
        key: this.key,
        sessionId: this.sessionId,
        events: this.events,
        messages: this.messages,
        tokens: this.tokens,
        createdAt: this.createdAt || new Date().toISOString(),
        lastTs: this.lastTs?.toISOString()
      };
      // messageSignatures are runtime-only; do NOT persist - stale hashes
      // cause false duplicate detection across server restarts.
      // Atomic write: write to temp file, then rename
      const tempPath = filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
      fs.renameSync(tempPath, filePath);
    } catch (e) {
      log('error', `Failed to save session ${this.key}:`, e.message);
    }
  }

  toClientFormat() {
    return {
      key: this.key,
      sessionId: this.sessionId,
      events: this.events,
      messages: this.messages,
      tokens: this.tokens,
      createdAt: this.createdAt,
      lastTs: this.lastTs?.toISOString()
    };
  }

  // Lightweight summary for initial connect (no events/messages arrays)
  toClientSummary() {
    return {
      key: this.key,
      sessionId: this.sessionId,
      eventCount: this.events.length,
      messageCount: this.messages.length,
      tokens: this.tokens,
      createdAt: this.createdAt,
      lastTs: this.lastTs?.toISOString()
    };
  }
}

function getSession(sk, loadFromDisk = true) {
  if (!sessions.has(sk)) {
    sessions.set(sk, new SessionState(sk, loadFromDisk));
  }
  return sessions.get(sk);
}

function broadcastToClients(payload) {
  const data = JSON.stringify(payload);
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(data);
    }
  });
}

const HTML_PATH = path.join(__dirname, 'index.html');

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);

  if (authEnabled) {
    if (!validateBasicAuth(req.headers['authorization'])) {
      res.writeHead(401, {
        'Content-Type': 'text/plain',
        'WWW-Authenticate': 'Basic realm="MiniClaw UI"'
      });
      res.end('401 Unauthorized');
      return;
    }
  }

  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(html);
    return;
  }

  if (parsedUrl.pathname === '/api/sessions') {
    // Only return in-memory sessions synced from gateway (not from disk)
    const sessionsList = [];
    sessions.forEach((sess, sk) => {
      sessionsList.push({
        key: sk,
        sessionId: sess.sessionId,
        eventCount: sess.events.length,
        messageCount: sess.messages.length,
        tokens: sess.tokens,
        lastTs: sess.lastTs?.toISOString()
      });
    });

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sessions: sessionsList }));
    return;
  }

  // Dynamic agent list from gateway config
  if (parsedUrl.pathname === '/api/agents') {
    const agentsPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    try {
      const data = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
      // Include only agents with a model (filter out tool-only entries)
      const agentList = (data.agents?.list || [])
        .filter(a => a.model)
        .map(a => ({
          id: a.id,
          model: a.model,
          sessionKey: `agent:${a.id}:main`
        }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ agents: agentList }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ agents: [], error: e.message }));
    }
    return;
  }

  const resetMatch = parsedUrl.pathname.match(/^\/api\/session\/([^/]+)\/reset$/);
  if (resetMatch) {
    const sk = decodeURIComponent(resetMatch[1]);
    const reqId = makeId();

    if (gwSocket && gwReady) {
      gwSocket.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'sessions.reset',
        params: { key: sk }
      }));
    }

    if (sessions.has(sk)) {
      const sess = sessions.get(sk);
      sess.events = [];
      sess.messages = [];
      sess.tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0 };
      sess._doSave();
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ key: sk, reset: true }));
    return;
  }

  const deleteMatch = parsedUrl.pathname.match(/^\/api\/session\/([^/]+)\/delete$/);
  if (deleteMatch) {
    const sk = decodeURIComponent(deleteMatch[1]);
    const reqId = makeId();

    // Notify gateway to delete the session
    if (gwSocket && gwReady) {
      gwSocket.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'sessions.delete',
        params: { key: sk }
      }));
    }

    // Cancel any pending debounced save to prevent disk file re-creation
    if (saveTimers.has(sk)) {
      clearTimeout(saveTimers.get(sk));
      saveTimers.delete(sk);
    }

    // Remove from memory
    if (sessions.has(sk)) {
      sessions.delete(sk);
    }

    // Track as deleted to prevent re-creation from in-flight gateway events
    deletedSessions.add(sk);

    // Delete from disk
    const filePath = getSessionDataPath(sk);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        log('info', `Deleted session file: ${sk}`);
      } catch (e) {
        log('error', `Failed to delete session file: ${e.message}`);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ key: sk, deleted: true }));
    return;
  }

  const clearEventsMatch = parsedUrl.pathname.match(/^\/api\/session\/([^/]+)\/clear-events$/);
  if (clearEventsMatch && req.method === 'POST') {
    const sk = decodeURIComponent(clearEventsMatch[1]);
    const sess = sessions.get(sk);

    if (!sess) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Session not found', key: sk }));
      return;
    }

    // Cancel any pending debounced save to avoid race conditions
    if (saveTimers.has(sk)) {
      clearTimeout(saveTimers.get(sk));
      saveTimers.delete(sk);
    }

    const beforeCount = sess.events.length;

    // Keep user_text + only final assistant_text (skip streaming, tool-call, and intermediate)
    // Uses isIntermediate/isFinal when available (post run_end), falls back to hasToolCalls + source
    const filtered = sess.events.filter(ev => {
      if (ev.type === 'user_text') return true;
      if (ev.type !== 'assistant_text') return false;
      // Explicit final marker from run_end processing
      if (ev.isFinal === true) return true;
      // Explicit intermediate marker (from run_end or hasToolCalls at creation)
      if (ev.isIntermediate === true) return false;
      // Backward compat: if neither marker set, use source + hasToolCalls heuristic
      if (ev.source !== 'message') return false;  // skip streaming deltas
      if (ev.hasToolCalls) return false;           // skip tool-call messages
      return true;  // keep text-only message events (best guess for historical data)
    });

    // If nothing would be removed (already filtered), clear everything
    if (filtered.length === beforeCount) {
      sess.events = [];
    } else {
      sess.events = filtered;
    }
    const afterCount = sess.events.length;

    // Rebuild dedup set from remaining events
    sess._seenEventKeys = new Set();
    for (const ev of sess.events) {
      sess._seenEventKeys.add(sess._makeEventKey(ev));
    }

    // Reset token counters (no longer meaningful after filtering)
    sess.tokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: false,
      contextTokens: 0,
      estimatedCostUsd: 0,
      model: '',
      modelProvider: '',
      status: ''
    };

    // Persist immediately
    sess._doSave();

    // Broadcast updated session to all browser clients
    broadcastToClients({
      type: 'event',
      event: 'session.cleared',
      payload: { sessionKey: sk, eventsRemoved: beforeCount - afterCount, eventsKept: afterCount }
    });

    const action = afterCount === 0 ? 'fully cleared' : 'filtered';
    log('info', `Cleared session ${sk} (${action}): ${beforeCount - afterCount} events removed, ${afterCount} kept`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ key: sk, eventsRemoved: beforeCount - afterCount, eventsKept: afterCount }));
    return;
  }

  const sessionMatch = parsedUrl.pathname.match(/^\/api\/session\/(.+)$/);
  if (sessionMatch) {
    const sk = decodeURIComponent(sessionMatch[1]);
    const limit = parseInt(parsedUrl.query.limit) || 0; // 0 = no limit (all)
    const sess = sessions.get(sk);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    if (sess) {
      const fmt = sess.toClientFormat();
      if (limit > 0 && fmt.events.length > limit) {
        fmt.events = fmt.events.slice(-limit);
        fmt.truncated = true;
        fmt.totalEventCount = sess.events.length;
      }
      res.end(JSON.stringify(fmt));
    } else {
      res.end(JSON.stringify({ key: sk, events: [], messages: [], tokens: {}, error: 'not found' }));
    }
    return;
  }

  const eventsMatch = parsedUrl.pathname.match(/^\/api\/events\/(.+)$/);
  if (eventsMatch) {
    const sk = decodeURIComponent(eventsMatch[1]);
    const limit = parseInt(parsedUrl.query.limit) || 100;
    const sess = sessions.get(sk);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    if (sess) {
      const events = sess.events.slice(-limit);
      res.end(JSON.stringify({ sessionKey: sk, events, total: sess.events.length }));
    } else {
      res.end(JSON.stringify({ sessionKey: sk, events: [], total: 0 }));
    }
    return;
  }

  // ── Reusable media serving (virtual tool results) ─────────────────────
  // GET /api/media/serve/:token — serves media files from async generation
  // completions. Non-consumable (unlike file sharing). Tokens survive page
  // reloads and server restarts (re-registered in SessionState.load()).
  {
    const mediaServeMatch = parsedUrl.pathname.match(/^\/api\/media\/serve\/([^/]+)$/);
    if (mediaServeMatch) {
      const token = mediaServeMatch[1];
      const entry = mediaTokens.get(token);

      if (!entry) {
        res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Media token expired or invalid');
        return;
      }

      // TTL expiry: 7 days since creation or 24h since last access
      const now = Date.now();
      const CREATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
      const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
      const age = now - (entry.createdAt || 0);
      const idle = now - (entry.lastAccessed || 0);
      if (age > CREATION_TTL_MS || idle > IDLE_TTL_MS) {
        mediaTokens.delete(token);
        res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Media token expired');
        return;
      }
      entry.lastAccessed = now;

      // Security check: path must be under ~/.openclaw/media/
      const mediaDir = path.join(os.homedir(), '.openclaw', 'media');
      const resolved = path.resolve(entry.path);
      if (!resolved.startsWith(mediaDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Access denied');
        return;
      }

      if (!fs.existsSync(resolved)) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('File not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': entry.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      });
      const readStream = fs.createReadStream(resolved);
      readStream.pipe(res);
      readStream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Error reading file');
        }
      });
      return;
    }
  }

  // One-shot file sharing: generate a single-use download link
  if (parsedUrl.pathname === '/api/files/share' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'filePath is required' }));
          return;
        }

        const resolved = path.resolve(filePath);
        const allowed = FILE_SHARE_ALLOWED_PREFIXES.some(prefix => resolved.startsWith(prefix));
        if (!allowed) {
          log('warn', `File share rejected (path not allowed): ${resolved} (prefixes: ${FILE_SHARE_ALLOWED_PREFIXES.join(', ')})`);
          res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: `File path not allowed: ${resolved}` }));
          return;
        }

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

        const token = crypto.randomUUID();
        const timeoutHandle = setTimeout(() => {
          fileShareTokens.delete(token);
        }, FILE_SHARE_TTL_MS);

        fileShareTokens.set(token, { path: resolved, timeoutHandle });
        log('info', `File share token created: ${token} → ${resolved}`);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          url: `/api/files/serve/${token}`,
          viewUrl: `/api/files/view/${token}`,
          filename: path.basename(resolved)
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // One-shot file serving: serve a file by token (consumes the token)
  const serveMatch = parsedUrl.pathname.match(/^\/api\/files\/serve\/([^/]+)$/);
  if (serveMatch) {
    const token = serveMatch[1];
    const entry = fileShareTokens.get(token);

    if (!entry) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('This link has expired or already been used.');
      return;
    }

    // Consume immediately - prevents double-click re-download, browser prefetch, etc.
    fileShareTokens.delete(token);
    clearTimeout(entry.timeoutHandle);

    if (!fs.existsSync(entry.path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('File no longer exists.');
      return;
    }

    try {
      if (!fs.statSync(entry.path).isFile()) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Path is not a regular file.');
        return;
      }
    } catch (statErr) {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Error reading file.');
      return;
    }

    const filename = path.basename(entry.path);
    log('info', `Serving one-shot file: ${entry.path} (token consumed)`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*'
    });
    const readStream = fs.createReadStream(entry.path);
    readStream.pipe(res);
    readStream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Error reading file');
      }
    });
    return;
  }

  // One-shot file viewer: serves an HTML page with embedded file content
  const viewMatch = parsedUrl.pathname.match(/^\/api\/files\/view\/([^/]+)$/);
  if (viewMatch) {
    const token = viewMatch[1];
    const entry = fileShareTokens.get(token);

    if (!entry) {
      res.writeHead(410, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end('<!DOCTYPE html><body style="background:#1e1e2e;color:#cdd6f4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>Link Expired</h2><p style="color:#a6adc8">This link has expired or already been used.</p></div></body>');
      return;
    }

    // Consume immediately to prevent double-use
    fileShareTokens.delete(token);
    clearTimeout(entry.timeoutHandle);

    if (!fs.existsSync(entry.path)) {
      res.writeHead(404, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end('<!DOCTYPE html><body style="background:#1e1e2e;color:#cdd6f4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh"><h2>File Not Found</h2></body>');
      return;
    }

    // Read the file content (cap at 2MB for viewer)
    let stat;
    try {
      stat = fs.statSync(entry.path);
    } catch (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end('<!DOCTYPE html><body style="background:#1e1e2e;color:#cdd6f4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh"><h2>File Unavailable</h2><p style="color:#a6adc8">' + statErr.message + '</p></body>');
      return;
    }

    if (!stat.isFile()) {
      res.writeHead(400, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end('<!DOCTYPE html><body style="background:#1e1e2e;color:#cdd6f4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Not a File</h2><p style="color:#a6adc8">The requested path is not a regular file.</p></body>');
      return;
    }

    const MAX_VIEW_SIZE = 2 * 1024 * 1024; // 2MB
    if (stat.size > MAX_VIEW_SIZE) {
      res.writeHead(413, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end('<!DOCTYPE html><body style="background:#1e1e2e;color:#cdd6f4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>File Too Large</h2><p style="color:#a6adc8">Files over 2MB cannot be previewed inline.</p></div></body>');
      return;
    }

    // Detect file type to decide how to read
    const fileType = detectFileType(entry.path);
    const isImage = fileType.kind === 'image';

    let content;
    try {
      if (isImage) {
        // Read images as base64 for data URI embedding (includes SVG)
        const buf = fs.readFileSync(entry.path);
        content = buf.toString('base64');
      } else {
        content = fs.readFileSync(entry.path, 'utf8');
      }
    } catch (readErr) {
      res.writeHead(500, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end('<!DOCTYPE html><body style="background:#1e1e2e;color:#cdd6f4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Read Error</h2><p style="color:#a6adc8">' + readErr.message + '</p></body>');
      return;
    }

    const filename = path.basename(entry.path);
    log('info', `Viewing one-shot file: ${entry.path} (token consumed)`);

    const viewerHtml = generateViewerPage(entry.path, content, filename);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(viewerHtml);
    return;
  }

  // Save edited file content (markdown editor)
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

        const resolved = path.resolve(filePath);
        const allowed = FILE_SHARE_ALLOWED_PREFIXES.some(prefix => resolved.startsWith(prefix));
        if (!allowed) {
          log('warn', `File save rejected (path not allowed): ${resolved}`);
          res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: `File path not allowed: ${resolved}` }));
          return;
        }

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

        const MAX_SAVE_SIZE = 2 * 1024 * 1024;
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > MAX_SAVE_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Content exceeds 2MB limit' }));
          return;
        }

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

  if (parsedUrl.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      gatewayReady: gwReady,
      sessionCount: sessions.size,
      clientCount: clients.size,
      dataDir: DATA_DIR
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// Load TLS certificates if available
const fullchainPath = path.join(__dirname, 'fullchain.pem');
const privkeyPath = path.join(__dirname, 'privkey.pem');
const certs = fs.existsSync(fullchainPath) && fs.existsSync(privkeyPath)
  ? { key: fs.readFileSync(privkeyPath), cert: fs.readFileSync(fullchainPath) }
  : null;

const server = certs
  ? https.createServer(certs, handleRequest)
  : http.createServer(handleRequest);

if (certs) {
  log('info', 'TLS certificates loaded - HTTPS enabled');
} else {
  log('warn', 'No TLS certificates found - running without HTTPS');
}

const wss = new WebSocket.Server({
  server,
  verifyClient: ({ req }) => {
    // Enforce same Basic Auth as HTTP endpoints.
    // Browsers automatically send cached credentials on same-origin
    // WebSocket upgrades, including auto-reconnects. When the password
    // changes and the server restarts, old clients are rejected here
    // and must refresh the page to re-authenticate.
    return authEnabled ? validateBasicAuth(req.headers['authorization']) : true;
  }
});

wss.on('connection', (ws, req) => {
  const clientId = makeId();
  ws.id = clientId;
  clients.add(ws);
  log('info', `Browser client connected: ${clientId} (total: ${clients.size})`);

  ws.send(JSON.stringify({
    type: 'event',
    event: 'status',
    payload: {
      gatewayReady: gwReady,
      sessionCount: sessions.size,
      clientCount: clients.size,
      ts: Date.now()
    }
  }));

  sessions.forEach((sess, sk) => {
    const allEvents = sess.events;
    const SYNC_EVENT_LIMIT = 100;
    const truncated = allEvents.length > SYNC_EVENT_LIMIT;
    const syncEvents = truncated ? allEvents.slice(-SYNC_EVENT_LIMIT) : allEvents;
    log('info', `Syncing session ${sk} to client ${clientId}: ${syncEvents.length} events (of ${allEvents.length}), ${sess.messages.length} messages`);
    ws.send(JSON.stringify({
      type: 'event',
      event: 'session.sync',
      payload: {
        ...sess.toClientFormat(),
        sessionKey: sk,
        events: syncEvents,
        truncated,
        totalEventCount: allEvents.length
      }
    }));
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } else if (data.type === 'req') {
        handleClientRequest(ws, data);
      } else if (data.type === 'chat') {
        const sk = data.sessionKey || 'agent:main:main';
        const chatMsg = data.message;
        const chatReqId = makeId();

        chatRequests.set(chatReqId, { ws, sessionKey: sk });

        // Create canonical user_text event - the single source of truth.
        // gateway echoes are silenced in convertToFrontendEvent.
        const session = getSession(sk);
        session.addEvent({
          type: 'user_text',
          runId: 'chat-' + chatReqId,
          text: chatMsg,
          ts: new Date(),
          source: 'canonical'
        });

        if (gwSocket && gwReady) {
          gwSocket.send(JSON.stringify({
            type: 'req',
            id: chatReqId,
            method: 'sessions.send',
            params: { key: sk, message: chatMsg }
          }));
          log('info', `Forwarded chat to ${sk}: ${chatMsg.substring(0, 50)}...`);

          // Phase 4: Send immediate acknowledgment to browser
          ws.send(JSON.stringify({
            type: 'chat_ack',
            ok: true,
            sessionKey: sk,
            ts: Date.now()
          }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Gateway not connected' }));
        }
      }
    } catch (e) {
      log('error', 'Failed to parse client message:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Clean up any pending chat requests from this client
    chatRequests.forEach((entry, reqId) => {
      if (entry.ws === ws) chatRequests.delete(reqId);
    });
    log('info', `Browser client disconnected (total: ${clients.size})`);
  });
});

function handleClientRequest(ws, req) {
  const { method, params, id } = req;
  let response = { type: 'res', id, ok: true };

  if (method === 'sessions.list') {
    const list = [];
    sessions.forEach((sess, sk) => {
      list.push({
        key: sk,
        sessionId: sess.sessionId,
        tokens: sess.tokens,
        eventCount: sess.events.length,
        messageCount: sess.messages.length
      });
    });
    response.payload = { sessions: list };
  } else if (method === 'sessions.get') {
    const sess = sessions.get(params.sessionKey);
    if (sess) {
      response.payload = sess.toClientFormat();
    } else {
      response.ok = false;
      response.error = { code: 'NOT_FOUND', message: 'Session not found' };
    }
  } else if (method === 'events.get') {
    const sess = sessions.get(params.sessionKey);
    if (sess) {
      const limit = params.limit || 100;
      response.payload = {
        sessionKey: params.sessionKey,
        events: sess.events.slice(-limit),
        total: sess.events.length
      };
    } else {
      response.ok = false;
      response.error = { code: 'NOT_FOUND', message: 'Session not found' };
    }
  } else if (method === 'sessions.reset') {
    const sk = params.key || 'agent:main:main';
    const reason = params.reason || 'new';
    const reqId = makeId();

    if (gwSocket && gwReady) {
      gwSocket.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'sessions.reset',
        params: { key: sk, reason }
      }));
    }

    if (sessions.has(sk)) {
      const sess = sessions.get(sk);
      sess.events = [];
      sess.messages = [];
      sess.tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0 };
      sess._doSave();
    }

    response.payload = { key: sk, reset: true };
  } else if (method === 'sessions.create') {
    const reqId = makeId();
    const sessionKey = params.key || 'agent:main:main';

    if (gwSocket && gwReady) {
      gwSocket.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'sessions.create',
        params: { key: sessionKey }
      }));
    }

    response.payload = { key: sessionKey, created: true };
  } else if (method === 'sessions.abort') {
    const sk = params.key || 'agent:main:main';
    const reqId = makeId();

    if (gwSocket && gwReady) {
      gwSocket.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'sessions.abort',
        params: { key: sk }
      }));
      log('info', `Abort requested for session: ${sk}`);
    }

    response.payload = { key: sk, aborted: true };
  } else {
    response.ok = false;
    response.error = { code: 'METHOD_NOT_FOUND', message: method };
  }

  ws.send(JSON.stringify(response));
}

function connectGateway() {
  log('info', `Connecting to gateway at ${GW_URL}...`);

  const originProtocol = GW_URL.startsWith('wss') ? 'https' : 'http';
  gwSocket = new WebSocket(GW_URL, {
    headers: { 'Origin': `${originProtocol}://127.0.0.1:18789` },
    rejectUnauthorized: false
  });

  gwSocket.on('open', () => {
    log('info', 'Gateway connected, awaiting challenge...');
  });

  gwSocket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleGatewayMessage(msg);
    } catch (err) {
      log('error', 'Failed to parse gateway message:', err.message);
    }
  });

  gwSocket.on('close', (code, reason) => {
    log('warn', `Gateway disconnected (${code}): ${reason}`);
    gwReady = false;
    connectResponseId = null;
    pendingSubId = null;
    broadcastToClients({ type: 'event', event: 'gateway.disconnected', payload: { code, reason: reason.toString() } });
    setTimeout(connectGateway, 3000);
  });

  gwSocket.on('error', (err) => {
    log('error', 'Gateway socket error:', err.message);
  });
}

function handleGatewayMessage(msg) {
  const { type, event, id, payload } = msg;

  if (type === 'event' && event === 'connect.challenge') {
    const nonce = payload.nonce;
    const ts = payload.ts;

    const scopes = [
      'operator.read', 'operator.write', 'operator.admin',
      'sessions.subscribe', 'sessions.unsubscribe',
      'sessions.list', 'sessions.history',
      'sessions.send', 'sessions.reset', 'sessions.create'
    ];

    const connectParams = {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: 'openclaw-control-ui',
        version: '1.0.0',
        platform: process.platform,
        mode: 'webchat'
      },
      scopes: scopes,
      caps: ['tool-events', 'llm-events'],
      auth: { token: GW_TOKEN },
      role: 'operator',
      userAgent: 'miniclaw-ui/1.5'
    };

    if (deviceIdentity) {
      const signedAtMs = Date.now();
      const devicePayload = buildDeviceAuthPayloadV3({
        deviceId: deviceIdentity.deviceId,
        clientId: 'openclaw-control-ui',
        clientMode: 'webchat',
        role: 'operator',
        scopes: scopes,
        signedAtMs: signedAtMs,
        token: deviceIdentity.operatorToken,
        nonce: nonce,
        platform: process.platform,
        deviceFamily: ''
      });
      const signature = signDevicePayload(deviceIdentity.privateKeyPem, devicePayload);
      const publicKeyBase64Url = publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem);
      connectParams.auth.deviceToken = deviceIdentity.operatorToken;
      connectParams.device = {
        id: deviceIdentity.deviceId,
        publicKey: publicKeyBase64Url,
        signature: signature,
        signedAt: signedAtMs,
        nonce: nonce
      };
    } else {
      log('warn', 'No device identity available, using token-only auth');
    }

    connectResponseId = makeId();
    gwSocket.send(JSON.stringify({
      type: 'req',
      id: connectResponseId,
      method: 'connect',
      params: connectParams
    }));
    return;
  }

  if (type === 'res' && id === connectResponseId) {
    if (msg.ok) {
      log('info', 'Gateway auth successful');
      gwReady = true;
      deletedSessions.clear(); // Reset deletion tracking on fresh gateway connection
      broadcastToClients({ type: 'event', event: 'gateway.connected', payload: { ts: Date.now() } });

      setTimeout(() => {
        pendingSubId = makeId();
        gwSocket.send(JSON.stringify({
          type: 'req',
          id: pendingSubId,
          method: 'sessions.subscribe',
          params: {}
        }));
      }, 100);

      setTimeout(() => {
        const listId = makeId();
        gwSocket.send(JSON.stringify({
          type: 'req',
          id: listId,
          method: 'sessions.list',
          params: {}
        }));
      }, 200);
    } else {
      log('error', 'Gateway auth failed:', JSON.stringify(msg.error));
    }
    return;
  }

  if (type === 'res' && id === pendingSubId) {
    log('info', 'Sessions subscribed');
    pendingSubId = null;
    return;
  }

  if (type === 'res' && chatRequests.has(id)) {
    const entry = chatRequests.get(id);
    const clientWs = entry.ws;
    const sk = entry.sessionKey;
    log('info', 'Chat response:', msg.ok ? 'ok' : JSON.stringify(msg.error || msg));

    // Phase 4: Forward delivery confirmation to browser
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'chat_delivered',
        ok: msg.ok,
        sessionKey: sk,
        ts: Date.now()
      }));
    }

    chatRequests.delete(id);
    return;
  }

  function calculateActualContext(events) {
    if (!events || events.length === 0) return 0;
    let totalChars = 0;
    events.forEach(ev => {
      if (ev.input && typeof ev.input === 'string') totalChars += ev.input.length;
      if (ev.result && typeof ev.result === 'string') totalChars += ev.result.length;
      if (ev.text && typeof ev.text === 'string') totalChars += ev.text.length;
      if (ev.thinking && typeof ev.thinking === 'string') totalChars += ev.thinking.length;
    });
    return Math.ceil(totalChars / 4);
  }

  if (type === 'res' && payload?.sessions) {
    const gatewaySessionKeys = new Set(payload.sessions.map(s => s.key));

    // Remove sessions that no longer exist on gateway
    sessions.forEach((sess, sk) => {
      if (!gatewaySessionKeys.has(sk)) {
        sessions.delete(sk);
        const filePath = getSessionDataPath(sk);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            log('info', `Removed stale session: ${sk}`);
          } catch (e) {
            log('error', `Failed to delete stale session file: ${e.message}`);
          }
        }
        // Broadcast removal to all browser clients so their session maps stay in sync
        broadcastToClients({
          type: 'event',
          event: 'sessions.changed',
          payload: { sessionKey: sk, state: 'deleted', phase: 'ended', ts: Date.now() }
        });
      }
    });

    payload.sessions.forEach(sess => {
      const sk = sess.key;
      // Skip sessions the user explicitly deleted - the gateway may not have
      // processed the deletion yet. Marker cleared on reconnect or when a
      // genuine sessions.changed (state='created') arrives.
      if (deletedSessions.has(sk)) return;
      deletedSessions.delete(sk);
      const session = getSession(sk);
      session.sessionId = sess.sessionId || '';

      const actualContext = calculateActualContext(session.events);
      const gatewayContext = sess.contextTokens || 0;
      const finalContext = actualContext > 0 ? actualContext : gatewayContext;

      session.updateTokens({
        inputTokens: sess.inputTokens || 0,
        outputTokens: sess.outputTokens || 0,
        totalTokens: sess.totalTokens || 0,
        totalTokensFresh: sess.totalTokensFresh || false,
        contextTokens: finalContext,
        estimatedCostUsd: sess.estimatedCostUsd || 0,
        model: sess.model || '',
        modelProvider: sess.modelProvider || '',
        status: sess.status || ''
      });

      log('info', `Session ${sk}: tokens=${session.tokens.totalTokens}, context=${finalContext} (gateway=${gatewayContext})`);
    });
    return;
  }

  if (type === 'event' || type === 'broadcast') {
    const eventName = event || msg.name;

    // Handle session deletion BEFORE forwarding to clients or re-creating state.
    // Otherwise getSession(sk) re-creates a just-deleted session.
    if (eventName === 'sessions.changed') {
      const state = payload?.state || msg?.state || '';
      const reason = payload?.reason || '';
      if (state === 'ended' || state === 'deleted' || reason === 'deleted' || reason === 'ended') {
        const changedSk = payload?.sessionKey || msg?.sessionKey || payload?.session?.key;
        log('info', `Session ended/deleted from gateway: ${changedSk}`);
        deletedSessions.add(changedSk);
        if (changedSk && sessions.has(changedSk)) {
          sessions.delete(changedSk);
          const fp = getSessionDataPath(changedSk);
          if (fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); } catch (e) { /* ignore */ }
          }
        }
        // Broadcast deletion to all browser clients so they can remove it from UI
        broadcastToClients({
          type: 'event',
          event: 'sessions.changed',
          payload: { sessionKey: changedSk, state, phase: 'ended', ts: Date.now() }
        });
        return;
      }
    }

    broadcastToClients(msg);

    const sk = payload?.sessionKey || msg.sessionKey || payload?.session?.key;
    if (sk) {
      // Don't re-create state for deleted sessions from in-flight gateway events
      if (deletedSessions.has(sk)) {
        if (eventName !== 'sessions.changed') return;
        // Only clear the deletion marker for genuinely recreated sessions,
        // not for loaded/list-sync events that may arrive before the gateway
        // has processed the deletion.
        const evtState = payload?.state || msg?.state || '';
        const evtReason = payload?.reason || '';
        if (evtState === 'created' || evtReason === 'create') {
          deletedSessions.delete(sk);
        } else {
          return;
        }
      }
      const session = getSession(sk);

      const converted = convertToFrontendEvent(msg);
      if (converted) {
        const events = Array.isArray(converted) ? converted : [converted];
        let hasRunEnd = false;
        let runEndRunId = null;
        events.forEach(ev => {
          ev.sessionKey = sk;
          ev.ts = Date.now();

          // ── Detect async media completion BEFORE persisting ─────────
          // Pattern A (message tool_start) must run before addEvent so
          // caption extraction works, THEN we can filter the event.
          // Pattern B (exec tool_result) runs AFTER addEvent — it needs
          // to search backwards through session.events for the exec start.
          let skip = false;

          if (ev.type === 'tool_start' && ev.toolName === 'message') {
            // Pattern A: message tool_start with runId like image_generate:<taskId>:ok
            const runMatch = (ev.runId || '').match(
              /^(image_generate|video_generate|music_generate):[^:]+:(ok|error)$/
            );
            if (runMatch) {
              // Extract caption + filePath first via detection
              tryDetectMediaCompletion(ev, session);
              // Then filter the delivery plumbing event from display
              skip = true;
              completionDeliveryCallIds.add(ev.toolCallId);
            }
          }

          if (ev.type === 'tool_result' && ev.toolName === 'message') {
            // Filter tool_result if its tool_start was a completion delivery
            if (completionDeliveryCallIds.has(ev.toolCallId)) {
              completionDeliveryCallIds.delete(ev.toolCallId);
              skip = true;
            }
          }

          if (!skip) {
            session.addEvent(ev);
          }

          // Pattern B (exec tool_result) — runs AFTER addEvent, searches
          // backwards in event list for matching exec tool_start.
          // exec events are NOT filtered — they represent real tool calls.
          if (ev.type === 'tool_result' && ev.toolName === 'exec') {
            tryDetectMediaCompletion(ev, session);
          }

          // Also update SessionState tokens when run_start includes token data
          if (ev.type === 'run_start' && ev.totalTokens) {
            session.updateTokens({
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
              totalTokens: ev.totalTokens,
              contextTokens: ev.contextTokens,
              estimatedCostUsd: ev.estimatedCostUsd,
              model: ev.model
            }, false); // Don't re-broadcast, already done via addEvent
          }

          if (ev.type === 'run_end' && ev.runId) {
            hasRunEnd = true;
            runEndRunId = ev.runId;
          }
        });

        // When run_end arrives, mark the last assistant_text for this runId as final,
        // and earlier assistant_text events as intermediate
        if (hasRunEnd && runEndRunId) {
          let foundFinal = false;
          for (let i = session.events.length - 1; i >= 0; i--) {
            const e = session.events[i];
            if (e.runId !== runEndRunId) continue;
            if (e.type === 'assistant_text') {
              if (!foundFinal) {
                e.isFinal = true;
                e.isIntermediate = false;
                foundFinal = true;
              } else if (!e.isFinal) {
                e.isIntermediate = true;
              }
            }
          }
          // If no assistant_text was found (e.g. tool-only run), that's fine
        }
      }
      // Raw events that didn't convert are silently dropped - they're
      // internal plumbing (agent, chat, sessions.changed, heartbeat, etc.)
      // that don't belong in the display events array.

      if (eventName === 'session.tool' || eventName === 'sessions.tokens') {
        const tokens = payload?.tokens || payload?.session || payload;
        if (tokens?.totalTokens !== undefined) {
          const existing = session.tokens?.contextTokens || 0;
          const eventCtx = tokens?.contextTokens || 0;
          const finalCtx = (eventCtx > 0 && eventCtx < 200000) ? eventCtx : existing;
          session.updateTokens({ ...tokens, contextTokens: finalCtx });
        }
      }

      if ((eventName === 'session.message' || eventName === 'agent.turn') && payload) {
        let rawContent = payload.content || payload.text ||
                     payload.message?.content || payload.message?.text || '';
        if (!rawContent && payload.message) {
          rawContent = payload.message.content || payload.message.text || '';
        }
        // Parse and extract clean text BEFORE storing
        const content = parseMessageContent(rawContent);
        const role = payload.role || payload.message?.role || (eventName === 'agent.turn' ? 'assistant' : 'user');

        if (content && content.length > 0) {
          const msg = {
            role: role,
            content: content, // Store PARSED text, not raw JSON
            ts: Date.now()
          };

          // Filter out metadata garbage before storing
          // NOTE: removed ^\[ - real messages can start with brackets (e.g. "[important] ...")
          const isMetadataGarbage = /^(Sender|System|\[Mon|\[Tue|\[Wed)/.test(content);
          if (isMetadataGarbage) {
            log('info', `Skipping metadata garbage for ${sk}: ${content.slice(0, 50)}`);
          } else if (isDuplicateMessage(sk, msg)) {
            log('info', `Skipping duplicate message for ${sk}`);
          } else {
            session.addMessage(msg);

            // Send only the new message delta, not the entire array
            const startIdx = session._lastMsgBroadcastCount || 0;
            const newMsgs = session.messages.slice(startIdx);
            session._lastMsgBroadcastCount = session.messages.length;

            broadcastToClients({
              type: 'event',
              event: 'session.messages',
              payload: {
                sessionKey: sk,
                messages: newMsgs,
                events: [],
                ts: Date.now()
              }
            });
          }
        }
      }
    }

    if (eventName === 'sessions.changed') {
      const phase = payload?.phase || '';
      const state = payload?.state || '';

      // Only reset for NEW sessions (state='created'), not for existing sessions being loaded
      // Use sessions.get(sk) because the 'session' variable is scoped inside the if(sk) block above
      const reason = payload?.reason || '';
      if (state === 'created' || phase === 'created' || reason === 'create') {
        deletedSessions.delete(sk); // Gateway explicitly creates this session
        log('info', `Creating new session: ${sk}`);

        const sess = sessions.get(sk);
        if (sess) {
          sess.events = [];
          sess.messages = [];

          sess.tokens = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            totalTokensFresh: false,
            contextTokens: 0,
            estimatedCostUsd: 0,
            model: '',
            modelProvider: '',
            status: ''
          };

          // Persist the cleared state to disk so it doesn't leak on restart
          sess._doSave();
        }

        const filePath = getSessionDataPath(sk);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            log('info', `Deleted old session file: ${sk}`);
          } catch (e) {
            log('error', `Failed to delete session file: ${e.message}`);
          }
        }
      }

      log('info', `SESSION CHANGED: ${sk}`);
    }
  }
}

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (line) => {
  const cmd = line.trim().toLowerCase();

  if (cmd === 'status') {
    console.log('\n=== MiniClaw UI Status ===');
    console.log('Gateway:', gwReady ? 'connected' : 'disconnected');
    console.log('Sessions:', sessions.size);
    console.log('Browser clients:', clients.size);
    console.log('Data directory:', DATA_DIR);
  } else if (cmd === 'sessions') {
    console.log('\n=== Sessions ===');
    sessions.forEach((sess, sk) => {
      console.log(`${sk}: ${sess.events.length} events, ${sess.messages.length} msgs, tokens: ${sess.tokens.totalTokens}`);
    });
  } else if (cmd === 'events') {
    const limit = 5;
    sessions.forEach((sess, sk) => {
      console.log(`\n${sk} (last ${Math.min(limit, sess.events.length)} events):`);
      sess.events.slice(-limit).forEach((ev, i) => {
        console.log(`  ${i}: ${ev.type} at ${ev.ts}`);
      });
    });
  } else if (cmd === 'gc') {
    const before = sessions.size;
    const now = Date.now();
    sessions.forEach((sess, sk) => {
      if (now - sess.lastTs.getTime() > 3600000) {
        sessions.delete(sk);
      }
    });
    console.log(`Cleaned up ${before - sessions.size} stale sessions`);
  } else if (cmd === 'reset') {
    sessions.clear();
    console.log('Sessions cleared (disk data retained)');
  } else if (cmd === 'help') {
    console.log('\nCommands: status, sessions, events, gc, reset, help');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = require('os').networkInterfaces()['eth0']?.[0]?.address ||
             require('os').networkInterfaces()['wlan0']?.[0]?.address ||
             'localhost';
  const protocol = certs ? 'https' : 'http';
  log('info', `MiniClaw UI running at ${protocol}://0.0.0.0:${PORT}/`);
  log('info', `Access from LAN: ${protocol}://${ip}:${PORT}/`);
  log('info', `Data directory: ${DATA_DIR}`);
  log('info', 'Commands: status | sessions | events | gc | reset | help');
  connectGateway();
});

// Graceful shutdown: flush pending disk saves
function flushAllSaves() {
  saveTimers.forEach((timer, sk) => {
    clearTimeout(timer);
    const sess = sessions.get(sk);
    if (sess) {
      try { sess._doSave(); } catch (e) { /* ignore */ }
    }
  });
  saveTimers.clear();
}
process.on('SIGINT', () => { flushAllSaves(); process.exit(0); });
process.on('SIGTERM', () => { flushAllSaves(); process.exit(0); });