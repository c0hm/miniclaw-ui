# Fix: Tool Events Not Rendering After OpenClaw v2026.5.28 Update

**Date:** 2026-05-31
**Status:** Completed

## Problem

After updating to OpenClaw v2026.5.28, tool events (`tool_start`, `tool_result`) stopped being rendered in the MiniClaw UI. Session data files showed zero tool events despite the model calling tools.

## Root Cause

The OpenClaw v2026.5.28 update introduced a `toolEventRecipients` registry in the gateway. When miniclaw-ui forwards a browser chat message via `sessions.send`, the gateway registers miniclaw-ui's connection as a `toolEventRecipient` for that run. Tool events are then targeted to `runToolRecipients` via the `agent` event, while the `session.tool` broadcast **excludes** `runToolRecipients`:

```js
// Gateway: server-chat-C9AwM_MK.js
const sessionSubscribers = excludeConnIds(
    sessionEventSubscribers.getAll(), runToolRecipients
);
if (sessionSubscribers.size > 0) broadcastToConnIds("session.tool", ...);
// MiniClaw UI was excluded → never received session.tool for tools
```

MiniClaw UI received tool events via the `agent` event, but `convertToFrontendEvent()` only handled `session.tool` events. The `agent` event was treated as "internal plumbing" and silently dropped.

## Fix

Added `agent` event handling to `convertToFrontendEvent()` in `miniclaw-ui.js` (line ~421). When an `agent` event with `stream === 'tool'` arrives, the same extraction logic from `session.tool` is applied to produce `tool_start` / `tool_result` events.

Non-tool `agent` streams (lifecycle, thinking, assistant) are intentionally NOT converted — they arrive through other gateway paths to avoid duplicates.

## Files Changed

1. `miniclaw-ui.js` — Added `agent` event handler in `convertToFrontendEvent()`
2. `docs/message-processing.md` — Documented `agent` event conversion
3. `docs/gateway-websocket.md` — Added `agent` event to gateway events table
