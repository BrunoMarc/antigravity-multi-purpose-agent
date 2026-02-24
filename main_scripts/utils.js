(function (exports) {
    'use strict';

    const MIN_OPACITY_THRESHOLD = 0.1;

    function getWindow(el, win) {
        return win || (el.ownerDocument ? el.ownerDocument.defaultView : null) || window;
    }

    exports.assert = function assert(condition, message) {
        if (!condition) {
            throw new Error(message || "Assertion failed")
        }
    };

    exports.getIDEName = function getIDEName() {
        // Node side detection (only if vscode module is available)
        if (typeof require === 'function') {
            try {
                const vscode = require('vscode');
                if (vscode && vscode.env) {
                    const appName = vscode.env.appName || '';
                    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
                }
            } catch (e) {
                // vscode module not available
            }
        }
        // Browser side detection
        if (typeof document !== 'undefined') {
            const title = document.title.toLowerCase();
            if (title.includes('antigravity') || !!document.getElementById('antigravity.agentPanel')) return 'Antigravity';
        }
        return 'Antigravity';
    };

    exports.updateTabNames = function updateTabNames(tabs) {
        if (!tabs || tabs.length === 0) return

        const rawNames = Array.from(tabs).map(tab => exports.stripTimeSuffix(tab.textContent));
        const tabNames = exports.deduplicateNames(rawNames);

        // Only update if the content actually changed to save resources
        const currentState = window.__autoAcceptState
        if (currentState && JSON.stringify(currentState.tabNames) === JSON.stringify(tabNames)) {
            return
        }

        window.__autoAcceptState = {
            ...window.__autoAcceptState,
            tabNames: tabNames,
            lastUpdated: Date.now()
        }
    };

    /**
     * Strip time suffix from tab name (e.g., "3m", "4h", "12s")
     * @param {string} text - Text to strip suffix from
     * @returns {string} Text with time suffix removed
     */
    exports.stripTimeSuffix = function stripTimeSuffix(text) {
        return (text || '').trim().replace(/\s*\d+[smh]$/, '').trim();
    };

    /**
     * Deduplicate tab names by appending (2), (3), etc. for duplicates
     * @param {string[]} names - Array of tab names
     * @returns {string[]} Array of deduplicated names
     */
    exports.deduplicateNames = function deduplicateNames(names) {
        const counts = {};
        return names.map(name => {
            if (counts[name] === undefined) {
                counts[name] = 1;
                return name;
            } else {
                counts[name]++;
                return `${name} (${counts[name]})`;
            }
        });
    };

    /**
     * Recursively find all accessible documents including:
     * - Main document
     * - Shadow DOM of root document
     * - Iframes and their documents
     * - Elements with Shadow DOM
     * 
     * @param {Document|ShadowRoot} root - Root document or shadow root to start from
     * @returns {Array} Array of accessible documents
     */
    exports.getDocuments = function getDocuments(root = document) {
        let docs = [root];
        try {
            // Handle Document or ShadowRoot
            const isShadowRoot = root instanceof ShadowRoot;
            
            // Traverse Shadow DOM of the root itself
            if (root.shadowRoot) {
                docs.push(...exports.getDocuments(root.shadowRoot));
            }
            
            // Traverse iframes (only for Document nodes, not ShadowRoots)
            if (!isShadowRoot && root.querySelectorAll) {
                const iframes = root.querySelectorAll('iframe, frame');
                for (const iframe of iframes) {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (iframeDoc) {
                            docs.push(...exports.getDocuments(iframeDoc));
                        }
                    } catch (e) {
                        // Cross-origin iframe - skip
                    }
                }
            }
            
            // Traverse elements with Shadow DOM (only for Document nodes, not ShadowRoots)
            if (!isShadowRoot && root.querySelectorAll) {
                const allElements = root.querySelectorAll('*');
                for (const el of allElements) {
                    if (el.shadowRoot) {
                        docs.push(...exports.getDocuments(el.shadowRoot));
                    }
                }
            }
        } catch (e) {
            // Ignore errors (e.g., detached nodes)
        }
        return docs;
    };

    /**
     * Query all matching elements across all accessible documents.
     * Uses the enhanced getDocuments() which handles Shadow DOM.
     * 
     * @param {string} selector - CSS selector to query
     * @param {Document|ShadowRoot} root - Optional root document (defaults to document)
     * @returns {Array} Array of matched elements
     */
    exports.queryAll = function queryAll(selector, root = document) {
        const docs = exports.getDocuments(root);
        let results = [];
        for (const doc of docs) {
            try {
                if (doc.querySelectorAll) {
                    results.push(...Array.from(doc.querySelectorAll(selector)));
                }
            } catch (e) {
                // Ignore errors (e.g., detached documents)
            }
        }
        return results;
    };

    /**
     * Query all matching elements within a specific root document.
     * Alias for queryAll(selector, root) for backwards compatibility.
     * 
     * @param {Document|ShadowRoot} root - Root document to query within
     * @param {string} selector - CSS selector to query
     * @returns {Array} Array of matched elements
     */
    exports.queryAllWithin = function queryAllWithin(root, selector) {
        return exports.queryAll(selector, root);
    };

    /**
     * Check if an element is visible in the viewport.
     * Standardized visibility check that handles:
     * - display !== 'none'
     * - visibility !== 'hidden'
     * - opacity > 0.1
     * - dimensions > 0
     * - pointerEvents !== 'none'
     * - disabled state
     * 
     * @param {Element} el - Element to check
     * @param {Window} [win] - Optional window object (defaults to global)
     * @returns {boolean} True if element is visible
     */
    exports.isElementVisible = function isElementVisible(el, win) {
        if (!el || !el.isConnected) return false;
        
        const w = getWindow(el, win);
        const style = w.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        
        // Check display
        if (style.display === 'none') return false;
        
        // Check visibility
        if (style.visibility === 'hidden') return false;
        
        // Check opacity (standardized threshold)
        const opacity = parseFloat(style.opacity);
        if (isNaN(opacity) || opacity <= MIN_OPACITY_THRESHOLD) return false;
        
        // Check dimensions
        if (rect.width <= 0 || rect.height <= 0) return false;
        
        return true;
    };

    /**
     * Check if an element is clickable (can receive pointer events and is not disabled).
     * 
     * @param {Element} el - Element to check
     * @param {Window} [win] - Optional window object (defaults to global)
     * @returns {boolean} True if element is clickable
     */
    exports.isElementClickable = function isElementClickable(el, win) {
        if (!el || !el.isConnected) return false;
        
        const w = getWindow(el, win);
        const style = w.getComputedStyle(el);
        
        // Check pointer events
        if (style.pointerEvents === 'none') return false;
        
        // Check disabled state
        if (el.disabled) return false;
        if (el.hasAttribute && el.hasAttribute('disabled')) return false;
        
        return true;
    };

    /**
     * Combined visibility and clickability check.
     * 
     * @param {Element} el - Element to check
     * @param {Window} [win] - Optional window object (defaults to global)
     * @returns {boolean} True if element is both visible and clickable
     */
    exports.isElementVisibleAndClickable = function isElementVisibleAndClickable(el, win) {
        return exports.isElementVisible(el, win) && exports.isElementClickable(el, win);
    };

    /**
     * Standard accept button text patterns (lowercase, for matching)
     * @type {string[]}
     */
    exports.ACCEPT_PATTERNS = ['accept', 'allow', 'continue', 'proceed', 'apply', 'confirm', 'yes', 'ok', 'save', 'run', 'keep'];

    /**
     * Standard reject button text patterns (lowercase, for matching)
     * @type {string[]}
     */
    exports.REJECT_PATTERNS = ['reject', 'cancel', 'discard', 'deny', 'skip', 'close', 'no', 'delete'];

    /**
     * Accept button data-testid selector patterns
     * Used for CDP-based element detection
     * @type {string[]}
     */
    exports.ACCEPT_TESTID_SELECTORS = [
        'allow',
        'accept',
        'continue',
        'proceed',
        'accept-button',
        'accept-all-button',
        'apply-button',
        'confirm-button',
        'yes',
        'ok',
        'save'
    ];

    /**
     * Reject button data-testid selector patterns (excluded from auto-click)
     * Used for CDP-based element detection
     * @type {string[]}
     */
    exports.REJECT_TESTID_SELECTORS = [
        'reject-button',
        'cancel-button',
        'discard-button',
        'close-button',
        'deny-button',
        'skip-button',
        'reject',
        'cancel',
        'discard',
        'deny',
        'no'
    ];

    /**
     * Legacy accept button selectors (exact match patterns for auto_accept.js)
     * Format: { pattern: string, exact: boolean }
     * @type {Array<{pattern: string, exact: boolean}>}
     */
    exports.ACCEPT_BUTTON_SELECTORS = [
        { pattern: 'accept', exact: false },
        { pattern: 'accept all', exact: false },
        { pattern: 'acceptalt', exact: false },
        { pattern: 'run command', exact: false },
        { pattern: 'run', exact: false },
        { pattern: 'run code', exact: false },
        { pattern: 'run cell', exact: false },
        { pattern: 'run all', exact: false },
        { pattern: 'run selection', exact: false },
        { pattern: 'run and debug', exact: false },
        { pattern: 'run test', exact: false },
        { pattern: 'apply', exact: true },
        { pattern: 'execute', exact: true },
        { pattern: 'resume', exact: true },
        { pattern: 'retry', exact: true },
        { pattern: 'try again', exact: false },
        { pattern: 'confirm', exact: false },
        { pattern: 'Allow Once', exact: true }
    ];

    /**
     * Legacy reject button selectors (for auto_accept.js)
     * @type {string[]}
     */
    exports.REJECT_BUTTON_SELECTORS = ['skip', 'reject', 'cancel', 'discard', 'deny', 'close', 'refine', 'other'];

    /**
     * Build a single regex that matches any of the given patterns using word boundaries.
     * Cached for performance — call once per pattern list.
     * @param {string[]} patterns - Patterns to compile
     * @returns {RegExp}
     */
    exports.buildWordBoundaryRegex = function buildWordBoundaryRegex(patterns) {
        var escaped = patterns.map(function(p) {
            return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        });
        return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i');
    };

    /**
     * Normalize button text for pattern matching.
     * Inserts spaces at camelCase boundaries so that "RunAlt+\u21B5" becomes "Run Alt+\u21B5".
     * This ensures word-boundary regex \b correctly matches "Run" in "RunAlt".
     * @param {string} text - Raw button text
     * @returns {string} Normalized text
     */
    exports.normalizeButtonText = function normalizeButtonText(text) {
        if (!text) return '';
        return text.replace(/([a-z])([A-Z])/g, '$1 $2');
    };

    // Pre-compiled regexes for accept/reject pattern matching (word-boundary)
    var _acceptRegex = exports.buildWordBoundaryRegex(exports.ACCEPT_PATTERNS);
    var _rejectRegex = exports.buildWordBoundaryRegex(exports.REJECT_PATTERNS);

    /**
     * Test if text matches any pattern using word-boundary matching.
     * Prevents false positives like "ok" matching "kokoro" or "token".
     * @param {string} text - Text to test
     * @param {string[]} patterns - Patterns to match
     * @returns {boolean}
     */
    exports.matchesPatternWord = function matchesPatternWord(text, patterns) {
        if (!text || !patterns || patterns.length === 0) return false;
        var regex = exports.buildWordBoundaryRegex(patterns);
        return regex.test(text);
    };

    /**
     * Check if text matches any accept pattern (word-boundary matching)
     * @param {string} text - Text to check
     * @returns {boolean} True if text contains any accept pattern as a whole word
     */
    exports.matchesAcceptPattern = function matchesAcceptPattern(text) {
        if (!text) return false;
        var normalized = exports.normalizeButtonText(text).toLowerCase().trim();
        return _acceptRegex.test(normalized);
    };

    /**
     * Check if text matches any reject pattern
     * @param {string} text - Text to check
     * @returns {{matches: boolean, pattern?: string}} Object with match status and matched pattern
     */
    exports.matchesRejectPattern = function matchesRejectPattern(text) {
        if (!text) return { matches: false };
        var normalized = exports.normalizeButtonText(text).toLowerCase().trim();
        if (!_rejectRegex.test(normalized)) return { matches: false };
        for (var i = 0; i < exports.REJECT_PATTERNS.length; i++) {
            var p = exports.REJECT_PATTERNS[i];
            var rx = new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            if (rx.test(normalized)) {
                return { matches: true, pattern: p };
            }
        }
        return { matches: false };
    };

    /**
     * Check if a testid matches any accept testid selector
     * @param {string} testId - Test ID to check
     * @returns {boolean} True if testId matches any accept pattern
     */
    exports.matchesAcceptTestId = function matchesAcceptTestId(testId) {
        if (!testId) return false;
        var lowerTestId = testId.toLowerCase().trim();
        return exports.ACCEPT_TESTID_SELECTORS.some(function(p) { return lowerTestId.includes(p); });
    };

    /**
     * Check if a testid matches any reject testid selector
     * @param {string} testId - Test ID to check
     * @returns {boolean} True if testId matches any reject pattern
     */
    exports.matchesRejectTestId = function matchesRejectTestId(testId) {
        if (!testId) return false;
        var lowerTestId = testId.toLowerCase().trim();
        return exports.REJECT_TESTID_SELECTORS.some(function(p) { return lowerTestId.includes(p); });
    };

    /**
     * Check if legacy accept button selector matches
     * @param {string} text - Text to check
     * @returns {boolean} True if text matches legacy accept pattern
     */
    exports.matchesLegacyAcceptPattern = function matchesLegacyAcceptPattern(text) {
        if (!text) return false;
        var lowerText = text.toLowerCase().trim();
        return exports.ACCEPT_BUTTON_SELECTORS.some(function(p) { 
            return p.exact ? lowerText === p.pattern : lowerText.includes(p.pattern);
        });
    };

    /**
     * Check if legacy reject button selector matches
     * @param {string} text - Text to check
     * @returns {boolean} True if text matches legacy reject pattern
     */
    exports.matchesLegacyRejectPattern = function matchesLegacyRejectPattern(text) {
        if (!text) return false;
        var lowerText = text.toLowerCase().trim();
        return exports.REJECT_BUTTON_SELECTORS.some(function(p) { return lowerText.includes(p); });
    };

    /**
     * Find the latest CDP log file in a directory.
     * Searches for files matching pattern 'multi-purpose-cdp-*.log' and returns the most recently modified one.
     * 
     * @param {string} directory - Directory path to search for log files
     * @param {Object} [options] - Optional settings
     * @param {boolean} [options.generateIfNotFound=false] - If true, generates a new log file path when no files exist
     * @returns {string|null} Full path to the latest log file, or null if not found (when generateIfNotFound is false)
     */
    exports.getLatestCdpLogPath = function getLatestCdpLogPath(directory, options) {
        var fs, path;
        
        // Only works in Node.js environment
        if (typeof require !== 'function') {
            return null;
        }
        
        try {
            fs = require('fs');
            path = require('path');
        } catch (e) {
            return null;
        }
        
        var generateIfNotFound = options && options.generateIfNotFound === true;
        
        /**
         * Generate a new log file path with timestamp suffix
         * @returns {string} Generated log file path
         */
        function generateNewLogPath() {
            var d = new Date();
            var pad2 = function(n) { return String(n).padStart(2, '0'); };
            var suffix = pad2(d.getMinutes()) + pad2(d.getHours()) + '-' + 
                         pad2(d.getDate()) + pad2(d.getMonth() + 1) + pad2(d.getFullYear() % 100);
            return path.join(directory, 'multi-purpose-cdp-' + suffix + '.log');
        }
        
        try {
            var entries = fs.readdirSync(directory);
            var candidates = entries
                .filter(function(name) { return name.startsWith('multi-purpose-cdp-') && name.endsWith('.log'); })
                .map(function(name) { return path.join(directory, name); })
                .filter(function(p) { return fs.existsSync(p); });
            
            if (candidates.length === 0) {
                return generateIfNotFound ? generateNewLogPath() : null;
            }
            
            var best = candidates[0];
            var bestMtime = 0;
            for (var i = 0; i < candidates.length; i++) {
                var p = candidates[i];
                try {
                    var stat = fs.statSync(p);
                    var mtime = stat.mtimeMs || 0;
                    if (mtime >= bestMtime) {
                        bestMtime = mtime;
                        best = p;
                    }
                } catch (e) {
                    // Ignore stat errors
                }
            }
            return best;
        } catch (e) {
            return generateIfNotFound ? generateNewLogPath() : null;
        }
    };
// UMD (Universal Module Definition) wrapper
// Supports: CommonJS (Node.js), browser global (window.Utils)
//
// Environment detection:
// 1. CommonJS (Node.js): 'exports' object exists -> use it directly
// 2. Browser: create window.Utils global object
// 3. Fallback: empty object (defensive, shouldn't happen in practice)
})(
    typeof exports === 'object' && exports !== null
        ? exports  // CommonJS environment
        : typeof window !== 'undefined'
            ? (window.Utils = window.Utils || {})  // Browser: create or reuse window.Utils
            : {}  // Fallback
);

// CommonJS module.exports support for require() in Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
}
