/**
 * VS Code Command Strategy for Hybrid Auto-Accept
 * 
 * This module implements the primary strategy for auto-accept functionality
 * by polling VS Code commands directly through the VS Code API.
 * 
 * @module vscode-command-strategy
 */

const vscode = require('vscode');
const EventEmitter = require('events');
const { mixLogger } = require('../base-logger');
const { DELIBERATELY_EXCLUDED_COMMANDS, SafetyFilter } = require('./safety-filter');

// Create a safety filter instance for command checking
const safetyFilter = new SafetyFilter({ logger: null });

/**
 * Default commands to poll for auto-accept
 * @type {string[]}
 */
const DEFAULT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept'
];

/**
 * Commands that are deliberately excluded for safety
 * Imported from safety-filter.js as single source of truth
 * @type {string[]}
 */
const DELIBERATELY_EXCLUDED = DELIBERATELY_EXCLUDED_COMMANDS;

/**
 * Simple async lock implementation for preventing concurrent execution
 */
class AsyncLock {
    constructor() {
        this.locks = new Map();
    }

    /**
     * Acquire a lock and execute the callback
     * @param {string} key - Lock key
     * @param {() => Promise<T>} callback - Async callback to execute
     * @returns {Promise<T>}
     * @template T
     */
    async acquire(key, callback) {
        // Wait for existing lock to release
        while (this.locks.has(key)) {
            await this.locks.get(key);
        }

        // Create new lock
        let releaseLock;
        const lockPromise = new Promise(resolve => {
            releaseLock = resolve;
        });
        this.locks.set(key, lockPromise);

        try {
            return await callback();
        } finally {
            this.locks.delete(key);
            releaseLock();
        }
    }

    /**
     * Check if a lock is currently held
     * @param {string} key
     * @returns {boolean}
     */
    isLocked(key) {
        return this.locks.has(key);
    }
}

/**
 * VS Code Command Strategy
 * 
 * Primary strategy that polls VS Code commands for auto-accept functionality.
 * Uses the VS Code commands API to execute accept actions directly.
 * 
 * @class VSCodeCommandStrategy
 * @extends EventEmitter
 */
class VSCodeCommandStrategy extends mixLogger(EventEmitter, 'VSCodeCommandStrategy') {
    /**
     * Create a new VS Code Command Strategy instance
     * 
     * @param {object} config - Configuration options
     * @param {number} [config.pollInterval=500] - Polling interval in milliseconds
     * @param {string[]} [config.commands] - Commands to poll
     * @param {(msg: string) => void} [config.logger] - Logger function
     */
    constructor(config = {}) {
        super(config);
        
        this.pollInterval = config.pollInterval || 500;
        this.commands = config.commands || [...DEFAULT_COMMANDS];
        
        this._timer = null;
        this._isEnabled = false;
        this._isProcessing = false;
        this._lock = new AsyncLock();
        
        // Statistics tracking
        this._stats = {
            totalPolls: 0,
            commandsExecuted: 0,
            commandsFailed: 0,
            lastExecutionTime: 0
        };
    }

    /**
     * Check if the strategy is currently enabled and polling
     * @returns {boolean}
     */
    get isEnabled() {
        return this._isEnabled;
    }

    /**
     * Get current statistics
     * @returns {object}
     */
    get stats() {
        return { ...this._stats };
    }

    /**
     * Start polling for available commands
     * 
     * @returns {void}
     */
    start() {
        if (this._isEnabled) {
            this._log('VSCodeCommandStrategy already running');
            return;
        }

        this._isEnabled = true;
        this._log(`Starting VS Code command polling (interval: ${this.pollInterval}ms)`);
        
        // Start the polling loop
        this._scheduleNextPoll();
    }

    /**
     * Stop polling
     * 
     * @returns {void}
     */
    stop() {
        if (!this._isEnabled) {
            return;
        }

        this._isEnabled = false;
        
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        
        this._log('VS Code command polling stopped');
    }

    /**
     * Schedule the next poll cycle
     * @private
     */
    _scheduleNextPoll() {
        if (!this._isEnabled) {
            return;
        }

        this._timer = setTimeout(() => {
            this._executePollCycle()
                .catch(err => this._log(`Poll cycle error: ${err.message}`))
                .finally(() => this._scheduleNextPoll());
        }, this.pollInterval);
    }

