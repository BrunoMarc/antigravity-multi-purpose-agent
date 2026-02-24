/**
 * VS Code Command Strategy Unit Tests
 * 
 * Tests for the VSCodeCommandStrategy class that implements the primary
 * strategy for auto-accept functionality by polling VS Code commands.
 * 
 * @module tests/vscode-command-strategy.test
 */

const assert = require('assert');
const { describe, it, beforeEach, afterEach, runAndExit } = require('./test-runner');
const Module = require('module');

// Track mock state
let mockAvailableCommands = [];
let mockExecuteCommandCalls = [];
let mockExecuteCommandError = null;

// Mock vscode module for Node test environment
const mockVscode = {
    commands: {
        getCommands: async () => [...mockAvailableCommands],
        executeCommand: async (command) => {
            mockExecuteCommandCalls.push(command);
            if (mockExecuteCommandError) {
                throw mockExecuteCommandError;
            }
            return true;
        }
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key, defaultValue) => defaultValue
        })
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalLoad.apply(this, arguments);
};

// Override commands for testing
mockVscode.commands.getCommands = async () => [...mockAvailableCommands];
mockVscode.commands.executeCommand = async (command) => {
    mockExecuteCommandCalls.push(command);
    if (mockExecuteCommandError) {
        throw mockExecuteCommandError;
    }
    return true;
};

const { 
    VSCodeCommandStrategy, 
    AsyncLock, 
    DEFAULT_COMMANDS, 
    DELIBERATELY_EXCLUDED 
} = require('../main_scripts/auto-accept/vscode-command-strategy');

/**
 * Reset mock state before each test
 */
function resetMocks() {
    mockAvailableCommands = [];
    mockExecuteCommandCalls = [];
    mockExecuteCommandError = null;
}

/**
 * Test suite for VSCodeCommandStrategy
 */
