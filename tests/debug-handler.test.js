const assert = require('assert');
const Module = require('module');
const { describe, it, beforeEach, runAndExit } = require('./test-runner');

const scheduleState = {
    enabled: false,
    mode: 'interval',
    value: '30',
    prompt: 'Status report please',
    prompts: [],
    queueMode: 'consume',
    silenceTimeout: 30,
    'checkPrompt.enabled': false,
    'checkPrompt.text': ''
};

const quotaState = {
    enabled: true,
    pollInterval: 60
};

const quotaResumeState = {
    enabled: true
};

const autoContinueState = {
    enabled: false
};

const debugModeState = {
    enabled: true
};

let executeCalls = [];

const mockVscode = {
    ConfigurationTarget: {
        Global: 'Global'
    },
    commands: {
        executeCommand: async (command, ...args) => {
            executeCalls.push({ command, args });
            if (command === 'auto-accept.getAntigravityQuota') {
                return { ok: true };
            }
            if (command === 'auto-accept.getROIStats') {
                return { roi: 1 };
            }
            return true;
        },
        getCommands: async () => ['antigravity.agent.acceptAgentStep']
    },
    workspace: {
        getConfiguration: (section) => {
            const pickStore = () => {
                if (section === 'auto-accept.schedule') return scheduleState;
                if (section === 'auto-accept.antigravityQuota') return quotaState;
                if (section === 'auto-accept.antigravityQuota.resume') return quotaResumeState;
                if (section === 'auto-accept.autoContinue') return autoContinueState;
                if (section === 'auto-accept.debugMode') return debugModeState;
                return {};
            };

            const store = pickStore();
            return {
                get: (key, defaultValue) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue),
                update: async (key, value) => {
                    store[key] = value;
                    return true;
                }
            };
        }
    },
    env: {
        appName: 'VS Code Test',
        machineId: 'machine-test-id'
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalLoad.apply(this, arguments);
};

const { DebugHandler } = require('../main_scripts/debug-handler');

function resetConfigState() {
    scheduleState.enabled = false;
    scheduleState.mode = 'interval';
    scheduleState.value = '30';
    scheduleState.prompt = 'Status report please';
    scheduleState.prompts = [];
    scheduleState.queueMode = 'consume';
    scheduleState.silenceTimeout = 30;
    scheduleState['checkPrompt.enabled'] = false;
    scheduleState['checkPrompt.text'] = '';

    quotaState.enabled = true;
    quotaState.pollInterval = 60;
    quotaResumeState.enabled = true;
    autoContinueState.enabled = false;
    debugModeState.enabled = true;
}

function createTestContext() {
    const state = {
        'auto-accept-enabled-global': false,
        'auto-accept-frequency': 1000,
        'auto-accept-banned-commands': [],
        'auto-accept-stats': {}
    };

    return {
        extensionPath: process.cwd(),
        globalState: {
            get: (key, defaultValue) => (Object.prototype.hasOwnProperty.call(state, key) ? state[key] : defaultValue),
            update: async (key, value) => {
                state[key] = value;
                return true;
            }
        }
    };
}

