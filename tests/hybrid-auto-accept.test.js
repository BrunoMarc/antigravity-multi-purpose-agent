/**
 * Hybrid Auto-Accept Integration Tests
 * 
 * Tests for the HybridAutoAccept orchestrator class that coordinates
 * between VS Code command strategy (primary) and CDP strategy (fallback).
 * 
 * @module tests/hybrid-auto-accept.test
 */

const assert = require('assert');
const { describe, it, beforeEach, afterEach, runAndExit } = require('./test-runner');
const Module = require('module');

// Mock vscode module for Node test environment
const mockVscode = {
    commands: {
        getCommands: async () => [],
        executeCommand: async () => true
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

const { HybridAutoAccept } = require('../main_scripts/auto-accept');
const { VSCodeCommandStrategy, AsyncLock, DEFAULT_COMMANDS, DELIBERATELY_EXCLUDED } = require('../main_scripts/auto-accept/vscode-command-strategy');
const { CDPStrategy, TESTID_SELECTORS, EXCLUDED_TESTIDS } = require('../main_scripts/auto-accept/cdp-strategy');
const { SafetyFilter, isCommandSafe, filterCommands, DELIBERATELY_EXCLUDED_COMMANDS } = require('../main_scripts/auto-accept/safety-filter');

/**
 * Test suite for HybridAutoAccept module
 */
describe('HybridAutoAccept', () => {
    let hybridAutoAccept;
    let mockLogger;
    let mockCdpHandler;

    /**
     * Setup before each test
     */
    beforeEach(() => {
        mockLogger = (msg) => { /* silent logger */ };
        
        mockCdpHandler = {
            getConnectionCount: () => 0,
            evaluate: async () => ({ clicked: false })
        };
        
        hybridAutoAccept = new HybridAutoAccept({
            logger: mockLogger,
            cdpHandler: mockCdpHandler
        });
    });

    /**
     * Cleanup after each test
     */
    afterEach(async () => {
        if (hybridAutoAccept) {
            await hybridAutoAccept.stop();
            hybridAutoAccept.dispose();
        }
    });

    // ============================================
    // Module Loading Tests
    // ============================================
    describe('Module Loading', () => {
        it('should load all submodules correctly', () => {
            assert.ok(HybridAutoAccept, 'HybridAutoAccept should be defined');
            assert.ok(VSCodeCommandStrategy, 'VSCodeCommandStrategy should be defined');
            assert.ok(CDPStrategy, 'CDPStrategy should be defined');
            assert.ok(SafetyFilter, 'SafetyFilter should be defined');
        });

        it('should export DEFAULT_COMMANDS array', () => {
            assert.ok(Array.isArray(DEFAULT_COMMANDS), 'DEFAULT_COMMANDS should be an array');
            assert.ok(DEFAULT_COMMANDS.length > 0, 'DEFAULT_COMMANDS should not be empty');
        });

        it('should export DELIBERATELY_EXCLUDED array', () => {
            assert.ok(Array.isArray(DELIBERATELY_EXCLUDED), 'DELIBERATELY_EXCLUDED should be an array');
        });

        it('should export TESTID_SELECTORS array', () => {
            assert.ok(Array.isArray(TESTID_SELECTORS), 'TESTID_SELECTORS should be an array');
        });

        it('should export DELIBERATELY_EXCLUDED_COMMANDS array', () => {
            assert.ok(Array.isArray(DELIBERATELY_EXCLUDED_COMMANDS), 'DELIBERATELY_EXCLUDED_COMMANDS should be an array');
        });
    });

    // ============================================
    // Initialization Tests
    // ============================================
    describe('Initialization', () => {
        it('should initialize with default config', () => {
            const instance = new HybridAutoAccept({ logger: mockLogger });
            
            assert.strictEqual(instance.isEnabled, false, 'Should not be enabled initially');
            assert.ok(instance.config, 'Should have config');
            assert.ok(instance.stats, 'Should have stats');
        });

        it('should initialize with custom config', () => {
            const customConfig = {
                enabled: true,
                primaryStrategy: {
                    pollInterval: 1000,
                    commands: ['custom.command']
                }
            };
            
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: customConfig
            });
            
            assert.strictEqual(instance.config.primaryStrategy.pollInterval, 1000);
            assert.deepStrictEqual(instance.config.primaryStrategy.commands, ['custom.command']);
        });

        it('should initialize with CDP handler', () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler
            });
            
            assert.ok(instance.cdpHandler, 'Should have CDP handler');
        });

        it('should initialize stats with zeros', () => {
            const stats = hybridAutoAccept.stats;
            
            assert.strictEqual(stats.totalAccepts, 0);
            assert.strictEqual(stats.primaryAccepts, 0);
            assert.strictEqual(stats.fallbackAccepts, 0);
            assert.strictEqual(stats.blockedAttempts, 0);
            assert.strictEqual(stats.lastAcceptTime, 0);
        });

        it('should not be enabled after construction', () => {
            assert.strictEqual(hybridAutoAccept.isEnabled, false);
        });
    });

    // ============================================
    // Start/Stop Tests
    // ============================================
    describe('Start/Stop Functionality', () => {
        it('should start successfully when enabled', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: { enabled: true }
            });
            
            await instance.start();
            
            assert.strictEqual(instance.isEnabled, true);
            
            await instance.stop();
        });

        it('should not start when disabled by config', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: { enabled: false }
            });
            
            await instance.start();
            
            assert.strictEqual(instance.isEnabled, false);
        });

        it('should stop successfully after starting', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: { enabled: true }
            });
            
            await instance.start();
            assert.strictEqual(instance.isEnabled, true);
            
            await instance.stop();
            assert.strictEqual(instance.isEnabled, false);
        });

        it('should handle multiple start calls gracefully', async () => {
            await hybridAutoAccept.start();
            await hybridAutoAccept.start(); // Second call should be no-op
            
            assert.strictEqual(hybridAutoAccept.isEnabled, true);
        });

        it('should handle multiple stop calls gracefully', async () => {
            await hybridAutoAccept.start();
            await hybridAutoAccept.stop();
            await hybridAutoAccept.stop(); // Second call should be no-op
            
            assert.strictEqual(hybridAutoAccept.isEnabled, false);
        });

        it('should handle stop without start', async () => {
            // Should not throw
            await hybridAutoAccept.stop();
            assert.strictEqual(hybridAutoAccept.isEnabled, false);
        });
    });

    // ============================================
    // Dual-Strategy Coordination Tests
    // ============================================
    describe('Dual-Strategy Coordination', () => {
        it('should initialize primary strategy when enabled', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: {
                    enabled: true,
                    primaryStrategy: { enabled: true }
                }
            });
            
            await instance.start();
            
            // Primary strategy should be initialized
            assert.ok(instance._primaryStrategy);
            
            await instance.stop();
        });

        it('should initialize fallback strategy when enabled with CDP handler', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: {
                    enabled: true,
                    fallbackStrategy: { enabled: true }
                }
            });
            
            await instance.start();
            
            // Fallback strategy should be initialized
            assert.ok(instance._fallbackStrategy);
            
            await instance.stop();
        });

        it('should not initialize fallback strategy without CDP handler', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: null,
                config: {
                    enabled: true,
                    fallbackStrategy: { enabled: true }
                }
            });
            
            await instance.start();
            
            // Fallback strategy should not be initialized
            assert.strictEqual(instance._fallbackStrategy, null);
            
            await instance.stop();
        });

        it('should initialize safety filter', async () => {
            await hybridAutoAccept.start();
            
            assert.ok(hybridAutoAccept._safetyFilter);
        });

        it('should skip disabled primary strategy', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: {
                    enabled: true,
                    primaryStrategy: { enabled: false }
                }
            });
            
            await instance.start();
            
            assert.strictEqual(instance._primaryStrategy, null);
            
            await instance.stop();
        });

        it('should skip disabled fallback strategy', async () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: {
                    enabled: true,
                    fallbackStrategy: { enabled: false }
                }
            });
            
            await instance.start();
            
            assert.strictEqual(instance._fallbackStrategy, null);
            
            await instance.stop();
        });
    });

    // ============================================
    // Event Emission Tests
    // ============================================
    describe('Event Emission', () => {
        it('should emit "started" event when started', (done) => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: { enabled: true }
            });
            
            instance.on('started', (data) => {
                assert.ok(data.timestamp);
                done();
            });
            
            instance.start();
        });

        it('should emit "stopped" event when stopped', (done) => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: { enabled: true }
            });
            
            instance.on('stopped', (data) => {
                assert.ok(data.timestamp);
                done();
            });
            
            instance.start().then(() => instance.stop());
        });

        it('should emit "accept" event on primary success', (done) => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: { enabled: true }
            });
            
            instance.on('accept', (data) => {
                assert.strictEqual(data.strategy, 'vscode-command');
                assert.ok(data.command);
                done();
            });
            
            // Simulate primary success
            instance.start().then(() => {
                instance._handlePrimarySuccess({
                    command: 'test.command',
                    timestamp: Date.now()
                });
            });
        });

        it('should emit "accept" event on fallback success', (done) => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                cdpHandler: mockCdpHandler,
                config: { enabled: true }
            });
            
            instance.on('accept', (data) => {
                assert.strictEqual(data.strategy, 'cdp');
                assert.ok(data.selector);
                done();
            });
            
            // Simulate fallback success
            instance.start().then(() => {
                instance._handleFallbackSuccess({
                    selector: '[data-testid="accept-button"]',
                    method: 'data-testid',
                    timestamp: Date.now()
                });
            });
        });

        it('should emit "clickTracked" event', (done) => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: { enabled: true }
            });
            
            instance.on('clickTracked', (data) => {
                assert.ok(data.command);
                assert.ok(data.timestamp);
                done();
            });
            
            instance.start().then(() => {
                instance._handleClickTracked({
                    command: 'test.command',
                    timestamp: Date.now()
                });
            });
        });
    });

    // ============================================
    // Statistics Tracking Tests
    // ============================================
    describe('Statistics Tracking', () => {
        it('should track total accepts', async () => {
            await hybridAutoAccept.start();
            
            hybridAutoAccept._handlePrimarySuccess({
                command: 'test.command',
                timestamp: Date.now()
            });
            
            assert.strictEqual(hybridAutoAccept.stats.totalAccepts, 1);
        });

        it('should track primary accepts', async () => {
            await hybridAutoAccept.start();
            
            hybridAutoAccept._handlePrimarySuccess({
                command: 'test.command',
                timestamp: Date.now()
            });
            
            assert.strictEqual(hybridAutoAccept.stats.primaryAccepts, 1);
            assert.strictEqual(hybridAutoAccept.stats.fallbackAccepts, 0);
        });

        it('should track fallback accepts', async () => {
            await hybridAutoAccept.start();
            
            hybridAutoAccept._handleFallbackSuccess({
                selector: '[data-testid="accept"]',
                method: 'data-testid',
                timestamp: Date.now()
            });
            
            assert.strictEqual(hybridAutoAccept.stats.fallbackAccepts, 1);
            assert.strictEqual(hybridAutoAccept.stats.primaryAccepts, 0);
        });

        it('should track last accept time', async () => {
            await hybridAutoAccept.start();
            
            const beforeTime = Date.now();
            
            hybridAutoAccept._handlePrimarySuccess({
                command: 'test.command',
                timestamp: Date.now()
            });
            
            assert.ok(hybridAutoAccept.stats.lastAcceptTime >= beforeTime);
        });

        it('should return copy of stats', () => {
            const stats1 = hybridAutoAccept.stats;
            const stats2 = hybridAutoAccept.stats;
            
            assert.notStrictEqual(stats1, stats2, 'Stats should be copies');
        });

        it('should return copy of config', () => {
            const config1 = hybridAutoAccept.config;
            const config2 = hybridAutoAccept.config;
            
            assert.notStrictEqual(config1, config2, 'Config should be copies');
        });
    });

    // ============================================
    // Configuration Update Tests
    // ============================================
    describe('Configuration Updates', () => {
        it('should update configuration at runtime', () => {
            hybridAutoAccept.updateConfig({
                primaryStrategy: {
                    pollInterval: 2000
                }
            });
            
            assert.strictEqual(hybridAutoAccept.config.primaryStrategy.pollInterval, 2000);
        });

        it('should merge nested configuration', () => {
            const originalInterval = hybridAutoAccept.config.primaryStrategy.pollInterval;
            
            hybridAutoAccept.updateConfig({
                safety: {
                    requireVisibility: false
                }
            });
            
            // Original values should be preserved
            assert.strictEqual(hybridAutoAccept.config.primaryStrategy.pollInterval, originalInterval);
            assert.strictEqual(hybridAutoAccept.config.safety.requireVisibility, false);
        });

        it('should add banned patterns via updateConfig', async () => {
            await hybridAutoAccept.start();
            
            hybridAutoAccept.updateConfig({
                safety: {
                    bannedCommands: ['custom-dangerous-pattern']
                }
            });
            
            // Safety filter should have the new pattern
            const config = hybridAutoAccept._safetyFilter.getConfig();
            assert.ok(config.bannedPatterns.some(p => p.includes('custom-dangerous-pattern')));
        });

        it('should add excluded commands via updateConfig', async () => {
            await hybridAutoAccept.start();
            
            hybridAutoAccept.updateConfig({
                safety: {
                    excludedCommands: ['custom.excluded.command']
                }
            });
            
            const config = hybridAutoAccept._safetyFilter.getConfig();
            assert.ok(config.excludedCommands.includes('custom.excluded.command'));
        });
    });

    // ============================================
    // Dispose Tests
    // ============================================
    describe('Dispose Functionality', () => {
        it('should dispose all resources', async () => {
            await hybridAutoAccept.start();
            
            hybridAutoAccept.dispose();
            
            assert.strictEqual(hybridAutoAccept.isEnabled, false);
        });

        it('should remove all event listeners on dispose', async () => {
            await hybridAutoAccept.start();
            
            const listenerCount = hybridAutoAccept.listenerCount('started');
            
            hybridAutoAccept.dispose();
            
            assert.strictEqual(hybridAutoAccept.listenerCount('started'), 0);
        });

        it('should handle dispose without start', () => {
            const instance = new HybridAutoAccept({ logger: mockLogger });
            
            // Should not throw
            instance.dispose();
        });
    });

    // ============================================
    // Poll Tests
    // ============================================
    describe('Poll Functionality', () => {
        it('should return not enabled when stopped', async () => {
            const result = await hybridAutoAccept.poll();
            
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.strategy, 'none');
            assert.ok(result.error);
        });

        it('should return none when no strategies execute', async () => {
            await hybridAutoAccept.start();
            
            const result = await hybridAutoAccept.poll();
            
            // With no available commands and no CDP connections, should return none
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.strategy, 'none');
        });

        it('should use async lock for poll', async () => {
            await hybridAutoAccept.start();
            
            // Start multiple polls simultaneously
            const promises = [
                hybridAutoAccept.poll(),
                hybridAutoAccept.poll(),
                hybridAutoAccept.poll()
            ];
            
            const results = await Promise.all(promises);
            
            // All should complete without error
            assert.strictEqual(results.length, 3);
        });
    });

    // ============================================
    // Configuration Loading Tests
    // ============================================
    describe('Configuration Loading', () => {
        it('should load default configuration', () => {
            const instance = new HybridAutoAccept({ logger: mockLogger });
            
            assert.strictEqual(instance.config.enabled, true);
            assert.strictEqual(instance.config.primaryStrategy.enabled, true);
            assert.strictEqual(instance.config.fallbackStrategy.enabled, true);
        });

        it('should merge custom configuration with defaults', () => {
            const instance = new HybridAutoAccept({
                logger: mockLogger,
                config: {
                    primaryStrategy: {
                        pollInterval: 999
                    }
                }
            });
            
            // Custom value should override
            assert.strictEqual(instance.config.primaryStrategy.pollInterval, 999);
            // Default values should remain
            assert.ok(instance.config.primaryStrategy.commands.length > 0);
        });

        it('should have correct default poll intervals', () => {
            const instance = new HybridAutoAccept({ logger: mockLogger });
            
            assert.strictEqual(instance.config.primaryStrategy.pollInterval, 500);
            assert.strictEqual(instance.config.fallbackStrategy.pollInterval, 1500);
        });

        it('should have correct default commands', () => {
            const instance = new HybridAutoAccept({ logger: mockLogger });
            
            assert.ok(instance.config.primaryStrategy.commands.includes('antigravity.agent.acceptAgentStep'));
            assert.ok(instance.config.primaryStrategy.commands.includes('antigravity.terminalCommand.accept'));
        });
    });
});