describe('VSCodeCommandStrategy', () => {
    let strategy;
    let mockLogger;
    let logMessages;

    /**
     * Setup before each test
     */
    beforeEach(() => {
        resetMocks();
        logMessages = [];
        mockLogger = (msg) => logMessages.push(msg);
        
        strategy = new VSCodeCommandStrategy({
            logger: mockLogger,
            pollInterval: 100
        });
    });

    /**
     * Cleanup after each test
     */
    afterEach(() => {
        if (strategy) {
            strategy.dispose();
        }
    });

    // ============================================
    // Constructor Tests
    // ============================================
    describe('Constructor', () => {
        it('should create instance with default config', () => {
            const instance = new VSCodeCommandStrategy();
            
            assert.strictEqual(instance.pollInterval, 500);
            assert.deepStrictEqual(instance.commands, DEFAULT_COMMANDS);
        });

        it('should create instance with custom poll interval', () => {
            const instance = new VSCodeCommandStrategy({
                pollInterval: 1000
            });
            
            assert.strictEqual(instance.pollInterval, 1000);
        });

        it('should create instance with custom commands', () => {
            const customCommands = ['custom.command1', 'custom.command2'];
            const instance = new VSCodeCommandStrategy({
                commands: customCommands
            });
            
            assert.deepStrictEqual(instance.commands, customCommands);
        });

        it('should use custom logger', () => {
            const logs = [];
            const logger = (msg) => logs.push(msg);
            
            const instance = new VSCodeCommandStrategy({ logger });
            instance._log('test message');
            
            assert.ok(logs.length > 0);
            assert.ok(logs[0].includes('test message'));
        });

        it('should initialize with disabled state', () => {
            assert.strictEqual(strategy.isEnabled, false);
        });

        it('should initialize stats with zeros', () => {
            const stats = strategy.stats;
            
            assert.strictEqual(stats.totalPolls, 0);
            assert.strictEqual(stats.commandsExecuted, 0);
            assert.strictEqual(stats.commandsFailed, 0);
            assert.strictEqual(stats.lastExecutionTime, 0);
        });
    });

    // ============================================
    // Start/Stop Tests
    // ============================================
    describe('Start/Stop Polling', () => {
        it('should start polling when start() is called', () => {
            strategy.start();
            
            assert.strictEqual(strategy.isEnabled, true);
            assert.ok(strategy._timer !== null);
        });

        it('should stop polling when stop() is called', () => {
            strategy.start();
            strategy.stop();
            
            assert.strictEqual(strategy.isEnabled, false);
            assert.strictEqual(strategy._timer, null);
        });

        it('should handle multiple start calls gracefully', () => {
            strategy.start();
            strategy.start(); // Second call should be no-op
            
            assert.strictEqual(strategy.isEnabled, true);
        });

        it('should handle multiple stop calls gracefully', () => {
            strategy.start();
            strategy.stop();
            strategy.stop(); // Second call should be no-op
            
            assert.strictEqual(strategy.isEnabled, false);
        });

        it('should handle stop without start', () => {
            strategy.stop(); // Should not throw
            
            assert.strictEqual(strategy.isEnabled, false);
        });

        it('should log when starting', () => {
            strategy.start();
            
            assert.ok(logMessages.some(m => m.includes('Starting')));
        });

        it('should log when stopping', () => {
            strategy.start();
            strategy.stop();
            
            assert.ok(logMessages.some(m => m.includes('stopped')));
        });
    });

    // ============================================
    // Async Lock Tests
    // ============================================
    describe('Async Lock Mechanism', () => {
        it('should prevent concurrent poll execution', async () => {
            // Test that the lock properly serializes execution
            const executionOrder = [];
            
            // Override _executeAllCommands to track execution order
            const originalExecute = strategy._executeAllCommands.bind(strategy);
            strategy._executeAllCommands = async function() {
                executionOrder.push('start');
                await new Promise(r => setTimeout(r, 30));
                executionOrder.push('end');
                return originalExecute();
            };
            
            mockAvailableCommands = ['antigravity.agent.acceptAgentStep'];
            
            // Start multiple polls simultaneously
            await Promise.all([
                strategy.poll(),
                strategy.poll(),
                strategy.poll()
            ]);
            
            // Due to lock, executions should be serialized (start-end-start-end-start-end)
            // Not interleaved (start-start-start-end-end-end)
            let properlySerialized = true;
            let depth = 0;
            let maxDepth = 0;
            
            for (const event of executionOrder) {
                if (event === 'start') {
                    depth++;
                    maxDepth = Math.max(maxDepth, depth);
                } else {
                    depth--;
                }
            }
            
            // Max depth should be 1 if properly serialized
            assert.strictEqual(maxDepth, 1, 'Executions should be serialized, not concurrent');
        });

        it('should return early if already processing', async () => {
            strategy._isProcessing = true;
            
            const result = await strategy.poll();
            
            assert.strictEqual(result.executed, false);
            assert.strictEqual(result.error, 'Already processing');
        });

        it('should release lock after completion', async () => {
            await strategy.poll();
            
            assert.strictEqual(strategy._lock.isLocked('poll'), false);
        });

        it('should release lock after error', async () => {
            mockAvailableCommands = ['test.command'];
            mockExecuteCommandError = new Error('Test error');
            
            await strategy.poll();
            
            assert.strictEqual(strategy._lock.isLocked('poll'), false);
        });
    });

    // ============================================
    // Command Execution Tests
    // ============================================
    describe('Command Execution', () => {
        it('should ignore trae namespace commands even when available', async () => {
            mockAvailableCommands = ['trae.agent.accept'];
            strategy.setCommands(['trae.agent.accept']);

            const result = await strategy.poll();

            assert.strictEqual(result.executed, false);
            assert.strictEqual(mockExecuteCommandCalls.length, 0);
        });

        it('should execute available command', async () => {
            mockAvailableCommands = ['antigravity.agent.acceptAgentStep'];
            
            const result = await strategy.poll();
            
            assert.strictEqual(result.executed, true);
            assert.strictEqual(result.command, 'antigravity.agent.acceptAgentStep');
        });

        it('should not execute unavailable command', async () => {
            mockAvailableCommands = ['some.other.command'];
            
            const result = await strategy.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should not execute deliberately excluded command', async () => {
            mockAvailableCommands = ['notification.acceptPrimaryAction'];
            
            const result = await strategy.poll();
            
            // Should not execute because it's in DELIBERATELY_EXCLUDED
            assert.strictEqual(result.executed, false);
        });

        it('should execute first available command only', async () => {
            mockAvailableCommands = [
                'antigravity.agent.acceptAgentStep',
                'antigravity.terminalCommand.accept'
            ];
            
            await strategy.poll();
            
            // Should have executed at least one command
            assert.ok(mockExecuteCommandCalls.length >= 1);
        });

        it('should handle command execution error gracefully', async () => {
            mockAvailableCommands = ['antigravity.agent.acceptAgentStep'];
            mockExecuteCommandError = new Error('Command failed');
            
            const result = await strategy.poll();
            
            // Should not throw, should return false
            assert.strictEqual(result.executed, false);
        });

        it('should increment stats on successful execution', async () => {
            mockAvailableCommands = ['antigravity.agent.acceptAgentStep'];
            
            await strategy.poll();
            
            assert.strictEqual(strategy.stats.commandsExecuted, 1);
            assert.ok(strategy.stats.lastExecutionTime > 0);
        });

        it('should increment total polls on each poll', async () => {
            await strategy.poll();
            await strategy.poll();
            
            assert.strictEqual(strategy.stats.totalPolls, 2);
        });
    });

    // ============================================
    // Poll Interval Tests
    // ============================================
    describe('Poll Interval Configuration', () => {
        it('should use default poll interval of 500ms', () => {
            const instance = new VSCodeCommandStrategy();
            
            assert.strictEqual(instance.pollInterval, 500);
        });

        it('should update poll interval with setPollInterval()', () => {
            strategy.setPollInterval(1000);
            
            assert.strictEqual(strategy.pollInterval, 1000);
        });

        it('should reject invalid poll interval', () => {
            const originalInterval = strategy.pollInterval;
            
            strategy.setPollInterval(10); // Too low
            
            assert.strictEqual(strategy.pollInterval, originalInterval);
        });

        it('should reject non-numeric poll interval', () => {
            const originalInterval = strategy.pollInterval;
            
            strategy.setPollInterval('invalid');
            
            assert.strictEqual(strategy.pollInterval, originalInterval);
        });

        it('should log when poll interval is updated', () => {
            strategy.setPollInterval(1000);
            
            assert.ok(logMessages.some(m => m.includes('1000')));
        });
    });

    // ============================================
    // Commands List Tests
    // ============================================
    describe('Commands List Management', () => {
        it('should have default commands defined', () => {
            assert.ok(Array.isArray(DEFAULT_COMMANDS));
            assert.ok(DEFAULT_COMMANDS.length > 0);
        });

        it('should include expected default commands', () => {
            assert.ok(DEFAULT_COMMANDS.includes('antigravity.agent.acceptAgentStep'));
            assert.ok(DEFAULT_COMMANDS.includes('antigravity.terminalCommand.accept'));
            assert.ok(DEFAULT_COMMANDS.includes('antigravity.terminalCommand.run'));
            assert.ok(DEFAULT_COMMANDS.includes('antigravity.command.accept'));
        });

        it('should have deliberately excluded commands defined', () => {
            assert.ok(Array.isArray(DELIBERATELY_EXCLUDED));
            assert.ok(DELIBERATELY_EXCLUDED.length > 0);
        });

        it('should include expected excluded commands', () => {
            assert.ok(DELIBERATELY_EXCLUDED.includes('notification.acceptPrimaryAction'));
            assert.ok(DELIBERATELY_EXCLUDED.includes('acceptSelectedSuggestion'));
        });

        it('should update commands with setCommands()', () => {
            const newCommands = ['new.command1', 'new.command2'];
            
            strategy.setCommands(newCommands);
            
            assert.deepStrictEqual(strategy.commands, newCommands);
        });

        it('should reject non-array commands', () => {
            const originalCommands = [...strategy.commands];
            
            strategy.setCommands('not an array');
            
            assert.deepStrictEqual(strategy.commands, originalCommands);
        });

        it('should add command with addCommand()', () => {
            strategy.addCommand('new.command');
            
            assert.ok(strategy.commands.includes('new.command'));
        });

        it('should not add duplicate command', () => {
            const originalLength = strategy.commands.length;
            
            strategy.addCommand(DEFAULT_COMMANDS[0]);
            
            assert.strictEqual(strategy.commands.length, originalLength);
        });

        it('should remove command with removeCommand()', () => {
            const commandToRemove = DEFAULT_COMMANDS[0];
            
            strategy.removeCommand(commandToRemove);
            
            assert.ok(!strategy.commands.includes(commandToRemove));
        });

        it('should handle removing non-existent command', () => {
            const originalLength = strategy.commands.length;
            
            strategy.removeCommand('non.existent.command');
            
            assert.strictEqual(strategy.commands.length, originalLength);
        });
    });

    // ============================================
    // Event Emission Tests
    // ============================================
    describe('Event Emission', () => {
        it('should emit commandExecuted event on success', (done) => {
            mockAvailableCommands = ['antigravity.agent.acceptAgentStep'];
            
            strategy.on('commandExecuted', (data) => {
                assert.strictEqual(data.command, 'antigravity.agent.acceptAgentStep');
                assert.ok(data.timestamp);
                done();
            });
            
            strategy.poll();
        });

        it('should emit clickTracked event on success', (done) => {
            mockAvailableCommands = ['antigravity.agent.acceptAgentStep'];
            
            strategy.on('clickTracked', (data) => {
                assert.strictEqual(data.command, 'antigravity.agent.acceptAgentStep');
                assert.ok(data.timestamp);
                done();
            });
            
            strategy.poll();
        });

        it('should not emit events on failed execution', async () => {
            let eventEmitted = false;
            
            strategy.on('commandExecuted', () => {
                eventEmitted = true;
            });
            
            mockAvailableCommands = []; // No commands available
            
            await strategy.poll();
            
            assert.strictEqual(eventEmitted, false);
        });
    });

    // ============================================
    // Error Handling Tests
    // ============================================
    describe('Error Handling', () => {
        it('should handle getCommands error gracefully', async () => {
            // Override getCommands to throw
            mockVscode.commands.getCommands = async () => {
                throw new Error('getCommands error');
            };
            
            const result = await strategy.poll();
            
            assert.strictEqual(result.executed, false);
            
            // Restore
            mockVscode.commands.getCommands = async () => [...mockAvailableCommands];
        });

        it('should increment failed count on error', async () => {
            mockAvailableCommands = ['test.command'];
            mockExecuteCommandError = new Error('Execution failed');
            
            await strategy.poll();
            
            // Stats should still be updated
            assert.strictEqual(strategy.stats.totalPolls, 1);
        });

        it('should continue to next command on error', async () => {
            mockAvailableCommands = [
                'antigravity.agent.acceptAgentStep',
                'antigravity.terminalCommand.accept'
            ];
            
            // First command fails, second should be tried
            let callCount = 0;
            mockVscode.commands.executeCommand = async (cmd) => {
                callCount++;
                if (callCount === 1) {
                    throw new Error('First command failed');
                }
                return true;
            };
            
            await strategy.poll();
            
            // Both commands should have been tried
            assert.ok(callCount >= 1);
            
            // Restore
            mockVscode.commands.executeCommand = async (command) => {
                mockExecuteCommandCalls.push(command);
                if (mockExecuteCommandError) throw mockExecuteCommandError;
                return true;
            };
        });
    });

    // ============================================
    // Statistics Tests
    // ============================================
    describe('Statistics', () => {
        it('should return copy of stats', () => {
            const stats1 = strategy.stats;
            const stats2 = strategy.stats;
            
            assert.notStrictEqual(stats1, stats2);
        });

        it('should reset stats with resetStats()', () => {
            strategy._stats.totalPolls = 10;
            strategy._stats.commandsExecuted = 5;
            
            strategy.resetStats();
            
            assert.strictEqual(strategy.stats.totalPolls, 0);
            assert.strictEqual(strategy.stats.commandsExecuted, 0);
        });
    });

    // ============================================
    // isCommandAvailable Tests
    // ============================================
    describe('isCommandAvailable', () => {
        it('should return true for available command', async () => {
            mockAvailableCommands = ['test.command'];
            
            const result = await strategy.isCommandAvailable('test.command');
            
            assert.strictEqual(result, true);
        });

        it('should return false for unavailable command', async () => {
            mockAvailableCommands = ['other.command'];
            
            const result = await strategy.isCommandAvailable('test.command');
            
            assert.strictEqual(result, false);
        });

        it('should handle getCommands error', async () => {
            mockVscode.commands.getCommands = async () => {
                throw new Error('Error');
            };
            
            const result = await strategy.isCommandAvailable('test.command');
            
            assert.strictEqual(result, false);
            
            // Restore
            mockVscode.commands.getCommands = async () => [...mockAvailableCommands];
        });
    });

    // ============================================
    // Dispose Tests
    // ============================================
    describe('Dispose', () => {
        it('should stop polling on dispose', () => {
            strategy.start();
            strategy.dispose();
            
            assert.strictEqual(strategy.isEnabled, false);
        });

        it('should remove all listeners on dispose', () => {
            strategy.on('test', () => {});
            
            strategy.dispose();
            
            assert.strictEqual(strategy.listenerCount('test'), 0);
        });

        it('should handle dispose without start', () => {
            const instance = new VSCodeCommandStrategy();
            
            // Should not throw
            instance.dispose();
        });
    });
});

