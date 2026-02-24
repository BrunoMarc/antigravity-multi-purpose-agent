/**
 * Safety Filter Module for Hybrid Auto-Accept
 * 
 * This module provides safety filtering for commands and elements,
 * preventing dangerous or unwanted auto-accept actions.
 * 
 * @module safety-filter
 */

// Import centralized patterns and pattern matching functions
const { REJECT_TESTID_SELECTORS, matchesRejectPattern } = require('../utils');

/**
 * Default banned command patterns (regex patterns)
 * These patterns match dangerous operations that should never be auto-executed
 * @type {RegExp[]}
 */
const DEFAULT_BANNED_PATTERNS = [
    /delete\s*all/i,
    /rm\s+-rf/i,
    /drop\s+table/i,
    /truncate\s+table/i,
    /format\s+disk/i,
    /wipe\s+disk/i,
    /delete\s+branch/i,
    /force\s+push/i,
    /reset\s+--hard/i,
    /clean\s+all/i,
    /remove\s+all/i,
    /purge\s+all/i,
    /delete\s+workspace/i,
    /delete\s+project/i
];

/**
 * Deliberately excluded commands
 * These commands should never be auto-executed for safety or UX reasons
 * @type {string[]}
 */
const DELIBERATELY_EXCLUDED_COMMANDS = [
    // Notification actions - user should explicitly handle
    'notification.acceptPrimaryAction',
    
    // Tool approval - requires explicit user consent
    'workbench.action.chat.editToolApproval',
    
    // Bulk operations - too aggressive for auto-accept
    'antigravity.prioritized.agentAcceptAllInFile',
    
    // Git merge - requires careful review
    'git.acceptMerge',
    
    // Suggestion acceptance - can interfere with typing
    'acceptSelectedSuggestion',
    
    // Reject actions - opposite of accept
    'antigravity.agent.rejectEdit',
    'antigravity.agent.rejectAgentPlan',
    'antigravity.agent.rejectAgentStep',
    'antigravity.terminalCommand.reject',
    'antigravity.command.reject',
    
    // Discard/cancel operations
    'antigravity.agent.discardChanges',
    'antigravity.agent.cancelOperation',
    
    // Trae commands - exclude all commands starting with trae.
    /^trae\./i
];

/**
 * Excluded data-testid selectors for CDP strategy
 * Elements with these testIds should never be clicked automatically
 * @type {string[]}
 */
const EXCLUDED_TESTIDS = REJECT_TESTID_SELECTORS;

/**
 * Reject patterns for element text matching
 * Now uses centralized patterns from utils.js
 * @type {string[]}
 */
// REJECT_PATTERNS is now imported from utils.js

/**
 * Check if text contains any reject patterns
 * Now uses matchesRejectPattern from utils.js for consistency
 *
 * @param {string} text - Text to check for reject patterns
 * @returns {{matches: boolean, pattern?: string}}
 */
function hasRejectPattern(text) {
    return matchesRejectPattern(text);
}



/**
 * Filter out unsafe commands from a list
 * 
 * @param {string[]} commands - Array of command IDs to filter
 * @param {string[]} [bannedList=[]] - Additional banned command patterns
 * @param {string[]} [excludedList=[]] - Additional excluded commands
 * @returns {{safe: string[], unsafe: Array<{command: string, reason: string}>}}
 */
function filterCommands(commands, bannedList = [], excludedList = []) {
    const safe = [];
    const unsafe = [];
    const filter = new SafetyFilter({
        bannedPatterns: bannedList,
        excludedCommands: excludedList,
        logger: null
    });

    for (const command of commands) {
        const result = filter.checkCommand(command);
        
        if (result.safe) {
            safe.push(command);
        } else {
            unsafe.push({
                command,
                reason: result.reason,
                pattern: result.pattern
            });
        }
    }

    return { safe, unsafe };
}

/**
 * Filter elements based on safety criteria
 * 
 * @param {Array<{text: string, testId?: string}>} elements - Elements to filter
 * @param {string[]} [bannedList=[]] - Additional banned patterns
 * @returns {{safe: Array<{text: string, testId?: string}>, unsafe: Array<{element: {text: string, testId?: string}, reason: string}>}}
 */
function filterElements(elements, bannedList = []) {
    const safe = [];
    const unsafe = [];
    const filter = new SafetyFilter({
        bannedPatterns: bannedList,
        logger: null
    });

    for (const element of elements) {
        const result = filter.checkElement(element.text, element.testId || '');
        
        if (result.safe) {
            safe.push(element);
        } else {
            unsafe.push({
                element,
                reason: result.reason,
                pattern: result.pattern
            });
        }
    }

    return { safe, unsafe };
}

