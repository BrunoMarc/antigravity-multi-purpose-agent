/**
 * Auto-Accept Browser Test Suite
 * 
 * This file provides browser-based tests for auto-accept functionality.
 * It includes tests for data-testid selectors, new button patterns, and
 * integration with the hybrid auto-accept approach.
 * 
 * Run in browser console: testAutoAccept() or testAutoAcceptDataTestId()
 * 
 * @module tests/auto_accept_test
 */
(function () {
    console.log("%c[AutoAccept] Test Suite Initialized", "color: #00ff00; font-weight: bold;");

    // --- Helpers ---
    const assert = (condition, message) => {
        if (!condition) throw new Error(message || "Assertion failed");
    };

    const assertEqual = (actual, expected, message) => {
        if (actual !== expected) {
            throw new Error(message || `Expected ${expected}, got ${actual}`);
        }
    };

    const getDocuments = (root = document) => {
        let docs = [root];
        try {
            // Traverse Shadow DOM
            if (root.shadowRoot) {
                docs.push(...getDocuments(root.shadowRoot));
            }
            // Traverse iframes
            const iframes = root.querySelectorAll ? root.querySelectorAll('iframe, frame') : [];
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) docs.push(...getDocuments(iframeDoc));
                } catch (e) { }
            }
            // Traverse elements with Shadow DOM
            const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of allElements) {
                if (el.shadowRoot) {
                    docs.push(...getDocuments(el.shadowRoot));
                }
            }
        } catch (e) { }
        return docs;
    };

    // --- State & Logic from auto_accept.js ---
    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const win = el.ownerDocument.defaultView || window;
        const style = win.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0.1 &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.pointerEvents !== 'none';
    }

    function isElementClickable(el) {
        const win = el.ownerDocument.defaultView || window;
        const style = win.getComputedStyle(el);
        return style.pointerEvents !== 'none' && !el.disabled && !el.hasAttribute('disabled');
    }

    // ============================================
    // Data-TestID Selector Support
    // ============================================
    
    /**
     * data-testid selectors for Shadow DOM buttons (i18n-safe)
     * Priority order: most common accept buttons first
     */
    const TESTID_SELECTORS = [
        'alwaysallow',
        'allow',
        'accept',
        'run',
        'continue',
        'proceed',
        'accept-button',
        'accept-all-button',
        'run-button',
        'apply-button',
        'confirm-button',
        'allow-button'
    ];

    /**
     * Excluded testid selectors (reject/cancel actions)
     * These should never be auto-clicked
     */
    const EXCLUDED_TESTIDS = [
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
     * Find element by data-testid attribute
     * @param {string} testId - The data-testid value to search for
     * @returns {Element|null}
     */
    function findByTestId(testId) {
        const docs = getDocuments();
        for (const doc of docs) {
            try {
                const el = doc.querySelector(`[data-testid="${testId}"]`);
                if (el && isElementVisible(el)) {
                    return el;
                }
            } catch (e) { }
        }
        return null;
    }

    /**
     * Find all elements by data-testid attribute
     * @param {string} testId - The data-testid value to search for
     * @returns {Element[]}
     */
    function findAllByTestId(testId) {
        const docs = getDocuments();
        const elements = [];
        for (const doc of docs) {
            try {
                doc.querySelectorAll(`[data-testid="${testId}"]`).forEach(el => {
                    if (isElementVisible(el)) {
                        elements.push(el);
                    }
                });
            } catch (e) { }
        }
        return elements;
    }

    /**
     * Click element by data-testid
     * @param {string} testId - The data-testid value
     * @returns {boolean} - Whether click was successful
     */
    function clickByTestId(testId) {
        const el = findByTestId(testId);
        if (el) {
            console.log(`[AutoAccept] %cCLICKING by data-testid: "${testId}"`, "color: #28a745; font-weight: bold;");
            el.dispatchEvent(new MouseEvent('click', { 
                view: window, 
                bubbles: true, 
                cancelable: true 
            }));
            return true;
        }
        return false;
    }

    // ============================================
    // New Button Patterns
    // ============================================

    /**
     * Extended accept patterns for better matching
     */
    const ACCEPT_PATTERNS = [
        { pattern: 'accept', exact: false },
        { pattern: 'accept all', exact: false },
        { pattern: 'apply', exact: true },
        { pattern: 'execute', exact: true },
        { pattern: 'resume', exact: true },
        { pattern: 'retry', exact: true },
        { pattern: 'try again', exact: false },
        // New patterns for hybrid approach
        { pattern: 'run', exact: true },
        { pattern: 'run all', exact: false },
        { pattern: 'continue', exact: true },
        { pattern: 'proceed', exact: true },
        { pattern: 'confirm', exact: true },
        { pattern: 'allow', exact: true },
        { pattern: 'allow always', exact: false },
        { pattern: 'yes', exact: true },
        { pattern: 'ok', exact: true },
        { pattern: 'got it', exact: false }
    ];

    /**
     * Extended reject patterns
     */
    const REJECT_PATTERNS = [
        'skip', 'reject', 'cancel', 'discard', 'deny', 'close', 'other',
        // New reject patterns
        'abort', 'dismiss', 'ignore', 'no', 'never'
    ];

    /**
     * Check if element is an accept button (text-based)
     * @param {Element} el 
     * @returns {boolean}
     */
    function isAcceptButton(el) {
        if (!el || !el.textContent) return false;
        const text = el.textContent.trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;

        const matched = ACCEPT_PATTERNS.some(p => p.exact ? text === p.pattern : text.includes(p.pattern));
        if (!matched) return false;

        if (REJECT_PATTERNS.some(p => text.includes(p))) {
            console.log(`[AutoAccept] Rejected (negative): "${text}"`);
            return false;
        }

        const visible = isElementVisible(el);
        const clickable = isElementClickable(el);
        if (!visible || !clickable) {
            console.log(`[AutoAccept] Rejected (state): "${text}" (V:${visible}, C:${clickable})`);
            return false;
        }

        console.log(`[AutoAccept] Found: "${text}"`);
        return true;
    }

    /**
     * Check if element is safe to click based on testId
     * @param {string} testId 
     * @returns {boolean}
     */
    function isTestIdSafe(testId) {
        if (!testId) return true;
        return !EXCLUDED_TESTIDS.some(excluded => 
            testId.toLowerCase() === excluded || 
            testId.toLowerCase().includes(excluded)
        );
    }

    // ============================================
    // Hybrid Integration
    // ============================================

    /**
     * Hybrid click function - tries data-testid first, then text-based
     * @param {string[]} targetSelectors - CSS selectors for text-based matching
     * @param {string} panelSelector - Panel to focus
     * @returns {{clickCount: number, method: string}}
     */
    function hybridClick(targetSelectors, panelSelector) {
        focusOnPanel(panelSelector);
        
        // Priority 1: Try data-testid selectors
        for (const testId of TESTID_SELECTORS) {
            if (!isTestIdSafe(testId)) continue;
            
            const elements = findAllByTestId(testId);
            for (const el of elements) {
                if (isElementVisible(el) && isElementClickable(el)) {
                    console.log(`[AutoAccept] %cHYBRID CLICK (data-testid): "${testId}"`, "color: #28a745; font-weight: bold;");
                    el.dispatchEvent(new MouseEvent('click', { 
                        view: window, 
                        bubbles: true, 
                        cancelable: true 
                    }));
                    return { clickCount: 1, method: 'data-testid', selector: testId };
                }
            }
        }
        
        // Priority 2: Fall back to text-based matching
        const targets = Array.isArray(targetSelectors) ? targetSelectors : [targetSelectors];
        const docs = getDocuments();
        const discoveredElements = [];

        for (const target of targets) {
            if (typeof target === 'string') {
                for (const doc of docs) {
                    doc.querySelectorAll(target).forEach(el => discoveredElements.push(el));
                }
            }
        }

        const uniqueElements = [...new Set(discoveredElements)];
        let clickCount = 0;
        for (const el of uniqueElements) {
            if (isAcceptButton(el)) {
                console.log(`[AutoAccept] %cHYBRID CLICK (text): "${el.textContent.trim()}"`, "color: #007bff; font-weight: bold;");
                el.click();
                clickCount++;
            }
        }
        
        return { clickCount, method: clickCount > 0 ? 'text-content' : 'none' };
    }

    function focusOnPanel(panelSelector) {
        if (!panelSelector) return;
        const docs = getDocuments();
        for (const doc of docs) {
            const panel = doc.querySelector(panelSelector);
            if (panel) {
                panel.focus();
                break;
            }
        }
    }

    function click(targetSelectors, panelSelector) {
        focusOnPanel(panelSelector);
        const targets = Array.isArray(targetSelectors) ? targetSelectors : [targetSelectors];
        const docs = getDocuments();
        const discoveredElements = [];

        for (const target of targets) {
            if (typeof target === 'string') {
                for (const doc of docs) {
                    doc.querySelectorAll(target).forEach(el => discoveredElements.push(el));
                }
            }
        }

        const uniqueElements = [...new Set(discoveredElements)];
        let clickCount = 0;
        for (const el of uniqueElements) {
            if (isAcceptButton(el)) {
                console.log(`[AutoAccept] %cCLICKING: "${el.textContent.trim()}"`, "color: #007bff; font-weight: bold;");
                el.click();
                clickCount++;
            }
        }
        return clickCount;
    }

    // ============================================
    // Test Runners
    // ============================================

    /**
     * Original test runner (Antigravity only)
     */
    window.testAutoAccept = function () {
        const targetSelectors = [".bg-ide-button-background", "button"];
        const panelSelector = "#antigravity\\.agentPanel";

        console.log("[AutoAccept] Running test for ANTIGRAVITY...");
        const result = click(targetSelectors, panelSelector);
        console.log(`[AutoAccept] Test complete. Buttons clicked: ${result}`);
        return result;
    };

    /**
     * Test data-testid selector support
     */
    window.testAutoAcceptDataTestId = function () {
        console.log("%c[AutoAccept] Testing data-testid selectors...", "color: #00ff00; font-weight: bold;");
        
        const results = {
            found: [],
            clicked: [],
            notFound: []
        };

        for (const testId of TESTID_SELECTORS) {
            const elements = findAllByTestId(testId);
            if (elements.length > 0) {
                results.found.push({ testId, count: elements.length });
                console.log(`[AutoAccept] Found ${elements.length} element(s) with data-testid="${testId}"`);
            } else {
                results.notFound.push(testId);
            }
        }

        console.log("%c[AutoAccept] Data-testid test complete", "color: #00ff00; font-weight: bold;");
        console.log("Results:", results);
        return results;
    };

    /**
     * Test hybrid approach (data-testid + text-based)
     */
    window.testAutoAcceptHybrid = function () {
        const targetSelectors = [".bg-ide-button-background", "button"];
        const panelSelector = "#antigravity\\.agentPanel";

        console.log("%c[AutoAccept] Running HYBRID test...", "color: #00ff00; font-weight: bold;");
        
        const result = hybridClick(targetSelectors, panelSelector);
        
        console.log(`[AutoAccept] Hybrid test complete. Method: ${result.method}, Clicks: ${result.clickCount}`);
        return result;
    };

    /**
     * Test Shadow DOM traversal
     */
    window.testShadowDOMTraversal = function () {
        console.log("%c[AutoAccept] Testing Shadow DOM traversal...", "color: #00ff00; font-weight: bold;");
        
        const docs = getDocuments();
        console.log(`[AutoAccept] Found ${docs.length} document(s) (including Shadow DOM)`);
        
        let shadowRootCount = 0;
        const traverse = (root, depth = 0) => {
            if (root.shadowRoot) {
                shadowRootCount++;
                console.log(`${'  '.repeat(depth)}Shadow root found in:`, root.tagName, root.className);
            }
            const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const child of children) {
                traverse(child, depth + 1);
            }
        };
        
        traverse(document);
        
        console.log(`[AutoAccept] Found ${shadowRootCount} shadow root(s)`);
        return { documentCount: docs.length, shadowRootCount };
    };

    /**
     * Test visibility detection
     */
    window.testVisibilityDetection = function () {
        console.log("%c[AutoAccept] Testing visibility detection...", "color: #00ff00; font-weight: bold;");
        
        const buttons = document.querySelectorAll('button, [role="button"]');
        const results = {
            visible: 0,
            hidden: 0,
            clickable: 0,
            notClickable: 0
        };
        
        buttons.forEach(btn => {
            const visible = isElementVisible(btn);
            const clickable = isElementClickable(btn);
            
            if (visible) results.visible++;
            else results.hidden++;
            
            if (clickable) results.clickable++;
            else results.notClickable++;
        });
        
        console.log(`[AutoAccept] Visibility results:`, results);
        return results;
    };

    /**
     * Test safety filter for testIds
     */
    window.testSafetyFilter = function () {
        console.log("%c[AutoAccept] Testing safety filter...", "color: #00ff00; font-weight: bold;");
        
        const testCases = [
            { testId: 'accept-button', expected: true },
            { testId: 'reject-button', expected: false },
            { testId: 'cancel-button', expected: false },
            { testId: 'run-button', expected: true },
            { testId: 'discard-button', expected: false },
            { testId: 'allow-button', expected: true }
        ];
        
        const results = testCases.map(tc => ({
            testId: tc.testId,
            expected: tc.expected,
            actual: isTestIdSafe(tc.testId),
            passed: isTestIdSafe(tc.testId) === tc.expected
        }));
        
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;
        
        console.log(`[AutoAccept] Safety filter results: ${passed} passed, ${failed} failed`);
        console.log("Details:", results);
        
        return { passed, failed, results };
    };

    /**
     * Comprehensive test suite
     */
    window.runAllAutoAcceptTests = function () {
        console.log("%c========================================", "color: #00ff00");
        console.log("%c[AutoAccept] Running ALL Tests", "color: #00ff00; font-weight: bold;");
        console.log("%c========================================", "color: #00ff00");
        
        const results = {};
        
        try {
            console.log("\n--- Test 1: Shadow DOM Traversal ---");
            results.shadowDOM = testShadowDOMTraversal();
        } catch (e) {
            console.error("Shadow DOM test failed:", e);
            results.shadowDOM = { error: e.message };
        }
        
        try {
            console.log("\n--- Test 2: Visibility Detection ---");
            results.visibility = testVisibilityDetection();
        } catch (e) {
            console.error("Visibility test failed:", e);
            results.visibility = { error: e.message };
        }
        
        try {
            console.log("\n--- Test 3: Data-TestID Selectors ---");
            results.dataTestId = testAutoAcceptDataTestId();
        } catch (e) {
            console.error("Data-TestID test failed:", e);
            results.dataTestId = { error: e.message };
        }
        
        try {
            console.log("\n--- Test 4: Safety Filter ---");
            results.safetyFilter = testSafetyFilter();
        } catch (e) {
            console.error("Safety filter test failed:", e);
            results.safetyFilter = { error: e.message };
        }
        
        try {
            console.log("\n--- Test 5: Hybrid Click ---");
            results.hybrid = testAutoAcceptHybrid();
        } catch (e) {
            console.error("Hybrid test failed:", e);
            results.hybrid = { error: e.message };
        }
        
        console.log("\n%c========================================", "color: #00ff00");
        console.log("%c[AutoAccept] All Tests Complete", "color: #00ff00; font-weight: bold;");
        console.log("%c========================================", "color: #00ff00");
        console.log("Summary:", results);
        
        return results;
    };

    // ============================================
    // Expose utilities for external use
    // ============================================
    window.__autoAcceptTest = {
        // Core functions
        getDocuments,
        isElementVisible,
        isElementClickable,
        isAcceptButton,
        isTestIdSafe,
        
        // Data-testid functions
        findByTestId,
        findAllByTestId,
        clickByTestId,
        TESTID_SELECTORS,
        EXCLUDED_TESTIDS,
        
        // Pattern lists
        ACCEPT_PATTERNS,
        REJECT_PATTERNS,
        
        // Click functions
        click,
        hybridClick,
        focusOnPanel
    };

    console.log("To run tests, use one of:");
    console.log("  %ctestAutoAccept()%c - Original test (text-based)", "color: #ced4da; font-family: monospace;", "color: inherit;");
    console.log("  %ctestAutoAcceptDataTestId()%c - Test data-testid selectors", "color: #ced4da; font-family: monospace;", "color: inherit;");
    console.log("  %ctestAutoAcceptHybrid()%c - Test hybrid approach", "color: #ced4da; font-family: monospace;", "color: inherit;");
    console.log("  %ctestShadowDOMTraversal()%c - Test Shadow DOM traversal", "color: #ced4da; font-family: monospace;", "color: inherit;");
    console.log("  %ctestVisibilityDetection()%c - Test visibility detection", "color: #ced4da; font-family: monospace;", "color: inherit;");
    console.log("  %ctestSafetyFilter()%c - Test safety filter", "color: #ced4da; font-family: monospace;", "color: inherit;");
    console.log("  %crunAllAutoAcceptTests()%c - Run all tests", "color: #28a745; font-family: monospace; font-weight: bold;", "color: inherit;");
})();