# Contributing to MiniClaw UI

## Start Here: `AGENTS.md`

**Before you write a single line of code, read `AGENTS.md` in the project root.** It's the developer bootstrap — architecture diagrams, source layout by line number, event flow, dedup behavior, session lifecycle, edge cases, and gotchas. It turns any coder (human or agent) into a productive MiniClaw UI developer in one read.

This document covers how to contribute. `AGENTS.md` covers how the code works.

## Task Workflow

Every task — feature, bug fix, refactor — follows this workflow:

1. **Create a task doc** → `docs/tasks/<kebab-case-name>.md`
   - Goal, context, plan, related docs, start date
2. **Keep it updated** → decisions, trade-offs, problems encountered
3. **Mark done** → outcomes, completion date
4. **Update the index** → add/update entry in `docs/tasks/index.md`
5. **Sync the docs** → if you changed code, update the relevant `/docs` file in the same commit. The docs ARE the source of truth.

## Code Style

### JavaScript (Node.js backend + vanilla frontend)

This is a **zero-framework** project. No React, no Vue, no Express. Just Node.js `http` module and vanilla DOM APIs. Keep it that way.

- **ES6+** — use `const` by default, `let` when reassigning, never `var`
- **Descriptive names** — `getSessionDataPath()` not `gsp()`, `convertToFrontendEvent()` not `cvt()`
- **Comment the why, not the what** — the code says what; comments explain edge cases, workarounds, and intent
- **Section headers** — `miniclaw-ui.js` uses `// === Section Name ===` blocks; follow that pattern
- **Line length** — no hard limit, but keep it readable. The file is already 1800+ lines; don't make it worse
- **No new dependencies** — the only runtime dep is `ws`. Every dependency adds surface area; justify it hard

### HTML/CSS

- **Semantic HTML** — use `<section>`, `<nav>`, `<article>` where appropriate
- **CSS custom properties** — the theme lives in 10 variables in `:root`. Don't scatter hardcoded colors
- **Dark theme only** — no light mode toggle, no media query detection. Dark is the design
- **Responsive** — sidebar collapses, modals adapt. Test at narrow widths

## Testing

There is no test suite. Testing is manual.

```bash
# Start the server
node miniclaw-ui.js

# Hit the API
curl -u :miniclaw http://localhost:1234/api/status
curl -u :miniclaw http://localhost:1234/api/sessions

# Load the UI in a browser
# http://localhost:1234
```

When testing:
- **Exercise the full event pipeline** — create a new session, send a chat message, watch tool calls stream in
- **Test edge cases** — empty sessions, rapid message sending, disconnect/reconnect, cleared events, deleted sessions
- **Check both surfaces** — the REST API and the browser WebSocket should agree on state
- **File sharing** — test with text files, markdown, and binary files under `$HOME`

## Before Submitting

- [ ] Code matches the existing style (section comments, naming, patterns)
- [ ] New behavior has a matching doc update in `/docs`
- [ ] Task doc in `docs/tasks/` is complete and linked from `docs/tasks/index.md`
- [ ] Manual smoke test: start server, load UI, trigger affected flows
- [ ] No new dependencies added without explicit justification
- [ ] Edge cases from `AGENTS.md` §6 considered (dedup, session lifecycle, event conversion gotchas)

## Reporting Issues

Include:
1. **Steps to reproduce** — exact curl commands or UI clicks
2. **Expected behavior** — what should happen
3. **Actual behavior** — what actually happens (logs, screenshots, error messages)
4. **Environment** — Node version, OS, Gateway status, any custom env vars (`PORT`, `MCPASS`, `GW_WSS`)

### Where to look for clues

- **Server logs** — `miniclaw-ui.js` prints to stdout
- **Browser console** — the frontend logs connection state and event processing
- **Session data** — `data/session-{key}.json` has the raw event storage
- **Gateway status** — is the Gateway running and reachable at `ws://127.0.0.1:18789`?

## Feature Requests

1. Describe what the feature does from the user's perspective
2. Explain why it matters — what workflow does it enable or fix?
3. Rough scope: frontend only? backend changes? new API endpoint? config change?

---

*Thank you for contributing. Start with `AGENTS.md` — it has everything you need.*
