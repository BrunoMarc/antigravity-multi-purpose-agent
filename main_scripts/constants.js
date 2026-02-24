/**
 * Centralized constants for the extension
 * 
 * This file contains all shared constants used across the extension to
 * prevent duplication and ensure consistency.
 */

// Chrome DevTools Protocol
const DEFAULT_CDP_PORT = 9004;

// Analytics and ROI
const SECONDS_PER_CLICK = 5;
const TIME_VARIANCE = 0.2; // +/- 20% variance for time saved calculations

// State management keys
const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
const ROI_STATS_KEY = 'auto-accept-roi-stats';
const CDP_SETUP_COMPLETED_KEY = 'cdp-setup-completed';
const EXTENSION_VERSION_KEY = 'extension-version';
const BOOT_RELAUNCH_PROMPTED_KEY = 'boot-relaunch-prompted';

// CDP availability
const CDP_AVAILABILITY_ATTEMPTS = 3;
const CDP_AVAILABILITY_RETRY_MS = 500;

// Debug server
const DEBUG_SERVER_PORT = 54321;

// Default configuration values
const DEFAULT_POLL_INTERVAL = 500;
const DEFAULT_CDP_STRATEGY_POLL_INTERVAL = 1500;

module.exports = {
    DEFAULT_CDP_PORT,
    SECONDS_PER_CLICK,
    TIME_VARIANCE,
    GLOBAL_STATE_KEY,
    FREQ_STATE_KEY,
    BANNED_COMMANDS_KEY,
    ROI_STATS_KEY,
    CDP_SETUP_COMPLETED_KEY,
    EXTENSION_VERSION_KEY,
    BOOT_RELAUNCH_PROMPTED_KEY,
    CDP_AVAILABILITY_ATTEMPTS,
    CDP_AVAILABILITY_RETRY_MS,
    DEBUG_SERVER_PORT,
    DEFAULT_POLL_INTERVAL,
    DEFAULT_CDP_STRATEGY_POLL_INTERVAL
};
