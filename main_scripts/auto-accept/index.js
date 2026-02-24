/**
 * Hybrid Auto-Accept Module - Main Orchestrator
 * 
 * This module coordinates between VS Code command strategy (primary) and 
 * CDP strategy (fallback) for auto-accept functionality.
 * 
 * @module auto-accept
 */

const vscode = require('vscode');
const EventEmitter = require('events');
const { mixLogger } = require('../base-logger');

const { VSCodeCommandStrategy, AsyncLock, DEFAULT_COMMANDS, DELIBERATELY_EXCLUDED } = require('./vscode-command-strategy');
const { CDPStrategy, TESTID_SELECTORS, EXCLUDED_TESTIDS } = require('./cdp-strategy');
const { SafetyFilter, isCommandSafe, filterCommands, filterElements, DELIBERATELY_EXCLUDED_COMMANDS } = require('./safety-filter');

/**
 * @typedef {object} HybridAutoAcceptConfig
 * @property {boolean} enabled - Master toggle for hybrid auto-accept
 * @property {object} primaryStrategy - Primary strategy configuration
 * @property {boolean} primaryStrategy.enabled - Enable VS Code command polling
 * @property {number} primaryStrategy.pollInterval - Polling interval in ms
 * @property {string[]} primaryStrategy.commands - Commands to poll
 * @property {object} fallbackStrategy - Fallback strategy configuration
 * @property {boolean} fallbackStrategy.enabled - Enable CDP fallback
 * @property {number} fallbackStrategy.pollInterval - Fallback poll interval in ms
 * @property {boolean} fallbackStrategy.useDataTestId - Use data-testid selectors
 * @property {object} safety - Safety filter configuration
 * @property {string[]} safety.bannedCommands - Additional banned patterns
 * @property {string[]} safety.excludedCommands - Additional excluded commands
 * @property {boolean} safety.requireVisibility - Require visibility check
 */

/**
 * @typedef {object} AcceptResult
 * @property {boolean} success - Whether accept succeeded
 * @property {'vscode-command'|'cdp'|'none'} strategy - Strategy used
 * @property {string} [command] - Command that was executed
 * @property {string} [error] - Error message if failed
 * @property {number} timestamp - Timestamp of the result
 */

/**
 * @typedef {object} HybridStats
 * @property {number} totalAccepts - Total successful accepts
 * @property {number} primaryAccepts - Accepts via VS Code commands
 * @property {number} fallbackAccepts - Accepts via CDP
 * @property {number} blockedAttempts - Blocked by safety filter
 * @property {number} lastAcceptTime - Timestamp of last accept
 */

/**
 * Default configuration for HybridAutoAccept
 * @type {HybridAutoAcceptConfig}
 */
const DEFAULT_CONFIG = {
    enabled: true,
    primaryStrategy: {
        enabled: true,
        pollInterval: 500,
        commands: [...DEFAULT_COMMANDS]
    },
    fallbackStrategy: {
        enabled: true,
        pollInterval: 1500,
        useDataTestId: true
    },
    safety: {
        bannedCommands: [],
        excludedCommands: [],
        requireVisibility: true
    }
};

/**
 * HybridAutoAccept - Main orchestrator for auto-accept functionality
 * 
 * Coordinates between:
 * - Primary Strategy: VS Code commands (reliable, authoritative)
 * - Fallback Strategy: CDP with Shadow DOM handling
 * - Safety Layer: Banned/excluded commands filtering
 * 
 * @class HybridAutoAccept
 * @extends EventEmitter
 */
class HybridAutoAccept extends mixLogger(EventEmitter, 'HybridAutoAccept') {
    /**
     * Create a new HybridAutoAccept instance
     * 
     * @param {object} options - Configuration options
     * @param {vscode.ExtensionContext} [options.context] - VS Code extension context
     * @param {object} [options.cdpHandler] - CDP handler instance for fallback
     * @param {(msg: string) => void} [options.logger] - Logger function
     * @param {HybridAutoAcceptConfig} [options.config] - Custom configuration
     */
    constructor(options = {}) {
        super(options);
        
        this.context = options.context;
        this.cdpHandler = options.cdpHandler;
        
        // Load configuration
        this._config = this._loadConfig(options.config);
        
        // Initialize components
        this._primaryStrategy = null;
        this._fallbackStrategy = null;
        this._safetyFilter = null;
        
        // State
        this._isEnabled = false;
        this._lock = new AsyncLock();
        
        // Statistics
        this._stats = {
            totalAccepts: 0,
            primaryAccepts: 0,
            fallbackAccepts: 0,
            blockedAttempts: 0,
            lastAcceptTime: 0,
            startTime: null
        };
        
        // Analytics integration
        this._analytics = null;
    }

