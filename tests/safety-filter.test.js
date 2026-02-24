/**
 * Safety Filter Unit Tests
 * 
 * Tests for the SafetyFilter class and related functions that provide
 * safety filtering for commands and elements in the hybrid auto-accept system.
 * 
 * @module tests/safety-filter.test
 */

const assert = require('assert');
const { describe, it, beforeEach, runAndExit } = require('./test-runner');

const { 
    SafetyFilter, 
    filterCommands, 
    filterElements,
    DEFAULT_BANNED_PATTERNS,
    DELIBERATELY_EXCLUDED_COMMANDS,
    EXCLUDED_TESTIDS
} = require('../main_scripts/auto-accept/safety-filter');

/**
 * Test suite for SafetyFilter module
 */
describe('SafetyFilter', () => {
    let safetyFilter;
    let mockLogger;
    let logMessages;

    /**
     * Setup before each test
     */
    beforeEach(() => {
        logMessages = [];
        mockLogger = (msg) => logMessages.push(msg);
        
        safetyFilter = new SafetyFilter({ logger: mockLogger });
    });

    // ============================================
    // Constants Tests
    // ============================================
    describe('Constants', () => {
        it('should have DEFAULT_BANNED_PATTERNS defined', () => {
            assert.ok(Array.isArray(DEFAULT_BANNED_PATTERNS));
            assert.ok(DEFAULT_BANNED_PATTERNS.length > 0);
        });

        it('should have expected banned patterns', () => {
            const patternSources = DEFAULT_BANNED_PATTERNS.map(p => p.source);
            
            assert.ok(patternSources.some(s => s.includes('delete')));
            assert.ok(patternSources.some(s => s.includes('rm')));
            assert.ok(patternSources.some(s => s.includes('drop')));
        });

        it('should have DELIBERATELY_EXCLUDED_COMMANDS defined', () => {
            assert.ok(Array.isArray(DELIBERATELY_EXCLUDED_COMMANDS));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.length > 0);
        });

        it('should have expected excluded commands', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('notification.acceptPrimaryAction'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('acceptSelectedSuggestion'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.agent.rejectEdit'));
        });

        it('should have EXCLUDED_TESTIDS defined', () => {
            assert.ok(Array.isArray(EXCLUDED_TESTIDS));
            assert.ok(EXCLUDED_TESTIDS.length > 0);
        });

        it('should have expected excluded testids', () => {
            assert.ok(EXCLUDED_TESTIDS.includes('reject-button'));
            assert.ok(EXCLUDED_TESTIDS.includes('cancel-button'));
            assert.ok(EXCLUDED_TESTIDS.includes('discard-button'));
        });
    });

    // ============================================
    // Constructor Tests
    // ============================================
    describe('Constructor', () => {
        it('should create instance with default config', () => {
            const instance = new SafetyFilter();
            
            assert.ok(instance.bannedPatterns.length > 0);
            assert.ok(instance.excludedCommands.size > 0);
        });

        it('should create instance with custom banned patterns', () => {
            const instance = new SafetyFilter({
                bannedPatterns: ['custom-dangerous-pattern']
            });
            
            const config = instance.getConfig();
            assert.ok(config.bannedPatterns.some(p => p.includes('custom-dangerous-pattern')));
        });

        it('should create instance with custom excluded commands', () => {
            const instance = new SafetyFilter({
                excludedCommands: ['custom.excluded.command']
            });
            
            assert.ok(instance.excludedCommands.has('custom.excluded.command'));
        });

        it('should create instance with custom excluded testids', () => {
            const instance = new SafetyFilter({
                excludedTestIds: ['custom-excluded-button']
            });
            
            assert.ok(instance.excludedTestIds.has('custom-excluded-button'));
        });

        it('should use custom logger', () => {
            const logs = [];
            const logger = (msg) => logs.push(msg);
            
            const instance = new SafetyFilter({ logger });
            instance._log('test message');
            
            assert.ok(logs.length > 0);
            assert.ok(logs[0].includes('test message'));
        });

        it('should initialize stats with zeros', () => {
            const stats = safetyFilter.getStats();
            
            assert.strictEqual(stats.commandsChecked, 0);
            assert.strictEqual(stats.commandsBlocked, 0);
            assert.strictEqual(stats.elementsChecked, 0);
            assert.strictEqual(stats.elementsBlocked, 0);
        });

        it('should set requireVisibility to true by default', () => {
            const instance = new SafetyFilter();
            
            assert.strictEqual(instance.requireVisibility, true);
        });

        it('should allow disabling requireVisibility', () => {
            const instance = new SafetyFilter({
                requireVisibility: false
            });
            
            assert.strictEqual(instance.requireVisibility, false);
        });
    });

    // ============================================
    // checkCommand() Tests - Safe Commands
    // ============================================
    describe('checkCommand() - Safe Commands', () => {
        it('should return safe for accept commands', () => {
            const result = safetyFilter.checkCommand('antigravity.agent.acceptAgentStep');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for terminal accept command', () => {
            const result = safetyFilter.checkCommand('antigravity.terminalCommand.accept');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for chat editing commands', () => {
            const result = safetyFilter.checkCommand('chatEditing.acceptAllFiles');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for inline chat commands', () => {
            const result = safetyFilter.checkCommand('inlineChat.acceptChanges');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for unknown commands', () => {
            const result = safetyFilter.checkCommand('some.unknown.command');
            
            assert.strictEqual(result.safe, true);
        });
    });

    // ============================================
    // checkCommand() Tests - Excluded Commands
    // ============================================
    describe('checkCommand() - Excluded Commands', () => {
        it('should block trae namespace commands', () => {
            const result = safetyFilter.checkCommand('trae.agent.accept');

            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block notification.acceptPrimaryAction', () => {
            const result = safetyFilter.checkCommand('notification.acceptPrimaryAction');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block acceptSelectedSuggestion', () => {
            const result = safetyFilter.checkCommand('acceptSelectedSuggestion');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block antigravity.agent.rejectEdit', () => {
            const result = safetyFilter.checkCommand('antigravity.agent.rejectEdit');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block antigravity.terminalCommand.reject', () => {
            const result = safetyFilter.checkCommand('antigravity.terminalCommand.reject');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block antigravity.agent.discardChanges', () => {
            const result = safetyFilter.checkCommand('antigravity.agent.discardChanges');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block git.acceptMerge', () => {
            const result = safetyFilter.checkCommand('git.acceptMerge');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block with additional excluded list', () => {
            safetyFilter.addExcludedCommand('custom.excluded.command');
            
            const result = safetyFilter.checkCommand('custom.excluded.command');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });
    });

    // ============================================
    // checkCommand() Tests - Banned Patterns
    // ============================================
    describe('checkCommand() - Banned Commands (Regex)', () => {
        it('should block "delete all" pattern', () => {
            // The command name itself contains the banned pattern
            const result = safetyFilter.checkCommand('delete all files', []);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should block "rm -rf" pattern', () => {
            const result = safetyFilter.checkCommand('rm -rf /', []);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should block "drop table" pattern', () => {
            const result = safetyFilter.checkCommand('drop table users', []);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should block "delete branch" pattern', () => {
            const result = safetyFilter.checkCommand('delete branch main', []);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should block "force push" pattern', () => {
            const result = safetyFilter.checkCommand('force push origin', []);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should block "reset --hard" pattern', () => {
            const result = safetyFilter.checkCommand('reset --hard HEAD', []);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should be case insensitive', () => {
            const result = safetyFilter.checkCommand('DELETE ALL FILES', []);
            
            assert.strictEqual(result.safe, false);
        });
    });

    // ============================================
    // filterCommands() Tests
    // ============================================
    describe('filterCommands() - Filtering Logic', () => {
        it('should separate safe and unsafe commands', () => {
            const commands = [
                'antigravity.agent.acceptAgentStep',
                'antigravity.agent.rejectEdit',
                'chatEditing.acceptFile'
            ];
            
            const result = filterCommands(commands);
            
            assert.strictEqual(result.safe.length, 2);
            assert.strictEqual(result.unsafe.length, 1);
        });

        it('should return all safe for safe commands', () => {
            const commands = [
                'antigravity.agent.acceptAgentStep',
                'chatEditing.acceptFile'
            ];
            
            const result = filterCommands(commands);
            
            assert.strictEqual(result.safe.length, 2);
            assert.strictEqual(result.unsafe.length, 0);
        });

        it('should return all unsafe for excluded commands', () => {
            const commands = [
                'antigravity.agent.rejectEdit',
                'antigravity.terminalCommand.reject'
            ];
            
            const result = filterCommands(commands);
            
            assert.strictEqual(result.safe.length, 0);
            assert.strictEqual(result.unsafe.length, 2);
        });

        it('should include reason in unsafe results', () => {
            const commands = ['antigravity.agent.rejectEdit'];
            
            const result = filterCommands(commands);
            
            assert.strictEqual(result.unsafe[0].reason, 'excluded-command');
        });

        it('should filter with additional banned list', () => {
            const commands = [
                'safe.command',
                'dangerous.command'
            ];
            
            const result = filterCommands(commands, ['dangerous']);
            
            assert.strictEqual(result.safe.length, 1);
            assert.strictEqual(result.unsafe.length, 1);
        });

        it('should handle empty array', () => {
            const result = filterCommands([]);
            
            assert.strictEqual(result.safe.length, 0);
            assert.strictEqual(result.unsafe.length, 0);
        });
    });

    // ============================================
    // checkElement() Tests - Safe Elements
    // ============================================
    describe('checkElement() - Safe Elements', () => {
        it('should return safe for accept button', () => {
            const result = safetyFilter.checkElement('Accept', '');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for run button', () => {
            const result = safetyFilter.checkElement('Run', '');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for allow button', () => {
            const result = safetyFilter.checkElement('Allow', '');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for continue button', () => {
            const result = safetyFilter.checkElement('Continue', '');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for apply button', () => {
            const result = safetyFilter.checkElement('Apply', '');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for confirm button', () => {
            const result = safetyFilter.checkElement('Confirm', '');
            
            assert.strictEqual(result.safe, true);
        });

        it('should return safe for proceed button', () => {
            const result = safetyFilter.checkElement('Proceed', '');
            
            assert.strictEqual(result.safe, true);
        });
    });

    // ============================================
    // checkElement() Tests - Unsafe Elements
    // ============================================
    describe('checkElement() - Unsafe Elements', () => {
        it('should block reject button text', () => {
            const result = safetyFilter.checkElement('Reject', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'reject-pattern');
        });

        it('should block cancel button text', () => {
            const result = safetyFilter.checkElement('Cancel', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'reject-pattern');
        });

        it('should block discard button text', () => {
            const result = safetyFilter.checkElement('Discard', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'reject-pattern');
        });

        it('should block deny button text', () => {
            const result = safetyFilter.checkElement('Deny', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'reject-pattern');
        });

        it('should block skip button text', () => {
            const result = safetyFilter.checkElement('Skip', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'reject-pattern');
        });

        it('should block close button text', () => {
            const result = safetyFilter.checkElement('Close', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'reject-pattern');
        });

        it('should block element with excluded testId', () => {
            const result = safetyFilter.checkElement('Accept', 'reject-button');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-element');
        });

        it('should block element with cancel-button testId', () => {
            const result = safetyFilter.checkElement('OK', 'cancel-button');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-element');
        });

        it('should block element with banned pattern in text', () => {
            const result = safetyFilter.checkElement('Delete all files', '', ['delete']);
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });
    });

    // ============================================
    // filterElements() Tests
    // ============================================
    describe('filterElements() - Filtering Logic', () => {
        it('should separate safe and unsafe elements', () => {
            const elements = [
                { text: 'Accept', testId: 'accept-button' },
                { text: 'Reject', testId: 'reject-button' },
                { text: 'Run', testId: 'run-button' }
            ];
            
            const result = filterElements(elements);
            
            assert.strictEqual(result.safe.length, 2);
            assert.strictEqual(result.unsafe.length, 1);
        });

        it('should return all safe for safe elements', () => {
            const elements = [
                { text: 'Accept', testId: 'accept-button' },
                { text: 'Run', testId: 'run-button' }
            ];
            
            const result = filterElements(elements);
            
            assert.strictEqual(result.safe.length, 2);
            assert.strictEqual(result.unsafe.length, 0);
        });

        it('should return all unsafe for reject elements', () => {
            const elements = [
                { text: 'Reject', testId: 'reject-button' },
                { text: 'Cancel', testId: 'cancel-button' }
            ];
            
            const result = filterElements(elements);
            
            assert.strictEqual(result.safe.length, 0);
            assert.strictEqual(result.unsafe.length, 2);
        });

        it('should include reason in unsafe results', () => {
            const elements = [{ text: 'Reject', testId: '' }];
            
            const result = filterElements(elements);
            
            assert.ok(result.unsafe[0].reason);
        });

        it('should handle empty array', () => {
            const result = filterElements([]);
            
            assert.strictEqual(result.safe.length, 0);
            assert.strictEqual(result.unsafe.length, 0);
        });

        it('should handle elements without testId', () => {
            const elements = [
                { text: 'Accept' },
                { text: 'Reject' }
            ];
            
            const result = filterElements(elements);
            
            assert.strictEqual(result.safe.length, 1);
            assert.strictEqual(result.unsafe.length, 1);
        });
    });

    // ============================================
    // SafetyFilter Class - checkCommand() Tests
    // ============================================
    describe('SafetyFilter.checkCommand()', () => {
        it('should block trae namespace commands at class level', () => {
            const result = safetyFilter.checkCommand('trae.agent.accept');

            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should return safe for safe commands', () => {
            const result = safetyFilter.checkCommand('antigravity.agent.acceptAgentStep');
            
            assert.strictEqual(result.safe, true);
        });

        it('should block excluded commands', () => {
            const result = safetyFilter.checkCommand('antigravity.agent.rejectEdit');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
        });

        it('should block commands matching banned pattern', () => {
            const result = safetyFilter.checkCommand('delete all command');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should check context for banned patterns', () => {
            const result = safetyFilter.checkCommand('safe.command', 'delete all files');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should increment commandsChecked counter', () => {
            safetyFilter.checkCommand('test.command');
            safetyFilter.checkCommand('test.command2');
            
            assert.strictEqual(safetyFilter.getStats().commandsChecked, 2);
        });

        it('should increment commandsBlocked counter', () => {
            safetyFilter.checkCommand('antigravity.agent.rejectEdit');
            safetyFilter.checkCommand('antigravity.terminalCommand.reject');
            
            assert.strictEqual(safetyFilter.getStats().commandsBlocked, 2);
        });

        it('should log blocked commands', () => {
            safetyFilter.checkCommand('antigravity.agent.rejectEdit');
            
            assert.ok(logMessages.some(m => m.includes('Blocked')));
        });
    });

    // ============================================
    // SafetyFilter Class - checkElement() Tests
    // ============================================
    describe('SafetyFilter.checkElement()', () => {
        it('should return safe for safe elements', () => {
            const result = safetyFilter.checkElement('Accept', 'accept-button');
            
            assert.strictEqual(result.safe, true);
        });

        it('should block elements with banned text', () => {
            const result = safetyFilter.checkElement('delete all files', '');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'banned-pattern');
        });

        it('should block elements with excluded testId', () => {
            const result = safetyFilter.checkElement('OK', 'reject-button');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-element');
        });

        it('should increment elementsChecked counter', () => {
            safetyFilter.checkElement('Accept', '');
            safetyFilter.checkElement('Run', '');
            
            assert.strictEqual(safetyFilter.getStats().elementsChecked, 2);
        });

        it('should increment elementsBlocked counter', () => {
            safetyFilter.checkElement('Reject', '');
            safetyFilter.checkElement('Cancel', '');
            
            assert.strictEqual(safetyFilter.getStats().elementsBlocked, 2);
        });

        it('should log blocked elements', () => {
            safetyFilter.checkElement('Reject', '');
            
            assert.ok(logMessages.some(m => m.includes('Blocked')));
        });
    });

    // ============================================
    // Runtime Modification Tests
    // ============================================
    describe('Runtime Modification', () => {
        it('should add banned pattern at runtime', () => {
            safetyFilter.addBannedPattern('custom-dangerous-pattern');
            
            const result = safetyFilter.checkCommand('custom-dangerous-pattern command');
            
            assert.strictEqual(result.safe, false);
        });

        it('should add banned pattern as RegExp', () => {
            safetyFilter.addBannedPattern(/custom-pattern/i);
            
            const result = safetyFilter.checkCommand('custom-pattern command');
            
            assert.strictEqual(result.safe, false);
        });

        it('should remove banned pattern', () => {
            safetyFilter.addBannedPattern('custom-pattern');
            safetyFilter.removeBannedPattern('custom-pattern');
            
            const config = safetyFilter.getConfig();
            assert.ok(!config.bannedPatterns.some(p => p === 'custom-pattern'));
        });

        it('should add excluded command at runtime', () => {
            safetyFilter.addExcludedCommand('custom.excluded.command');
            
            const result = safetyFilter.checkCommand('custom.excluded.command');
            
            assert.strictEqual(result.safe, false);
        });

        it('should remove excluded command', () => {
            safetyFilter.addExcludedCommand('custom.excluded.command');
            safetyFilter.removeExcludedCommand('custom.excluded.command');
            
            const result = safetyFilter.checkCommand('custom.excluded.command');
            
            assert.strictEqual(result.safe, true);
        });

        it('should add excluded testId at runtime', () => {
            safetyFilter.addExcludedTestId('custom-excluded-button');
            
            const result = safetyFilter.checkElement('Accept', 'custom-excluded-button');
            
            assert.strictEqual(result.safe, false);
        });

        it('should return true when removing existing pattern', () => {
            safetyFilter.addBannedPattern('test-pattern');
            
            const result = safetyFilter.removeBannedPattern('test-pattern');
            
            assert.strictEqual(result, true);
        });

        it('should return false when removing non-existing pattern', () => {
            const result = safetyFilter.removeBannedPattern('non-existing-pattern');
            
            assert.strictEqual(result, false);
        });

        it('should return true when removing existing command', () => {
            safetyFilter.addExcludedCommand('test.command');
            
            const result = safetyFilter.removeExcludedCommand('test.command');
            
            assert.strictEqual(result, true);
        });

        it('should return false when removing non-existing command', () => {
            const result = safetyFilter.removeExcludedCommand('non.existing.command');
            
            assert.strictEqual(result, false);
        });
    });

    // ============================================
    // getConfig() Tests
    // ============================================
    describe('getConfig()', () => {
        it('should return current configuration', () => {
            const config = safetyFilter.getConfig();
            
            assert.ok(config.bannedPatterns);
            assert.ok(config.excludedCommands);
            assert.ok(config.excludedTestIds);
            assert.ok(config.requireVisibility !== undefined);
        });

        it('should return banned patterns as strings', () => {
            const config = safetyFilter.getConfig();
            
            assert.ok(config.bannedPatterns.every(p => typeof p === 'string'));
        });

        it('should return excluded commands as array', () => {
            const config = safetyFilter.getConfig();
            
            assert.ok(Array.isArray(config.excludedCommands));
        });

        it('should return excluded testIds as array', () => {
            const config = safetyFilter.getConfig();
            
            assert.ok(Array.isArray(config.excludedTestIds));
        });
    });

    // ============================================
    // Statistics Tests
    // ============================================
    describe('Statistics', () => {
        it('should return copy of stats', () => {
            const stats1 = safetyFilter.getStats();
            const stats2 = safetyFilter.getStats();
            
            assert.notStrictEqual(stats1, stats2);
        });

        it('should reset stats with resetStats()', () => {
            safetyFilter.checkCommand('test.command');
            safetyFilter.checkElement('Accept', '');
            
            safetyFilter.resetStats();
            
            const stats = safetyFilter.getStats();
            assert.strictEqual(stats.commandsChecked, 0);
            assert.strictEqual(stats.elementsChecked, 0);
        });
    });

    // ============================================
    // Default Excluded Commands List Tests
    // ============================================
    describe('Default Excluded Commands List', () => {
        it('should include notification.acceptPrimaryAction', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('notification.acceptPrimaryAction'));
        });

        it('should include workbench.action.chat.editToolApproval', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('workbench.action.chat.editToolApproval'));
        });

        it('should include antigravity.prioritized.agentAcceptAllInFile', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.prioritized.agentAcceptAllInFile'));
        });

        it('should include git.acceptMerge', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('git.acceptMerge'));
        });

        it('should include acceptSelectedSuggestion', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('acceptSelectedSuggestion'));
        });

        it('should include all reject commands', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.agent.rejectEdit'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.agent.rejectAgentPlan'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.agent.rejectAgentStep'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.terminalCommand.reject'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.command.reject'));
        });

        it('should include discard/cancel operations', () => {
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.agent.discardChanges'));
            assert.ok(DELIBERATELY_EXCLUDED_COMMANDS.includes('antigravity.agent.cancelOperation'));
        });
    });
});

// Run tests
runAndExit();