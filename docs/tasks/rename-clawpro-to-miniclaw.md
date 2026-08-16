# Rename: Clawpro 1.2 → MiniClaw UI v1.5

**Created:** 2026-08-16
**Status:** ✅ Completed (2026-08-16)

## Scope

Rename the entire project back from "Clawpro 1.2" to "MiniClaw UI" (version 1.5), reversing
the 2026-07-14 rename while bumping the version from 1.2 → 1.5.

### Rename Rules

| Original | Replacement |
|----------|-------------|
| `Clawpro 1.2` (title case) | `MiniClaw UI` |
| `Clawpro` (standalone, title case) | `MiniClaw UI` |
| `clawpro-ui` (kebab-case, everywhere) | `miniclaw-ui` |
| `clawpro-ui.js` (filename) | `miniclaw-ui.js` |
| `clawpro-ui.service` (systemd unit) | `miniclaw-ui.service` |
| `clawpro-ui/1.2` (userAgent) | `miniclaw-ui/1.5` |
| `"1.2.0"` (package version) | `"1.5.0"` |
| `<title>…</title>` | `MiniClaw UI v1.5` |
| `miniclaw` (default password) | Keep as-is (credential, not a name) |

> **Note:** The default password `"miniclaw"` is kept as-is — it is a credential value,
> not a project name. Changing it would break existing auth.

### Files Changed

#### 1. Binary rename
- `clawpro-ui.js` → `miniclaw-ui.js` (via `git mv`)

#### 2. Source (`miniclaw-ui.js`)
- `userAgent: 'clawpro-ui/1.2'` → `'miniclaw-ui/1.5'`
- `WWW-Authenticate: Basic realm="Clawpro 1.2"` → `"MiniClaw UI"`
- stdin `status` banner `=== Clawpro 1.2 Status ===` → `=== MiniClaw UI Status ===`
- startup log `Clawpro 1.2 running at …` → `MiniClaw UI running at …`
- **Untouched (protocol/device identity):** `client.id`, `client.version`, device auth payload

#### 3. Package files
- `package.json` / `package-lock.json`: name `clawpro-ui` → `miniclaw-ui`, version `1.2.0` → `1.5.0`

#### 4. Frontend (`index.html`)
- `<title>Clawpro 1.2</title>` → `<title>MiniClaw UI v1.5</title>`
- `<h1>` banner `Clawpro 1.2` → `MiniClaw UI`
- `localStorage` keys `clawpro-ui-*` → `miniclaw-ui-*`

#### 5. Scripts & systemd
- `install.sh` — service `clawpro-ui` → `miniclaw-ui`, banner text updated
- `restart.sh` — binary + pkill pattern updated
- systemd unit `/home/ju/.config/systemd/user/miniclaw-ui.service` (live rename, env preserved)

#### 6. Docs
- All 30+ markdown files swept (`Clawpro 1.2` → `MiniClaw UI`, `clawpro-ui` → `miniclaw-ui`)
- Fixed stale `v2` status string leftovers in `configuration.md` / `cli-commands.md`
- Fixed stale `Deepclaw-ui` prose in `fix-agent-tool-events.md`
- Fixed `.env.example` (stale `DCPASS`/`deepclaw` → `MCPASS`/`miniclaw`)
- **Kept as historical record:** `docs/tasks/rename-miniclaw-to-clawpro.md`

#### 7. Workspace (agent context)
- `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `AGENTS.md` under `/home/ju/.openclaw/workspace/deepui/`

### Verification
- `grep -ri "clawpro"` returns only the historical rename task doc
- Service runs as `miniclaw-ui.service`, dashboard reachable at `http://localhost:1234`
