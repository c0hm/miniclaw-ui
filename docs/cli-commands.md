# CLI Commands

## Overview

MiniClaw UI supports interactive commands via stdin when running in a terminal.

## Available Commands

### status

Shows server status:

```
> status
=== MiniClaw UI Status ===
Gateway: connected
Sessions: 3
Browser clients: 2
Data directory: /path/to/data
```

### sessions

Lists all sessions:

```
> sessions
=== Sessions ===
agent:main:main: 150 events, 12 msgs, tokens: 7500
agent:personal:main: 45 events, 5 msgs, tokens: 3200
agent:main:test: 10 events, 2 msgs, tokens: 500
```

### events

Shows recent events for each session:

```
> events
agent:main:main (last 5 events):
  0: tool_start at Mon Apr 20 2026 12:15:30 GMT
  1: tool_result at Mon Apr 20 2026 12:15:32 GMT
  2: run_start at Mon Apr 20 2026 12:15:33 GMT
  3: assistant_text at Mon Apr 20 2026 12:15:35 GMT
  4: run_end at Mon Apr 20 2026 12:15:40 GMT
```

### gc

Garbage collection - removes stale sessions:

```
> gc
Cleaned up 2 stale sessions
```

**Criteria:** Sessions inactive for more than 1 hour.

### reset

Clears all in-memory sessions:

```
> reset
Sessions cleared (disk data retained)
```

**Note:** Disk files are not deleted.

### help

Shows available commands:

```
> help
Commands: status, sessions, events, gc, reset, help
```

## Usage

Commands are entered in the terminal where the server is running:

```bash
$ node miniclaw-ui.js
[1234567890] [info] MiniClaw UI running at http://0.0.0.0:1234/
[1234567890] [info] Data directory: /home/ju/miniclaw-ui/data
# Type commands here:
status
sessions
```

## Implementation

### Input Handling

```javascript
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
    // ... list sessions
  } else if (cmd === 'events') {
    // ... show events
  } else if (cmd === 'gc') {
    // ... garbage collection
  } else if (cmd === 'reset') {
    sessions.clear();
    console.log('Sessions cleared (disk data retained)');
  } else if (cmd === 'help') {
    console.log('\nCommands: status, sessions, events, gc, reset, help');
  }
});
```

## Logging

All commands and operations are logged:

```javascript
function log(level, ...args) {
  console.log(`[${now()}] [${level}]`, ...args);
}
```

Format: `[timestamp] [level] message`

### Log Levels

| Level | Usage |
|-------|-------|
| `info` | Normal operations |
| `warn` | Non-critical issues |
| `error` | Errors and failures |

## Related Documentation

- [Session Management](session-management.md)
- [Configuration](configuration.md)