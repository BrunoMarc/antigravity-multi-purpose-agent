# Change Log

All notable changes to the "Multi Purpose Agent" extension will be documented in this file.

## [Unreleased]
### Added
- **Centralized Constants**: Added `constants.js` with shared constants to eliminate duplication across modules
- **Unified Logging**: Added `base-logger.js` providing a standard logging mixin (`mixLogger`) and base class (`BaseLogger`)

### Fixed
- **Queue Sequencing (Final Production Fix)**: Restored strict prompt sequencing by aligning queue completion detection with the known-good behavior from commit `82f440d`, while keeping a guarded fast busy-to-idle confirmation path. The queue now reliably waits for the previous AI response to finish before sending the next prompt.
- **Queue Timing Regression**: Removed blocking post-send response-start waits from queue send flow and reverted to send-time activity baseline for silence-based advancement, eliminating premature next-prompt dispatch.
- **Debug Server Port on Windows**: Changed debug server default from `54321` to `54123` because Windows reserved range `54316-54415` can deny binds (`EACCES`) on affected systems.

### Changed
- **Production Readiness Validation**: Re-ran release checks (queue runtime validation, test suites, and package build) and aligned release documentation for GitHub publication.
- **Code Deduplication**: Refactored multiple modules to use centralized utilities from `utils.js`, removing duplicate implementations of `getDocuments()`, `isElementVisible()`, `isElementClickable()`, `queryAll()`, `stripTimeSuffix()`, and `deduplicateNames()`
- **Logger Consolidation**: Multiple classes (`CDPHandler`, `DebugHandler`, `Relauncher`, `SafetyFilter`, `CDPStrategy`, `VSCodeCommandStrategy`, `HybridAutoAccept`) now use the unified logging from `base-logger.js`
- **Dependency Update**: Upgraded ESLint from v8.57.1 to v10.0.1 with new flat config format (`eslint.config.js`)
- **Node.js Compatibility**: Updated engine requirement to `>=18.0.0` for broader compatibility

## [1.0.2] - 2026-02-21
### Added
- **Hybrid Debug Controls**: Added debug actions for hybrid runtime introspection and control (`getHybridStatus`, `pollAutoAccept`, `updateHybridConfig`) to support faster diagnostics and safer tuning without code edits.
- **Expanded Validation Suites**: Added/expanded proactive tests for debug-handler routing, queue/check-prompt runtime behavior, and end-to-end debug server flows.
- **Queue Status Bar**: Wired up the queue status bar item to display live progress (`Queue 1/N`) during queue execution and update on start, advance, stop, and reset.
- **Queue Busy-Wait Sequencing**: Queue now detects when the AI is still generating a response before sending the next prompt. Prevents queue items from overlapping — each task waits for the previous one to finish.
- **Configuration Declarations**: All new settings (`domActivityTracking`, `hybrid`, `continue`) are now declared in `package.json` to ensure reliable read/write on all IDE platforms.

### Changed
- **Command-First Auto Accept**: Runtime now prioritizes VS Code command strategy first, with CDP fallback kept conservative by default.
- **Safer Queue/Debug Reliability**: Queue-control and debug validation now account for scheduler dampening/timing behavior to reduce false negatives during automated checks.
- **Antigravity Scope Enforcement**: Revalidated Auto Accept and Queueing flows to keep behavior Antigravity-specific and avoid TRAE coupling in runtime paths.

### Fixed
- **Queue "Save & Run" Regression**: Fixed critical regression where "Save & Run Queue" did nothing due to (a) duplicate `__autoAcceptIsConversationWorking` definition that scanned the entire page for false-positive busy signals, (b) missing error handling in the save-and-start handler that allowed config write failures to silently block queue start.
- **Conversation Busy Detection False Positives**: Rewrote `detectConversationWorking()` to only match explicit stop/cancel generation buttons by their direct text label (not nested content), and scoped detection to the agent panel root instead of the entire document.
- **Runaway Click Protection**: Added anti-loop click cooldown and stricter visible-label gating to prevent repeated unintended button clicks.
- **Auto Accept Safety**: Hardened CDP fallback selectors and disabled permissive DOM polling defaults that could target stale/inactive UI actions.
- **Queue Stability in Debug Workflows**: Reduced flaky queue-start/control behavior in debug-driven test flows by enforcing safer sequencing.
- **Release Readiness**: Aligned release metadata and validation gates for 1.0.2 publication.

### Why this improves the app
- **Higher Safety**: Reduces risk of accidental UI actions (for example stale Run/Allow/Image-style clicks) by tightening click eligibility and adding cooldown protections.
- **Higher Reliability**: Queue, check-prompt, and control actions behave more predictably under real debug/runtime conditions.
- **Faster Troubleshooting**: New hybrid debug endpoints and broader tests make regressions easier to detect and isolate before release.

### Documentation
- **Docs Hygiene**: Consolidated/cleaned repository documentation to remove standalone TRAE-specific planning content while preserving relevant operational guidance in existing docs.

## [1.0.1] - 2026-02-02
### Fixed
- **Startup Flow**: Restart prompt now reliably triggers on first install or reinstall.
- **Error Handling**: Fixed duplicate error messages where both a toast and popup would appear during CDP setup.
- **Windows Launch**: Revised `relaunch()` logic on Windows to explicitly include the `--remote-debugging-port` flag during restart.

### Added
- **Reinstall Detection**: Detects version changes to reset internal state and ensure proper setup prompts appear.
- **Cleanup**: Automatically clears extension configuration state and log files upon deactivation/uninstall.
- **Smart Warnings**: CDP connection error popup now only correctly appears if the port is still inaccessible *after* the restart flow.