    /**
     * Execute a single poll cycle
     * 
     * @returns {Promise<{executed: boolean, command?: string, error?: string}>}
     */
    async poll() {
        return this._lock.acquire('poll', async () => {
            if (this._isProcessing) {
                return { executed: false, error: 'Already processing' };
            }

            this._isProcessing = true;
            this._stats.totalPolls++;

            try {
                const results = await this._executeAllCommands();
                
                const executed = results.some(r => r.status === 'fulfilled' && r.value?.executed);
                const successfulResult = results.find(r => r.status === 'fulfilled' && r.value?.executed);

                if (executed && successfulResult) {
                    this._stats.commandsExecuted++;
                    this._stats.lastExecutionTime = Date.now();
                    
                    // Emit event for analytics
                    this.emit('commandExecuted', {
                        command: successfulResult.value.command,
                        timestamp: this._stats.lastExecutionTime
                    });
                    
                    return { executed: true, command: successfulResult.value.command };
                }

                return { executed: false };
            } catch (error) {
                this._stats.commandsFailed++;
                this._log(`Poll error: ${error.message}`);
                return { executed: false, error: error.message };
            } finally {
                this._isProcessing = false;
            }
        });
    }

    /**
     * Execute all commands using Promise.allSettled
     * 
     * @returns {Promise<PromiseSettledResult<{executed: boolean, command?: string}>[]>}
     * @private
     */
    async _executeAllCommands() {
        // Get all available commands from VS Code
        let availableCommands = [];
        try {
            availableCommands = await vscode.commands.getCommands(true);
        } catch (error) {
            this._log(`Failed to get available commands: ${error.message}`);
            return [];
        }

        // Filter to only commands that are available and not excluded
        const commandsToExecute = this.commands.filter(cmd =>
            availableCommands.includes(cmd) &&
            safetyFilter.checkCommand(cmd).safe
        );

        // Execute all commands using Promise.allSettled
        // NOTE: VS Code commands often resolve successfully even when they don't
        // actually do anything (no pending action). We only count a command as
        // "executed" if it returns a truthy value, which indicates real action.
        const commandPromises = commandsToExecute.map(async (command) => {
            try {
                // Try to execute the command
                const result = await vscode.commands.executeCommand(command);
                
                // Only treat as executed if the command returned a truthy value.
                // Commands that resolve with undefined/null are no-ops.
                if (result) {
                    this._log(`[Primary] Executed command: ${command} (result: ${String(result).substring(0, 50)})`);
                    
                    // Emit click tracked event
                    this.emit('clickTracked', { command, timestamp: Date.now() });
                    
                    return { executed: true, command };
                }
                
                return { executed: false, command };
            } catch (error) {
                // Command execution failed - this is expected for commands that aren't applicable
                // Don't log as error since this is normal behavior
                return { executed: false, command, error: error.message };
            }
        });

        return Promise.allSettled(commandPromises);
    }

    /**
     * Execute a single poll cycle (internal)
     * 
     * @returns {Promise<void>}
     * @private
     */
    async _executePollCycle() {
        if (!this._isEnabled) {
            return;
        }

        await this.poll();
    }

    /**
     * Check if a command is currently available in VS Code
     * 
     * @param {string} commandId - The command ID to check
     * @returns {Promise<boolean>}
     */
    async isCommandAvailable(commandId) {
        try {
            const commands = await vscode.commands.getCommands(true);
            return commands.includes(commandId);
        } catch {
            return false;
        }
    }

    /**
     * Update the polling interval
     * 
     * @param {number} intervalMs - New interval in milliseconds
     * @returns {void}
     */
    setPollInterval(intervalMs) {
        if (typeof intervalMs !== 'number' || intervalMs < 50) {
            this._log('Invalid poll interval, must be >= 50ms');
            return;
        }
        
        this.pollInterval = intervalMs;
        this._log(`Poll interval updated to ${intervalMs}ms`);
    }

    /**
     * Update the commands list
     * 
     * @param {string[]} commands - New commands array
     * @returns {void}
     */
    setCommands(commands) {
        if (!Array.isArray(commands)) {
            this._log('Commands must be an array');
            return;
        }
        
        this.commands = commands;
        this._log(`Commands updated: ${commands.length} commands`);
    }

    /**
     * Add a command to the polling list
     * 
     * @param {string} command - Command ID to add
     * @returns {void}
     */
    addCommand(command) {
        if (!this.commands.includes(command)) {
            this.commands.push(command);
            this._log(`Command added: ${command}`);
        }
    }

    /**
     * Remove a command from the polling list
     * 
     * @param {string} command - Command ID to remove
     * @returns {void}
     */
    removeCommand(command) {
        const index = this.commands.indexOf(command);
        if (index !== -1) {
            this.commands.splice(index, 1);
            this._log(`Command removed: ${command}`);
        }
    }

    /**
     * Reset statistics
     * 
     * @returns {void}
     */
    resetStats() {
        this._stats = {
            totalPolls: 0,
            commandsExecuted: 0,
            commandsFailed: 0,
            lastExecutionTime: 0
        };
    }

    /**
     * Dispose of all resources
     * 
     * @returns {void}
     */
    dispose() {
        this.stop();
        this.removeAllListeners();
        this._log('VSCodeCommandStrategy disposed');
    }

}

module.exports = {
    VSCodeCommandStrategy,
    AsyncLock,
    DEFAULT_COMMANDS,
    DELIBERATELY_EXCLUDED
};