    /**
     * Check if hybrid auto-accept is currently enabled
     * @returns {boolean}
     */
    get isEnabled() {
        return this._isEnabled;
    }

    /**
     * Get current configuration
     * @returns {HybridAutoAcceptConfig}
     */
    get config() {
        return { ...this._config };
    }

    /**
     * Get current statistics
     * @returns {HybridStats}
     */
    get stats() {
        return { ...this._stats };
    }

    /**
     * Load and merge configuration
     * @param {Partial<HybridAutoAcceptConfig>} customConfig
     * @returns {HybridAutoAcceptConfig}
     * @private
     */
    _loadConfig(customConfig = {}) {
        // Try to load from VS Code settings if available
        let vsCodeConfig = {};
        try {
            if (vscode.workspace && vscode.workspace.getConfiguration) {
                const settings = vscode.workspace.getConfiguration('auto-accept.hybrid');
                if (settings) {
                    vsCodeConfig = {
                        enabled: settings.get('enabled', DEFAULT_CONFIG.enabled),
                        primaryStrategy: {
                            enabled: settings.get('primaryStrategy.enabled', DEFAULT_CONFIG.primaryStrategy.enabled),
                            pollInterval: settings.get('primaryStrategy.pollInterval', DEFAULT_CONFIG.primaryStrategy.pollInterval),
                            commands: settings.get('primaryStrategy.commands', DEFAULT_CONFIG.primaryStrategy.commands)
                        },
                        fallbackStrategy: {
                            enabled: settings.get('fallbackStrategy.enabled', DEFAULT_CONFIG.fallbackStrategy.enabled),
                            pollInterval: settings.get('fallbackStrategy.pollInterval', DEFAULT_CONFIG.fallbackStrategy.pollInterval),
                            useDataTestId: settings.get('fallbackStrategy.useDataTestId', DEFAULT_CONFIG.fallbackStrategy.useDataTestId)
                        },
                        safety: {
                            bannedCommands: settings.get('safety.bannedCommands', DEFAULT_CONFIG.safety.bannedCommands),
                            excludedCommands: settings.get('safety.excludedCommands', DEFAULT_CONFIG.safety.excludedCommands),
                            requireVisibility: settings.get('safety.requireVisibility', DEFAULT_CONFIG.safety.requireVisibility)
                        }
                    };
                }
            }
        } catch (error) {
            this._log(`Could not load VS Code settings: ${error.message}`);
        }

        // Merge configurations: defaults < VS Code settings < custom config
        return this._mergeConfig(DEFAULT_CONFIG, vsCodeConfig, customConfig);
    }