/**
 * SafetyFilter class for stateful safety management
 * 
 * Provides a configurable safety filter that can be updated at runtime.
 * 
 * @class SafetyFilter
 */
const { BaseLogger } = require('../base-logger');

class SafetyFilter extends BaseLogger {
    /**
     * Create a new SafetyFilter instance
     * 
     * @param {object} [options={}] - Configuration options
     * @param {string[]} [options.bannedPatterns=[]] - Additional banned patterns
     * @param {string[]} [options.excludedCommands=[]] - Additional excluded commands
     * @param {boolean} [options.requireVisibility=true] - Require visibility check
     * @param {(msg: string) => void} [options.logger] - Logger function
     */
    constructor(options = {}) {
        super(options.logger || console.log, 'SafetyFilter');
        
        // Initialize banned patterns
        this.bannedPatterns = [
            ...DEFAULT_BANNED_PATTERNS,
            ...(options.bannedPatterns || []).map(p => 
                typeof p === 'string' ? new RegExp(p, 'i') : p
            )
        ];
        
        // Initialize excluded commands
        this.excludedCommands = new Set([
            ...DELIBERATELY_EXCLUDED_COMMANDS,
            ...(options.excludedCommands || [])
        ]);
        
        // Initialize excluded testIds
        this.excludedTestIds = new Set([
            ...EXCLUDED_TESTIDS,
            ...(options.excludedTestIds || [])
        ]);
        
        this.requireVisibility = options.requireVisibility !== false;
        
        // Statistics
        this._stats = {
            commandsChecked: 0,
            commandsBlocked: 0,
            elementsChecked: 0,
            elementsBlocked: 0
        };
    }

    /**
     * Check if a command is safe to execute
     *
     * @param {string} commandId - The VS Code command ID
     * @param {string} [context=''] - Additional context for pattern matching
     * @returns {{safe: boolean, reason?: string, pattern?: string}}
     */
    checkCommand(commandId, context = '') {
        this._stats.commandsChecked++;

        // Check against deliberately excluded commands (supports strings and regex patterns)
        const allExcluded = [...DELIBERATELY_EXCLUDED_COMMANDS, ...this.excludedCommands];
        for (const excluded of allExcluded) {
            if (typeof excluded === 'string') {
                if (excluded === commandId) {
                    this._stats.commandsBlocked++;
                    this._log(`Blocked command: ${commandId} (excluded-command)`);
                    return { safe: false, reason: 'excluded-command', command: commandId };
                }
            } else if (excluded instanceof RegExp) {
                if (excluded.test(commandId)) {
                    this._stats.commandsBlocked++;
                    this._log(`Blocked command: ${commandId} (excluded-command)`);
                    return { safe: false, reason: 'excluded-command', command: commandId };
                }
            }
        }

        // Check against banned patterns
        for (const pattern of this.bannedPatterns) {
            if (pattern.test(commandId)) {
                this._stats.commandsBlocked++;
                this._log(`Blocked command: ${commandId} (banned-pattern)`);
                return { safe: false, reason: 'banned-pattern', pattern: pattern.source || pattern.toString() };
            }
        }

        // Additional context check (unique to class method)
        if (context) {
            for (const pattern of this.bannedPatterns) {
                if (pattern.test(context)) {
                    this._stats.commandsBlocked++;
                    this._log(`Blocked by context pattern: ${pattern} in "${context}"`);
                    return { safe: false, reason: 'banned-pattern' };
                }
            }
        }
        
        return { safe: true };
    }

    /**
     * Check if a button/element is safe to click
     *
     * @param {string} text - Button text content
     * @param {string} [testId=''] - data-testid attribute
     * @returns {{safe: boolean, reason?: string, pattern?: string}}
     */
    checkElement(text, testId = '') {
        this._stats.elementsChecked++;

        // Check testId against excluded list
        if (testId && this.excludedTestIds.has(testId)) {
            this._stats.elementsBlocked++;
            this._log(`Blocked element: ${text} (excluded-element)`);
            return { safe: false, reason: 'excluded-element', testId };
        }

        // Check text against banned patterns
        for (const pattern of this.bannedPatterns) {
            if (pattern.test(text)) {
                this._stats.elementsBlocked++;
                this._log(`Blocked element: ${text} (banned-pattern)`);
                return { safe: false, reason: 'banned-pattern', pattern: pattern.source || pattern.toString() };
            }
        }

        // Check for reject-like text patterns
        const rejectCheck = hasRejectPattern(text);
        if (rejectCheck.matches) {
            this._stats.elementsBlocked++;
            this._log(`Blocked element: ${text} (reject-pattern)`);
            return { safe: false, reason: 'reject-pattern', pattern: rejectCheck.pattern };
        }

        return { safe: true };
    }