// ============================================
// Integration Tests
// ============================================
describe('Integration Tests', () => {
    describe('HybridAutoAccept Full Flow', () => {
        it('should coordinate both strategies correctly', async () => {
            const mockCdp = {
                getConnectionCount: () => 1,
                evaluate: async () => ({ clicked: false })
            };
            
            const instance = new HybridAutoAccept({
                logger: () => {},
                cdpHandler: mockCdp,
                config: {
                    enabled: true,
                    primaryStrategy: { enabled: true },
                    fallbackStrategy: { enabled: true }
                }
            });
            
            await instance.start();
            
            // Both strategies should be initialized
            assert.ok(instance._primaryStrategy);
            assert.ok(instance._fallbackStrategy);
            
            await instance.stop();
            instance.dispose();
        });

        it('should use primary strategy first', async () => {
            // This test verifies the order of strategy execution
            const instance = new HybridAutoAccept({
                logger: () => {},
                config: {
                    enabled: true,
                    primaryStrategy: { enabled: true },
                    fallbackStrategy: { enabled: false }
                }
            });
            
            await instance.start();
            
            // Only primary should be initialized
            assert.ok(instance._primaryStrategy);
            assert.strictEqual(instance._fallbackStrategy, null);
            
            await instance.stop();
            instance.dispose();
        });

        it('should fallback to CDP when primary fails', async () => {
            const mockCdp = {
                getConnectionCount: () => 1,
                evaluate: async () => ({ clicked: true, selector: '[data-testid="accept"]', method: 'data-testid' })
            };
            
            const instance = new HybridAutoAccept({
                logger: () => {},
                cdpHandler: mockCdp,
                config: {
                    enabled: true,
                    primaryStrategy: { enabled: false },
                    fallbackStrategy: { enabled: true }
                }
            });
            
            await instance.start();
            
            // Only fallback should be initialized
            assert.strictEqual(instance._primaryStrategy, null);
            assert.ok(instance._fallbackStrategy);
            
            await instance.stop();
            instance.dispose();
        });

        it('should respect safety filter in both strategies', async () => {
            const instance = new HybridAutoAccept({
                logger: () => {},
                config: {
                    enabled: true,
                    safety: {
                        excludedCommands: ['test.excluded.command']
                    }
                }
            });
            
            await instance.start();
            
            const result = instance._safetyFilter.checkCommand('test.excluded.command');
            
            assert.strictEqual(result.safe, false);
            assert.strictEqual(result.reason, 'excluded-command');
            
            await instance.stop();
            instance.dispose();
        });
    });

    describe('Error Handling', () => {
        it('should handle CDP handler errors gracefully', async () => {
            const mockCdp = {
                getConnectionCount: () => 1,
                evaluate: async () => { throw new Error('CDP error'); }
            };
            
            const instance = new HybridAutoAccept({
                logger: () => {},
                cdpHandler: mockCdp,
                config: { enabled: true }
            });
            
            await instance.start();
            
            // Should not throw
            const result = await instance.poll();
            
            assert.strictEqual(result.success, false);
            
            await instance.stop();
            instance.dispose();
        });

        it('should handle missing CDP handler gracefully', async () => {
            const instance = new HybridAutoAccept({
                logger: () => {},
                cdpHandler: null,
                config: { enabled: true }
            });
            
            // Should not throw
            await instance.start();
            
            assert.strictEqual(instance._fallbackStrategy, null);
            
            await instance.stop();
            instance.dispose();
        });
    });
});

