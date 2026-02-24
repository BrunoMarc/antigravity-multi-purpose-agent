/**
 * CDP Strategy Module - Fallback Strategy for Shadow DOM Handling
 * 
 * This module wraps the existing CDP-based auto accept functionality
 * to provide a standardized interface for the HybridAutoAccept orchestrator.
 * 
 * @module auto-accept/cdp-strategy
 */

const EventEmitter = require('events');
const { mixLogger } = require('../base-logger');

// Import centralized patterns and utilities
const { 
    ACCEPT_TESTID_SELECTORS,
    REJECT_TESTID_SELECTORS,
    ACCEPT_PATTERNS,
    REJECT_PATTERNS
} = require('../utils');

/**
 * data-testid selectors for Shadow DOM buttons (i18n-safe)
 * Priority order: most common accept buttons first
 * Now uses centralized patterns from utils.js
 */
const TESTID_SELECTORS = ACCEPT_TESTID_SELECTORS;

/**
 * Excluded testid selectors (reject/cancel actions)
 * Now uses centralized patterns from utils.js
 */
const EXCLUDED_TESTIDS = REJECT_TESTID_SELECTORS;

/**
 * Default configuration for CDP Strategy
 */
const DEFAULT_CONFIG = {
    pollInterval: 1500,
    useDataTestId: true,
    enabled: true
};

/**
 * CDPStrategy - Fallback strategy using Chrome DevTools Protocol
 * 
 * Handles Shadow DOM elements and permission dialogs that may not be
 * accessible via VS Code commands.
 * 
 * @class CDPStrategy
 * @extends EventEmitter
 */
class CDPStrategy extends mixLogger(EventEmitter, 'CDPStrategy') {
    /**
     * Create a new CDPStrategy instance
     * 
     * @param {object} options - Configuration options
     * @param {object} options.cdpHandler - CDP handler instance
     * @param {(msg: string) => void} [options.logger] - Logger function
     * @param {number} [options.pollInterval=1500] - Polling interval in ms
     * @param {boolean} [options.useDataTestId=true] - Use data-testid selectors
     */
    constructor(options = {}) {
        super(options);
        
        this.cdpHandler = options.cdpHandler;
        
        // Configuration
        this._config = {
            ...DEFAULT_CONFIG,
            pollInterval: options.pollInterval || DEFAULT_CONFIG.pollInterval,
            useDataTestId: options.useDataTestId !== false
        };
        
        // State
        this._isEnabled = false;
        this._timer = null;
        this._isProcessing = false;
        
        // Statistics
        this._stats = {
            totalClicks: 0,
            dataTestIdClicks: 0,
            textContentClicks: 0,
            failedAttempts: 0,
            lastClickTime: null,
            startTime: null
        };
    }

    /**
     * Check if CDP strategy is currently enabled
     * @returns {boolean}
     */
    get isEnabled() {
        return this._isEnabled;
    }

    /**
     * Get current configuration
     * @returns {object}
     */
    get config() {
        return { ...this._config };
    }

    /**
     * Get current statistics
     * @returns {object}
     */
    get stats() {
        return { ...this._stats };
    }

    /**
     * Start CDP-based polling
     * 
     * @returns {void}
     */
    start() {
        if (this._isEnabled) {
            this._log('CDPStrategy already running');
            return;
        }

        if (!this.cdpHandler) {
            this._log('Cannot start CDPStrategy: no CDP handler available');
            return;
        }

        this._log('Starting CDP Strategy...');
        
        this._isEnabled = true;
        this._stats.startTime = Date.now();
        
        // Start polling loop
        this._startPolling();
        
        this._log(`CDP Strategy started (poll interval: ${this._config.pollInterval}ms)`);
        
        // Emit start event
        this.emit('started', { timestamp: this._stats.startTime });
    }

    /**
     * Stop CDP polling
     * 
     * @returns {void}
     */
    stop() {
        if (!this._isEnabled) {
            return;
        }

        this._log('Stopping CDP Strategy...');
        
        this._isEnabled = false;
        
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        
        this._log('CDP Strategy stopped');
        
        // Emit stop event
        this.emit('stopped', { timestamp: Date.now() });
    }

    /**
     * Start the polling loop
     * @private
     */
    _startPolling() {
        const poll = async () => {
            if (!this._isEnabled) return;
            
            try {
                await this.poll();
            } catch (error) {
                this._log(`Poll error: ${error.message}`);
            }
            
            // Schedule next poll
            if (this._isEnabled) {
                this._timer = setTimeout(poll, this._config.pollInterval);
            }
        };
        
        // Start immediately
        poll();
    }

