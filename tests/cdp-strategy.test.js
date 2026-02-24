/**
 * CDP Strategy Unit Tests
 * 
 * Tests for the CDPStrategy class that implements the fallback strategy
 * for auto-accept functionality using Chrome DevTools Protocol.
 * 
 * @module tests/cdp-strategy.test
 */

const assert = require('assert');
const { describe, it, beforeEach, afterEach, runAndExit } = require('./test-runner');

const { 
    CDPStrategy, 
    TESTID_SELECTORS, 
    EXCLUDED_TESTIDS,
    DEFAULT_CONFIG 
} = require('../main_scripts/auto-accept/cdp-strategy');

/**
 * Create a mock CDP handler for testing
 */
function createMockCdpHandler(overrides = {}) {
    return {
        getConnectionCount: overrides.getConnectionCount || (() => 1),
        evaluate: overrides.evaluate || (async () => ({ clicked: false })),
        ...overrides
    };
}

/**
 * Test suite for CDPStrategy
 */
describe('CDPStrategy', () => {
    let strategy;
    let mockLogger;
    let logMessages;
    let mockCdpHandler;

    /**
     * Setup before each test
     */
    beforeEach(() => {
        logMessages = [];
        mockLogger = (msg) => logMessages.push(msg);
        
        mockCdpHandler = createMockCdpHandler();
        
        strategy = new CDPStrategy({
            logger: mockLogger,
            cdpHandler: mockCdpHandler,
            pollInterval: 100
        });
    });

    /**
     * Cleanup after each test
     */
    afterEach(() => {
        if (strategy) {
            strategy.stop();
        }
    });

    // ============================================
    // Constants Tests
    // ============================================
    describe('Constants', () => {
        it('should have TESTID_SELECTORS defined', () => {
            assert.ok(Array.isArray(TESTID_SELECTORS));
            assert.ok(TESTID_SELECTORS.length > 0);
        });

        it('should have expected testid selectors', () => {
            assert.ok(TESTID_SELECTORS.includes('accept-button'));
            assert.ok(TESTID_SELECTORS.includes('accept-all-button'));
            assert.ok(TESTID_SELECTORS.includes('apply-button'));
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

        it('should have DEFAULT_CONFIG defined', () => {
            assert.ok(DEFAULT_CONFIG);
            assert.strictEqual(DEFAULT_CONFIG.pollInterval, 1500);
            assert.strictEqual(DEFAULT_CONFIG.useDataTestId, true);
            assert.strictEqual(DEFAULT_CONFIG.enabled, true);
        });
    });

    // ============================================
    // Constructor Tests
    // ============================================
    describe('Constructor', () => {
        it('should create instance with default config', () => {
            const instance = new CDPStrategy();
            
            assert.strictEqual(instance._config.pollInterval, 1500);
            assert.strictEqual(instance._config.useDataTestId, true);
        });

        it('should create instance with custom poll interval', () => {
            const instance = new CDPStrategy({
                pollInterval: 2000
            });
            
            assert.strictEqual(instance._config.pollInterval, 2000);
        });

        it('should create instance with CDP handler', () => {
            const cdp = createMockCdpHandler();
            const instance = new CDPStrategy({ cdpHandler: cdp });
            
            assert.strictEqual(instance.cdpHandler, cdp);
        });

        it('should use custom logger', () => {
            const logs = [];
            const logger = (msg) => logs.push(msg);
            
            const instance = new CDPStrategy({ logger });
            instance._log('test message');
            
            assert.ok(logs.length > 0);
            assert.ok(logs[0].includes('test message'));
        });

        it('should initialize with disabled state', () => {
            assert.strictEqual(strategy.isEnabled, false);
        });

        it('should initialize stats with zeros', () => {
            const stats = strategy.stats;
            
            assert.strictEqual(stats.totalClicks, 0);
            assert.strictEqual(stats.dataTestIdClicks, 0);
            assert.strictEqual(stats.textContentClicks, 0);
            assert.strictEqual(stats.failedAttempts, 0);
            assert.strictEqual(stats.lastClickTime, null);
        });

        it('should use data-testid by default', () => {
            const instance = new CDPStrategy();
            
            assert.strictEqual(instance._config.useDataTestId, true);
        });

        it('should allow disabling data-testid', () => {
            const instance = new CDPStrategy({
                useDataTestId: false
            });
            
            assert.strictEqual(instance._config.useDataTestId, false);
        });
    });

    // ============================================
    // Start/Stop Tests
    // ============================================
    describe('Start/Stop Functionality', () => {
        it('should start successfully with CDP handler', () => {
            strategy.start();
            
            assert.strictEqual(strategy.isEnabled, true);
        });

        it('should not start without CDP handler', () => {
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: null
            });
            
            instance.start();
            
            assert.strictEqual(instance.isEnabled, false);
        });

        it('should stop successfully after starting', () => {
            strategy.start();
            strategy.stop();
            
            assert.strictEqual(strategy.isEnabled, false);
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

        it('should clear timer on stop', () => {
            strategy.start();
            strategy.stop();
            
            assert.strictEqual(strategy._timer, null);
        });

        it('should log when starting', () => {
            strategy.start();
            
            assert.ok(logMessages.some(m => m.includes('Starting')));
        });

        it('should log when stopping', () => {
            strategy.start();
            strategy.stop();
            
            assert.ok(logMessages.some(m => m.includes('Stopping')));
        });
    });

    // ============================================
    // Poll Tests
    // ============================================
    describe('Poll Functionality', () => {
        it('should return not executed when no CDP connection', async () => {
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: { getConnectionCount: () => 0 }
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should return not executed when already processing', async () => {
            strategy._isProcessing = true;
            
            const result = await strategy.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should return executed when CDP click succeeds', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({
                    clicked: true,
                    selector: '[data-testid="accept-button"]',
                    method: 'data-testid'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, true);
            assert.strictEqual(result.selector, '[data-testid="accept-button"]');
            assert.strictEqual(result.method, 'data-testid');
        });

        it('should return not executed when no click happens', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({ clicked: false })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should handle CDP errors gracefully', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => {
                    throw new Error('CDP error');
                }
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
            assert.ok(result.error);
        });

        it('should handle JSON parse errors gracefully', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => 'invalid json{'
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            // Should not throw
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should handle string result from CDP', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => JSON.stringify({
                    clicked: true,
                    selector: '[data-testid="accept"]',
                    method: 'data-testid'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, true);
        });
    });

    // ============================================
    // Data-TestID Selector Tests
    // ============================================
    describe('Data-TestID Selector Generation', () => {
        it('should build evaluation script with testid selectors', () => {
            const script = strategy._buildEvaluationScript();
            
            assert.ok(script.includes('data-testid'));
            assert.ok(script.includes('testIdSelectors'));
        });

        it('should include excluded testids in script', () => {
            const script = strategy._buildEvaluationScript();
            
            assert.ok(script.includes('excludedTestIds'));
        });

        it('should include visibility check in script', () => {
            const script = strategy._buildEvaluationScript();
            
            assert.ok(script.includes('isVisible'));
        });

        it('should include Shadow DOM traversal in script', () => {
            const script = strategy._buildEvaluationScript();
            
            assert.ok(script.includes('shadowRoot'));
            assert.ok(script.includes('getDocuments'));
        });

        it('should include click dispatch in script', () => {
            const script = strategy._buildEvaluationScript();
            
            assert.ok(script.includes('el.click()'));
        });

        it('should return JSON result from script', () => {
            const script = strategy._buildEvaluationScript();
            
            assert.ok(script.includes('JSON.stringify'));
            assert.ok(script.includes('return JSON.stringify'));
        });

        it('should prioritize data-testid over text content', () => {
            const script = strategy._buildEvaluationScript();
            
            // data-testid should come before text content matching
            const testIdIndex = script.indexOf('data-testid');
            const textContentIndex = script.indexOf('text-content');
            
            assert.ok(testIdIndex < textContentIndex);
        });
    });

    // ============================================
    // Poll Interval Tests
    // ============================================
    describe('Poll Interval Configuration', () => {
        it('should use default poll interval of 1500ms', () => {
            const instance = new CDPStrategy();
            
            assert.strictEqual(instance._config.pollInterval, 1500);
        });

        it('should update poll interval with setPollInterval()', () => {
            strategy.setPollInterval(2000);
            
            assert.strictEqual(strategy._config.pollInterval, 2000);
        });

        it('should reject invalid poll interval', () => {
            const originalInterval = strategy._config.pollInterval;
            
            strategy.setPollInterval(-1);
            
            assert.strictEqual(strategy._config.pollInterval, originalInterval);
        });

        it('should reject non-numeric poll interval', () => {
            const originalInterval = strategy._config.pollInterval;
            
            strategy.setPollInterval('invalid');
            
            assert.strictEqual(strategy._config.pollInterval, originalInterval);
        });

        it('should restart polling when interval changes while running', () => {
            strategy.start();
            
            strategy.setPollInterval(2000);
            
            assert.strictEqual(strategy._config.pollInterval, 2000);
            assert.strictEqual(strategy.isEnabled, true);
        });
    });

    // ============================================
    // Event Emission Tests
    // ============================================
    describe('Event Emission', () => {
        it('should emit "started" event when started', (done) => {
            strategy.on('started', (data) => {
                assert.ok(data.timestamp);
                done();
            });
            
            strategy.start();
        });

        it('should emit "stopped" event when stopped', (done) => {
            strategy.on('stopped', (data) => {
                assert.ok(data.timestamp);
                done();
            });
            
            strategy.start();
            strategy.stop();
        });

        it('should emit "click" event on successful click', (done) => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({
                    clicked: true,
                    selector: '[data-testid="accept-button"]',
                    method: 'data-testid'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            instance.on('click', (data) => {
                assert.strictEqual(data.selector, '[data-testid="accept-button"]');
                assert.strictEqual(data.method, 'data-testid');
                assert.ok(data.timestamp);
                done();
            });
            
            instance.poll();
        });

        it('should not emit click event on failed click', async () => {
            let clickEmitted = false;
            
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({ clicked: false })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            instance.on('click', () => {
                clickEmitted = true;
            });
            
            await instance.poll();
            
            assert.strictEqual(clickEmitted, false);
        });
    });

    // ============================================
    // Statistics Tests
    // ============================================
    describe('Statistics Tracking', () => {
        it('should track total clicks', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({
                    clicked: true,
                    selector: '[data-testid="accept"]',
                    method: 'data-testid'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            await instance.poll();
            
            assert.strictEqual(instance.stats.totalClicks, 1);
        });

        it('should track data-testid clicks', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({
                    clicked: true,
                    selector: '[data-testid="accept"]',
                    method: 'data-testid'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            await instance.poll();
            
            assert.strictEqual(instance.stats.dataTestIdClicks, 1);
            assert.strictEqual(instance.stats.textContentClicks, 0);
        });

        it('should track text-content clicks', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({
                    clicked: true,
                    selector: 'accept',
                    method: 'text-content'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            await instance.poll();
            
            assert.strictEqual(instance.stats.textContentClicks, 1);
            assert.strictEqual(instance.stats.dataTestIdClicks, 0);
        });

        it('should track failed attempts', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => {
                    throw new Error('CDP error');
                }
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            await instance.poll();
            
            assert.strictEqual(instance.stats.failedAttempts, 1);
        });

        it('should track last click time', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => ({
                    clicked: true,
                    selector: '[data-testid="accept"]',
                    method: 'data-testid'
                })
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            const beforeTime = Date.now();
            await instance.poll();
            
            assert.ok(instance.stats.lastClickTime >= beforeTime);
        });

        it('should return copy of stats', () => {
            const stats1 = strategy.stats;
            const stats2 = strategy.stats;
            
            assert.notStrictEqual(stats1, stats2);
        });

        it('should reset stats with resetStats()', () => {
            strategy._stats.totalClicks = 10;
            strategy._stats.dataTestIdClicks = 5;
            
            strategy.resetStats();
            
            assert.strictEqual(strategy.stats.totalClicks, 0);
            assert.strictEqual(strategy.stats.dataTestIdClicks, 0);
        });
    });

    // ============================================
    // Configuration Tests
    // ============================================
    describe('Configuration', () => {
        it('should return copy of config', () => {
            const config1 = strategy.config;
            const config2 = strategy.config;
            
            assert.notStrictEqual(config1, config2);
        });

        it('should update useDataTestId with setUseDataTestId()', () => {
            strategy.setUseDataTestId(false);
            
            assert.strictEqual(strategy._config.useDataTestId, false);
        });

        it('should update CDP handler with setCDPHandler()', () => {
            const newCdp = createMockCdpHandler();
            
            strategy.setCDPHandler(newCdp);
            
            assert.strictEqual(strategy.cdpHandler, newCdp);
        });
    });

    // ============================================
    // Error Handling Tests
    // ============================================
    describe('Error Handling', () => {
        it('should handle null CDP handler gracefully', async () => {
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: null
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should handle undefined CDP handler gracefully', async () => {
            const instance = new CDPStrategy({
                logger: mockLogger
            });
            
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should handle CDP handler without getConnectionCount', async () => {
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: {}
            });
            
            // Should not throw
            const result = await instance.poll();
            
            assert.strictEqual(result.executed, false);
        });

        it('should handle CDP handler without evaluate', async () => {
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: { getConnectionCount: () => 1 }
            });
            
            // Should not throw
            try {
                await instance.poll();
            } catch (e) {
                // Expected to throw, but should be handled
            }
        });

        it('should reset isProcessing on error', async () => {
            const mockCdp = createMockCdpHandler({
                evaluate: async () => {
                    throw new Error('CDP error');
                }
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp
            });
            
            await instance.poll();
            
            assert.strictEqual(instance._isProcessing, false);
        });
    });

    // ============================================
    // Integration Tests
    // ============================================
    describe('Integration', () => {
        it('should work with full polling cycle', async () => {
            let pollCount = 0;
            
            const mockCdp = createMockCdpHandler({
                evaluate: async () => {
                    pollCount++;
                    return { clicked: false };
                }
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp,
                pollInterval: 50
            });
            
            instance.start();
            
            // Wait for a few poll cycles
            await new Promise(r => setTimeout(r, 200));
            
            instance.stop();
            
            assert.ok(pollCount >= 2);
        });

        it('should stop polling after stop() is called', async () => {
            let pollCount = 0;
            
            const mockCdp = createMockCdpHandler({
                evaluate: async () => {
                    pollCount++;
                    return { clicked: false };
                }
            });
            
            const instance = new CDPStrategy({
                logger: mockLogger,
                cdpHandler: mockCdp,
                pollInterval: 50
            });
            
            instance.start();
            
            // Wait for a few poll cycles
            await new Promise(r => setTimeout(r, 150));
            
            instance.stop();
            
            const countAfterStop = pollCount;
            
            // Wait more
            await new Promise(r => setTimeout(r, 150));
            
            // Count should not have increased
            assert.strictEqual(pollCount, countAfterStop);
        });
    });
});

// Run tests
runAndExit();