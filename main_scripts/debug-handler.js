const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { BaseLogger } = require('./base-logger');
const { getLatestCdpLogPath } = require('./utils');
const { GLOBAL_STATE_KEY, FREQ_STATE_KEY, BANNED_COMMANDS_KEY, DEFAULT_CDP_PORT } = require('./constants');

class DebugHandler extends BaseLogger {
    constructor(context, helpers) {
        super(helpers.log || console.log, 'DebugHandler');
        this.context = context;
        this.helpers = helpers; // { log, getScheduler, getHybridAutoAccept, getAntigravityClient, getRelauncher, getLockedOut }
        this.server = null;
        this.serverPort = 54123;
    }

    /**
     * Override _log to add trace file logging in addition to the base logger.
     * 
     * NOTE: This method intentionally does NOT call super._log() because:
     * 1. We need to write to a trace.log file with timestamps
     * 2. We then call this.logger() directly (which is what BaseLogger._log does)
     * 
     * If super._log() were called, we'd get duplicate prefix tags like [DebugHandler][DebugHandler].
     * This override completely replaces the parent implementation.
     * 
     * @param {string} message - The message to log
     * @override
     */
    _log(message) {
        // Write to trace.log file with full timestamp
        try {
            const logPath = path.join(__dirname, '..', 'trace.log');
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${this.prefix}] ${message}\n`);
        } catch (e) {
            // Ignore file write errors
        }

        // Call the logger function directly (same as BaseLogger._log does)
        if (this.logger) {
            this.logger(`[${this.prefix}] ${message}`);
        }
    }

    async handleCommand(action, params = {}) {
        const scheduler = this.helpers.getScheduler ? this.helpers.getScheduler() : null;
        const hybridAutoAccept = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;
        const isEnabled = this.context.globalState.get(GLOBAL_STATE_KEY, false);

        try {
            switch (action) {
                // === Core Controls ===
                case 'toggle':
                    await vscode.commands.executeCommand('auto-accept.toggle');
                    return { success: true, enabled: this.context.globalState.get(GLOBAL_STATE_KEY, false) };
                case 'getEnabled':
                    return { success: true, enabled: isEnabled };

                // === Queue Control ===
                case 'startQueue':
                    // DEFENSIVE CHECK: Don't start if prompts are empty
                    if (scheduler) {
                        const configPrompts = vscode.workspace.getConfiguration('auto-accept.schedule').get('prompts', []);
                        if (!configPrompts || configPrompts.length === 0) {
                            return { success: false, error: 'Queue is empty' };
                        }
                    }
                    await vscode.commands.executeCommand('auto-accept.startQueue', { source: 'manual' });
                    return { success: true };
                case 'pauseQueue':
                    if (scheduler) { scheduler.pauseQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'resumeQueue':
                    if (scheduler) { scheduler.resumeQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'skipPrompt':
                    if (scheduler) { await scheduler.skipPrompt(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'stopQueue':
                    if (scheduler) { scheduler.stopQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'resetQueue':
                    if (scheduler) { await scheduler.resetQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'sendPrompt':
                    // Send prompt via scheduler (ensures history is updated)
                    if (scheduler && scheduler.cdpHandler && params.prompt) {
                        // Use scheduler's sendPrompt and await the full promise chain
                        const promptPromise = scheduler.sendPrompt(params.prompt);
                        await promptPromise; // This awaits the promptQueue chain
                        return { success: true, method: 'CDP' };
                    }
                    if (!params.prompt) return { success: false, error: 'No prompt provided' };
                    return { success: false, error: 'Scheduler or CDPHandler not initialized' };
                case 'getSchedulerInternals':
                    if (scheduler) {
                        return {
                            success: true,
                            internals: {
                                silenceTimerActive: !!scheduler.silenceTimer,
                                timerActive: !!scheduler.timer,
                                hasSentCurrentItem: scheduler.hasSentCurrentItem,
                                isStopped: scheduler.isStopped,
                                queueRunId: scheduler.queueRunId,
                                lastActivityTime: scheduler.lastActivityTime,
                                taskStartTime: scheduler.taskStartTime,
                                lastClickTime: scheduler.lastClickTime,
                                lastClickCount: scheduler.lastClickCount,
                                configMode: scheduler.config?.mode,
                                configSilenceTimeout: scheduler.config?.silenceTimeout,
                                enabled: scheduler.enabled,
                                runtimeQueueLen: scheduler.runtimeQueue?.length,
                                isRunningQueue: scheduler.isRunningQueue,
                                isPaused: scheduler.isPaused,
                                isQuotaExhausted: scheduler.isQuotaExhausted,
                                queueIndex: scheduler.queueIndex,
                                conversationStatus: scheduler.conversationStatus,
                                _silenceCheckCount: scheduler._silenceCheckCount || 0
                            }
                        };
                    }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'getQueueStatus':
                    // Re-implementing logic here or calling command? Command is safer if it exists, but getStatus is direct.
                    // Extension.js has no public command for getQueueStatus that returns data (showQueueMenu is UI).
                    if (scheduler) {
                        return { success: true, status: scheduler.getStatus() };
                    }
                    return { success: true, status: { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0 } };

                // === Hybrid Auto-Accept Debug ===
                case 'getHybridStatus':
                    if (!hybridAutoAccept) {
                        return { success: false, error: 'HybridAutoAccept not initialized' };
                    }
                    return { success: true, hybrid: hybridAutoAccept.getStatus() };

                case 'pollAutoAccept':
                    if (!hybridAutoAccept) {
                        return { success: false, error: 'HybridAutoAccept not initialized' };
                    }
                    return { success: true, result: await hybridAutoAccept.poll() };

                case 'updateHybridConfig':
                    if (!hybridAutoAccept) {
                        return { success: false, error: 'HybridAutoAccept not initialized' };
                    }
                    hybridAutoAccept.updateConfig(params.config || {});
                    return { success: true };

                // === Schedule Configuration ===
                case 'updateSchedule':
                    // Reuse existing update logic by checking params
                    const schedConfig = vscode.workspace.getConfiguration('auto-accept.schedule');
                    if (params.enabled !== undefined) await schedConfig.update('enabled', params.enabled, vscode.ConfigurationTarget.Global);
                    if (params.mode !== undefined) await schedConfig.update('mode', params.mode, vscode.ConfigurationTarget.Global);
                    if (params.value !== undefined) await schedConfig.update('value', params.value, vscode.ConfigurationTarget.Global);
                    if (params.prompt !== undefined) await schedConfig.update('prompt', params.prompt, vscode.ConfigurationTarget.Global);
                    if (params.prompts !== undefined) await schedConfig.update('prompts', params.prompts, vscode.ConfigurationTarget.Global);
                    if (params.queueMode !== undefined) await schedConfig.update('queueMode', params.queueMode, vscode.ConfigurationTarget.Global);
                    if (params.silenceTimeout !== undefined) await schedConfig.update('silenceTimeout', params.silenceTimeout, vscode.ConfigurationTarget.Global);
                    if (params.checkPromptEnabled !== undefined) await schedConfig.update('checkPrompt.enabled', params.checkPromptEnabled, vscode.ConfigurationTarget.Global);
                    if (params.checkPromptText !== undefined) await schedConfig.update('checkPrompt.text', params.checkPromptText, vscode.ConfigurationTarget.Global);
                    return { success: true };

                case 'getSchedule':
                    const sched = vscode.workspace.getConfiguration('auto-accept.schedule');
                    return {
                        success: true,
                        schedule: {
                            enabled: sched.get('enabled'),
                            mode: sched.get('mode'),
                            value: sched.get('value'),
                            prompt: sched.get('prompt'),
                            prompts: sched.get('prompts', []),
                            queueMode: sched.get('queueMode', 'consume'),
                            silenceTimeout: sched.get('silenceTimeout', 30),
                            checkPromptEnabled: sched.get('checkPrompt.enabled', false),
                            checkPromptText: sched.get('checkPrompt.text', '')
                        }
                    };

                // === Conversations ===
                case 'getConversations':
                    if (scheduler) {
                        const convs = await scheduler.getConversations();
                        return { success: true, conversations: convs };
                    }
                    return { success: true, conversations: [] };
                case 'setTargetConversation':
                    await vscode.commands.executeCommand('auto-accept.setTargetConversation', params.conversationId);
                    return { success: true };
                case 'getPromptHistory':
                    if (scheduler) {
                        return { success: true, history: scheduler.getHistory() };
                    }
                    return { success: true, history: [] };

                // === Banned Commands (Safety) ===
                case 'updateBannedCommands':
                    // Reuse command which handles state + session sync
                    await vscode.commands.executeCommand('auto-accept.updateBannedCommands', params.commands);
                    return { success: true };
                case 'getBannedCommands':
                    return { success: true, commands: this.context.globalState.get(BANNED_COMMANDS_KEY, []) };

                // === Antigravity Quota ===
                case 'setAntigravityQuota':
                    const quotaCfg = vscode.workspace.getConfiguration('auto-accept.antigravityQuota');
                    await quotaCfg.update('enabled', params.value, vscode.ConfigurationTarget.Global);
                    // updateStatusBar logic is handled by config listener in extension.js usually, or checks global state
                    return { success: true };
                case 'getAntigravityQuota':
                    return { success: true, enabled: vscode.workspace.getConfiguration('auto-accept.antigravityQuota').get('enabled', true) };
                case 'refreshAntigravityQuota':
                    const snapshot = await vscode.commands.executeCommand('auto-accept.getAntigravityQuota');
                    return { success: true, snapshot };
                case 'setResumeEnabled':
                    const resumeConf = vscode.workspace.getConfiguration('auto-accept.antigravityQuota.resume');
                    await resumeConf.update('enabled', params.value, vscode.ConfigurationTarget.Global);
                    return { success: true };
                case 'setAutoContinue':
                    const autoContConf = vscode.workspace.getConfiguration('auto-accept.autoContinue');
                    await autoContConf.update('enabled', params.value, vscode.ConfigurationTarget.Global);
                    return { success: true };
                case 'getAutoContinue':
                    return { success: true, enabled: vscode.workspace.getConfiguration('auto-accept.autoContinue').get('enabled', false) };

                // === Stats ===
                case 'getStats':
                    return { success: true, stats: this.context.globalState.get('auto-accept-stats', {}) };
                case 'getROIStats':
                    const roiStats = await vscode.commands.executeCommand('auto-accept.getROIStats');
                    return { success: true, roiStats };

                // === Logs ===
                case 'getLogs':
                    return this.getLogs(params.tailLines);
                case 'clearLogs':
                    return this.clearLogs();
                case 'openLogFile':
                    return this.openLogFile();

                // === Utility ===
                case 'setFrequency':
                    await vscode.commands.executeCommand('auto-accept.updateFrequency', params.value);
                    return { success: true };
                case 'resetAllSettings':
                    await vscode.commands.executeCommand('auto-accept.resetSettings');
                    return { success: true };

                // === Advanced / System ===
                case 'getSystemInfo':
                    return {
                        success: true,
                        info: {
                            platform: process.platform,
                            nodeVersion: process.versions.node,
                            appName: vscode.env.appName,
                            machineId: vscode.env.machineId,
                            time: new Date().toISOString()
                        }
                    };
                case 'getAntigravityStatus':
                    const client = this.helpers.getAntigravityClient ? this.helpers.getAntigravityClient() : null;
                    const status = client ? (client.isConnected ? 'connected' : 'disconnected') : 'not_initialized';
                    return {
                        success: true,
                        status
                    };
                case 'forceRelaunch':
                    await vscode.commands.executeCommand('auto-accept.relaunch');
                    return { success: true };
                case 'getLockedOut':
                    const locked = this.helpers.getLockedOut ? this.helpers.getLockedOut() : false;
                    return { success: true, isLockedOut: locked };

                // === Full State Snapshot ===
                case 'getFullState':
                    return this.getFullState();

                case 'getServerStatus':
                    return {
                        success: true,
                        server: {
                            running: !!this.server,
                            port: this.serverPort
                        }
                    };

                case 'getCDPStatus':
                    // Get detailed CDP connection status
                    const cdpHandler = scheduler ? scheduler.cdpHandler : null;
                    if (cdpHandler) {
                        return {
                            success: true,
                            cdp: {
                                connectionCount: cdpHandler.getConnectionCount(),
                                isEnabled: cdpHandler.isEnabled || false,
                                connections: Array.from(cdpHandler.connections.keys())
                            }
                        };
                    }
                    return { success: false, error: 'CDPHandler not available' };

                case 'listChatCommands':
                    // List all available commands that might be chat-related
                    try {
                        const allCommands = await vscode.commands.getCommands(true);
                        const chatCommands = allCommands.filter(cmd =>
                            cmd.includes('chat') ||
                            cmd.includes('Chat') ||
                            cmd.includes('antigravity') ||
                            cmd.includes('Antigravity') ||
                            cmd.includes('agent') ||
                            cmd.includes('Agent') ||
                            cmd.includes('ai') ||
                            cmd.includes('AI') ||
                            cmd.includes('copilot') ||
                            cmd.includes('Copilot')
                        ).sort();
                        return { success: true, commands: chatCommands, count: chatCommands.length };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }

                case 'executeVSCodeCommand':
                    // Execute arbitrary VS Code command (for testing)
                    if (params.command) {
                        try {
                            const args = params.args || [];
                            const result = await vscode.commands.executeCommand(params.command, ...args);
                            return { success: true, command: params.command, result: result };
                        } catch (e) {
                            return { success: false, command: params.command, error: e.message };
                        }
                    }
                    return { success: false, error: 'No command provided' };

                case 'evaluateInBrowser':
                    // Evaluate arbitrary JavaScript in the browser context for debugging
                    // This allows testing selectors and input methods without rebuilding
                    if (params.code && scheduler && scheduler.cdpHandler) {
                        try {
                            if (params.allConnections) {
                                // Evaluate on ALL connections and return each result
                                const results = [];
                                for (const [id] of scheduler.cdpHandler.connections) {
                                    try {
                                        const res = await scheduler.cdpHandler._evaluate(id, params.code);
                                        results.push({ id, value: res?.result?.value });
                                    } catch (e) {
                                        results.push({ id, error: e.message });
                                    }
                                }
                                return { success: true, results, lastSendConnectionId: scheduler.cdpHandler.lastSendConnectionId };
                            }
                            const result = await scheduler.cdpHandler.evaluate(params.code);
                            return { success: true, result: result };
                        } catch (e) {
                            return { success: false, error: e.message };
                        }
                    }
                    if (!params.code) return { success: false, error: 'No code provided' };
                    return { success: false, error: 'CDP handler not available' };

                case 'getCDPConnections':
                    // List all CDP connections and their page info
                    if (scheduler && scheduler.cdpHandler) {
                        const connections = [];
                        for (const [id, conn] of scheduler.cdpHandler.connections) {
                            connections.push({ id, injected: conn.injected });
                        }
                        return { success: true, connections, count: connections.length };
                    }
                    return { success: false, error: 'CDP handler not available' };

                // === WebView UI Testing ===
                case 'uiAction':
                    // Forward UI action to Settings Panel WebView
                    const SettingsPanel = require('./settings-panel').SettingsPanel;
                    if (SettingsPanel.currentPanel) {
                        SettingsPanel.currentPanel.handleDebugUIAction(params);
                        // Wait briefly for async result
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const uiResult = SettingsPanel.currentPanel.getLastUIResult();
                        return { success: true, result: uiResult };
                    }
                    return { success: false, error: 'Settings panel not open. Open it first via auto-accept.openSettings command.' };

                case 'getUISnapshot':
                    // Get full Settings Panel UI state
                    const SP = require('./settings-panel').SettingsPanel;
                    if (SP.currentPanel) {
                        SP.currentPanel.handleDebugUIAction({ type: 'getSnapshot' });
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const snapshot = SP.currentPanel.getLastUIResult();
                        return { success: true, snapshot };
                    }
                    return { success: false, error: 'Settings panel not open' };

                case 'listUIElements':
                    // List all interactive elements in Settings Panel
                    const Panel = require('./settings-panel').SettingsPanel;
                    if (Panel.currentPanel) {
                        Panel.currentPanel.handleDebugUIAction({ type: 'listElements' });
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const elements = Panel.currentPanel.getLastUIResult();
                        return { success: true, ...elements };
                    }
                    return { success: false, error: 'Settings panel not open' };

                case 'openSettingsPanel':
                    // Open or focus the settings panel
                    await vscode.commands.executeCommand('auto-accept.openSettings');
                    return { success: true };

                case 'dumpDOM': {
                    // Dump the full DOM (or a subtree) from all CDP connections
                    // params.selector — optional CSS selector to limit the dump (default: full page)
                    // params.maxLength — optional max string length per connection (default: 500000)
                    const cdp = this.helpers.getCDPHandler ? this.helpers.getCDPHandler() : null;
                    if (!cdp || cdp.getConnectionCount() === 0) {
                        return { success: false, error: `No CDP connections (count=${cdp ? cdp.getConnectionCount() : 0}). Restart IDE with --remote-debugging-port flag.` };
                    }
                    const selector = params.selector || 'html';
                    const maxLen = params.maxLength || 500000;
                    const dumps = [];
                    for (const [connId] of cdp.connections) {
                        try {
                            const res = await cdp._evaluate(connId, `(function(){
                                var el = document.querySelector(${JSON.stringify(selector)});
                                if (!el) return JSON.stringify({ error: 'selector not found: ${selector}' });
                                var html = el.outerHTML;
                                if (html.length > ${maxLen}) html = html.substring(0, ${maxLen}) + '...(truncated)';
                                return JSON.stringify({ html: html, length: el.outerHTML.length });
                            })()`, 10000);
                            const raw = res?.result?.value;
                            dumps.push({ connectionId: connId, result: raw ? JSON.parse(raw) : null });
                        } catch (e) {
                            dumps.push({ connectionId: connId, error: e.message });
                        }
                    }
                    return { success: true, dumps };
                }

                case 'probeCDPTargets': {
                    // Probe the CDP debug port directly for available targets (useful even with 0 connections)
                    const cdpPort = params.port || (this.helpers.getCDPHandler ? this.helpers.getCDPHandler().port : DEFAULT_CDP_PORT);
                    try {
                        const targets = await new Promise((resolve) => {
                            const req = http.get({ hostname: '127.0.0.1', port: cdpPort, path: '/json/list', timeout: 3000 }, (res) => {
                                let body = '';
                                res.on('data', chunk => body += chunk);
                                res.on('end', () => {
                                    try { resolve(JSON.parse(body)); } catch { resolve([]); }
                                });
                            });
                            req.on('error', (e) => resolve({ error: e.message }));
                            req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
                        });
                        return { success: true, port: cdpPort, targets };
                    } catch (e) {
                        return { success: false, port: cdpPort, error: e.message };
                    }
                }

                case 'getCDPDiagnostics': {
                    // Comprehensive CDP diagnostics: flag check, port probe, connections
                    const cdpDiag = this.helpers.getCDPHandler ? this.helpers.getCDPHandler() : null;
                    const hasFlag = process.argv.some(a => a.includes('--remote-debugging-port='));
                    const diagPort = cdpDiag ? cdpDiag.port : DEFAULT_CDP_PORT;
                    let portReachable = false;
                    let targetCount = 0;
                    try {
                        const targets = await new Promise((resolve) => {
                            const req = http.get({ hostname: '127.0.0.1', port: diagPort, path: '/json/list', timeout: 3000 }, (res) => {
                                let body = '';
                                res.on('data', chunk => body += chunk);
                                res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve([]); } });
                            });
                            req.on('error', () => resolve(null));
                            req.on('timeout', () => { req.destroy(); resolve(null); });
                        });
                        portReachable = targets !== null;
                        targetCount = Array.isArray(targets) ? targets.length : 0;
                    } catch { /* ignore */ }
                    return {
                        success: true,
                        diagnostics: {
                            cdpFlagInProcessArgs: hasFlag,
                            cdpPort: diagPort,
                            portReachable,
                            targetCount,
                            connectionCount: cdpDiag ? cdpDiag.getConnectionCount() : 0,
                            isEnabled: cdpDiag ? cdpDiag.isEnabled : false,
                            processArgv: process.argv.filter(a => a.includes('remote-debugging') || a.includes('port')),
                            recommendation: !hasFlag
                                ? `Restart IDE with: --remote-debugging-port=${diagPort}`
                                : !portReachable
                                    ? `CDP flag present but port ${diagPort} not responding. Try restarting.`
                                    : targetCount === 0
                                        ? 'CDP port active but no targets. Open a chat panel.'
                                        : 'CDP looks healthy.'
                        }
                    };
                }

                // === Autonomous Auto-Accept Diagnostics ===

                case 'diagnoseAutoAccept': {
                    // Comprehensive auto-accept diagnostics: scans DOM for buttons,
                    // checks both strategies, reports what's clickable and what's blocked
                    const cdp = this.helpers.getCDPHandler ? this.helpers.getCDPHandler() : null;
                    const hybrid = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;

                    const diag = {
                        hybridEnabled: hybrid ? hybrid.isEnabled : false,
                        hybridStats: hybrid ? hybrid.stats : null,
                        primaryStrategy: null,
                        fallbackStrategy: null,
                        cdpConnections: 0,
                        domButtons: [],
                        recommendations: []
                    };

                    if (hybrid) {
                        const status = hybrid.getStatus();
                        diag.primaryStrategy = status.primaryStrategy;
                        diag.fallbackStrategy = status.fallbackStrategy;
                    }

                    if (cdp) {
                        diag.cdpConnections = cdp.getConnectionCount();
                    }

                    // Scan DOM for accept/reject buttons
                    if (cdp && cdp.getConnectionCount() > 0) {
                        const scanScript = `(function(){
                            var results=[];
                            function scan(root,depth){
                                if(depth>8)return;
                                var els=root.querySelectorAll?root.querySelectorAll('button,[role=button],a.action-label,input[type=button],input[type=submit]'):[];
                                for(var i=0;i<els.length;i++){
                                    var e=els[i];
                                    var t=(e.textContent||e.value||'').trim();
                                    if(!t||t.length>80)continue;
                                    var tid=e.getAttribute('data-testid')||'';
                                    var style=window.getComputedStyle(e);
                                    var rect=e.getBoundingClientRect();
                                    var vis=style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;
                                    var clickable=style.pointerEvents!=='none'&&!e.disabled;
                                    var tl=t.toLowerCase();
                                    if(tl.match(/accept|reject|continue|run|approve|allow|deny|cancel|keep|discard|proceed|apply|confirm|save/)||tid){
                                        results.push({text:t.substring(0,60),testId:tid,tag:e.tagName,visible:vis,clickable:clickable,rect:{x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}});
                                    }
                                }
                                var all=root.querySelectorAll?root.querySelectorAll('*'):[];
                                for(var j=0;j<all.length;j++){if(all[j].shadowRoot)scan(all[j].shadowRoot,depth+1)}
                            }
                            scan(document,0);
                            return JSON.stringify(results);
                        })()`;

                        for (const [connId] of cdp.connections) {
                            try {
                                const res = await cdp._evaluate(connId, scanScript, 5000);
                                const raw = res?.result?.value;
                                if (raw) {
                                    const buttons = JSON.parse(raw);
                                    diag.domButtons.push({ connectionId: connId, buttons });
                                }
                            } catch (e) {
                                diag.domButtons.push({ connectionId: connId, error: e.message });
                            }
                        }
                    }

                    // Build recommendations
                    if (!diag.hybridEnabled) diag.recommendations.push('HybridAutoAccept is not enabled. Toggle the extension ON.');
                    if (diag.cdpConnections === 0) diag.recommendations.push('No CDP connections. Ensure IDE was launched with --remote-debugging-port flag.');
                    if (diag.primaryStrategy && !diag.primaryStrategy.enabled) diag.recommendations.push('Primary VS Code command strategy is disabled.');
                    if (diag.fallbackStrategy && !diag.fallbackStrategy.enabled) diag.recommendations.push('CDP fallback strategy is not running. It should auto-start with hybrid.');
                    const allButtons = diag.domButtons.flatMap(d => d.buttons || []);
                    const visibleAccept = allButtons.filter(b => b.visible && b.clickable && b.text.toLowerCase().match(/accept|run|continue|allow|proceed|apply|confirm|keep/));
                    if (visibleAccept.length > 0) diag.recommendations.push(`Found ${visibleAccept.length} clickable accept button(s): ${visibleAccept.map(b => b.text).join(', ')}`);
                    if (diag.recommendations.length === 0) diag.recommendations.push('Auto-accept looks healthy. No pending buttons detected.');

                    return { success: true, diagnostics: diag };
                }

                case 'scanAcceptButtons': {
                    // Scan DOM across all CDP connections for accept/reject buttons
                    const cdp2 = this.helpers.getCDPHandler ? this.helpers.getCDPHandler() : null;
                    if (!cdp2 || cdp2.getConnectionCount() === 0) {
                        return { success: false, error: 'No CDP connections available' };
                    }

                    const scanScript2 = `(function(){
                        var results=[];
                        function scan(root,depth){
                            if(depth>8)return;
                            var els=root.querySelectorAll?root.querySelectorAll('button,[role=button],a.action-label,input[type=button],input[type=submit]'):[];
                            for(var i=0;i<els.length;i++){
                                var e=els[i];
                                var t=(e.textContent||e.value||'').trim();
                                if(!t||t.length>80)continue;
                                var tid=e.getAttribute('data-testid')||'';
                                var style=window.getComputedStyle(e);
                                var rect=e.getBoundingClientRect();
                                var vis=style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;
                                var clickable=style.pointerEvents!=='none'&&!e.disabled;
                                results.push({text:t.substring(0,60),testId:tid,tag:e.tagName,visible:vis,clickable:clickable,category:t.toLowerCase().match(/accept|run|continue|allow|proceed|apply|confirm|keep|save/)?'accept':t.toLowerCase().match(/reject|cancel|discard|deny|close/)?'reject':'other'});
                            }
                            var all=root.querySelectorAll?root.querySelectorAll('*'):[];
                            for(var j=0;j<all.length;j++){if(all[j].shadowRoot)scan(all[j].shadowRoot,depth+1)}
                        }
                        scan(document,0);
                        return JSON.stringify(results);
                    })()`;

                    const allResults = [];
                    for (const [connId] of cdp2.connections) {
                        try {
                            const res = await cdp2._evaluate(connId, scanScript2, 5000);
                            const raw = res?.result?.value;
                            if (raw) {
                                const buttons = JSON.parse(raw);
                                allResults.push({ connectionId: connId, buttons, count: buttons.length });
                            }
                        } catch (e) {
                            allResults.push({ connectionId: connId, error: e.message });
                        }
                    }
                    return { success: true, connections: allResults };
                }

                case 'testPrimaryStrategy': {
                    // Manually trigger one primary strategy poll cycle and return detailed results
                    const hybrid2 = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;
                    if (!hybrid2) return { success: false, error: 'HybridAutoAccept not initialized' };

                    // Check which commands are currently available
                    const allCmds = await vscode.commands.getCommands(true);
                    const primaryCmds = hybrid2.config.primaryStrategy?.commands || [];
                    const availableCmds = primaryCmds.filter(c => allCmds.includes(c));

                    // Execute each command individually and track results
                    const cmdResults = [];
                    for (const cmd of availableCmds) {
                        try {
                            const before = Date.now();
                            const result = await vscode.commands.executeCommand(cmd);
                            cmdResults.push({ command: cmd, executed: true, result: result !== undefined ? String(result) : 'void', ms: Date.now() - before });
                        } catch (e) {
                            cmdResults.push({ command: cmd, executed: false, error: e.message });
                        }
                    }

                    return {
                        success: true,
                        strategy: 'primary',
                        configuredCommands: primaryCmds,
                        availableInVSCode: availableCmds,
                        missingCommands: primaryCmds.filter(c => !allCmds.includes(c)),
                        results: cmdResults,
                        note: 'Commands returning void may be no-ops if no UI action is pending.'
                    };
                }

                case 'testFallbackStrategy': {
                    // Manually trigger one CDP fallback strategy poll and return results
                    const hybrid3 = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;
                    if (!hybrid3) return { success: false, error: 'HybridAutoAccept not initialized' };

                    // Access the internal fallback strategy
                    const fallback = hybrid3._fallbackStrategy;
                    if (!fallback) return { success: false, error: 'CDP fallback strategy not initialized. Ensure fallbackStrategy.enabled is true.' };

                    try {
                        const before = Date.now();
                        const result = await fallback.poll();
                        return {
                            success: true,
                            strategy: 'cdp-fallback',
                            result,
                            ms: Date.now() - before,
                            stats: fallback.stats
                        };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                }

                case 'forceClickAccept': {
                    // Force-click the first visible accept button via CDP (bypasses strategy layers)
                    const cdp3 = this.helpers.getCDPHandler ? this.helpers.getCDPHandler() : null;
                    if (!cdp3 || cdp3.getConnectionCount() === 0) {
                        return { success: false, error: 'No CDP connections' };
                    }

                    const clickScript = `(function(){
                        function scan(root,depth){
                            if(depth>8)return null;
                            var els=root.querySelectorAll?root.querySelectorAll('button,[role=button],a.action-label'):[];
                            for(var i=0;i<els.length;i++){
                                var e=els[i];
                                var t=(e.textContent||'').trim().toLowerCase();
                                if(!t||t.length>60)continue;
                                var style=window.getComputedStyle(e);
                                var rect=e.getBoundingClientRect();
                                var vis=style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;
                                var clickable=style.pointerEvents!=='none'&&!e.disabled;
                                if(vis&&clickable&&t.match(/^(accept|run|continue|allow|proceed|apply|confirm|keep|save)/)){
                                    e.click();
                                    return {clicked:true,text:t.substring(0,40)};
                                }
                            }
                            var all=root.querySelectorAll?root.querySelectorAll('*'):[];
                            for(var j=0;j<all.length;j++){if(all[j].shadowRoot){var r=scan(all[j].shadowRoot,depth+1);if(r)return r}}
                            return null;
                        }
                        var r=scan(document,0);
                        return JSON.stringify(r||{clicked:false});
                    })()`;

                    const clickResults = [];
                    for (const [connId] of cdp3.connections) {
                        try {
                            const res = await cdp3._evaluate(connId, clickScript, 5000);
                            const raw = res?.result?.value;
                            const parsed = raw ? JSON.parse(raw) : { clicked: false };
                            clickResults.push({ connectionId: connId, ...parsed });
                            if (parsed.clicked) break; // Stop after first successful click
                        } catch (e) {
                            clickResults.push({ connectionId: connId, error: e.message });
                        }
                    }
                    return { success: true, results: clickResults };
                }

                case 'getAutoAcceptConfig': {
                    // Return the full hybrid auto-accept configuration
                    const hybrid4 = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;
                    const vsConfig = vscode.workspace.getConfiguration('auto-accept.hybrid');
                    return {
                        success: true,
                        runtime: hybrid4 ? hybrid4.config : null,
                        vscodeSettings: {
                            enabled: vsConfig.get('enabled'),
                            primaryEnabled: vsConfig.get('primaryStrategy.enabled'),
                            primaryPollInterval: vsConfig.get('primaryStrategy.pollInterval'),
                            primaryCommands: vsConfig.get('primaryStrategy.commands'),
                            fallbackEnabled: vsConfig.get('fallbackStrategy.enabled'),
                            fallbackPollInterval: vsConfig.get('fallbackStrategy.pollInterval'),
                            fallbackUseDataTestId: vsConfig.get('fallbackStrategy.useDataTestId')
                        },
                        isRunning: hybrid4 ? hybrid4.isEnabled : false
                    };
                }

                case 'restartAutoAccept': {
                    // Stop and restart the hybrid auto-accept system
                    const hybrid5 = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;
                    if (!hybrid5) return { success: false, error: 'HybridAutoAccept not initialized' };

                    try {
                        await hybrid5.stop();
                        hybrid5.updateConfig(hybrid5.config); // Reload config
                        await hybrid5.start();
                        return { success: true, status: hybrid5.getStatus() };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                }

                case 'listDebugActions': {
                    // Return a catalog of all available debug actions with descriptions
                    return {
                        success: true,
                        actions: {
                            // Core
                            toggle: 'Toggle the extension on/off',
                            getEnabled: 'Check if extension is enabled',
                            getFullState: 'Get complete extension state snapshot',
                            getSystemInfo: 'Get system/platform info',

                            // Auto-Accept Diagnostics
                            diagnoseAutoAccept: 'Comprehensive auto-accept health check (DOM scan, strategy status, recommendations)',
                            scanAcceptButtons: 'Scan DOM for all accept/reject/action buttons across CDP connections',
                            testPrimaryStrategy: 'Manually execute one VS Code command strategy poll with detailed results',
                            testFallbackStrategy: 'Manually execute one CDP fallback poll with detailed results',
                            forceClickAccept: 'Force-click the first visible accept button via CDP',
                            getAutoAcceptConfig: 'Get full auto-accept configuration (runtime + VS Code settings)',
                            restartAutoAccept: 'Stop and restart the hybrid auto-accept system',
                            getHybridStatus: 'Get hybrid auto-accept status and stats',
                            pollAutoAccept: 'Trigger one poll cycle through hybrid orchestrator',
                            updateHybridConfig: 'Update hybrid config at runtime (params: {config: {...}})',

                            // CDP
                            getCDPStatus: 'Get CDP connection status',
                            getCDPConnections: 'List all CDP connections with page info',
                            getCDPDiagnostics: 'Full CDP diagnostics (flag, port, targets, connections)',
                            probeCDPTargets: 'Probe CDP port for available targets',
                            evaluateInBrowser: 'Evaluate JS in browser context (params: {code, allConnections?})',
                            dumpDOM: 'Dump DOM HTML from CDP connections (params: {selector?, maxLength?})',

                            // Queue
                            startQueue: 'Start prompt queue',
                            pauseQueue: 'Pause running queue',
                            resumeQueue: 'Resume paused queue',
                            skipPrompt: 'Skip current queue prompt',
                            stopQueue: 'Stop the queue',
                            resetQueue: 'Reset queue to beginning',
                            sendPrompt: 'Send a prompt via CDP (params: {prompt})',
                            getQueueStatus: 'Get queue status',
                            getSchedulerInternals: 'Get scheduler internal state',

                            // Schedule
                            updateSchedule: 'Update schedule config (params: {enabled, mode, value, ...})',
                            getSchedule: 'Get schedule configuration',

                            // Safety
                            updateBannedCommands: 'Update banned command patterns (params: {commands: [...]})',
                            getBannedCommands: 'Get banned command patterns',

                            // Commands
                            listChatCommands: 'List all chat/agent/AI related VS Code commands',
                            executeVSCodeCommand: 'Execute any VS Code command (params: {command, args?})',

                            // Logs
                            getLogs: 'Get extension log tail (params: {tailLines?})',
                            clearLogs: 'Clear extension log file',
                            openLogFile: 'Open log file in editor',

                            // Settings
                            setFrequency: 'Set poll frequency (params: {value})',
                            resetAllSettings: 'Reset all extension settings to defaults',
                            openSettingsPanel: 'Open the settings panel UI',

                            // Quota
                            getAntigravityQuota: 'Get quota enabled status',
                            setAntigravityQuota: 'Set quota enabled (params: {value})',
                            refreshAntigravityQuota: 'Refresh quota data',

                            // Advanced
                            forceRelaunch: 'Force IDE relaunch with CDP flag',
                            getLockedOut: 'Check lockout state',
                            getAntigravityStatus: 'Check Antigravity client connection',
                            getServerStatus: 'Check debug server status'
                        }
                    };
                }

                default:
                    return { success: false, error: `Unknown debug action: ${action}` };
            }
        } catch (err) {
            this._logError(`Error executing ${action}: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    getLatestCdpLogPath() {
        return getLatestCdpLogPath(this.context.extensionPath);
    }

    getLogs(tailLinesParam) {
        const logPath = this.getLatestCdpLogPath();
        try {
            if (logPath && fs.existsSync(logPath)) {
                const stat = fs.statSync(logPath);
                const maxBytes = 250000;
                const tailLines = tailLinesParam || 300;
                const start = Math.max(0, stat.size - maxBytes);
                const fd = fs.openSync(logPath, 'r');
                const buf = Buffer.alloc(stat.size - start);
                fs.readSync(fd, buf, 0, buf.length, start);
                fs.closeSync(fd);
                const lines = buf.toString('utf8').split(/\r?\n/).filter(l => l.length > 0);
                const tail = lines.slice(-tailLines).join('\n');
                return { success: true, logs: tail, linesCount: Math.min(tailLines, lines.length), totalSize: stat.size };
            }
            return { success: true, logs: '', linesCount: 0, totalSize: 0 };
        } catch (e) {
            return { success: false, error: `Failed to read logs: ${e.message}` };
        }
    }

    clearLogs() {
        const logPath = this.getLatestCdpLogPath();
        try {
            if (!logPath) return { success: true };
            fs.writeFileSync(logPath, '', 'utf8');
            return { success: true };
        } catch (e) {
            return { success: false, error: `Failed to clear logs: ${e.message}` };
        }
    }

    async openLogFile() {
        const logPath = this.getLatestCdpLogPath();
        if (logPath && fs.existsSync(logPath)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
            await vscode.window.showTextDocument(doc, { preview: false });
            return { success: true };
        }
        return { success: false, error: 'Log file not found' };
    }

    getFullState() {
        const scheduler = this.helpers.getScheduler ? this.helpers.getScheduler() : null;
        const hybridAutoAccept = this.helpers.getHybridAutoAccept ? this.helpers.getHybridAutoAccept() : null;
        const scheduleConfig = vscode.workspace.getConfiguration('auto-accept.schedule');
        const quotaConfig = vscode.workspace.getConfiguration('auto-accept.antigravityQuota');

        return {
            success: true,
            state: {
                enabled: this.context.globalState.get(GLOBAL_STATE_KEY, false),
                frequency: this.context.globalState.get(FREQ_STATE_KEY, 1000),
                schedule: {
                    enabled: scheduleConfig.get('enabled'),
                    mode: scheduleConfig.get('mode'),
                    value: scheduleConfig.get('value'),
                    prompt: scheduleConfig.get('prompt'),
                    prompts: scheduleConfig.get('prompts', []),
                    queueMode: scheduleConfig.get('queueMode', 'consume'),
                    silenceTimeout: scheduleConfig.get('silenceTimeout', 30)
                },
                quota: {
                    enabled: quotaConfig.get('enabled', true),
                    pollInterval: quotaConfig.get('pollInterval', 60),
                    resumeEnabled: vscode.workspace.getConfiguration('auto-accept.antigravityQuota.resume').get('enabled', true),
                    autoContinueEnabled: vscode.workspace.getConfiguration('auto-accept.autoContinue').get('enabled', false)
                },
                queueStatus: scheduler ? scheduler.getStatus() : null,
                hybridStatus: hybridAutoAccept ? hybridAutoAccept.getStatus() : null,
                bannedCommands: this.context.globalState.get(BANNED_COMMANDS_KEY, []),
                stats: this.context.globalState.get('auto-accept-stats', {}),
                isLockedOut: this.helpers.getLockedOut ? this.helpers.getLockedOut() : false,
                debugMode: true,
                antigravityStatus: (this.helpers.getAntigravityClient && this.helpers.getAntigravityClient()?.isConnected) ? 'connected' : 'disconnected'
            }
        };
    }

    startServer() {
        if (this.server) return;

        // Check if debug mode is enabled (defaults to true)
        const debugEnabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', true);
        if (!debugEnabled) return;

        try {
            this.server = http.createServer(async (req, res) => {
                // CORS headers
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end('Method not allowed, use POST');
                    return;
                }

                let body = '';
                // Safety: limit body size to ~1MB
                let bodySize = 0;
                const MAX_BODY_SIZE = 1024 * 1024;

                req.on('data', chunk => {
                    bodySize += chunk.length;
                    if (bodySize > MAX_BODY_SIZE) {
                        res.writeHead(413, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
                        req.destroy();
                        return;
                    }
                    body += chunk.toString();
                });

                req.on('end', async () => {
                    try {
                        let data = {};
                        if (body) {
                            try {
                                data = JSON.parse(body);
                            } catch (e) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
                                return;
                            }
                        }

                        const { action, params } = data;
                        if (!action) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: 'Missing action' }));
                            return;
                        }

                        const source = `${req.socket?.remoteAddress}:${req.socket?.remotePort}`;
                        this._log(`Received action: ${action} from ${source}`);
                        if (action === 'uiAction' && data.params && data.params.type === 'click') {
                            this._log(`[ALERT] UI CLICK DETECTED FROM ${source} ON TARGET ${data.params.target}`);
                        }

                        // Delegate to handleCommand
                        const result = await this.handleCommand(action, params);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (e) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: e.message }));
                    }
                });
            });

            this._log('Debug Server: calling listen...');
            this.server.listen(this.serverPort, '127.0.0.1', () => {
                this._log(`Debug Server running on http://127.0.0.1:${this.serverPort}`);
            });

            this.server.on('error', (e) => {
                this._log(`Debug Server Error: ${e.code} - ${e.message}`);
                this._logError(`Debug Server Error: ${e.message}`);
                if (e.code === 'EADDRINUSE') {
                    this._log('Port 54321 is busy. Debug server could not start.');
                }
                this.stopServer(); // Cleanup
            });

        } catch (e) {
            this._logError(`Failed to start Debug Server: ${e.message}`);
        }
    }

    stopServer() {
        if (this.server) {
            this.server.close();
            this.server = null;
            this._log('Debug Server stopped');
        }
    }
}

module.exports = { DebugHandler };