    /**
     * Add a banned pattern at runtime
     * 
     * @param {string|RegExp} pattern - Pattern to add
     * @returns {void}
     */
    addBannedPattern(pattern) {
        const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
        this.bannedPatterns.push(regex);
        this._log(`Added banned pattern: ${regex}`);
    }

    /**
     * Remove a banned pattern
     * 
     * @param {string|RegExp} pattern - Pattern to remove
     * @returns {boolean} - Whether the pattern was found and removed
     */
    removeBannedPattern(pattern) {
        const source = typeof pattern === 'string' ? pattern : pattern.source;
        const index = this.bannedPatterns.findIndex(p => p.source === source);
        
        if (index !== -1) {
            this.bannedPatterns.splice(index, 1);
            this._log(`Removed banned pattern: ${source}`);
            return true;
        }
        return false;
    }

    /**
     * Add an excluded command at runtime
     * 
     * @param {string} commandId - Command ID to exclude
     * @returns {void}
     */
    addExcludedCommand(commandId) {
        this.excludedCommands.add(commandId);
        this._log(`Added excluded command: ${commandId}`);
    }

    /**
     * Remove an excluded command
     * 
     * @param {string} commandId - Command ID to remove from exclusion
     * @returns {boolean} - Whether the command was found and removed
     */
    removeExcludedCommand(commandId) {
        if (this.excludedCommands.has(commandId)) {
            this.excludedCommands.delete(commandId);
            this._log(`Removed excluded command: ${commandId}`);
            return true;
        }
        return false;
    }

    /**
     * Add an excluded testId at runtime
     *
     * @param {string} testId - TestId to exclude
     * @returns {void}
     */
    addExcludedTestId(testId) {
        this.excludedTestIds.add(testId);
        this._log(`Added excluded testId: ${testId}`);
    }

    /**
     * Remove an excluded testId
     *
     * @param {string} testId - TestId to remove from exclusion
     * @returns {boolean} - Whether the testId was found and removed
     */
    removeExcludedTestId(testId) {
        if (this.excludedTestIds.has(testId)) {
            this.excludedTestIds.delete(testId);
            this._log(`Removed excluded testId: ${testId}`);
            return true;
        }
        return false;
    }

    /**
     * Get current configuration
     *
     * @returns {{bannedPatterns: string[], excludedCommands: string[], excludedTestIds: string[]}}
     */
    getConfig() {
        return {
            bannedPatterns: this.bannedPatterns.map(p => p.source),
            excludedCommands: [...this.excludedCommands],
            excludedTestIds: [...this.excludedTestIds],
            requireVisibility: this.requireVisibility
        };
    }

    /**
     * Get current statistics
     * 
     * @returns {object}
     */
    getStats() {
        return { ...this._stats };
    }

    /**
     * Reset statistics
     * 
     * @returns {void}
     */
    resetStats() {
        this._stats = {
            commandsChecked: 0,
            commandsBlocked: 0,
            elementsChecked: 0,
            elementsBlocked: 0
        };
    }

}

module.exports = {
    SafetyFilter,
    isCommandSafe,
    isElementSafe,
    filterCommands,
    filterElements,
    hasRejectPattern,
    DEFAULT_BANNED_PATTERNS,
    DELIBERATELY_EXCLUDED_COMMANDS,
    EXCLUDED_TESTIDS
};

// ============================================================
// Backwards Compatibility Wrappers
// These functions wrap the SafetyFilter class for backwards compatibility
// ============================================================

/**
 * Check if a command is safe to execute (backwards compatible wrapper)
 * 
 * @param {string} command - The command ID to check
 * @param {string[]} [bannedList=[]] - Additional banned command patterns (regex strings)
 * @param {string[]} [excludedList=[]] - Additional excluded commands
 * @returns {{safe: boolean, reason?: string, pattern?: string}}
 */
function isCommandSafe(command, bannedList = [], excludedList = []) {
    const filter = new SafetyFilter({
        bannedPatterns: bannedList,
        excludedCommands: excludedList,
        logger: null
    });
    return filter.checkCommand(command);
}

/**
 * Check if an element is safe to click (for CDP strategy) - backwards compatible wrapper
 * 
 * @param {string} text - Button/element text content
 * @param {string} [testId=''] - data-testid attribute value
 * @param {string[]} [bannedList=[]] - Additional banned patterns
 * @returns {{safe: boolean, reason?: string, pattern?: string}}
 */
function isElementSafe(text, testId = '', bannedList = []) {
    const filter = new SafetyFilter({
        bannedPatterns: bannedList,
        logger: null
    });
    return filter.checkElement(text, testId);
}