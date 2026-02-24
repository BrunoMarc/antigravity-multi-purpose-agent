/**
 * Platform Strategies for Antigravity Process Discovery
 * 
 * Ported from AntigravityQuota/src/core/platform_strategies.ts
 */

'use strict';

/**
 * Base Strategy - Contains shared functionality for all platform strategies
 */
class BaseStrategy {
    /**
     * Shared port parsing logic for all strategies
     * @param {string} stdout - Command output
     * @param {RegExp} portRegex - Regular expression to extract ports
     * @param {function} [customParser] - Optional custom parsing function (for PowerShell JSON output)
     * @returns {number[]} Sorted array of unique ports
     */
    parseListeningPorts(stdout, portRegex, customParser = null) {
        const ports = [];

        if (customParser) {
            const customPorts = customParser(stdout);
            customPorts.forEach(port => {
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            });
        }

        let match;
        while ((match = portRegex.exec(stdout)) !== null) {
            const port = parseInt(match[1], 10);
            if (!ports.includes(port)) {
                ports.push(port);
            }
        }

        return ports.sort((a, b) => a - b);
    }

    /**
     * Shared extension port parsing from command line
     * @param {string} commandLine - Process command line
     * @returns {number} Extension server port or 0 if not found
     */
    parseExtensionPort(commandLine) {
        const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
        return portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
    }

    /**
     * Shared CSRF token parsing from command line
     * @param {string} commandLine - Process command line
     * @returns {string} CSRF token or empty string if not found
     */
    parseCsrfToken(commandLine) {
        const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/i);
        return tokenMatch && tokenMatch[1] ? tokenMatch[1] : '';
    }
}

/**
 * Windows Strategy - Uses PowerShell/WMIC to find the language_server process
 */
class WindowsStrategy extends BaseStrategy {
    constructor() {
        super();
        this.usePowerShell = true;
    }

    /**
     * Check if a command line belongs to an Antigravity process.
     * @param {string} commandLine - The process command line
     * @returns {boolean}
     */
    isAntigravityProcess(commandLine) {
        const lowerCmd = commandLine.toLowerCase();

        // Check for --app_data_dir antigravity parameter
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }

        // Check for antigravity in the path
        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) {
            return true;
        }

        return false;
    }

    /**
     * Get the command to list processes
     * @param {string} processName - Name of the process to find
     * @returns {string}
     */
    getProcessListCommand(processName) {
        if (this.usePowerShell) {
            return `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
        }
        return `wmic process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
    }

    /**
     * Parse process info from command output
     * @param {string} stdout - Command output
     * @returns {{pid: number, extensionPort: number, csrfToken: string} | null}
     */
    parseProcessInfo(stdout) {
        // Try JSON parsing first (PowerShell output)
        if (this.usePowerShell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                let data = JSON.parse(stdout.trim());

                // Handle array response (multiple processes)
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        return null;
                    }

                    // Filter to only Antigravity processes
                    const antigravityProcesses = data.filter(
                        item => item.CommandLine && this.isAntigravityProcess(item.CommandLine)
                    );

                    if (antigravityProcesses.length === 0) {
                        return null;
                    }

                    data = antigravityProcesses[0];
                } else {
                    // Single object response
                    if (!data.CommandLine || !this.isAntigravityProcess(data.CommandLine)) {
                        return null;
                    }
                }

                const commandLine = data.CommandLine || '';
                const pid = data.ProcessId;

                if (!pid) {
                    return null;
                }

                // Extract port and token from command line
                const extensionPort = this.parseExtensionPort(commandLine);
                const csrfToken = this.parseCsrfToken(commandLine);

                if (!csrfToken) {
                    return null;
                }

                return { pid, extensionPort, csrfToken };
            } catch (e) {
                // Fall through to WMIC parsing
            }
        }

        // Fallback: WMIC format parsing
        const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);
        const candidates = [];

        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId=(\d+)/);
            const commandLineMatch = block.match(/CommandLine=(.+)/);

            if (!pidMatch || !commandLineMatch) {
                continue;
            }

            const commandLine = commandLineMatch[1].trim();

            if (!this.isAntigravityProcess(commandLine)) {
                continue;
            }

            const extensionPort = this.parseExtensionPort(commandLine);
            const csrfToken = this.parseCsrfToken(commandLine);

            if (!csrfToken) {
                continue;
            }

            const pid = parseInt(pidMatch[1], 10);

            candidates.push({ pid, extensionPort, csrfToken });
        }

        return candidates.length > 0 ? candidates[0] : null;
    }

    /**
     * Get command to list listening ports for a PID
     * @param {number} pid - Process ID
     * @returns {string}
     */
    getPortListCommand(pid) {
        if (this.usePowerShell) {
            return `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
        }
        return `netstat -ano | findstr "${pid}"`;
    }

    /**
     * Parse listening ports from command output
     * @param {string} stdout - Command output
     * @param {number} pid - Process ID
     * @returns {number[]}
     */
    parseListeningPorts(stdout, pid) {
        const customParser = (output) => {
            const customPorts = [];
            if (this.usePowerShell) {
                try {
                    const data = JSON.parse(output.trim());
                    if (Array.isArray(data)) {
                        for (const port of data) {
                            if (typeof port === 'number') {
                                customPorts.push(port);
                            }
                        }
                    } else if (typeof data === 'number') {
                        customPorts.push(data);
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            }
            return customPorts;
        };

        const portRegex = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):(\\d+)\\s+(?:0\\.0\\.0\\.0:0|\\[::\\]:0|\\*:\\*).*?\\s+${pid}$`, 'gim');
        return super.parseListeningPorts(stdout, portRegex, customParser);
    }
}

/**
 * Unix Strategy - Placeholder for macOS/Linux support
 */
class UnixStrategy extends BaseStrategy {
    constructor(platform) {
        super();
        this.platform = platform;
    }

    getProcessListCommand(processName) {
        if (this.platform === 'darwin') {
            return `pgrep -fl ${processName}`;
        }
        return `pgrep -af ${processName}`;
    }

    parseProcessInfo(stdout) {
        if (!stdout || typeof stdout !== 'string') {
            return null;
        }

        const lines = stdout.split('\n');
        for (const line of lines) {
            if (!line || !line.includes('--extension_server_port')) {
                continue;
            }

            try {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 2) {
                    continue;
                }

                const pid = parseInt(parts[0], 10);
                if (isNaN(pid) || pid <= 0) {
                    continue;
                }

                const cmd = line.substring(parts[0].length).trim();

                const extensionPort = this.parseExtensionPort(cmd);
                const csrfToken = this.parseCsrfToken(cmd);

                if (!csrfToken) {
                    continue;
                }

                return {
                    pid,
                    extensionPort,
                    csrfToken
                };
            } catch (e) {
                // Continue to next line on parse error
                continue;
            }
        }
        return null;
    }

    getPortListCommand(pid) {
        if (this.platform === 'darwin') {
            return `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`;
        }
        return `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
    }

    parseListeningPorts(stdout, pid) {
        const portRegex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
        return super.parseListeningPorts(stdout, portRegex);
    }
}

module.exports = { WindowsStrategy, UnixStrategy };
