const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEFAULT_CDP_PORT, CDP_AVAILABILITY_ATTEMPTS, CDP_AVAILABILITY_RETRY_MS } = require('./constants');
const { BaseLogger } = require('./base-logger');

class CDPHandler extends BaseLogger {
    constructor(logger = console.log, port = DEFAULT_CDP_PORT) {
        super(logger, 'CDP');
        this.port = port;
        this.connections = new Map(); // port:pageId -> {ws, injected}
        this.isEnabled = false;
        this.msgId = 1;
        this.bundleVersion = null;
        this.lastSendConnectionId = null; // Track which connection was used for sending
    }

    /**
     * Check if the configured CDP port is active
     */
    async isCDPAvailable() {
        // Fast path: start() already established connections
        if (this.connections.size > 0) return true;

        try {
            for (let attempt = 1; attempt <= CDP_AVAILABILITY_ATTEMPTS; attempt++) {
                const pages = await this._getPages(this.port);
                if (pages.length > 0) return true;

                if (attempt < CDP_AVAILABILITY_ATTEMPTS) {
                    await this._wait(CDP_AVAILABILITY_RETRY_MS);
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    async _wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Start/maintain the CDP connection and injection loop
     */
    async start(config) {
        this.isEnabled = true;
        if (config.port) this.port = config.port;
        this.workspaceName = config.workspaceName || null; // Store for later use in sendPrompt
        this._log(`Connecting to CDP on port ${this.port}...`);
        if (this.workspaceName) {
            this._log(`Current workspace: ${this.workspaceName}`);
        }

        try {
            const pages = await this._getPages(this.port);
            for (const page of pages) {
                const id = `${this.port}:${page.id}`;
                if (!this.connections.has(id)) {
                    await this._connect(id, page.webSocketDebuggerUrl);
                }
                if (this.connections.has(id)) {
                    this.connections.get(id).pageTitle = page.title || '';
                    this.connections.get(id).pageUrl = page.url || '';
                }
                await this._inject(id, config);
            }
        } catch (e) { }
    }

    async stop() {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                conn.ws.close();
            } catch (e) { }
        }
        this.connections.clear();
    }

    async _getPages(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(body);
                        // Filter for debuggable pages with WebSocket
                        const filtered = pages.filter(p => {
                            if (!p.webSocketDebuggerUrl) return false;
                            // Accept any page/webview/iframe — cast a wide net
                            // to ensure we don't miss the chat webview
                            if (p.type === 'service_worker' || p.type === 'background_page') return false;
                            // Filter out worker targets with no title/URL (internal threads that cause CDP timeouts)
                            if (p.type === 'worker' && !p.title && !p.url) return false;
                            // Exclude our own extension's webviews (Settings Panel) — their URL contains our extensionId
                            const url = (p.url || '').toLowerCase();
                            const title = (p.title || '').toLowerCase();
                            if (url.includes('extensionid=rodhayl.multi-purpose-agent') || title.includes('extensionid=rodhayl.multi-purpose-agent')) return false;
                            return true;
                        });
                        this._log(`_getPages: ${pages.length} total, ${filtered.length} after filter (types: ${filtered.map(p => `${p.type}:"${(p.title||'').substring(0,30)}"`).join(', ')})`);
                        resolve(filtered);
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    async _connect(id, url) {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => {
                this.connections.set(id, { ws, injected: false });
                this._log(`Connected to page ${id}`);
                resolve(true);
            });
            ws.on('error', () => resolve(false));
            ws.on('close', () => {
                this.connections.delete(id);
                this._log(`Disconnected from page ${id}`);
            });
        });
    }

