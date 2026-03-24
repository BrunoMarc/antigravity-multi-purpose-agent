# Multi Purpose Agent - Workflows & Architecture

This document describes how the Multi Purpose Agent VS Code extension works end-to-end: CDP connectivity, browser-side automation, scheduling/queueing, quota awareness, safety features, and debugging.

---

## 1. High-Level Architecture

**Primary components**

- **Extension Host (Node.js)**: [main_scripts/extension-impl.js](../main_scripts/extension-impl.js)
- **CDP bridge**: [main_scripts/cdp-handler.js](../main_scripts/cdp-handler.js)
- **Browser payload**: [main_scripts/full_cdp_script.js](../main_scripts/full_cdp_script.js)
- **Settings UI (WebView)**: [main_scripts/settings-panel.js](../main_scripts/settings-panel.js)
- **Debug server (optional)**: [main_scripts/debug-handler.js](../main_scripts/debug-handler.js)
- **Quota client (optional)**: [main_scripts/antigravity/client.js](../main_scripts/antigravity/client.js)

**Data flow (typical)**

1. Extension establishes CDP connections and injects the browser payload.
2. Browser payload exposes `window.__autoAccept*` APIs and runs the click loop.
3. Extension drives scheduling/queue actions by calling CDP APIs (send prompts, read stats).
4. Settings WebView reads/writes config and sends commands to the extension.

---

## 2. CDP Connectivity & Injection

**Connection policy**

- **Fixed CDP port**: `9004` only (no scanning).
- **Target discovery**: `http://127.0.0.1:9004/json/list`
- **Filter rules**: excludes targets without `webSocketDebuggerUrl` and excludes the Settings Panel webview.

**Injection sequence**

1. For each target, connect to its `webSocketDebuggerUrl`.
2. Inject [main_scripts/full_cdp_script.js](../main_scripts/full_cdp_script.js) once per target.
3. Call `window.__autoAcceptStart(config)` on that target to start the browser-side loop.

---

## 3. Browser-Side Auto-Accept Loop

The browser payload maintains a global state object `window.__autoAcceptState` (analytics, per-session flags, and shared counters).

**Click loop**

- Entry point: `window.__autoAcceptStart(config)`
- Loop cadence: `config.pollInterval` (default 60000ms)
- Candidate scan: broad selectors like `button`, `[class*="button"]`, `[class*="anysphere"]`
- Button eligibility:
  - Matches action keywords like `accept`, `run`, `retry`, `apply`, `execute`, `confirm`, `allow`
  - Rejects keywords like `skip`, `reject`, `cancel`, `close`, `refine`, `always`
  - Must be visible, enabled, and have pointer-events enabled

**Verification & stats**

- The click is only counted when the button disappears within ~500ms.
- Verified clicks are tracked via the analytics module inside the browser payload.

---

## 4. Safety & Multi-Window Coordination

### Banned Command Interception

When a candidate button looks like a command execution action, the payload attempts to locate nearby `<pre>` / `<code>` blocks and compares extracted text against a configurable ban list. If banned, the click is skipped and a blocked action is tracked.

### Instance Locking (Multi-window)

Only one extension instance should actively drive CDP in a multi-window environment:

- A lock is stored in `globalState` under `<ide>-instance-lock` plus a heartbeat `<ide>-instance-lock-ping`.
- Polling updates the ping every 5 seconds.
- If another instance holds the lock with a fresh ping (<15s), the current instance enters standby (“locked out”) and stops controlling CDP until the lock is stale.

---

## 5. Scheduler, Grace Period & Prompt Queue

The Scheduler lives in the extension host and supports:

- **Interval mode**: send a prompt every N minutes
- **Daily mode**: send a prompt at a fixed HH:MM
- **Queue mode**: execute a list of prompts sequentially (optionally with “check prompts” interleaved)

**Queue execution & The 15s Grace Period**

- Runtime queue is built from `auto-accept.schedule.prompts` (and optionally `checkPrompt.*`).
- Queue progression uses a robust silence heuristic:
  - Every 5 seconds, the Scheduler checks if the AI is busy via CDP (`window.__autoAcceptIsBusy`).
  - **Grace Period:** When a prompt is first sent, the extension forces a mandatory 15-second grace period where it assumes the AI is busy, regardless of UI state. This prevents the queue from advancing prematurely before the AI has time to render "Running" status.
  - **Busy Heuristics:** The script detects the active AI state by finding explicit "Stop Generating" buttons, or text labels containing "Running", "Generating", or "Thinking" that are located in the active composer area (bottom 500px of the screen), while ignoring the Extension's own Settings Panel.
  - Only after the AI is no longer busy AND the `silenceTimeout` (default 120s) has passed, the Scheduler advances to the next queue item.

---

## 6. Quota Awareness & Model Fallback

If Antigravity quota polling is enabled:

- The extension periodically calls `AntigravityClient.getUserStatus()` and updates a quota status bar item (Uses `ss` parsing for robust Linux PID discovery).
- When quota is exhausted, the extension checks for a **Fallback Model** (e.g. `Gemini 3 Flash` or `Gemini 3.1 Pro`).
  - If a fallback model is configured, the CDP payload automatically opens the model selector, switches the model, and allows the Queue to continue seamlessly.
  - If no fallback is configured, it calls `scheduler.setQuotaExhausted(true)`, pausing the queue.
- When quota transitions from exhausted → available, the Scheduler resumes natively.

---

## 7. Settings UI & Debugging

**Settings WebView**

- The Settings panel uses `postMessage` to call extension commands and update configuration.
- It also displays queue status, prompt history, quota info, logs, fallback model selector and safety settings.

**Debug Server (optional)**

- When debug mode is enabled, the extension can expose an HTTP debug server on `127.0.0.1:54321` for automated tests and live diagnostics.

---

## 8. Development Protocol (The Fast Sync Workflow)

### Modifying browser logic

The extension uses `esbuild` to compile everything. Since you are developing from a cloned repository (Fork), you can instantly push changes to your active Antigravity IDE without generating `.vsix` packages.

**Workflow:**
1. Make changes to `main_scripts/full_cdp_script.js` or `main_scripts/extension-impl.js`.
2. Run `npm run sync`. This script automatically compiles the extension and overwrites the active binary inside `~/.antigravity/extensions/rodhayl.multi-purpose-agent-1.0.1/`.
3. Open the Antigravity Command Palette (`Ctrl+Shift+P`) and execute **Developer: Reload Window** to load your fresh changes.

### Version Protection

The `package.json` version is permanently hardcoded to `999.0.0` to prevent the IDE's automatic updater from downloading the vanilla version from the marketplace and destroying your custom autonomous loop heuristics.