    /**
     * Execute a single poll cycle via CDP
     * 
     * @returns {Promise<{executed: boolean, selector?: string, method?: string}>}
     */
    async poll() {
        if (!this.cdpHandler || typeof this.cdpHandler.getConnectionCount !== 'function' || this.cdpHandler.getConnectionCount() === 0) {
            return { executed: false };
        }

        if (this._isProcessing) {
            return { executed: false };
        }

        this._isProcessing = true;

        try {
            // Build and execute the evaluation script
            const script = this._buildEvaluationScript();
            const result = await this.cdpHandler.evaluate(script);
            
            if (result) {
                let parsed;
                try {
                    parsed = typeof result === 'string' ? JSON.parse(result) : result;
                } catch {
                    parsed = result;
                }
                
                if (parsed?.clicked) {
                    this._stats.totalClicks++;
                    this._stats.lastClickTime = Date.now();
                    
                    if (parsed.method === 'data-testid') {
                        this._stats.dataTestIdClicks++;
                    } else {
                        this._stats.textContentClicks++;
                    }
                    
                    this._log(`[Fallback] Clicked via CDP: ${parsed.selector} (${parsed.method})`);
                    
                    // Emit click event
                    this.emit('click', {
                        selector: parsed.selector,
                        method: parsed.method,
                        timestamp: this._stats.lastClickTime
                    });
                    
                    return { 
                        executed: true, 
                        selector: parsed.selector,
                        method: parsed.method
                    };
                }
            }
            
            return { executed: false };
        } catch (error) {
            this._stats.failedAttempts++;
            this._log(`[Fallback] CDP poll error: ${error.message}`);
            return { executed: false, error: error.message };
        } finally {
            this._isProcessing = false;
        }
    }