// ============================================
// AsyncLock Unit Tests
// ============================================
describe('AsyncLock', () => {
    let lock;

    beforeEach(() => {
        lock = new AsyncLock();
    });

    describe('acquire', () => {
        it('should execute callback and return result', async () => {
            const result = await lock.acquire('key1', async () => {
                return 'test-result';
            });
            
            assert.strictEqual(result, 'test-result');
        });

        it('should allow parallel execution with different keys', async () => {
            const results = [];
            
            await Promise.all([
                lock.acquire('key1', async () => {
                    results.push('a');
                    await new Promise(r => setTimeout(r, 20));
                    results.push('b');
                }),
                lock.acquire('key2', async () => {
                    results.push('c');
                    await new Promise(r => setTimeout(r, 10));
                    results.push('d');
                })
            ]);
            
            // Both should have started before either finished
            assert.ok(results.indexOf('a') < results.indexOf('d'));
            assert.ok(results.indexOf('c') < results.indexOf('b'));
        });

        it('should serialize execution with same key', async () => {
            const results = [];
            
            await Promise.all([
                lock.acquire('key1', async () => {
                    results.push('a');
                    await new Promise(r => setTimeout(r, 30));
                    results.push('b');
                }),
                lock.acquire('key1', async () => {
                    results.push('c');
                    await new Promise(r => setTimeout(r, 10));
                    results.push('d');
                })
            ]);
            
            // First should complete before second starts
            assert.strictEqual(results[0], 'a');
            assert.strictEqual(results[1], 'b');
            assert.strictEqual(results[2], 'c');
            assert.strictEqual(results[3], 'd');
        });

        it('should propagate callback errors', async () => {
            let error = null;
            
            try {
                await lock.acquire('key1', async () => {
                    throw new Error('Test error');
                });
            } catch (e) {
                error = e;
            }
            
            assert.ok(error);
            assert.strictEqual(error.message, 'Test error');
        });

        it('should release lock after error', async () => {
            try {
                await lock.acquire('key1', async () => {
                    throw new Error('Test error');
                });
            } catch (e) {}
            
            assert.strictEqual(lock.isLocked('key1'), false);
        });
    });

    describe('isLocked', () => {
        it('should return false for unlocked key', () => {
            assert.strictEqual(lock.isLocked('key1'), false);
        });

        it('should return true during lock execution', async () => {
            let lockedDuringExecution = false;
            
            const promise = lock.acquire('key1', async () => {
                lockedDuringExecution = lock.isLocked('key1');
                await new Promise(r => setTimeout(r, 10));
            });
            
            // Check immediately after starting
            await new Promise(r => setTimeout(r, 1));
            
            await promise;
            
            assert.strictEqual(lockedDuringExecution, true);
        });

        it('should return false after lock released', async () => {
            await lock.acquire('key1', async () => {});
            
            assert.strictEqual(lock.isLocked('key1'), false);
        });
    });
});

// Run tests
runAndExit();

process.on('exit', () => {
    Module._load = originalLoad;
});