    /**
     * Deep merge configuration objects
     * @param {object} target - Target object
     * @param {...object} sources - Source objects
     * @returns {object}
     * @private
     */
    _mergeConfig(target, ...sources) {
        const result = { ...target };
        
        for (const source of sources) {
            if (!source || typeof source !== 'object') continue;
            
            for (const key of Object.keys(source)) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    result[key] = this._mergeConfig(result[key] || {}, source[key]);
                } else if (source[key] !== undefined) {
                    result[key] = source[key];
                }
            }
        }
        
        return result;
    }

    /**
     * Start the hybrid auto-accept polling
     * 
     * @returns {Promise<void>}
     */
    async start() {
        if (this._isEnabled) {
            this._log('HybridAutoAccept already running');
            return;
        }

        if (!this._config.enabled) {
            this._log('HybridAutoAccept is disabled by configuration');
            return;
        }

        this._log('Starting HybridAutoAccept...');
        
        // Initialize safety filter
        this._safetyFilter = new SafetyFilter({
            bannedPatterns: this._config.safety.bannedCommands,
            excludedCommands: this._config.safety.excludedCommands,
            requireVisibility: this._config.safety.requireVisibility,
            logger: this.logger
        });

        // Initialize primary strategy (VS Code commands)
        if (this._config.primaryStrategy.enabled) {
            this._primaryStrategy = new VSCodeCommandStrategy({
                pollInterval: this._config.primaryStrategy.pollInterval,
                commands: this._config.primaryStrategy.commands,
                logger: this.logger
            });
            
            // Wire up events
            this._primaryStrategy.on('commandExecuted', (data) => {
                this._handlePrimarySuccess(data);
            });
            
            this._primaryStrategy.on('clickTracked', (data) => {
                this._handleClickTracked(data);
            });
        }

        // Initialize fallback strategy (CDP)
        if (this._config.fallbackStrategy.enabled && this.cdpHandler) {
            this._initFallbackStrategy();
        }

        // Start strategies
        if (this._primaryStrategy) {
            this._primaryStrategy.start();
        }

        // Start fallback CDP strategy for background polling.
        // The safety filter + visibility checks prevent unintended clicks.
        if (this._fallbackStrategy) {
            this._fallbackStrategy.start();
            this._log('Fallback CDP strategy started for background polling');
        }

        this._isEnabled = true;
        this._stats.startTime = Date.now();
        
        this._log('HybridAutoAccept started successfully');
        
        // Emit start event
        this.emit('started', { timestamp: this._stats.startTime });
    }

    /**
     * Initialize the fallback strategy (CDP)
     * @private
     */
    _initFallbackStrategy() {
        this._fallbackStrategy = new CDPStrategy({
            cdpHandler: this.cdpHandler,
            logger: this.logger,
            pollInterval: this._config.fallbackStrategy.pollInterval,
            useDataTestId: this._config.fallbackStrategy.useDataTestId
        });
        
        // Wire up events
        this._fallbackStrategy.on('click', (data) => {
            this._handleFallbackSuccess(data);
        });
        
        this._fallbackStrategy.on('started', (data) => {
            this._log('[Fallback] CDP strategy started');
            this.emit('fallbackStarted', data);
        });
        
        this._fallbackStrategy.on('stopped', (data) => {
            this._log('[Fallback] CDP strategy stopped');
            this.emit('fallbackStopped', data);
        });
    }
    
    /**
     * Handle successful fallback strategy execution
     * 
     * @param {object} data - Event data
     * @param {string} data.selector - Selector that was clicked
     * @param {string} data.method - Method used (data-testid or text-content)
     * @param {number} data.timestamp - Execution timestamp
     * @private
     */
    _handleFallbackSuccess(data) {
        this._stats.totalAccepts++;
        this._stats.fallbackAccepts++;
        this._stats.lastAcceptTime = data.timestamp;
        
        this._log(`[Fallback] Success: ${data.selector} (${data.method})`);
        
        // Emit accept event
        this.emit('accept', {
            strategy: 'cdp',
            selector: data.selector,
            method: data.method,
            timestamp: data.timestamp
        });
    }

    /**
     * Stop all polling
     * 
     * @returns {Promise<void>}
     */
    async stop() {
        if (!this._isEnabled) {
            return;
        }

        this._log('Stopping HybridAutoAccept...');

        // Stop primary strategy
        if (this._primaryStrategy) {
            this._primaryStrategy.stop();
        }

        // Stop fallback strategy
        if (this._fallbackStrategy) {
            this._fallbackStrategy.stop();
        }

        this._isEnabled = false;
        
        this._log('HybridAutoAccept stopped');
        
        // Emit stop event
        this.emit('stopped', { timestamp: Date.now() });
    }

    /**
     * Handle successful primary strategy execution
     * 
     * @param {object} data - Event data
     * @param {string} data.command - Command that was executed
     * @param {number} data.timestamp - Execution timestamp
     * @private
     */
    _handlePrimarySuccess(data) {
        this._stats.totalAccepts++;
        this._stats.primaryAccepts++;
        this._stats.lastAcceptTime = data.timestamp;
        
        this._log(`[Primary] Success: ${data.command}`);
        
        // Emit accept event
        this.emit('accept', {
            strategy: 'vscode-command',
            command: data.command,
            timestamp: data.timestamp
        });
    }

    /**
     * Handle click tracked event from primary strategy
     * 
     * @param {object} data - Event data
     * @param {string} data.command - Command that was tracked
     * @param {number} data.timestamp - Tracking timestamp
     * @private
     */
    _handleClickTracked(data) {
        // Integrate with analytics module if available
        if (this._analytics && typeof this._analytics.trackClick === 'function') {
            this._analytics.trackClick(data.command, this.logger);
        }
        
        // Emit click tracked event
        this.emit('clickTracked', data);
    }

    /**
     * Execute a single poll cycle manually
     * 
     * @returns {Promise<AcceptResult>}
     */
    async poll() {
        return this._lock.acquire('poll', async () => {
            if (!this._isEnabled) {
                return { success: false, strategy: 'none', error: 'Not enabled', timestamp: Date.now() };
            }

            // Try primary strategy first
            if (this._primaryStrategy && this._primaryStrategy.isEnabled) {
                try {
                    const result = await this._primaryStrategy.poll();
                    
                    if (result.executed) {
                        return {
                            success: true,
                            strategy: 'vscode-command',
                            command: result.command,
                            timestamp: Date.now()
                        };
                    }
                } catch (error) {
                    this._log(`Primary strategy error: ${error.message}`);
                }
            }

            // Always try CDP fallback regardless of primary result.
            // Primary commands often resolve silently without acting.
            if (this._fallbackStrategy) {
                try {
                    const result = await this._fallbackStrategy.poll();
                    
                    if (result.executed) {
                        this._stats.totalAccepts++;
                        this._stats.fallbackAccepts++;
                        this._stats.lastAcceptTime = Date.now();
                        
                        this._log(`[Fallback] Success: ${result.selector}`);
                        
                        return {
                            success: true,
                            strategy: 'cdp',
                            selector: result.selector,
                            timestamp: this._stats.lastAcceptTime
                        };
                    }
                } catch (error) {
                    this._log(`Fallback strategy error: ${error.message}`);
                }
            }

            return { success: false, strategy: 'none', timestamp: Date.now() };
        });
    }

    /**
     * Update configuration at runtime
     * 
     * @param {Partial<HybridAutoAcceptConfig>} newConfig - New configuration values
     * @returns {void}
     */
    updateConfig(newConfig) {
        this._config = this._mergeConfig(this._config, newConfig);
        this._log('Configuration updated');
        
        // Apply changes to strategies
        if (this._primaryStrategy && newConfig.primaryStrategy) {
            if (newConfig.primaryStrategy.pollInterval) {
                this._primaryStrategy.setPollInterval(newConfig.primaryStrategy.pollInterval);
            }
            if (newConfig.primaryStrategy.commands) {
                this._primaryStrategy.setCommands(newConfig.primaryStrategy.commands);
            }
        }
        
        if (this._safetyFilter && newConfig.safety) {
            if (newConfig.safety.bannedCommands) {
                newConfig.safety.bannedCommands.forEach(p => 
                    this._safetyFilter.addBannedPattern(p)
                );
            }
            if (newConfig.safety.excludedCommands) {
                newConfig.safety.excludedCommands.forEach(cmd => 
                    this._safetyFilter.addExcludedCommand(cmd)
                );
            }
        }
        
        // Emit config change event
        this.emit('configChanged', { config: this._config });
    }

    /**
     * Set the analytics module for integration
     * 
     * @param {object} analytics - Analytics module instance
     * @returns {void}
     */
    setAnalytics(analytics) {
        this._analytics = analytics;
        this._log('Analytics module integrated');
    }

    /**
     * Get current status summary
     * 
     * @returns {object}
     */
    getStatus() {
        return {
            enabled: this._isEnabled,
            config: this._config,
            stats: this._stats,
            primaryStrategy: this._primaryStrategy ? {
                enabled: this._primaryStrategy.isEnabled,
                stats: this._primaryStrategy.stats
            } : null,
            fallbackStrategy: this._fallbackStrategy ? {
                enabled: this._fallbackStrategy.isEnabled
            } : null,
            safetyFilter: this._safetyFilter ? {
                config: this._safetyFilter.getConfig(),
                stats: this._safetyFilter.getStats()
            } : null
        };
    }

    /**
     * Reset all statistics
     * 
     * @returns {void}
     */
    resetStats() {
        this._stats = {
            totalAccepts: 0,
            primaryAccepts: 0,
            fallbackAccepts: 0,
            blockedAttempts: 0,
            lastAcceptTime: 0,
            startTime: this._isEnabled ? Date.now() : null
        };
        
        if (this._primaryStrategy) {
            this._primaryStrategy.resetStats();
        }
        
        if (this._safetyFilter) {
            this._safetyFilter.resetStats();
        }
        
        this._log('Statistics reset');
    }

    /**
     * Dispose of all resources
     * 
     * @returns {void}
     */
    dispose() {
        this.stop();
        
        if (this._primaryStrategy) {
            this._primaryStrategy.dispose();
            this._primaryStrategy = null;
        }
        
        if (this._fallbackStrategy) {
            this._fallbackStrategy.stop();
            this._fallbackStrategy = null;
        }
        
        this._safetyFilter = null;
        this._analytics = null;
        
        this.removeAllListeners();
        
        this._log('HybridAutoAccept disposed');
    }

}

// Export main class and utilities
module.exports = {
    HybridAutoAccept,
    VSCodeCommandStrategy,
    CDPStrategy,
    SafetyFilter,
    AsyncLock,
    isCommandSafe,
    filterCommands,
    filterElements,
    DEFAULT_COMMANDS,
    DELIBERATELY_EXCLUDED,
    DELIBERATELY_EXCLUDED_COMMANDS,
    TESTID_SELECTORS,
    EXCLUDED_TESTIDS,
    DEFAULT_CONFIG
};