    /**
     * Build and cache the concatenated sub-module bundle (utils + analytics).
     * File reads happen once; subsequent calls return the cached string.
     */
    _getSubModuleBundle() {
        if (this._subModuleBundle) return this._subModuleBundle;

        const base = path.join(__dirname, '..', 'main_scripts');
        const files = [
            path.join(base, 'utils.js'),
            path.join(base, 'analytics', 'state.js'),
            path.join(base, 'analytics', 'trackers', 'clicks.js'),
            path.join(base, 'analytics', 'trackers', 'away.js'),
            path.join(base, 'analytics', 'reporters', 'roi.js'),
            path.join(base, 'analytics', 'reporters', 'session.js'),
            path.join(base, 'analytics', 'focus.js'),
            path.join(base, 'analytics', 'index.js'),
        ];

        // Concatenate all sub-modules into one script (dependency order)
        this._subModuleBundle = files.map(f => fs.readFileSync(f, 'utf8')).join(';\n');
        return this._subModuleBundle;
    }

    async _inject(id, config) {
        const conn = this.connections.get(id);
        if (!conn) return;

        try {
            // Inject all sub-modules in a single CDP evaluation (utils + analytics)
            const subModuleBundle = this._getSubModuleBundle();
            await this._evaluate(id, subModuleBundle, 15000);

            // Then inject the main script (with version check to skip if unchanged)
            const scriptPath = path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js');
            const stat = fs.statSync(scriptPath);
            const runtimeBundleVersion = String(Math.floor(stat.mtimeMs));
            this.bundleVersion = runtimeBundleVersion;

            let currentBundleVersion = '';
            try {
                const currentVersionRes = await this._evaluate(id, '(function(){ return window.__autoAcceptBundleVersion || ""; })()');
                currentBundleVersion = currentVersionRes?.result?.value || '';
            } catch (e) { }

            if (!conn.injected || currentBundleVersion !== this.bundleVersion) {
                const script = fs.readFileSync(scriptPath, 'utf8');
                await this._evaluate(id, script, 15000);
                await this._evaluate(id, `window.__autoAcceptBundleVersion = ${JSON.stringify(this.bundleVersion)}`);
                conn.injected = true;
                this._log(`Script injected into ${id} (bundle ${this.bundleVersion})`);
            }

            await this._evaluate(id, `if(window.__autoAcceptStart) window.__autoAcceptStart(${JSON.stringify(config)})`);
        } catch (e) {
            this._logError(`Injection failed for ${id}: ${e.message}`);
        }
    }