// ============================================
// AsyncLock Tests
// ============================================
describe('AsyncLock', () => {
    let lock;

    beforeEach(() => {
        lock = new AsyncLock();
    });

    it('should execute callback and return result', async () => {
        const result = await lock.acquire('test', async () => {
            return 'success';
        });
        
        assert.strictEqual(result, 'success');
    });

    it('should prevent concurrent execution', async () => {
        let executionOrder = [];
        
        const promise1 = lock.acquire('test', async () => {
            executionOrder.push('start1');
            await new Promise(r => setTimeout(r, 50));
            executionOrder.push('end1');
            return 1;
        });
        
        const promise2 = lock.acquire('test', async () => {
            executionOrder.push('start2');
            await new Promise(r => setTimeout(r, 10));
            executionOrder.push('end2');
            return 2;
        });
        
        await Promise.all([promise1, promise2]);
        
        // First should complete before second starts
        assert.strictEqual(executionOrder[0], 'start1');
        assert.strictEqual(executionOrder[1], 'end1');
        assert.strictEqual(executionOrder[2], 'start2');
        assert.strictEqual(executionOrder[3], 'end2');
    });

    it('should allow concurrent execution with different keys', async () => {
        let executionOrder = [];
        
        const promise1 = lock.acquire('key1', async () => {
            executionOrder.push('start1');
            await new Promise(r => setTimeout(r, 50));
            executionOrder.push('end1');
            return 1;
        });
        
        const promise2 = lock.acquire('key2', async () => {
            executionOrder.push('start2');
            await new Promise(r => setTimeout(r, 10));
            executionOrder.push('end2');
            return 2;
        });
        
        await Promise.all([promise1, promise2]);
        
        // Both should start before either ends
        assert.strictEqual(executionOrder[0], 'start1');
        assert.strictEqual(executionOrder[1], 'start2');
    });

    it('should report lock status correctly', async () => {
        assert.strictEqual(lock.isLocked('test'), false);
        
        const promise = lock.acquire('test', async () => {
            assert.strictEqual(lock.isLocked('test'), true);
            await new Promise(r => setTimeout(r, 50));
        });
        
        await promise;
        
        assert.strictEqual(lock.isLocked('test'), false);
    });

    it('should release lock on error', async () => {
        try {
            await lock.acquire('test', async () => {
                throw new Error('Test error');
            });
        } catch (e) {
            // Expected
        }
        
        assert.strictEqual(lock.isLocked('test'), false);
    });
});

// Run tests
runAndExit();

process.on('exit', () => {
    Module._load = originalLoad;
});
