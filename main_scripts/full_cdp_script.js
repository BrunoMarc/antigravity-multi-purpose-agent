/**
 * FULL CDP CORE BUNDLE
 * Monolithic script for browser-side injection.
 * Combines utils, analytics, auto-accept, and lifecycle management.
 */
(function () {
    "use strict";

    // Guard: Bail out immediately if not in a browser context (e.g., service worker)
    if (typeof window === 'undefined') return;

    // ============================================================
    // ANALYTICS MODULE (Standalone - loaded from external module)
    // See: main_scripts/analytics/ for the analytics module source
    // The standalone module is loaded BEFORE this script in the injection chain
    // We access it via window.Analytics or Analytics global
    // ============================================================

    // Get Analytics from standalone module (loaded before this script)
    const Analytics = (typeof window !== 'undefined' && window.Analytics) 
        ? window.Analytics 
        : (typeof Analytics !== 'undefined' ? Analytics : null);

    // Get Utils from standalone module (loaded before this script)
    const Utils = (typeof window !== 'undefined' && window.Utils) 
        ? window.Utils 
        : (typeof Utils !== 'undefined' ? Utils : null);

    // --- LOGGING ---
    const log = (msg) => {
        // Simple log for CDP interception
        console.log(`[AutoAccept] ${msg}`);
    };

    // Initialize Analytics
    Analytics.initialize(log);

    // --- CENTRALIZED ACCEPT/REJECT PATTERNS ---
    // Use patterns from Utils module (loaded before this script)
    var CENTRALIZED_ACCEPT_PATTERNS = (Utils && Utils.ACCEPT_PATTERNS)
        ? Utils.ACCEPT_PATTERNS
        : ['accept', 'allow', 'continue', 'proceed', 'apply', 'confirm', 'yes', 'ok', 'save'];

    // Pre-compiled word-boundary regex for accept/reject matching (prevents false positives)
    var ACCEPT_WORD_REGEX = (Utils && Utils.buildWordBoundaryRegex)
        ? Utils.buildWordBoundaryRegex(CENTRALIZED_ACCEPT_PATTERNS)
        : new RegExp('\\b(' + CENTRALIZED_ACCEPT_PATTERNS.join('|') + ')\\b', 'i');
    var REJECT_WORD_REGEX = (Utils && Utils.REJECT_PATTERNS && Utils.buildWordBoundaryRegex)
        ? Utils.buildWordBoundaryRegex(Utils.REJECT_PATTERNS)
        : new RegExp('\\b(reject|cancel|discard|deny|skip|close|no|delete)\\b', 'i');

    // CamelCase normalization: "RunAlt+↵" → "Run Alt+↵" for proper word-boundary matching
    var normalizeButtonText = (Utils && Utils.normalizeButtonText)
        ? Utils.normalizeButtonText
        : function(text) { return text ? text.replace(/([a-z])([A-Z])/g, '$1 $2') : ''; };

    // --- 1. UTILS ---
    // Use Utils functions from standalone module (loaded before this script)
    const getDocuments = Utils.getDocuments;
    const queryAll = Utils.queryAll;
    const stripTimeSuffix = Utils.stripTimeSuffix;
    const deduplicateNames = Utils.deduplicateNames;

    const updateTabNames = (tabs) => {
        const rawNames = Array.from(tabs).map(tab => stripTimeSuffix(tab.textContent));
        const tabNames = deduplicateNames(rawNames);

        if (JSON.stringify(window.__autoAcceptState.tabNames) !== JSON.stringify(tabNames)) {
            log(`updateTabNames: Detected ${tabNames.length} tabs: ${tabNames.join(', ')}`);
            window.__autoAcceptState.tabNames = tabNames;
        }
    };

    // --- 2. BANNED COMMAND DETECTION ---
    /**
     * Traverses the parent containers and their siblings to find the command text being executed.
     * Based on Antigravity DOM structure: the command is in a PRE/CODE block that's a sibling
     * of the button's parent/grandparent container.
     * 
     * DOM Structure (Antigravity):
     *   <div> (grandparent: flex w-full...)
     *     <p>Run command?</p>
     *     <div> (parent: ml-auto flex...)
     *       <button>Reject</button>
     *       <button>Accept</button>  <-- we start here
     *     </div>
     *   </div>
     *   
     * The command text is in a PRE block that's a previous sibling of the grandparent.
     */
    function findNearbyCommandText(el) {
        const commandSelectors = ['pre', 'code', 'pre code'];
        let commandText = '';

        // Strategy 1: Walk up to find parent containers, then search their previous siblings
        // This matches the actual Antigravity DOM where PRE blocks are siblings of the button's ancestor
        let container = el.parentElement;
        let depth = 0;
        const maxDepth = 10; // Walk up to 10 levels

        while (container && depth < maxDepth) {
            // Search previous siblings of this container for PRE/CODE blocks
            let sibling = container.previousElementSibling;
            let siblingCount = 0;

            while (sibling && siblingCount < 5) {
                // Check if sibling itself is a PRE/CODE
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    const text = sibling.textContent.trim();
                    if (text.length > 0) {
                        commandText += ' ' + text;
                        log(`[BannedCmd] Found <${sibling.tagName}> sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                    }
                }

                // Check children of sibling for PRE/CODE
                for (const selector of commandSelectors) {
                    const codeElements = sibling.querySelectorAll(selector);
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            const text = codeEl.textContent.trim();
                            if (text.length > 0 && text.length < 5000) {
                                commandText += ' ' + text;
                                log(`[BannedCmd] Found <${selector}> in sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                            }
                        }
                    }
                }

                sibling = sibling.previousElementSibling;
                siblingCount++;
            }

            // If we found command text, we're done
            if (commandText.length > 10) {
                break;
            }

            container = container.parentElement;
            depth++;
        }

        // Strategy 2: Fallback - check immediate button siblings
        if (commandText.length === 0) {
            let btnSibling = el.previousElementSibling;
            let count = 0;
            while (btnSibling && count < 3) {
                for (const selector of commandSelectors) {
                    const codeElements = btnSibling.querySelectorAll ? btnSibling.querySelectorAll(selector) : [];
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            commandText += ' ' + codeEl.textContent.trim();
                        }
                    }
                }
                btnSibling = btnSibling.previousElementSibling;
                count++;
            }
        }

        // Strategy 3: Check aria-label and title attributes
        if (el.getAttribute('aria-label')) {
            commandText += ' ' + el.getAttribute('aria-label');
        }
        if (el.getAttribute('title')) {
            commandText += ' ' + el.getAttribute('title');
        }

        const result = commandText.trim().toLowerCase();
        if (result.length > 0) {
            log(`[BannedCmd] Extracted command text (${result.length} chars): "${result.substring(0, 150)}..."`);
        }
        return result;
    }

    /**
     * Check if a command is banned based on user-defined patterns.
     * Supports both literal substring matching and regex patterns.
     * 
     * Pattern format (line by line in settings):
     *   - Plain text: matches as literal substring (case-insensitive)
     *   - /pattern/: treated as regex (e.g., /rm\s+-rf/ matches "rm -rf")
     * 
     * @param {string} commandText - The extracted command text to check
     * @returns {boolean} True if command matches any banned pattern
     */
    function isCommandBanned(commandText, element) {
        // If we already logged this element as blocked, return true to skip clicking,
        // but DO NOT track stats again to prevent infinite loop.
        if (element && element.dataset.autoAcceptBlocked) {
            return true;
        }

        const state = window.__autoAcceptState;
        const bannedList = state.bannedCommands || [];

        if (bannedList.length === 0) return false;
        if (!commandText || commandText.length === 0) return false;

        const lowerText = commandText.toLowerCase();

        for (const banned of bannedList) {
            const pattern = banned.trim();
            if (!pattern || pattern.length === 0) continue;

            try {
                // Check if pattern is a regex (starts and ends with /)
                let isMatch = false;
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    const lastSlash = pattern.lastIndexOf('/');
                    const regexPattern = pattern.substring(1, lastSlash);
                    const flags = pattern.substring(lastSlash + 1) || 'i';
                    const regex = new RegExp(regexPattern, flags);
                    if (regex.test(commandText)) {
                        log(`[BANNED] Command blocked by regex: /${regexPattern}/${flags}`);
                        isMatch = true;
                    }
                } else {
                    const lowerPattern = pattern.toLowerCase();
                    if (lowerText.includes(lowerPattern)) {
                        log(`[BANNED] Command blocked by pattern: "${pattern}"`);
                        isMatch = true;
                    }
                }

                if (isMatch) {
                    Analytics.trackBlocked(log);
                    // Mark element so we don't count it again
                    if (element) {
                        element.dataset.autoAcceptBlocked = 'true';
                    }
                    return true;
                }
            } catch (e) {
                // Fallback
                if (lowerText.includes(pattern.toLowerCase())) {
                    log(`[BANNED] Command blocked by pattern (fallback): "${pattern}"`);
                    Analytics.trackBlocked(log);
                    if (element) element.dataset.autoAcceptBlocked = 'true';
                    return true;
                }
            }
        }
        return false;
    }

    // --- 4. CLICKING LOGIC ---
    // data-testid selectors for i18n-safe targeting (priority order)
    const TESTID_ACCEPT_SELECTORS = [
        'allow',
        'accept',
        'continue',
        'proceed',
        'accept-button',
        'accept-all-button',
        'apply-button',
        'confirm-button'
    ];

    // Excluded testid selectors (reject/cancel actions)
    const TESTID_EXCLUDED_SELECTORS = [
        'reject',
        'cancel',
        'discard',
        'deny',
        'reject-button',
        'cancel-button',
        'discard-button',
        'deny-button'
    ];

    /**
     * Check if element matches a data-testid accept selector
     * @param {Element} el - Element to check
     * @returns {{isMatch: boolean, testId: string|null}}
     */
    function checkTestIdSelector(el) {
        const testId = el.getAttribute('data-testid');
        if (!testId) return { isMatch: false, testId: null };
        
        // Check if it's an excluded testId
        if (TESTID_EXCLUDED_SELECTORS.includes(testId.toLowerCase())) {
            return { isMatch: false, testId: testId };
        }
        
        // Check if it's an accept testId
        if (TESTID_ACCEPT_SELECTORS.includes(testId.toLowerCase())) {
            return { isMatch: true, testId: testId };
        }
        
        return { isMatch: false, testId: null };
    }

    function isPotentialCommandTestId(testId) {
        const tid = String(testId || '').toLowerCase();
        return tid.includes('run') || tid.includes('execute') || tid.includes('terminal') || tid.includes('command');
    }

    function isAcceptButton(el) {
        // Never click anchor links — they navigate away and cause infinite loops
        if (el.tagName === 'A' && el.hasAttribute('href')) return false;

        // Priority 1: Check data-testid attribute (i18n-safe)
        const testIdResult = checkTestIdSelector(el);
        if (testIdResult.isMatch) {
            // Verify element is visible and interactive
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display !== 'none' && rect.width > 0 && style.pointerEvents !== 'none' && !el.disabled) {
                log(`[TestId] Found accept button with data-testid="${testIdResult.testId}"`);
                return true;
            }
        }
        
        // Priority 2: Word-boundary text content matching using centralized patterns
        const rawText = (el.textContent || "").trim();
        if (rawText.length === 0 || rawText.length > 50) return false;
        const text = normalizeButtonText(rawText).toLowerCase();
        // Word-boundary matching prevents false positives (e.g. "ok" matching "kokoro")
        if (REJECT_WORD_REGEX.test(text)) return false;
        if (!ACCEPT_WORD_REGEX.test(text)) return false;

        // Check if this is a command execution button by looking for "run command" or similar
        const isCommandButton = text.includes('run command') || text.includes('execute') || text.includes('run');

        // If it's a command button, check if the command is banned
        if (isCommandButton) {
            const nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText, el)) {
                log(`[BANNED] Skipping button: "${text}" - command is banned`);
                return false;
            }
        }

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const MIN_OPACITY_THRESHOLD = 0.1;
        const opacity = parseFloat(style.opacity);
        return style.display !== 'none' && 
               style.visibility !== 'hidden' &&
               (isNaN(opacity) || opacity > MIN_OPACITY_THRESHOLD) &&
               rect.width > 0 && 
               rect.height > 0 &&
               style.pointerEvents !== 'none' && 
               !el.disabled;
    }

    /**
     * Check if an element is still visible in the DOM.
     * Uses standardized visibility checks (matches utils.js isElementVisible)
     * @param {Element} el - Element to check
     * @returns {boolean} True if element is visible
     */
    // Use Utils function from standalone module (loaded before this script)
    const isElementVisible = Utils.isElementVisible;

    // ============================================================
    // DOM ACTIVITY TRACKING
    // MutationObserver-based tracking for more accurate silence detection
    // ============================================================

    /**
     * Start DOM activity tracking with MutationObserver.
     * @param {Element} rootEl - Root element to observe
     */
    function startDomActivityTracking(rootEl) {
        const state = window.__autoAcceptState;
        if (!state) return;

        if (state.domActivityObserver) {
            state.domActivityObserver.disconnect();
        }

        let last = 0;
        state.domActivityObserver = new MutationObserver(() => {
            const now = Date.now();
            // Throttle to max 1 update per second
            if (now - last < 1000) return;
            last = now;

            state.lastDomActivityTime = now;

            // Also update analytics
            if (typeof Analytics !== 'undefined' && Analytics.markDomActivity) {
                Analytics.markDomActivity(now, log);
            }

            log('[DOM Activity] Mutation detected at', now);
        });

        // Observe the entire document for changes
        state.domActivityObserver.observe(rootEl, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'disabled', 'aria-busy', 'aria-disabled']
        });

        log('[DOM Activity] Observer started');
    }

    /**
     * Stop DOM activity tracking.
     */
    function stopDomActivityTracking() {
        const state = window.__autoAcceptState;
        if (state && state.domActivityObserver) {
            state.domActivityObserver.disconnect();
            state.domActivityObserver = null;
            log('[DOM Activity] Observer stopped');
        }
    }

    /**
     * Get DOM activity info.
     * @returns {Object} DOM activity information
     */
    function getDomActivityInfo() {
        const state = window.__autoAcceptState;
        const lastActivity = state?.lastDomActivityTime || 0;
        return {
            lastDomActivityTime: lastActivity,
            msSinceLastActivity: lastActivity ? Date.now() - lastActivity : -1,
            isTracking: state?.domActivityObserver !== null,
            ts: Date.now()
        };
    }

    /**
     * Detect if AI is working (generating response).
     * @param {Element} rootEl - Root element to search
     * @returns {boolean} True if AI appears to be working
     */
    function detectConversationWorking(rootEl) {
        // Check 1: animate-markdown class — Antigravity's primary busy signal.
        // Present on <P> elements while AI is actively streaming text, removed when done.
        const animating = rootEl.querySelectorAll('.animate-markdown');
        if (animating && animating.length > 0) {
            return true;
        }

        // Check 2: aria-busy="true"
        const busyEl = rootEl.querySelector('[aria-busy="true"]');
        if (busyEl) {
            return true;
        }

        // Check 3: Stop/Cancel buttons
        const stopButtons = rootEl.querySelectorAll('button');
        for (const btn of stopButtons) {
            const directText = Array.from(btn.childNodes)
                .filter(n => n.nodeType === 3)
                .map(n => n.textContent.trim().toLowerCase())
                .join(' ');
            const labelText = (directText || (btn.getAttribute('aria-label') || '').toLowerCase());
            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            if (labelText.length > 0 && labelText.length < 30 &&
                (labelText === 'stop' || labelText === 'cancel' || labelText === 'stop generating' ||
                 testId === 'stop' || testId === 'cancel' || testId === 'stop-generating')) {
                if (isElementVisible(btn)) {
                    return true;
                }
            }
        }

        // Check 4: Loading/spinner indicators (only inside agent panel, not document-wide)
        if (rootEl !== document && rootEl !== document.body) {
            const loadingIndicators = rootEl.querySelectorAll('[class*="loading"], [class*="spinner"]');
            for (const indicator of loadingIndicators) {
                if (isElementVisible(indicator)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Get a snapshot of the conversation state for external comparison.
     * The scheduler uses this to detect when AI starts/stops responding.
     */
    window.__autoAcceptGetConversationSnapshot = function () {
        try {
            const panel = getAntigravityAgentPanelRoot();
            // Use panel if found; fall back to document.body (not document, which has no innerText)
            const root = panel || document.body;
            const text = root.innerText || '';
            // Use #conversation for accurate message area text, if available
            const conv = document.getElementById('conversation');
            const convText = conv ? (conv.innerText || '') : text;
            const busy = detectConversationWorking(panel || root);
            return {
                textLength: convText.length,
                messageCount: 0,
                busy: busy,
                ts: Date.now()
            };
        } catch (e) {
            return { textLength: 0, messageCount: 0, busy: false, ts: Date.now(), error: e.message };
        }
    };

    window.__autoAcceptIsConversationWorking = function () {
        try {
            const panel = getAntigravityAgentPanelRoot();
            const root = panel || document.body;
            return !!detectConversationWorking(root);
        } catch (e) {
            return false;
        }
    };

    /**
     * Wait for an element to disappear (removed from DOM or hidden).
     * @param {Element} el - Element to watch
     * @param {number} timeout - Max time to wait in ms
     * @returns {Promise<boolean>} True if element disappeared
     */
    function waitForDisappear(el, timeout = 500) {
        return new Promise(resolve => {
            const startTime = Date.now();
            const check = () => {
                if (!isElementVisible(el)) {
                    resolve(true);
                } else if (Date.now() - startTime >= timeout) {
                    resolve(false);
                } else {
                    requestAnimationFrame(check);
                }
            };
            // Give a small initial delay for the click to register
            setTimeout(check, 50);
        });
    }

    async function performClick(selectors) {
        const CLICK_COOLDOWN_MS = 10000;
        const isCoolingDown = (el) => {
            try {
                const ts = Number(el?.dataset?.autoAcceptLastClickedTs || 0);
                return ts > 0 && (Date.now() - ts) < CLICK_COOLDOWN_MS;
            } catch (e) {
                return false;
            }
        };
        const markClicked = (el) => {
            try {
                if (el?.dataset) {
                    el.dataset.autoAcceptLastClickedTs = String(Date.now());
                }
            } catch (e) { }
        };

        const found = [];
        selectors.forEach(s => queryAll(s).forEach(el => {
            // Skip anchor links — clicking them navigates away and causes infinite loops
            if (el.tagName === 'A' && el.hasAttribute('href')) return;
            found.push(el);
        }));
        let clicked = 0;
        let verified = 0;
        const uniqueFound = [...new Set(found)];

        // Priority 1: First try data-testid selectors (i18n-safe)
        for (const testId of TESTID_ACCEPT_SELECTORS) {
            const testIdElements = queryAll(`[data-testid="${testId}"]`);
            for (const el of testIdElements) {
                if (!el.isConnected) continue;
                if (isCoolingDown(el)) continue;

                if (isPotentialCommandTestId(testId)) {
                    const nearbyText = findNearbyCommandText(el);
                    if (isCommandBanned(nearbyText, el)) {
                        log(`[BANNED] Skipping data-testid click: "${testId}" - command is banned`);
                        continue;
                    }
                }
                
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                if (style.display === 'none' || rect.width === 0 || style.pointerEvents === 'none' || el.disabled) continue;

                const rawLabel = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim();
                if (!rawLabel || rawLabel.length < 2) continue;
                const visibleLabel = normalizeButtonText(rawLabel).toLowerCase();
                // Word-boundary matching prevents false positives
                if (!ACCEPT_WORD_REGEX.test(visibleLabel)) continue;
                
                log(`[TestId] Clicking element with data-testid="${testId}"`);
                markClicked(el);
                el.click();
                clicked++;
                
                const disappeared = await waitForDisappear(el);
                if (disappeared) {
                    Analytics.trackClick(`[data-testid="${testId}"]`, log);
                    verified++;
                    log(`[Stats] Click verified (button disappeared)`);
                }
                
                // Return after first successful testId click
                if (verified > 0) {
                    log(`[Click] TestId selectors: Attempted: ${clicked}, Verified: ${verified}`);
                    return verified;
                }
            }
        }

        // Priority 2: Fall back to text content matching
        for (const el of uniqueFound) {
            // Check if element is still valid (might have been removed by previous click in this loop)
            if (!el.isConnected) continue;
            if (isCoolingDown(el)) continue;

            if (isAcceptButton(el)) {
                const buttonText = (el.textContent || "").trim();
                log(`Clicking: "${buttonText}"`);

                // Use el.click() for more reliable event dispatch
                markClicked(el);
                el.click();
                clicked++;

                // Wait for button to disappear (verification)
                const disappeared = await waitForDisappear(el);

                if (disappeared) {
                    Analytics.trackClick(buttonText, log);
                    verified++;
                    log(`[Stats] Click verified (button disappeared)`);
                } else {
                    log(`[Stats] Click not verified (button still visible after 500ms)`);
                }
            }
        }

        if (clicked > 0) {
            log(`[Click] Attempted: ${clicked}, Verified: ${verified}`);
        }
        return verified;
    }

    // --- 4. CONTINUE BUTTON AUTO-CLICK ---
    // Thinking limit text patterns to detect
    const THINKING_LIMIT_PATTERNS = [
        'model thinking limit reached',
        'thinking limit reached',
        'token limit reached',
        'context limit reached',
        'context window full',
        'maximum context',
        'conversation too long'
    ];

    /**
     * Check if text matches any thinking limit pattern
     * @param {string} rawText - Text to check
     * @returns {boolean} True if matches a thinking limit pattern
     */
    function matchesThinkingLimitText(rawText) {
        const text = (rawText || '').toLowerCase();
        return THINKING_LIMIT_PATTERNS.some(pattern => text.includes(pattern));
    }

    /**
     * Find a Continue button candidate near thinking limit messages
     * @param {Element} rootEl - Root element to search within
     * @returns {Element|null} Continue button element or null
     */
    function findThinkingLimitContinueCandidate(rootEl) {
        // Check for banners with continue buttons
        const banners = rootEl.querySelectorAll('[class*="banner"], [class*="sticky"], [role="alert"]');
        for (const banner of banners) {
            if (matchesThinkingLimitText(banner.textContent)) {
                const btn = banner.querySelector('button');
                if (btn && isElementVisible(btn) && isClickable(btn)) {
                    log(`[Continue] Found Continue button in banner`);
                    return btn;
                }
            }
        }

        // Also look for buttons with continue-related testids or classes
        const continueSelectors = [
            'button[data-testid*="continue"]',
            'button[class*="continue"]'
        ];
        
        for (const selector of continueSelectors) {
            const buttons = rootEl.querySelectorAll(selector);
            for (const btn of buttons) {
                if (isElementVisible(btn) && isClickable(btn)) {
                    // Check if there's a thinking limit message nearby
                    const parent = btn.closest('[class*="banner"], [class*="sticky"], [role="alert"]');
                    if (parent && matchesThinkingLimitText(parent.textContent)) {
                        log(`[Continue] Found Continue button via selector: ${selector}`);
                        return btn;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Check if thinking limit message is present in the document
     * @param {Element} rootEl - Root element to search within
     * @returns {boolean} True if thinking limit message found
     */
    function hasThinkingLimitMessage(rootEl) {
        const allText = rootEl.textContent || '';
        return matchesThinkingLimitText(allText);
    }

    /**
     * Click Continue button if present and thinking limit detected
     * @param {Element} rootEl - Root element to search within
     * @returns {Promise<boolean>} True if button was clicked
     */
    async function clickContinueIfPresent(rootEl) {
        const state = window.__autoAcceptState;
        
        // Check if continue policy allows auto-click
        if (state.continuePolicy === 'ask') {
            return false;
        }

        let btn = findThinkingLimitContinueCandidate(rootEl);
        if (btn && hasThinkingLimitMessage(rootEl)) {
            log(`[Continue] Clicking Continue button for thinking limit`);
            btn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
            Analytics.trackClick('Continue', log);
            return true;
        }
        return false;
    }

    // --- 5. LIFECYCLE API ---
    // --- Update banned commands list ---
    window.__autoAcceptUpdateBannedCommands = function (bannedList) {
        const state = window.__autoAcceptState;
        state.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        log(`[Config] Updated banned commands list: ${state.bannedCommands.length} patterns`);
        if (state.bannedCommands.length > 0) {
            log(`[Config] Banned patterns: ${state.bannedCommands.join(', ')}`);
        }
    };

    // --- Get current stats for ROI notification ---
    window.__autoAcceptGetStats = function () {
        const stats = Analytics.getStats();
        return {
            clicks: stats.clicksThisSession || 0,
            blocked: stats.blockedThisSession || 0,
            sessionStart: stats.sessionStartTime,
            fileEdits: stats.fileEditsThisSession || 0,
            terminalCommands: stats.terminalCommandsThisSession || 0,
            actionsWhileAway: stats.actionsWhileAway || 0
        };
    };

    // --- Reset stats (called when extension wants to collect and reset) ---
    window.__autoAcceptResetStats = function () {
        return Analytics.collectROI(log);
    };

    // --- Get session summary for notifications ---
    window.__autoAcceptGetSessionSummary = function () {
        return Analytics.getSessionSummary();
    };

    // --- Get and reset away actions count ---
    window.__autoAcceptGetAwayActions = function () {
        return Analytics.consumeAwayActions(log);
    };

    // --- Set focus state (called from extension - authoritative source) ---
    window.__autoAcceptSetFocusState = function (isFocused) {
        Analytics.setFocusState(isFocused, log);
    };

    // --- MutationObserver-based auto-accept (instant, event-driven, no timeouts) ---
    /**
     * Start a MutationObserver that watches for DOM mutations and immediately
     * checks for accept buttons when new elements are added or visibility changes.
     * This replaces the old poll loop for 100% precise, instant detection.
     *
     * @param {object} state - window.__autoAcceptState
     * @param {number} sessionID - Session guard to stop if session changes
     */
    function startAutoAcceptObserver(state, sessionID) {
        // Clean up any previous observers
        if (state._autoAcceptObservers) {
            state._autoAcceptObservers.forEach(function(obs) { obs.disconnect(); });
        }
        state._autoAcceptObservers = [];

        let checking = false;
        let recheckNeeded = false;
        let lastCheckTime = 0;
        const MIN_CHECK_INTERVAL_MS = 300; // Minimum ms between observer-triggered checks
        let pendingTimer = null;

        function runCheck() {
            if (!state.isRunning || state.sessionID !== sessionID) {
                // Session changed or stopped — disconnect all observers
                if (state._autoAcceptObservers) {
                    state._autoAcceptObservers.forEach(function(obs) { obs.disconnect(); });
                    state._autoAcceptObservers = [];
                }
                if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
                return;
            }
            if (!state.domAutoAcceptEnabled) return;

            if (checking) {
                recheckNeeded = true;
                return;
            }

            // Throttle: if we checked very recently, schedule a deferred check
            const elapsed = Date.now() - lastCheckTime;
            if (elapsed < MIN_CHECK_INTERVAL_MS) {
                if (!pendingTimer) {
                    pendingTimer = setTimeout(function() {
                        pendingTimer = null;
                        runCheck();
                    }, MIN_CHECK_INTERVAL_MS - elapsed);
                }
                return;
            }

            checking = true;
            lastCheckTime = Date.now();
            // Use queueMicrotask to batch rapid mutations from a single DOM operation
            queueMicrotask(async function() {
                try {
                    do {
                        recheckNeeded = false;
                        await performClick(['button', '[class*="button"]', '[class*="anysphere"]']);

                        if (state.continuePolicy === 'auto') {
                            await clickContinueIfPresent(document);
                        }
                    } while (recheckNeeded && state.isRunning && state.sessionID === sessionID);
                } catch (e) {
                    log(`[Observer] Error in check: ${e.message}`);
                } finally {
                    checking = false;
                }
            });
        }

        function onMutation(mutations) {
            // Only react if new element nodes were added or attributes changed
            for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (m.type === 'attributes') {
                    runCheck();
                    return;
                }
                if (m.type === 'childList' && m.addedNodes.length > 0) {
                    for (let j = 0; j < m.addedNodes.length; j++) {
                        if (m.addedNodes[j].nodeType === 1) { // Element node
                            runCheck();
                            return;
                        }
                    }
                }
            }
        }

        function observeRoot(root) {
            try {
                const observer = new MutationObserver(onMutation);
                observer.observe(root, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['style', 'class', 'hidden', 'disabled', 'aria-hidden']
                });
                state._autoAcceptObservers.push(observer);
            } catch (e) { /* ignore unobservable roots */ }
        }

        // Observe all existing shadow roots recursively
        function observeShadowRoots(root) {
            try {
                if (root.shadowRoot) {
                    observeRoot(root.shadowRoot);
                    observeShadowRoots(root.shadowRoot);
                }
                var elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
                for (var k = 0; k < elements.length; k++) {
                    if (elements[k].shadowRoot) {
                        observeRoot(elements[k].shadowRoot);
                        observeShadowRoots(elements[k].shadowRoot);
                    }
                }
            } catch (e) { /* cross-origin or detached */ }
        }

        // Observe main document
        observeRoot(document.body || document.documentElement);
        // Also observe all known shadow roots
        observeShadowRoots(document);

        log(`[AutoAccept] MutationObserver active (${state._autoAcceptObservers.length} roots observed)`);

        // Run an immediate check for any buttons already in the DOM
        runCheck();
    }

    window.__autoAcceptStart = function (config) {
        try {
            const ide = (config.ide || 'antigravity').toLowerCase();

            // Update banned commands from config
            if (config.bannedCommands) {
                window.__autoAcceptUpdateBannedCommands(config.bannedCommands);
            }

            log(`__autoAcceptStart called: ide=${ide}`);

            const state = window.__autoAcceptState;

            // Skip restart only if EXACTLY the same config
            if (state.isRunning && state.currentMode === ide) {
                log(`Already running with same config, skipping`);
                return;
            }

            // Stop previous loop if switching
            if (state.isRunning) {
                log(`Stopping previous session...`);
                state.isRunning = false;
            }

            state.isRunning = true;
            state.currentMode = ide;
            state.sessionID++;
            const sid = state.sessionID;

            state.continuePolicy = (config.continuePolicy === 'ask') ? 'ask' : 'auto';
            state.domAutoAcceptEnabled = config.domAutoAcceptEnabled === true;

            // Reset transient per-session state
            state.tabNames = [];

            // Initialize session start time if not set (for stats tracking)
            if (!state.stats.sessionStartTime) {
                state.stats.sessionStartTime = Date.now();
            }

            // Start DOM activity tracking if enabled (default: true)
            if (config.domActivityTracking !== false) {
                startDomActivityTracking(document);
            }

            log(`Agent Loaded (IDE: ${ide})`, true);
            log(`[AutoAccept] DOM auto-accept ${state.domAutoAcceptEnabled ? 'enabled (MutationObserver)' : 'disabled'}`);

            // Use MutationObserver for instant, event-driven button detection.
            // No timeouts or polling — buttons are clicked the moment they appear in the DOM.
            if (state.domAutoAcceptEnabled) {
                startAutoAcceptObserver(state, sid);
            }
            
            // Continue button detection also uses observer (handled inside startAutoAcceptObserver)
        } catch (e) {
            log(`ERROR in __autoAcceptStart: ${e.message}`);
            console.error('[AutoAccept] Start error:', e);
        }
    };

    window.__autoAcceptStop = function () {
        const state = window.__autoAcceptState;
        if (state) {
            state.isRunning = false;
            state.currentMode = null;
            state.tabNames = [];
            // Disconnect all MutationObservers
            if (state._autoAcceptObservers) {
                state._autoAcceptObservers.forEach(function(obs) { obs.disconnect(); });
                state._autoAcceptObservers = [];
            }
        }
        // Stop DOM activity tracking
        stopDomActivityTracking();
        log("Agent Stopped.");
    };

    // --- DOM Activity Tracking API ---
    window.__autoAcceptGetDomActivity = getDomActivityInfo;

    // Active conversation helper (used by the queue to target "Current (Active Tab)")
    window.__autoAcceptGetActiveTabName = function () {
        try {
            const tabs = queryAll('button.grow').filter(t => isElementVisible(t));
            if (!tabs || tabs.length === 0) return '';

            const active = tabs.find(t => t.getAttribute('aria-selected') === 'true')
                || tabs.find(t => t.getAttribute('aria-current') === 'true')
                || tabs.find(t => t.getAttribute('data-state') === 'active')
                || tabs.find(t => ((t.className || '').toLowerCase()).includes('active'))
                || tabs[0];

            const name = stripTimeSuffix(active?.textContent || '');
            return (name || '').trim();
        } catch (e) {
            return '';
        }
    };

    // --- Prompt Sending (CDP) ---

    function getInputValue(el) {
        try {
            if (!el) return '';
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
            return (el.innerText || el.textContent || '').trim();
        } catch (e) {
            return '';
        }
    }

    function getInputHint(el) {
        try {
            if (!el) return '';
            const attrs = [
                el.getAttribute('placeholder'),
                el.getAttribute('aria-label'),
                el.getAttribute('data-placeholder'),
                el.getAttribute('title')
            ].filter(Boolean);
            return attrs.join(' ').trim();
        } catch (e) {
            return '';
        }
    }

    function isProbablyIMEOverlay(className) {
        // Only exclude actual "ime" tokens to avoid false positives like "time"/"timestamp".
        const c = (className || '').toLowerCase();
        return /\bime\b/.test(c) || c.includes('ime-text-area');
    }

    function getAntigravityAgentPanelRoot() {
        try {
            // 1. Direct class match — the panel's actual class in Antigravity
            const byDirectClass = document.querySelector('.antigravity-agent-side-panel');
            if (byDirectClass) { return byDirectClass; }
            // 2. Try the ID-based selectors (older Antigravity versions)
            const byId = document.getElementById('antigravity.agentPanel');
            if (byId) { return byId; }
            // 3. Use queryAll (iframe-aware) for nested frame scenarios
            const panels = queryAll('#antigravity\\.agentPanel');
            if (panels && panels.length > 0) {
                const visible = panels.find(p => {
                    try {
                        const rect = p.getBoundingClientRect();
                        return rect.width > 50 && rect.height > 50;
                    } catch (e) { return false; }
                });
                return visible || panels[0];
            }
            // 4. Broader fallback: class patterns
            const byClass = document.querySelector('[class*="agentPanel"], [class*="agent-panel"], [class*="agent-side-panel"], [data-testid*="agent"]');
            if (byClass) { return byClass; }
            return null;
        } catch (e) {
            try { return document.querySelector('.antigravity-agent-side-panel') || document.getElementById('antigravity.agentPanel'); } catch (e2) { }
        }
        return null;
    }

    function queryAllWithin(root, selector) {
        try {
            const results = [];
            getDocuments(root).forEach(doc => {
                try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
            });
            return results;
        } catch (e) {
            try { return Array.from((root || document).querySelectorAll(selector)); } catch (e2) { }
        }
        return [];
    }

    function findAntigravityChatInputContentEditable(root = document) {
        try {
            // Follow docs/SEND_MESSAGE_ANTIGRAVITY_TO_AGENT_CHAT.md:
            // prioritize a large contenteditable div with classes like cursor-text/overflow-y-auto,
            // and exclude IME overlay traps.
            const editables = queryAllWithin(root, '[contenteditable]');
            let candidate = null;
            let bestScore = -1;

            log(`[FindInput] Scanning ${editables.length} contenteditable elements in root=${root === document ? 'document' : (root.id || root.tagName)}`);

            for (const el of editables) {
                const attr = (el.getAttribute && el.getAttribute('contenteditable')) || '';
                if (String(attr).toLowerCase() === 'false') continue;

                const rect = el.getBoundingClientRect();
                const className = el.className || '';
                const c = String(className).toLowerCase();
                const doc = el.ownerDocument || document;
                const win = doc.defaultView || window;

                // Exclude non-visible elements
                try {
                    const style = win.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                } catch (e) { }

                // Exclude IME overlay + tiny elements
                if (isProbablyIMEOverlay(className)) continue;
                if (rect.width < 50 || rect.height < 15) continue;

                // Score each candidate to pick the best
                let score = 0;
                score += Math.min(rect.width, 800) / 4;
                score += Math.min(rect.height, 200) / 4;

                // Prefer Antigravity chat composer pattern
                if (c.includes('cursor-text') || c.includes('overflow')) score += 500;

                // Placeholder / aria hints
                const hint = getInputHint(el).toLowerCase();
                if (hint.includes('ask') || hint.includes('message') || hint.includes('chat') || hint.includes('prompt') || hint.includes('type')) score += 200;

                // Inside agent panel
                try { if (el.closest && el.closest('#antigravity\\.agentPanel')) score += 150; } catch (e) { }

                // Role=textbox
                if (el.getAttribute('role') === 'textbox') score += 80;

                log(`[FindInput] candidate: tag=${el.tagName}, class="${c.substring(0,60)}", rect=${Math.round(rect.width)}x${Math.round(rect.height)}, hint="${hint.substring(0,40)}", score=${score}`);

                if (score > bestScore) {
                    bestScore = score;
                    candidate = el;
                }
            }

            if (candidate) {
                log(`[FindInput] Best candidate score=${bestScore}`);
            } else {
                log(`[FindInput] No candidate found among ${editables.length} editables`);
            }

            return candidate;
        } catch (e) {
            log(`[FindInput] Error: ${e?.message || String(e)}`);
            return null;
        }
    }

    function scorePromptInputCandidate(el) {
        try {
            const rect = el.getBoundingClientRect();
            const visible = isElementVisible(el);
            if (!visible) return -1;
            if (rect.width < 50 || rect.height < 15) return -1;

            const className = el.className || '';
            if (isProbablyIMEOverlay(className)) return -1;

            const hint = (getInputHint(el) + ' ' + className).toLowerCase();
            const bottomDistance = Math.abs(window.innerHeight - rect.bottom);

            let score = 0;
            score += Math.min(rect.width, 1200) / 8;
            score += Math.min(rect.height, 200) / 4;
            score += Math.max(0, 400 - bottomDistance) / 4;

            if (el.contentEditable === 'true') score += 8;
            if (hint.includes('ask anything')) score += 80;
            if (hint.includes('ask') || hint.includes('message') || hint.includes('prompt') || hint.includes('chat')) score += 35;
            if (hint.includes('cursor') || hint.includes('composer')) score += 20;

            // Prefer inputs inside likely chat containers
            try {
                if (el.closest) {
                    if (el.closest('#antigravity\\.agentPanel')) score += 25;
                    if (el.closest('[class*="chat" i]')) score += 12;
                    if (el.closest('[data-testid*="chat" i]')) score += 12;
                }
            } catch (e) { }

            return score;
        } catch (e) {
            return -1;
        }
    }

    function findBestPromptInput() {
        const candidates = [];

        // Include role="textbox" to catch some custom editors.
        const selector = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"], .ProseMirror';
        const els = queryAll(selector);
        for (const el of els) {
            const score = scorePromptInputCandidate(el);
            if (score >= 0) {
                candidates.push({ el, score });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.length > 0 ? candidates[0].el : null;
    }

    /**
     * Check if an element is clickable.
     * Uses standardized visibility checks (matches utils.js isElementClickable)
     */
    function isClickable(el) {
        try {
            if (!el || !el.isConnected) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return false;
            const win = el.ownerDocument?.defaultView || window;
            const style = win.getComputedStyle(el);
            const MIN_OPACITY_THRESHOLD = 0.1;
            const opacity = parseFloat(style.opacity);
            
            // Check display
            if (style.display === 'none') return false;
            // Check visibility
            if (style.visibility === 'hidden') return false;
            // Check opacity (standardized threshold)
            if (isNaN(opacity) || opacity <= MIN_OPACITY_THRESHOLD) return false;
            // Check disabled
            if ('disabled' in el && el.disabled) return false;
            if (el.hasAttribute && el.hasAttribute('disabled')) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function findSendButtonNearInput(inputBox) {
        const doc = inputBox?.ownerDocument || document;
        const roots = [];
        try {
            const form = inputBox?.closest ? inputBox.closest('form') : null;
            if (form) roots.push(form);
        } catch (e) { }

        try {
            if (inputBox?.parentElement) roots.push(inputBox.parentElement);
        } catch (e) { }

        roots.push(doc);

        const selectors = [
            'button[type="submit"]',
            'button[aria-label*="Send" i]',
            'button[title*="Send" i]',
            'button[data-testid*="send" i]',
            'button[data-testid*="submit" i]',
            '[role="button"][aria-label*="Send" i]',
            '[role="button"][title*="Send" i]'
        ];

        for (const root of roots) {
            for (const sel of selectors) {
                const btn = root.querySelector(sel);
                if (isClickable(btn)) return btn;
            }

            const candidates = root.querySelectorAll('button,[role="button"]');
            for (const btn of candidates) {
                const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')).trim().toLowerCase();
                if (!label) continue;
                if (label === 'send' || label.includes(' send') || label.includes('send ') || label.includes('send') || label.includes('submit')) {
                    if (isClickable(btn)) return btn;
                }
            }
        }

        // Heuristic fallback: find a clickable element adjacent to the input (icon-only "send" buttons often lack labels).
        try {
            const inputRect = inputBox.getBoundingClientRect();
            const searchRoot = roots[0] && roots[0] !== document ? roots[0] : (inputBox.parentElement || document);
            const near = searchRoot.querySelectorAll('button,[role="button"],div[tabindex],span[tabindex]');
            let best = null;
            let bestScore = -Infinity;

            for (const el of near) {
                if (!isClickable(el)) continue;
                if (el === inputBox) continue;
                if (el.contains && el.contains(inputBox)) continue;

                const r = el.getBoundingClientRect();
                const dx = r.left - inputRect.right;
                const dy = Math.abs(((r.top + r.bottom) / 2) - ((inputRect.top + inputRect.bottom) / 2));

                // Must be near the right edge of the composer, and roughly aligned vertically.
                if (dx < -20 || dx > 180) continue;
                if (dy > 70) continue;

                const hasSvg = !!el.querySelector('svg');
                let score = 0;
                score += hasSvg ? 30 : 0;
                score += (180 - dx);
                score += (70 - dy);

                // Prefer slightly larger targets (common for icon buttons).
                score += Math.min(60, r.width + r.height);

                if (score > bestScore) {
                    bestScore = score;
                    best = el;
                }
            }

            if (best) return best;
        } catch (e) { }
        return null;
    }

    function setPromptText(inputBox, text) {
        try {
            const doc = inputBox.ownerDocument || document;
            const win = doc.defaultView || window;
            inputBox.focus();

            if (inputBox.tagName === 'TEXTAREA' || inputBox.tagName === 'INPUT') {
                const proto = inputBox.tagName === 'TEXTAREA'
                    ? win.HTMLTextAreaElement.prototype
                    : win.HTMLInputElement.prototype;
                const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (nativeSetter) {
                    nativeSetter.call(inputBox, text);
                } else {
                    inputBox.value = text;
                }
                inputBox.dispatchEvent(new win.Event('input', { bubbles: true }));
                return true;
            }

            if (inputBox.contentEditable === 'true' || inputBox.classList?.contains('ProseMirror') || inputBox.getAttribute?.('role') === 'textbox') {
                try {
                    doc.execCommand('selectAll', false, null);
                    const ok = doc.execCommand('insertText', false, text);
                    if (!ok) {
                        inputBox.innerText = text;
                    }
                } catch (e) {
                    inputBox.innerText = text;
                }
                inputBox.dispatchEvent(new win.Event('input', { bubbles: true }));
                return true;
            }

            inputBox.innerText = text;
            inputBox.dispatchEvent(new win.Event('input', { bubbles: true }));
            return true;
        } catch (e) {
            return false;
        }
    }

    function dispatchKey(inputBox, opts) {
        try {
            const doc = inputBox.ownerDocument || document;
            const win = doc.defaultView || window;
            inputBox.focus();
            const down = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
            const press = new win.KeyboardEvent('keypress', { bubbles: true, cancelable: true, ...opts });
            const up = new win.KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...opts });
            inputBox.dispatchEvent(down);
            inputBox.dispatchEvent(press);
            inputBox.dispatchEvent(up);
            return true;
        } catch (e) {
            return false;
        }
    }

    async function verifyPromptSent(inputBox, originalText, timeoutMs = 1200) {
        const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const wanted = normalize(originalText);
        const snippet = wanted.length > 64 ? wanted.slice(0, 64) : wanted;

        const elementContainsInput = (el) => {
            try {
                if (!el || !inputBox) return false;
                if (el === inputBox) return true;
                if (inputBox.contains && inputBox.contains(el)) return true;
                if (el.contains && el.contains(inputBox)) return true;
                return false;
            } catch (e) {
                return false;
            }
        };

        const transcriptHasSnippet = () => {
            try {
                if (!snippet) return false;
                const sn = snippet.toLowerCase();
                const candidates = queryAll('div,span,p,li,pre,code,blockquote').slice(0, 1200);
                for (const el of candidates) {
                    if (!el || !isElementVisible(el)) continue;
                    if (elementContainsInput(el)) continue;
                    const t = normalize(el.textContent || '');
                    if (!t) continue;
                    if (t.toLowerCase().includes(sn)) return true;
                }
                return false;
            } catch (e) {
                return false;
            }
        };

        // Phase 1: wait briefly for the composer to clear (strong signal of a send)
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 100));
            const current = getInputValue(inputBox);
            if (!current) return true;
        }

        // Phase 2: if the composer did not clear, only treat as sent if we can find the prompt in the visible transcript.
        // This avoids false positives when Enter inserts a newline instead of sending.
        return transcriptHasSnippet();
    }

    function wasComposerMutatedAfterSubmit(inputBox, originalText) {
        try {
            const current = (getInputValue(inputBox) || '').replace(/\s+/g, ' ').trim();
            const original = String(originalText || '').replace(/\s+/g, ' ').trim();
            if (!original) return false;
            if (!current) return true;

            // If composer no longer matches the original prompt text exactly,
            // treat this as a likely successful submit or editor handoff.
            if (current !== original) {
                // Guard against simple Enter newline that keeps the same content.
                const normalizedCurrent = current.replace(/\n/g, ' ').trim();
                const normalizedOriginal = original.replace(/\n/g, ' ').trim();
                return normalizedCurrent !== normalizedOriginal;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    window.__autoAcceptProbePrompt = function () {
        try {
            const panel = getAntigravityAgentPanelRoot();
            const root = panel || document;
            log(`[Probe] panel=${!!panel}, root=${root === document ? 'document' : (root.id || root.tagName)}`);
            let inputBox = findAntigravityChatInputContentEditable(root);
            if (!inputBox && panel) {
                // If agent panel found but no contenteditable inside it, try document-wide
                log('[Probe] Agent panel found but no input inside; falling back to document');
                inputBox = findAntigravityChatInputContentEditable(document);
            }
            if (!inputBox) {
                // Fallback to the broader heuristic selector (textarea/role=textbox/etc.)
                log('[Probe] No contenteditable found; trying findBestPromptInput()');
                inputBox = findBestPromptInput();
            }
            if (!inputBox) {
                log('[Probe] No input found at all');
                return {
                    hasInput: false,
                    score: 0,
                    hasAgentPanel: !!panel
                };
            }
            const rect = inputBox.getBoundingClientRect();
            const className = String(inputBox.className || '');
            const c = className.toLowerCase();

            let score = 0;
            if (panel) score += 1000;
            score += 200;
            if (c.includes('cursor-text') || c.includes('overflow')) score += 200;
            score += Math.min(rect.width, 1200) / 10;
            score += Math.min(rect.height, 300) / 10;

            const sendBtn = findSendButtonNearInput(inputBox);
            return {
                hasInput: true,
                score,
                hasAgentPanel: !!panel,
                inIframe: (inputBox.ownerDocument && inputBox.ownerDocument !== document),
                tagName: inputBox.tagName,
                hint: getInputHint(inputBox),
                className: className.substring(0, 120),
                rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
                hasSendButton: !!sendBtn
            };
        } catch (e) {
            return { hasInput: false, score: 0, error: e?.message || String(e) };
        }
    };

    window.__autoAcceptSendPrompt = async function (text) {
        try {
            log(`[Prompt] Request to send: "${String(text).substring(0, 50)}..."`);
            let attemptedSubmit = false;

            // Use the documented winning approach for Antigravity chat.
            const panel = getAntigravityAgentPanelRoot();
            const root = panel || document;
            let inputBox = findAntigravityChatInputContentEditable(root);

            // Fallback: try document-wide if panel had no input
            if (!inputBox && panel) {
                log('[Prompt] Agent panel found but no input inside; falling back to document');
                inputBox = findAntigravityChatInputContentEditable(document);
            }

            // Fallback if contenteditable isn't present (some builds render a textarea/ProseMirror).
            const isDocFirst = !!inputBox;
            if (!inputBox) inputBox = findBestPromptInput();
            if (!inputBox) {
                log('[Prompt] ERROR: No suitable input found!');
                return false;
            }

            const doc = inputBox.ownerDocument || document;
            const win = doc.defaultView || window;
            const cls = String(inputBox.className || '').substring(0, 80);
            log(`[Prompt] Using input: ${inputBox.tagName}, docFirst=${isDocFirst}, hasAgentPanel=${!!panel}, inIframe=${doc !== document}, class="${cls}"`);

            // Set text (preferred: execCommand on the element's owning document).
            inputBox.focus();
            try {
                if (doc.execCommand) {
                    doc.execCommand('selectAll', false, null);
                    const ok = doc.execCommand('insertText', false, String(text));
                    if (!ok) {
                        inputBox.innerText = String(text);
                    }
                } else {
                    inputBox.innerText = String(text);
                }
            } catch (e) {
                inputBox.innerText = String(text);
            }
            try { inputBox.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { inputBox.dispatchEvent(new Event('input', { bubbles: true })); }

            // 300ms delay is required for React/UI state to update before Enter is handled.
            await new Promise(r => setTimeout(r, 300));

            const dispatchEnter = (opts = {}) => {
                const params = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...opts };
                try {
                    inputBox.dispatchEvent(new win.KeyboardEvent('keydown', params));
                    inputBox.dispatchEvent(new win.KeyboardEvent('keypress', params));
                    inputBox.dispatchEvent(new win.KeyboardEvent('keyup', params));
                } catch (e) {
                    inputBox.dispatchEvent(new KeyboardEvent('keydown', params));
                    inputBox.dispatchEvent(new KeyboardEvent('keypress', params));
                    inputBox.dispatchEvent(new KeyboardEvent('keyup', params));
                }
            };

            inputBox.focus();
            dispatchEnter();
            attemptedSubmit = true;

            if (await verifyPromptSent(inputBox, String(text), 1200) || wasComposerMutatedAfterSubmit(inputBox, String(text))) {
                log('[Prompt] Sent via Enter (verified)');
                return true;
            }

            // Fallback: some chat UIs require Ctrl+Enter or a send button.
            log('[Prompt] Enter did not clear composer; trying Ctrl+Enter and send-button fallback...');

            setPromptText(inputBox, text);
            await new Promise(r => setTimeout(r, 150));
            dispatchEnter({ ctrlKey: true });
            attemptedSubmit = true;
            if (await verifyPromptSent(inputBox, String(text), 900) || wasComposerMutatedAfterSubmit(inputBox, String(text))) {
                log('[Prompt] Sent via Ctrl+Enter (verified)');
                return true;
            }

            const sendBtn = findSendButtonNearInput(inputBox);
            if (sendBtn) {
                try { sendBtn.click(); } catch (e) { }
                attemptedSubmit = true;
                if (await verifyPromptSent(inputBox, String(text), 900) || wasComposerMutatedAfterSubmit(inputBox, String(text))) {
                    log('[Prompt] Sent via Send button (verified)');
                    return true;
                }
            }

            if (attemptedSubmit) {
                log('[Prompt] WARN: Submit attempted but verification inconclusive; treating as sent');
                return true;
            }

            log('[Prompt] ERROR: Prompt did not appear to send (composer not cleared)');
            return false;
        } catch (e) {
            log(`[Prompt] ERROR: ${e?.message || String(e)}`);
            return false;
        }
    };

    // Send prompt to specific conversation (click tab first)
    window.__autoAcceptSendPromptToConversation = async (text, targetConversation) => {
        log(`[Prompt] sendPromptToConversation: "${text.substring(0, 50)}..." target: "${targetConversation || 'current'}"`);

        // Click target tab if specified
        if (targetConversation && targetConversation !== 'current') {
            const tabs = queryAll('button.grow');
            const targetTab = Array.from(tabs).find(t => {
                const tabName = t.textContent.trim();
                return tabName.includes(targetConversation) ||
                    targetConversation.includes(tabName.split(' ')[0]);
            });

            if (targetTab) {
                log(`[Prompt] Clicking target tab: "${targetTab.textContent.trim()}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                // Wait for tab switch
                await new Promise(r => setTimeout(r, 500));
            } else {
                log(`[Prompt] Target tab "${targetConversation}" not found, using current`);
            }
        }

        // Now send to current input, and return success status
        if (window.__autoAcceptSendPrompt) {
            return !!(await window.__autoAcceptSendPrompt(text));
        }
        return false;
    };

    // --- Continue Button API ---
    // Check if Continue button is present
    window.__autoAcceptHasContinue = function () {
        return findThinkingLimitContinueCandidate(document) !== null;
    };

    // Set Continue button policy ('auto' | 'ask')
    window.__autoAcceptSetContinuePolicy = function (policy) {
        const state = window.__autoAcceptState;
        if (state) {
            state.continuePolicy = policy; // 'auto' | 'ask'
            log(`[Continue] Policy set to: ${policy}`);
        }
    };

    // Force click Continue button once
    window.__autoAcceptForceClickContinueOnce = async function () {
        return await clickContinueIfPresent(document);
    };

    // Get Continue button diagnostics
    window.__autoAcceptGetContinueDiagnostics = function () {
        return {
            hasContinue: window.__autoAcceptHasContinue(),
            hasThinkingLimitMessage: hasThinkingLimitMessage(document),
            continuePolicy: window.__autoAcceptState?.continuePolicy || 'auto',
            ts: Date.now()
        };
    };

    log("Core Bundle Initialized.", true);
})();