    async _evaluate(id, expression, timeoutMs = 2000) {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), timeoutMs);

            const onMessage = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === currentId) {
                    conn.ws.off('message', onMessage);
                    clearTimeout(timeout);
                    resolve(msg.result);
                }
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    /**
     * Public evaluate method.
     * Evaluates expression on ALL connections and returns the first truthy result.
     * For auto-accept scripts that return JSON with {clicked:true/false}, this
     * ensures a successful click on connection A isn't overwritten by {clicked:false}
     * from connection B.
     */
    async evaluate(expression) {
        let lastResult = null;
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, expression);
                const value = res?.result?.value;
                if (value != null) {
                    lastResult = value;
                    // Short-circuit: if result looks like a JSON with clicked:true, return immediately
                    try {
                        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
                        if (parsed && parsed.clicked === true) return value;
                    } catch (_) { /* not JSON, continue */ }
                }
            } catch (e) { }
        }
        return lastResult;
    }

    async getStats() {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                }
            } catch (e) { }
        }
        return stats;
    }

    async getSessionSummary() { return this.getStats(); } // Compatibility
    async setFocusState(isFocused) {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id, `if(window.__autoAcceptSetFocusState) window.__autoAcceptSetFocusState(${isFocused})`);
            } catch (e) { }
        }
    }

    getConnectionCount() { return this.connections.size; }

    async probeForSendCapability() {
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, '!!(window.__autoAcceptSendPrompt || window.__autoAcceptSendPromptToConversation)');
                if (res?.result?.value === true) return true;
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    async isConversationBusy(targetConversation = '') {
        if (this.connections.size === 0) return false;

        for (const [id, conn] of this.connections) {
            try {
                if (targetConversation) {
                    const title = (conn?.pageTitle || '').toLowerCase();
                    if (!title.includes(String(targetConversation).toLowerCase())) {
                        continue;
                    }
                }

                const res = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && window.__autoAcceptIsConversationWorking) {
                            return !!window.__autoAcceptIsConversationWorking();
                        }
                        return false;
                    } catch (e) {
                        return false;
                    }
                })()`);

                if (res?.result?.value === true) {
                    this._log(`isConversationBusy: ${id} reports busy`);
                    return true;
                }
            } catch (e) {
                // Ignore per-connection errors and continue probing others
            }
        }

        return false;
    }

    async sendPrompt(text, targetConversation = '') {
        if (!text) return 0;

        const connCount = this.connections.size;
        if (connCount === 0) {
            this._logError(`No CDP connections available! Cannot send prompt.`);
            return 0;
        }

        this._log(`Sending prompt to ${connCount} connection(s)${targetConversation ? ` (target: "${targetConversation}")` : ''}: "${text.substring(0, 50)}..."`);

        // Use the newest prompt-sending implementation (probe + verification).
        try {
            return await this._sendPromptV2(text, targetConversation);
        } catch (e) {
            this._logError(`Prompt send (v2) failed: ${e?.message || String(e)}`);
            return 0;
        }
    }

    async _sendPromptV2(text, targetConversation = '') {
        if (!text) return 0;

        const connCount = this.connections.size;
        if (connCount === 0) return 0;

        this._log(`Prompt send (v2): Probing ${connCount} connection(s)...`);

        // Probe each connection for the best prompt input target
        const connectionResults = [];
        for (const [id, conn] of this.connections) {
            try {
                const pageTitle = conn?.pageTitle || '';
                const pageUrl = conn?.pageUrl || '';

                // Skip our own extension's webviews (Settings Panel) — never send prompts there
                if (pageUrl.toLowerCase().includes('extensionid=rodhayl.multi-purpose-agent') ||
                    pageTitle.toLowerCase().includes('extensionid=rodhayl.multi-purpose-agent')) {
                    this._log(`Prompt send (v2): Skipping own extension webview ${id}`);
                    continue;
                }

                this._log(`Prompt send (v2): Probing ${id} (title="${pageTitle.substring(0, 60)}", url="${pageUrl.substring(0, 80)}")`);

                const probeRes = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && window.__autoAcceptProbePrompt) {
                            return JSON.stringify(window.__autoAcceptProbePrompt());
                        }
                        // Fallback: basic scan (textarea or contenteditable)
                        const editables = document.querySelectorAll('[contenteditable="true"]');
                        const textareas = document.querySelectorAll('textarea');
                        const any = (editables && editables.length > 0) || (textareas && textareas.length > 0);
                        return JSON.stringify({ hasInput: !!any, score: any ? 1 : 0, fallback: true, editableCount: editables.length, textareaCount: textareas.length });
                    } catch (e) {
                        return JSON.stringify({ hasInput: false, score: 0, error: (e && e.message) ? e.message : String(e) });
                    }
                })()`);

                const parsed = typeof probeRes?.result?.value === 'string'
                    ? JSON.parse(probeRes.result.value)
                    : { hasInput: false, score: 0 };

                this._log(`Prompt send (v2): Probe result for ${id}: hasInput=${parsed.hasInput}, score=${parsed.score}, hasAgentPanel=${parsed.hasAgentPanel}, hint="${parsed.hint || ''}", error=${parsed.error || 'none'}`);

                connectionResults.push({
                    id,
                    hasInput: !!parsed.hasInput,
                    score: typeof parsed.score === 'number' ? parsed.score : 0,
                    details: parsed
                });
            } catch (e) {
                this._logError(`Prompt send (v2): Probe error for ${id}: ${e.message}`);
                connectionResults.push({ id, hasInput: false, score: 0, error: e.message });
            }
        }

        let targetsWithInput = connectionResults.filter(r => r.hasInput);

        // Prefer the Antigravity agent chat webview when present.
        const agentPanelTargets = targetsWithInput.filter(r => r.details && r.details.hasAgentPanel);
        if (agentPanelTargets.length > 0) {
            targetsWithInput = agentPanelTargets;
        }

        // If workspace preference set, filter targets to matching workspace
        if (this.workspaceName && targetsWithInput.length > 1) {
            const workspaceMatches = targetsWithInput.filter(r => {
                const conn = this.connections.get(r.id);
                const title = conn?.pageTitle || '';
                return title.toLowerCase().includes(this.workspaceName.toLowerCase());
            });
            if (workspaceMatches.length > 0) {
                targetsWithInput = workspaceMatches;
            }
        }

        if (targetsWithInput.length === 0) {
            this._log(`Prompt send (v2): No connection reports a prompt input (total probed: ${connectionResults.length}). Results: ${connectionResults.map(r => `${r.id}:hasInput=${r.hasInput},score=${r.score},err=${r.error || 'none'}`).join('; ')}`);
            return 0;
        }

        targetsWithInput.sort((a, b) => {
            const aPanel = a.details && a.details.hasAgentPanel ? 1 : 0;
            const bPanel = b.details && b.details.hasAgentPanel ? 1 : 0;
            if (aPanel !== bPanel) return bPanel - aPanel;
            return (b.score || 0) - (a.score || 0);
        });

        for (const target of targetsWithInput) {
            this._log(`Prompt send (v2): Using ${target.id} (score: ${target.score || 0})`);

            try {
                const result = await this._evaluate(target.id, `(async function(){
                    const out = { ok: false, method: null, error: null };
                    try {
                        if(typeof window !== "undefined" && window.__autoAcceptSendPromptToConversation) {
                            const okConv = await window.__autoAcceptSendPromptToConversation(${JSON.stringify(text)}, ${JSON.stringify(targetConversation)});
                            if (okConv) {
                                out.ok = true;
                                out.method = 'sendPromptToConversation';
                                return JSON.stringify(out);
                            }
                            out.error = 'sendPromptToConversation returned falsy';
                        }
                        if(typeof window !== "undefined" && window.__autoAcceptSendPrompt) {
                            const ok = await window.__autoAcceptSendPrompt(${JSON.stringify(text)});
                            out.ok = !!ok;
                            out.method = 'sendPrompt';
                            if(!out.ok) out.error = 'sendPrompt returned falsy';
                            return JSON.stringify(out);
                        }
                        out.error = 'no send functions found';
                        return JSON.stringify(out);
                    } catch (e) {
                        out.error = (e && e.message) ? e.message : String(e);
                        return JSON.stringify(out);
                    }
                })()`, 15000);

                const raw = result?.result?.value;
                let parsed = null;
                if (typeof raw === 'string') {
                    try { parsed = JSON.parse(raw); } catch (e) { }
                }

                if (parsed?.ok) {
                    this._log(`Prompt send (v2): Sent via ${parsed.method}`);
                    this.lastSendConnectionId = target.id;
                    return 1;
                }

                this._log(`Prompt send (v2): NOT sent on ${target.id}: ${parsed?.error || raw || 'unknown error'}`);
            } catch (e) {
                this._logError(`Prompt send (v2): Failed to send on ${target.id}: ${e.message}`);
            }
        }

        this._log('Prompt send (v2): Failed on all candidate connections');
        return 0;
    }

    /**
     * Get a snapshot of the conversation state (text length, message count) from the connection used for sending.
     * Used to detect when the AI starts/stops responding.
     */
    async getConversationSnapshot() {
        const targetId = this.lastSendConnectionId;
        if (!targetId || !this.connections.has(targetId)) {
            // Fallback: try all connections
            for (const [id] of this.connections) {
                try {
                    const res = await this._evaluate(id, `(function(){
                        try {
                            if (window.__autoAcceptGetConversationSnapshot) return JSON.stringify(window.__autoAcceptGetConversationSnapshot());
                            return JSON.stringify({textLength: document.body?.innerText?.length || 0, ts: Date.now()});
                        } catch(e) { return JSON.stringify({error: e.message}); }
                    })()`);
                    if (res?.result?.value) return JSON.parse(res.result.value);
                } catch (e) { }
            }
            return null;
        }
        try {
            const res = await this._evaluate(targetId, `(function(){
                try {
                    if (window.__autoAcceptGetConversationSnapshot) return JSON.stringify(window.__autoAcceptGetConversationSnapshot());
                    return JSON.stringify({textLength: document.body?.innerText?.length || 0, ts: Date.now()});
                } catch(e) { return JSON.stringify({error: e.message}); }
            })()`);
            if (res?.result?.value) return JSON.parse(res.result.value);
        } catch (e) { }
        return null;
    }

    /**
     * Wait for the AI to start responding after a prompt was sent.
     * Polls the conversation snapshot until text length increases or busy indicator appears.
     * @param {number} timeoutMs - Max time to wait (default 15s)
     * @param {number} intervalMs - Poll interval (default 1s)
     * @returns {boolean} true if response started, false if timed out
     */
    async waitForResponseStart(timeoutMs = 15000, intervalMs = 1000) {
        const baseline = await this.getConversationSnapshot();
        if (!baseline) return false;
        const startTextLen = baseline.textLength || 0;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, intervalMs));
            // Check busy state first (fastest signal)
            const busy = await this.isConversationBusy();
            if (busy) {
                this._log('waitForResponseStart: conversation became busy');
                return true;
            }
            // Check if text grew (AI started outputting)
            const snap = await this.getConversationSnapshot();
            if (snap && (snap.textLength || 0) > startTextLen + 10) {
                this._log(`waitForResponseStart: text grew from ${startTextLen} to ${snap.textLength}`);
                return true;
            }
        }
        this._log('waitForResponseStart: timed out waiting for response');
        return false;
    }

    async getAwayActions() {
        let total = 0;
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `(function(){ 
                    if(typeof window !== "undefined" && window.__autoAcceptGetAwayActions) {
                        return window.__autoAcceptGetAwayActions();
                    }
                    return 0; 
                })()`);

                if (res && res.result && res.result.value !== undefined) {
                    total += parseInt(res.result.value) || 0;
                }
            } catch (e) { }
        }
        return total;
    }

    async resetStats() {
        const aggregatedStats = { clicks: 0, blocked: 0 };
        for (const [id] of this.connections) {
            try {
                const jsonRes = await this._evaluate(id, `(function(){ 
                    if(typeof window !== "undefined" && window.__autoAcceptResetStats) {
                        return JSON.stringify(window.__autoAcceptResetStats());
                    }
                    return JSON.stringify({ clicks: 0, blocked: 0 });
                })()`);

                if (jsonRes && jsonRes.result && jsonRes.result.value) {
                    const s = JSON.parse(jsonRes.result.value);
                    aggregatedStats.clicks += s.clicks || 0;
                    aggregatedStats.blocked += s.blocked || 0;
                }
            } catch (e) {
                this._logError(`Failed to reset stats for ${id}: ${e.message}`);
            }
        }
        return aggregatedStats;
    }
    async getConversations() {
        const conversations = [];
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, '(function(){ return window.__autoAcceptState ? window.__autoAcceptState.tabNames : [] })()');
                if (res?.result?.value) {
                    // Result is an array of strings
                    const tabs = res.result.value; // It is already a protocol value which might need more parsing if it is an object description
                    // Actually Runtime.evaluate returns RemoteObject. 
                    // If it's an array, it might be returned as subtype array with objectId, OR if we JSON.stringify it it's easier.
                }
            } catch (e) { }
        }
        // Let's use the robust JSON stringify approach
        return await this._getConversationsRobust();
    }

    async getActiveConversation() {
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && window.__autoAcceptGetActiveTabName) {
                            return window.__autoAcceptGetActiveTabName() || '';
                        }
                        return '';
                    } catch (e) {
                        return '';
                    }
                })()`);
                const val = res?.result?.value;
                if (typeof val === 'string' && val.trim()) {
                    return val.trim();
                }
            } catch (e) { }
        }
        return '';
    }

    async _getConversationsRobust() {
        const allTabs = new Set();
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptState ? window.__autoAcceptState.tabNames : [])');
                if (res?.result?.value) {
                    const tabs = JSON.parse(res.result.value);
                    if (Array.isArray(tabs)) {
                        tabs.forEach(t => allTabs.add(t));
                    }
                }
            } catch (e) { }
        }
        return Array.from(allTabs);
    }
}

module.exports = { CDPHandler };
