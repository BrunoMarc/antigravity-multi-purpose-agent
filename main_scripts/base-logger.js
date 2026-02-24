/**
 * Logging Mixin
 * 
 * Provides a standard logging implementation that can be mixed into other classes.
 * This eliminates the need for duplicate logging methods across the codebase.
 * 
 * Usage:
 * class MyClass extends mixLogger(EventEmitter, 'MyPrefix') {
 *   constructor() {
 *     super();
 *   }
 * }
 */

function mixLogger(BaseClass, defaultPrefix = '') {
    return class extends BaseClass {
        /**
         * Create a new logger instance
         * @param {Object} options - Configuration options
         * @param {(msg: string) => void} [options.logger] - Custom logger function
         * @param {string} [options.prefix] - Prefix to use for all log messages
         */
        constructor(options = {}) {
            super();
            
            // Handle case where logger might be passed directly
            const logger = typeof options === 'function' ? options : options.logger || console.log;
            const prefix = options.prefix || defaultPrefix;
            
            this.logger = logger;
            this.prefix = prefix;
        }

        /**
         * Internal logging function
         * @param {string} message - The message to log
         * @private
         */
        _log(message) {
            if (this.logger) {
                if (this.prefix) {
                    this.logger(`[${this.prefix}] ${message}`);
                } else {
                    this.logger(message);
                }
            }
        }

        /**
         * Log an error message
         * @param {string} message - The error message to log
         */
        _logError(message) {
            const errorPrefix = this.prefix ? `[${this.prefix}] ERROR: ` : 'ERROR: ';
            if (this.logger) {
                this.logger(errorPrefix + message);
            } else {
                console.error(errorPrefix + message);
            }
        }
    };
}

/**
 * Base Logger Class
 * 
 * For classes that don't need to extend other base classes
 */
class BaseLogger {
    /**
     * Create a new logger instance
     * @param {Function} logger - Custom logger function (optional)
     * @param {string} prefix - Prefix to use for all log messages (optional)
     */
    constructor(logger = console.log, prefix = '') {
        this.logger = logger;
        this.prefix = prefix;
    }

    /**
     * Internal logging function
     * @param {string} message - The message to log
     * @private
     */
    _log(message) {
        if (this.logger) {
            if (this.prefix) {
                this.logger(`[${this.prefix}] ${message}`);
            } else {
                this.logger(message);
            }
        }
    }

    /**
     * Log an error message
     * @param {string} message - The error message to log
     */
    _logError(message) {
        const errorPrefix = this.prefix ? `[${this.prefix}] ERROR: ` : 'ERROR: ';
        if (this.logger) {
            this.logger(errorPrefix + message);
        } else {
            console.error(errorPrefix + message);
        }
    }
}

module.exports = { mixLogger, BaseLogger };
