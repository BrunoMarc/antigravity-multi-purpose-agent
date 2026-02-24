/**
 * Analytics Module - Main Orchestrator
 * 
 * High-level interface for all analytics functionality.
 * This module wires together the state, trackers, reporters, and focus management.
 * 
 * @module analytics
 * 
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      analytics/index.js                      │
 * │                     (Main Orchestrator)                      │
 * └───────────────────────────┬─────────────────────────────────┘
 *                             │
 *         ┌───────────────────┼───────────────────┐
 *         │                   │                   │
 *         ▼                   ▼                   ▼
 * ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 * │   state.js   │   │   focus.js   │   │  trackers/   │
 * │ (Init/Migrate)│   │ (Focus/Blur) │   │  reporters/  │
 * └──────────────┘   └──────────────┘   └──────────────┘
 */

// For browser injection, we inline the modules.
// For Node.js testing, we use require().

(function (exports) {
    'use strict';

     // Environment detection: CDP injection runs in Electron's browser context where
     // both process and window exist. Prefer the browser path (window globals) when
     // window is available, since sub-modules export to window in browser.
     const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
     const isNode = typeof process !== 'undefined' && process.versions && process.versions.node && !isBrowser;

     // ==========================================
     // STATE MANAGEMENT (delegates to state module)
     // ==========================================

     // Import state management functions
     let stateModule = {};
     if (isNode) {
         try {
             stateModule = require('./state');
         } catch (e) {
             console.warn('[Analytics] state module not available:', e.message);
         }
     }
      const { initializeState, getStats, getStatsMutable } = 
          isNode ? stateModule : (isBrowser ? window : {});

     // ==========================================
     // CLICK TRACKING
     // ==========================================

    // Import from clicks tracker module (with error handling)
    let clicksModule = {};
    if (isNode) {
        try {
            clicksModule = require('./trackers/clicks');
        } catch (e) {
            // Module not available in Node environment, use fallback
            console.warn('[Analytics] clicks module not available:', e.message);
        }
    }
    const { ActionType, categorizeClick } = isNode ? clicksModule : (isBrowser ? window : {});

    /**
     * Track a button click with full categorization and away detection.
     *
     * @param {string} buttonText - Text of the clicked button
     * @param {Function} log - Logger function
     * @returns {Object} Click metadata
     */
    function trackClick(buttonText, log) {
        const stats = getStatsMutable();
        let result;
        if (isNode && clicksModule.trackClick) {
            result = clicksModule.trackClick(stats, buttonText, log);
        } else if (isBrowser && window.trackClick) {
            result = window.trackClick(stats, buttonText, log);
        } else {
            // Fallback implementation
            stats.clicksThisSession++;
            log(`[Stats] Click tracked. Total: ${stats.clicksThisSession}`);
            const category = categorizeClick ? categorizeClick(buttonText) : 'unknown';
            result = { category, isAway: !stats.isWindowFocused, totalClicks: stats.clicksThisSession };
        }
        return {
            ...result,
            totalClicks: stats.clicksThisSession
        };
    }

    /**
     * Track a blocked command.
     *
     * @param {Function} log - Logger function
     */
    function trackBlocked(log) {
        const stats = getStatsMutable();
        if (isNode && clicksModule.trackBlocked) {
            return clicksModule.trackBlocked(stats, log);
        } else if (isBrowser && window.trackBlocked) {
            return window.trackBlocked(stats, log);
        } else {
            // Fallback implementation
            stats.blockedThisSession++;
            log(`[Stats] Blocked. Total: ${stats.blockedThisSession}`);
        }
    }

    // ==========================================
    // ROI REPORTING
    // ==========================================

    /**
     * Collect and reset ROI stats for weekly aggregation.
     * Preserves UX notification counters.
     *
     * @param {Function} log - Logger function
     * @returns {Object} Collected stats
     */
    function collectROI(log) {
        const stats = getStatsMutable();
        const collected = {
            clicks: stats.clicksThisSession || 0,
            blocked: stats.blockedThisSession || 0,
            sessionStart: stats.sessionStartTime
        };

        log(`[ROI] Collected: ${collected.clicks} clicks, ${collected.blocked} blocked`);

        // Reset ONLY core ROI metrics
        stats.clicksThisSession = 0;
        stats.blockedThisSession = 0;
        stats.sessionStartTime = Date.now();

        return collected;
    }

     // ==========================================
     // SESSION SUMMARY
     // ==========================================

     // Import focus management functions
     let focusModule = {};
     if (isNode) {
         try {
             focusModule = require('./focus');
         } catch (e) {
             console.warn('[Analytics] focus module not available:', e.message);
         }
     }
     const { dispatchUserReturnedEvent } = 
         isNode ? focusModule : (isBrowser ? window : {});

    /**
     * Get session summary for end-of-session notifications.
     *
     * @returns {Object} Session summary with time estimates
     */
    function getSessionSummary() {
        const stats = getStats();
        
        if (isNode) {
            try {
                return require('./reporters/session').getSessionSummary(stats);
            } catch (e) {
                // Fallback to inline implementation
            }
        } else if (isBrowser && window.getSessionSummary) {
            return window.getSessionSummary(stats);
        }
        
        // Fallback implementation if module not available
        const clicks = stats.clicksThisSession || 0;
        const fileEdits = stats.fileEditsThisSession || 0;
        const terminalCommands = stats.terminalCommandsThisSession || 0;
        const blocked = stats.blockedThisSession || 0;

        const baseSecs = clicks * 5;
        const minMins = Math.max(1, Math.floor((baseSecs * 0.8) / 60));
        const maxMins = Math.ceil((baseSecs * 1.2) / 60);

        return {
            clicks,
            fileEdits,
            terminalCommands,
            blocked,
            estimatedTimeSaved: clicks > 0 ? `${minMins}–${maxMins}` : null,
            hasActivity: clicks > 0 || blocked > 0
        };
    }

    // ==========================================
    // AWAY ACTIONS
    // ==========================================

    /**
     * Get and reset away actions counter.
     *
     * @param {Function} log - Logger function
     * @returns {number} Actions performed while away
     */
    function consumeAwayActions(log) {
        const stats = getStatsMutable();
        const count = stats.actionsWhileAway || 0;
        log(`[Away] Getting away actions: ${count}`);
        stats.actionsWhileAway = 0;
        return count;
    }

    /**
     * Check if user is currently away (window not focused).
     *
     * @returns {boolean} True if window not focused
     */
    function isUserAway() {
        return !getStats().isWindowFocused;
    }

    // ==========================================
    // FOCUS MANAGEMENT
    // ==========================================

    /**
     * Setup focus/blur listeners (delegates to focus manager module).
     *
     * @param {Function} log - Logger function
     */
    function setupFocusListeners(log) {
        const stats = getStatsMutable();
        
        if (isNode) {
            // Import focus module with error handling
            let focusModule;
            try {
                focusModule = require('./focus');
            } catch (e) {
                log('[Focus] Focus manager module not available:', e.message);
                return;
            }
            if (focusModule && focusModule.setupFocusListeners) {
                focusModule.setupFocusListeners(stats, log, dispatchUserReturnedEvent);
            }
        } else if (isBrowser && window.setupFocusListeners) {
            window.setupFocusListeners(stats, log, dispatchUserReturnedEvent);
        } else {
            log('[Focus] Focus manager module not available');
        }
    }

    /**
     * Set focus state (called from extension via CDP).
     *
     * @param {boolean} isFocused - Whether the window is focused
     * @param {Function} log - Logger function
     */
    function setFocusState(isFocused, log) {
        const stats = getStatsMutable();
        if (!stats) return;

        const wasAway = !stats.isWindowFocused;
        stats.isWindowFocused = isFocused;

        if (log) {
            log(`[Focus] Extension sync: focused=${isFocused}, wasAway=${wasAway}`);
        }
    }

    /**
     * Mark DOM activity (for future features).
     *
     * @param {number} timestamp - Time of DOM activity
     * @param {Function} log - Logger function
     */
    function markDomActivity(timestamp, log) {
        const state = (typeof window !== 'undefined') ? window.__autoAcceptState : global.__autoAcceptState;
        if (state) {
            state.lastDomActivityTime = timestamp;
            log(`[Analytics] DOM activity marked at ${timestamp}`);
        }
    }

     // ==========================================
     // INITIALIZATION
     // ==========================================

     /**
      * Initialize the analytics system.
      * Call this when the CDP script loads.
      *
      * @param {Function} log - Logger function
      */
     function initialize(log) {
         // Initialize state using state module
         initializeState(log);

         // Setup focus listeners (only in browser)
         if (isBrowser) {
             setupFocusListeners(log);
         }



         log('[Analytics] Initialized successfully');
     }

    // ==========================================
    // EXPORTS
    // ==========================================

    // Public API
    exports.Analytics = {
        // Initialization
        initialize,

        // Click tracking
        trackClick,
        trackBlocked,
        categorizeClick,
        ActionType,

        // ROI reporting
        collectROI,

        // Session summary
        getSessionSummary,

        // Away actions
        consumeAwayActions,
        isUserAway,

        // State access
        getStats,

        // Focus
        setupFocusListeners,
        setFocusState,

        // DOM activity
        markDomActivity
    };

    // Also expose individual functions for backwards compatibility
    exports.trackClick = trackClick;
    exports.trackBlocked = trackBlocked;
    exports.categorizeClick = categorizeClick;
    exports.ActionType = ActionType;
    exports.collectROI = collectROI;
    exports.getSessionSummary = getSessionSummary;
    exports.consumeAwayActions = consumeAwayActions;
    exports.initialize = initialize;
    exports.setFocusState = setFocusState;
    exports.markDomActivity = markDomActivity;

})(typeof module !== 'undefined' && module.exports ? module.exports : window);