    /**
     * Build the evaluation script for CDP
     * This script runs in the browser context
     * Uses Utils.* functions from utils.js (exposed via UMD wrapper)
     * 
     * @returns {string}
     * @private
     */
    _buildEvaluationScript() {
        const testIdSelectors = JSON.stringify(TESTID_SELECTORS);
        const excludedTestIds = JSON.stringify(EXCLUDED_TESTIDS);
        // Build word-boundary regex strings for browser-side use.
        // Escaping: template literal → JS string → RegExp constructor.
        // \\\\b in template produces \\b in output string, which RegExp reads as \b (word boundary).
        const acceptRegexSrc = '\\\\b(' + ACCEPT_PATTERNS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')).join('|') + ')\\\\b';
        const rejectRegexSrc = '\\\\b(' + REJECT_PATTERNS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')).join('|') + ')\\\\b';
        
        return `
            (function() {
                const result = { clicked: false, selector: null, method: null };
                
                // Word-boundary regexes prevent false positives (e.g. "ok" matching "kokoro")
                const acceptRegex = new RegExp('${acceptRegexSrc}', 'i');
                const rejectRegex = new RegExp('${rejectRegexSrc}', 'i');
                
                const Utils = window.Utils || {
                    getDocuments: function getDocuments(root) {
                        let docs = [root];
                        try {
                            const isShadowRoot = root instanceof ShadowRoot;
                            if (root.shadowRoot) {
                                docs.push(...getDocuments(root.shadowRoot));
                            }
                            if (!isShadowRoot && root.querySelectorAll) {
                                const iframes = root.querySelectorAll('iframe, frame');
                                for (const iframe of iframes) {
                                    try {
                                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                                        if (iframeDoc) docs.push(...getDocuments(iframeDoc));
                                    } catch (e) { }
                                }
                            }
                            if (!isShadowRoot && root.querySelectorAll) {
                                const allElements = root.querySelectorAll('*');
                                for (const el of allElements) {
                                    if (el.shadowRoot) {
                                        docs.push(...getDocuments(el.shadowRoot));
                                    }
                                }
                            }
                        } catch (e) { }
                        return docs;
                    },
                    isElementVisible: function isElementVisible(el) {
                        if (!el || !el.isConnected) return false;
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        if (style.display === 'none') return false;
                        if (style.visibility === 'hidden') return false;
                        const opacity = parseFloat(style.opacity);
                        if (isNaN(opacity) || opacity <= 0.1) return false;
                        if (rect.width <= 0 || rect.height <= 0) return false;
                        return true;
                    },
                    isElementClickable: function isElementClickable(el) {
                        if (!el || !el.isConnected) return false;
                        const style = window.getComputedStyle(el);
                        if (style.pointerEvents === 'none') return false;
                        if (el.disabled) return false;
                        if (el.hasAttribute && el.hasAttribute('disabled')) return false;
                        return true;
                    }
                };
                
                function isVisible(el) {
                    return Utils.isElementVisible(el) && Utils.isElementClickable(el);
                }
                
                const docs = Utils.getDocuments(document);
                
                // Priority 1: Try data-testid selectors (i18n-safe)
                const testIdSelectors = ${testIdSelectors};
                const excludedTestIds = ${excludedTestIds};
                
                for (const doc of docs) {
                    for (const testId of testIdSelectors) {
                        if (excludedTestIds.includes(testId)) continue;
                        
                        try {
                            const elements = doc.querySelectorAll(\`[data-testid="\${testId}"]\`);
                            for (const el of elements) {
                                if (isVisible(el)) {
                                    el.click();
                                    
                                    result.clicked = true;
                                    result.selector = \`[data-testid="\${testId}"]\`;
                                    result.method = 'data-testid';
                                    
                                    if (window.__autoAcceptState?.stats) {
                                        window.__autoAcceptState.stats.clicksThisSession = 
                                            (window.__autoAcceptState.stats.clicksThisSession || 0) + 1;
                                    }
                                    
                                    return JSON.stringify(result);
                                }
                            }
                        } catch (e) { }
                    }
                }
                
                // Priority 2: Text content matching with WORD-BOUNDARY regex
                // Normalize camelCase boundaries before matching (e.g., "RunAlt" → "Run Alt")
                function normalizeText(t) { return t.replace(/([a-z])([A-Z])/g, '$1 $2'); }
                
                for (const doc of docs) {
                    try {
                        const buttons = doc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
                        for (const el of buttons) {
                            if (!isVisible(el)) continue;
                            
                            const rawText = (el.textContent || el.value || '').trim();
                            if (rawText.length === 0 || rawText.length > 50) continue;
                            const text = normalizeText(rawText);
                            
                            // Skip if matches reject patterns (word-boundary)
                            if (rejectRegex.test(text)) continue;
                            
                            // Check if matches accept patterns (word-boundary)
                            if (acceptRegex.test(text)) {
                                // Safety check for banned commands
                                if (typeof window.__autoAcceptState?.bannedCommands !== 'undefined') {
                                    const banned = window.__autoAcceptState.bannedCommands || [];
                                    let isBanned = false;
                                    for (const pattern of banned) {
                                        try {
                                            if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                                                const lastSlash = pattern.lastIndexOf('/');
                                                const regex = new RegExp(
                                                    pattern.substring(1, lastSlash),
                                                    pattern.substring(lastSlash + 1) || 'i'
                                                );
                                                if (regex.test(text)) {
                                                    isBanned = true;
                                                    break;
                                                }
                                            } else if (text.toLowerCase().includes(pattern.toLowerCase())) {
                                                isBanned = true;
                                                break;
                                            }
                                        } catch (e) { }
                                    }
                                    if (isBanned) continue;
                                }
                                
                                el.click();
                                
                                result.clicked = true;
                                result.selector = text.substring(0, 30).toLowerCase();
                                result.method = 'text-content';
                                
                                if (window.__autoAcceptState?.stats) {
                                    window.__autoAcceptState.stats.clicksThisSession = 
                                        (window.__autoAcceptState.stats.clicksThisSession || 0) + 1;
                                }
                                
                                return JSON.stringify(result);
                            }
                        }
                    } catch (e) { }
                }
                
                return JSON.stringify(result);
            })()
        `;
    }

    /**
     * Update polling interval
     * 
     * @param {number} intervalMs - New polling interval in milliseconds
     * @returns {void}
     */
    setPollInterval(intervalMs) {
        if (typeof intervalMs === 'number' && intervalMs > 0) {
            this._config.pollInterval = intervalMs;
            this._log(`Poll interval updated to ${intervalMs}ms`);
            
            // Restart polling if running
            if (this._isEnabled) {
                if (this._timer) {
                    clearTimeout(this._timer);
                }
                this._startPolling();
            }
        }
    }

    /**
     * Enable or disable data-testid selector usage
     * 
     * @param {boolean} enabled - Whether to use data-testid selectors
     * @returns {void}
     */
    setUseDataTestId(enabled) {
        this._config.useDataTestId = enabled;
        this._log(`data-testid selectors ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Update the CDP handler reference
     * 
     * @param {object} cdpHandler - New CDP handler instance
     * @returns {void}
     */
    setCDPHandler(cdpHandler) {
        this.cdpHandler = cdpHandler;
        this._log('CDP handler updated');
    }

    /**
     * Reset all statistics
     * 
     * @returns {void}
     */
    resetStats() {
        this._stats = {
            totalClicks: 0,
            dataTestIdClicks: 0,
            textContentClicks: 0,
            failedAttempts: 0,
            lastClickTime: null,
            startTime: this._isEnabled ? Date.now() : null
        };
        
        this._log('Statistics reset');
    }

    /**
     * Dispose of all resources
     * 
     * @returns {void}
     */
    dispose() {
        this.stop();
        this.cdpHandler = null;
        this.removeAllListeners();
        this._log('CDPStrategy disposed');
    }

}

// Export module
module.exports = {
    CDPStrategy,
    TESTID_SELECTORS,
    EXCLUDED_TESTIDS,
    DEFAULT_CONFIG
};
