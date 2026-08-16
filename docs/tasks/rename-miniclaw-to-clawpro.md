# Rename: Clawpro → Clawpro 1.2

**Created:** 2026-07-14  
**Status:** ✅ Completed (2026-07-14)

## Scope

Rename the entire project from "Clawpro 1.2" to "Clawpro 1.2" across all files.

### Rename Rules

| Original | Replacement |
|----------|-------------|
| `Clawpro 1.2` (title case) | `Clawpro 1.2` |
| `Clawpro` (standalone, title case) | `Clawpro` |
| `clawpro-ui` (kebab-case, everywhere) | `clawpro-ui` |
| `miniclaw` (lowercase, standalone) | `clawpro` |
| `clawpro-ui.js` (filename) | `clawpro-ui.js` |
| `clawpro-ui.service` (service file) | `clawpro-ui.service` |
| `"miniclaw"` (default password string) | Keep as-is (not a project name reference) |

> **Note:** The default password `"miniclaw"` is kept as-is since it's a credential value, not a project name. Changing it would break existing auth for users.

### Files to Change

#### 1. Binary Rename
- `clawpro-ui.js` → `clawpro-ui.js`

#### 2. Source Code (`clawpro-ui.js`)
| Line/Area | Change |
|-----------|--------|
| `userAgent: 'clawpro-ui/1.0'` | `'clawpro-ui/1.2'` |
| `'Basic realm="Clawpro 1.2"'` | `'Basic realm="Clawpro 1.2"'` |
| `=== Clawpro 1.2 v2 Status ===` | `=== Clawpro 1.2 Status ===` |
| `Clawpro 1.2 v2 running at` | `Clawpro 1.2 running at` |

#### 3. Source Code (`index.html`)
| Line/Area | Change |
|-----------|--------|
| `<title>Clawpro 1.2 v1.1</title>` | `<title>Clawpro 1.2</title>` |
| `<h1>Clawpro 1.2</h1>` | `<h1>Clawpro 1.2</h1>` |
| `_PREFS_KEY = 'clawpro-ui-prefs'` | `'clawpro-ui-prefs'` |
| `localStorage.getItem('clawpro-ui-input-height')` ×3 | `'clawpro-ui-input-height'` |
| `_AGENT_THEMES_KEY = 'clawpro-ui-agent-themes'` | `'clawpro-ui-agent-themes'` |
| `HISTORY_KEY = 'clawpro-ui-input-history'` | `'clawpro-ui-input-history'` |

#### 4. Package Files
- `package.json`: name, description, main, scripts
- `package-lock.json`: name field (top-level only)

#### 5. Scripts
- `install.sh`: All references (banner, echo messages, `clawpro-ui.js` → `clawpro-ui.js`, service name)
- `restart.sh`: `clawpro-ui.js` → `clawpro-ui.js`, comment

#### 6. Systemd (actions, not file edits)
- Rename `~/.config/systemd/user/clawpro-ui.service` → `clawpro-ui.service`
- Update content: Description, ExecStart path, Environment=PATH
- `systemctl --user disable clawpro-ui`
- `systemctl --user daemon-reload`
- `systemctl --user enable --now clawpro-ui`

#### 7. Documentation (all `.md` files)
Every `docs/*.md` file needs review. Key patterns to replace:
- `# Clawpro 1.2` → `# Clawpro 1.2`
- `Clawpro 1.2` (in prose) → `Clawpro 1.2`
- `clawpro-ui.js` (code refs) → `clawpro-ui.js`
- `clawpro-ui/data` (paths) → `clawpro-ui/data`
- `clawpro-ui-prefs` (localStorage keys) → `clawpro-ui-prefs`
- `clawpro-ui-input-*` → `clawpro-ui-input-*`
- `clawpro-ui-agent-themes` → `clawpro-ui-agent-themes`
- `miniclaw` at `git.tuvo.tv` URLs → keep as-is (external)
- `node clawpro-ui.js` → `node clawpro-ui.js`
- `systemctl --user restart clawpro-ui` → `systemctl --user restart clawpro-ui`
- `/var/lib/clawpro-ui/data` → `/var/lib/clawpro-ui/data`

Files: README.md, AGENTS.md, docs/index.md, docs/ui-components.md, docs/frontend-patterns.md, docs/event-rendering.md, docs/event-types-reference.md, docs/websocket-client.md, docs/authentication.md, docs/configuration.md, docs/troubleshooting.md, docs/message-processing.md, docs/session-management.md, docs/gateway-websocket.md, docs/http-api.md, docs/file-sharing.md, docs/markdown-editor.md, docs/cli-commands.md, docs/contributing.md, docs/glossary.md, docs/tasks/index.md, docs/tasks/*.md

#### 8. Workspace Files (`~/.openclaw/workspace/deepui/`)
- `TOOLS.md`: Project name, filenames, restart command
- `MEMORY.md`: Section headers, filenames, paths, restart command
- `IDENTITY.md`: Codebase description

### Execution Order

1. Rename binary file `clawpro-ui.js` → `clawpro-ui.js` via `git mv`
2. Update `clawpro-ui.js` content (strings)
3. Update `index.html` (title, h1, localStorage keys)
4. Update `package.json` + `package-lock.json`
5. Update `install.sh` + `restart.sh`
6. Replace old service: disable, rename file, update content, enable new
7. Mass-update all `docs/**/*.md` files via sed/perl
8. Update workspace files
9. Git commit all changes
10. Restart server via new service name
11. Verify: `curl -u :miniclaw http://localhost:1234/api/status`