describe('DebugHandler', () => {
    let context;
    let scheduler;
    let hybrid;
    let handler;

    beforeEach(() => {
        executeCalls = [];
        resetConfigState();

        context = createTestContext();
        scheduler = {
            cdpHandler: {
                getConnectionCount: () => 1,
                isEnabled: true,
                connections: new Map([['conn-1', { injected: true }]]),
                evaluate: async () => 'ok'
            },
            pauseQueue: () => true,
            resumeQueue: () => true,
            skipPrompt: async () => true,
            stopQueue: () => true,
            resetQueue: async () => true,
            sendPrompt: async () => true,
            getStatus: () => ({
                enabled: true,
                isRunningQueue: false,
                queueLength: 0,
                queueIndex: 0,
                isPaused: false,
                isQuotaExhausted: false
            }),
            getConversations: async () => [],
            getHistory: () => []
        };

        hybrid = {
            getStatus: () => ({ isEnabled: true }),
            poll: async () => ({ executed: false }),
            updateConfig: () => {}
        };

        handler = new DebugHandler(context, {
            log: () => {},
            getScheduler: () => scheduler,
            getHybridAutoAccept: () => hybrid,
            getAntigravityClient: () => ({ isConnected: true }),
            getLockedOut: () => false
        });
    });

    it('returns queue empty error when startQueue has no prompts', async () => {
        scheduleState.prompts = [];

        const result = await handler.handleCommand('startQueue');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Queue is empty');
        assert.strictEqual(executeCalls.some(c => c.command === 'auto-accept.startQueue'), false);
    });

    it('executes startQueue command with manual source when prompts exist', async () => {
        scheduleState.prompts = ['Task 1'];

        const result = await handler.handleCommand('startQueue');

        assert.strictEqual(result.success, true);
        const call = executeCalls.find(c => c.command === 'auto-accept.startQueue');
        assert.ok(call);
        assert.strictEqual(call.args[0].source, 'manual');
    });

    it('updates and returns schedule including check prompt fields', async () => {
        await handler.handleCommand('updateSchedule', {
            mode: 'queue',
            prompts: ['A', 'B'],
            queueMode: 'loop',
            silenceTimeout: 45,
            checkPromptEnabled: true,
            checkPromptText: 'Check me'
        });

        const result = await handler.handleCommand('getSchedule');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.schedule.mode, 'queue');
        assert.deepStrictEqual(result.schedule.prompts, ['A', 'B']);
        assert.strictEqual(result.schedule.queueMode, 'loop');
        assert.strictEqual(result.schedule.silenceTimeout, 45);
        assert.strictEqual(result.schedule.checkPromptEnabled, true);
        assert.strictEqual(result.schedule.checkPromptText, 'Check me');
    });

    it('handles sendPrompt error when prompt is missing', async () => {
        const result = await handler.handleCommand('sendPrompt', {});

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'No prompt provided');
    });

    it('sends prompt through scheduler and reports CDP method', async () => {
        const result = await handler.handleCommand('sendPrompt', { prompt: 'Hello' });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.method, 'CDP');
    });

    it('returns hybrid status and can poll/update config', async () => {
        let updated = null;
        hybrid.updateConfig = (config) => {
            updated = config;
        };

        const statusRes = await handler.handleCommand('getHybridStatus');
        const pollRes = await handler.handleCommand('pollAutoAccept');
        const updateRes = await handler.handleCommand('updateHybridConfig', { config: { pollInterval: 700 } });

        assert.strictEqual(statusRes.success, true);
        assert.strictEqual(statusRes.hybrid.isEnabled, true);
        assert.strictEqual(pollRes.success, true);
        assert.strictEqual(updateRes.success, true);
        assert.deepStrictEqual(updated, { pollInterval: 700 });
    });

    it('returns hybrid-not-initialized error paths', async () => {
        handler = new DebugHandler(context, {
            log: () => {},
            getScheduler: () => scheduler,
            getHybridAutoAccept: () => null
        });

        const statusRes = await handler.handleCommand('getHybridStatus');
        const pollRes = await handler.handleCommand('pollAutoAccept');
        const updateRes = await handler.handleCommand('updateHybridConfig', { config: {} });

        assert.strictEqual(statusRes.success, false);
        assert.strictEqual(pollRes.success, false);
        assert.strictEqual(updateRes.success, false);
        assert.ok(statusRes.error.includes('HybridAutoAccept'));
    });

    it('returns unknown action error for invalid debug action', async () => {
        const result = await handler.handleCommand('notARealAction');

        assert.strictEqual(result.success, false);
        assert.ok(result.error.includes('Unknown debug action'));
    });

    it('returns resetQueue scheduler error when scheduler is missing', async () => {
        handler = new DebugHandler(context, {
            log: () => {},
            getScheduler: () => null,
            getHybridAutoAccept: () => hybrid
        });

        const result = await handler.handleCommand('resetQueue');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Scheduler not initialized');
    });
});

runAndExit();

process.on('exit', () => {
    Module._load = originalLoad;
});