/**
 * Comprehensive Queue Prompt Feature Test
 * 
 * Tests ALL Queue/Scheduler features using the Debug Server, simulating
 * exactly what the GUI does for 1-to-1 testing.
 * 
 * Run with: node tests/queue_feature_test.js
 */

const http = require('http');

const DEBUG_SERVER = 'http://127.0.0.1:54321';

// Test tracking
let passed = 0;
let failed = 0;
let testResults = [];

function sendCommand(action, params = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ action, params });
        const req = http.request({
            hostname: '127.0.0.1',
            port: 54321,
            path: '/command',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
            timeout: 10000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve({ raw: body });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.end(data);
    });
}

function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
        testResults.push({ test: message, status: 'passed' });
    } else {
        console.log(`  ❌ ${message}`);
        failed++;
        testResults.push({ test: message, status: 'failed' });
    }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ============================================================================
// TESTS
// ============================================================================

async function testScheduleConfiguration() {
    console.log('\n📅 Testing Schedule Configuration...');

    // Get initial schedule
    const initial = await sendCommand('getSchedule');
    assert(initial.success, 'Can query schedule');
    assert(initial.schedule !== undefined, 'Schedule object exists');
    assert(typeof initial.schedule.enabled === 'boolean', 'Schedule has enabled flag');
    assert(typeof initial.schedule.mode === 'string', 'Schedule has mode');
    assert(Array.isArray(initial.schedule.prompts), 'Schedule has prompts array');

    // Test setting mode to 'queue'
    await sendCommand('updateSchedule', { mode: 'queue' });
    await delay(200);
    const modeCheck = await sendCommand('getSchedule');
    assert(modeCheck.schedule.mode === 'queue', 'Mode can be set to queue');

    // Test setting mode to 'interval'
    await sendCommand('updateSchedule', { mode: 'interval' });
    await delay(200);
    const intervalCheck = await sendCommand('getSchedule');
    assert(intervalCheck.schedule.mode === 'interval', 'Mode can be set to interval');

    // Test setting mode to 'daily'
    await sendCommand('updateSchedule', { mode: 'daily' });
    await delay(200);
    const dailyCheck = await sendCommand('getSchedule');
    assert(dailyCheck.schedule.mode === 'daily', 'Mode can be set to daily');

    // Return to queue mode for further tests
    await sendCommand('updateSchedule', { mode: 'queue' });
}

async function testQueueModeOptions() {
    console.log('\n🔄 Testing Queue Mode Options...');

    // Test 'consume' mode (deletes prompts after completion)
    await sendCommand('updateSchedule', { queueMode: 'consume' });
    await delay(200);
    const consumeCheck = await sendCommand('getSchedule');
    assert(consumeCheck.schedule.queueMode === 'consume', 'Queue mode can be set to consume');

    // Test 'loop' mode (loops back to start)
    await sendCommand('updateSchedule', { queueMode: 'loop' });
    await delay(200);
    const loopCheck = await sendCommand('getSchedule');
    assert(loopCheck.schedule.queueMode === 'loop', 'Queue mode can be set to loop');

    // Test 'keep' mode (preserves prompts)
    await sendCommand('updateSchedule', { queueMode: 'keep' });
    await delay(200);
    const keepCheck = await sendCommand('getSchedule');
    assert(keepCheck.schedule.queueMode === 'keep', 'Queue mode can be set to keep');
}

async function testPromptManagement() {
    console.log('\n📝 Testing Prompt Management...');

    const testPrompts = [
        'Test Prompt 1: Create a simple function',
        'Test Prompt 2: Add error handling',
        'Test Prompt 3: Write unit tests'
    ];

    // Set prompts
    await sendCommand('updateSchedule', { prompts: testPrompts, mode: 'queue' });
    await delay(300);

    const afterAdd = await sendCommand('getSchedule');
    assert(afterAdd.schedule.prompts.length === 3, 'Three prompts saved');
    assert(afterAdd.schedule.prompts[0] === testPrompts[0], 'First prompt correct');
    assert(afterAdd.schedule.prompts[1] === testPrompts[1], 'Second prompt correct');
    assert(afterAdd.schedule.prompts[2] === testPrompts[2], 'Third prompt correct');

    // Update with different prompts
    const newPrompts = ['Updated Prompt A', 'Updated Prompt B'];
    await sendCommand('updateSchedule', { prompts: newPrompts });
    await delay(200);

    const afterUpdate = await sendCommand('getSchedule');
    assert(afterUpdate.schedule.prompts.length === 2, 'Prompts updated to two');
    assert(afterUpdate.schedule.prompts[0] === newPrompts[0], 'Updated prompt A correct');

    // Clear prompts
    await sendCommand('updateSchedule', { prompts: [] });
    await delay(200);

    const afterClear = await sendCommand('getSchedule');
    assert(afterClear.schedule.prompts.length === 0, 'Prompts can be cleared');
}

async function testSilenceTimeout() {
    console.log('\n⏱️ Testing Silence Timeout Configuration...');

    // Set silence timeout to 30 seconds
    await sendCommand('updateSchedule', { silenceTimeout: 30 });
    await delay(200);
    const check30 = await sendCommand('getSchedule');
    assert(check30.schedule.silenceTimeout === 30, 'Silence timeout can be set to 30s');

    // Set silence timeout to 60 seconds
    await sendCommand('updateSchedule', { silenceTimeout: 60 });
    await delay(200);
    const check60 = await sendCommand('getSchedule');
    assert(check60.schedule.silenceTimeout === 60, 'Silence timeout can be set to 60s');

    // Set silence timeout to 15 seconds (minimum reasonable)
    await sendCommand('updateSchedule', { silenceTimeout: 15 });
    await delay(200);
    const check15 = await sendCommand('getSchedule');
    assert(check15.schedule.silenceTimeout === 15, 'Silence timeout can be set to 15s');
}

async function testCheckPromptFeature() {
    console.log('\n✅ Testing Check Prompt Feature...');

    // Enable check prompt
    await sendCommand('updateSchedule', { checkPromptEnabled: true });
    await delay(200);
    const enabledCheck = await sendCommand('getSchedule');
    assert(enabledCheck.schedule.checkPromptEnabled === true, 'Check prompt can be enabled');

    // Set custom check prompt text
    const customCheckText = 'Custom verification: Ensure all requirements are met.';
    await sendCommand('updateSchedule', { checkPromptText: customCheckText });
    await delay(200);
    const textCheck = await sendCommand('getSchedule');
    assert(textCheck.schedule.checkPromptText === customCheckText, 'Check prompt text can be customized');

    // Disable check prompt
    await sendCommand('updateSchedule', { checkPromptEnabled: false });
    await delay(200);
    const disabledCheck = await sendCommand('getSchedule');
    assert(disabledCheck.schedule.checkPromptEnabled === false, 'Check prompt can be disabled');
}

async function testCheckPromptRuntimeInterleaving() {
    console.log('\n🧩 Testing Check Prompt Runtime Interleaving...');

    await sendCommand('stopQueue');
    await sendCommand('updateSchedule', {
        enabled: true,
        mode: 'queue',
        queueMode: 'keep',
        silenceTimeout: 300,
        checkPromptEnabled: true,
        checkPromptText: 'Runtime check prompt',
        prompts: ['Primary Task 1', 'Primary Task 2']
    });
    await delay(300);

    const startResult = await sendCommand('startQueue');
    assert(startResult.success, 'Check prompt queue starts successfully');
    await delay(400);

    let status = await sendCommand('getQueueStatus');
    assert(status.status.queueLength === 4, 'Runtime queue interleaves task+check prompts (2 tasks => 4 items)');
    assert(status.status.currentPrompt?.type === 'task', 'First runtime item is task');

    const skipResult = await sendCommand('skipPrompt');
    assert(skipResult.success, 'Can skip from task to check prompt');
    await delay(400);

    status = await sendCommand('getQueueStatus');
    assert(status.status.currentPrompt?.type === 'check', 'Next runtime item is check prompt after skip');

    await sendCommand('stopQueue');
}

async function testQueueStatus() {
    console.log('\n📊 Testing Queue Status...');

    const status = await sendCommand('getQueueStatus');
    assert(status.success, 'Can query queue status');
    assert(status.status !== undefined, 'Status object exists');
    assert(typeof status.status.enabled === 'boolean', 'Status has enabled flag');
    assert(typeof status.status.isRunningQueue === 'boolean', 'Status has isRunningQueue flag');
    assert(typeof status.status.queueLength === 'number', 'Status has queueLength');
    assert(typeof status.status.queueIndex === 'number', 'Status has queueIndex');
    assert(typeof status.status.isPaused === 'boolean', 'Status has isPaused flag');
    assert(typeof status.status.isQuotaExhausted === 'boolean', 'Status has isQuotaExhausted flag');
}

async function testQueueControl() {
    console.log('\n🎮 Testing Queue Control (Start/Pause/Resume/Stop)...');

    await sendCommand('stopQueue');
    await delay(2200); // Respect Scheduler startQueue dampener (<2s calls are ignored)

    // Setup: Create a queue with prompts
    const testPrompts = ['Queue Control Test Prompt 1', 'Queue Control Test Prompt 2'];
    await sendCommand('updateSchedule', {
        mode: 'queue',
        prompts: testPrompts,
        enabled: true,
        queueMode: 'loop',
        checkPromptEnabled: false,
        silenceTimeout: 300 // Long timeout to prevent auto-advance during test
    });
    await delay(300);

    // Verify queue is set up
    const setup = await sendCommand('getSchedule');
    assert(setup.schedule.prompts.length === 2, 'Queue prompts set up for control test');

    // Start Queue
    const startResult = await sendCommand('startQueue');
    assert(startResult.success, 'Start queue command accepted');
    await delay(500);

    let status = await sendCommand('getQueueStatus');
    assert(status.status.isRunningQueue === true, 'Queue is running after start');
    assert(status.status.queueIndex === 0, 'Queue starts at index 0');

    // Pause Queue
    const pauseResult = await sendCommand('pauseQueue');
    assert(pauseResult.success, 'Pause queue command accepted');
    await delay(200);

    status = await sendCommand('getQueueStatus');
    assert(status.status.isPaused === true, 'Queue is paused');

    // Resume Queue
    const resumeResult = await sendCommand('resumeQueue');
    assert(resumeResult.success, 'Resume queue command accepted');
    await delay(200);

    status = await sendCommand('getQueueStatus');
    assert(status.status.isPaused === false, 'Queue is resumed (not paused)');

    // Skip Prompt
    const skipResult = await sendCommand('skipPrompt');
    assert(skipResult.success, 'Skip prompt command accepted');
    await delay(500);

    status = await sendCommand('getQueueStatus');
    assert(status.status.queueIndex === 1, 'Queue advanced to index 1 after skip');

    // Stop Queue
    const stopResult = await sendCommand('stopQueue');
    assert(stopResult.success, 'Stop queue command accepted');
    await delay(200);

    status = await sendCommand('getQueueStatus');
    assert(status.status.isRunningQueue === false, 'Queue is stopped');
}

async function testPromptHistory() {
    console.log('\n📚 Testing Prompt History...');

    const historyResult = await sendCommand('getPromptHistory');
    assert(historyResult.success, 'Can query prompt history');
    assert(Array.isArray(historyResult.history), 'History is an array');

    if (historyResult.history.length > 0) {
        const lastEntry = historyResult.history[historyResult.history.length - 1];
        assert(typeof lastEntry.text === 'string', 'History entry has text');
        assert(typeof lastEntry.timestamp === 'number', 'History entry has timestamp');
        assert(typeof lastEntry.timeAgo === 'string', 'History entry has timeAgo');
        console.log(`  ℹ️  Found ${historyResult.history.length} history entries`);
    } else {
        console.log(`  ℹ️  History is empty (expected if no prompts sent recently)`);
    }
}

async function testConversationTargeting() {
    console.log('\n🎯 Testing Conversation Targeting...');

    // Get conversations
    const convResult = await sendCommand('getConversations');
    assert(convResult.success, 'Can query conversations');
    assert(Array.isArray(convResult.conversations), 'Conversations is an array');
    console.log(`  ℹ️  Found ${convResult.conversations.length} conversations`);

    // Set target conversation (empty = current active)
    const setTargetResult = await sendCommand('setTargetConversation', { conversationId: '' });
    assert(setTargetResult.success, 'Can set target conversation to current');

    // Verify in status
    const status = await sendCommand('getQueueStatus');
    assert(status.status.targetConversation === '', 'Target conversation is set to current (empty)');
}

async function testDebugActionCoverage() {
    console.log('\n🛠️ Testing Debug Action Coverage...');

    const unknown = await sendCommand('unknownActionCoverageProbe');
    assert(unknown.success === false, 'Unknown debug action is rejected');
    assert(typeof unknown.error === 'string' && unknown.error.includes('Unknown debug action'), 'Unknown action returns clear error');

    const resetRes = await sendCommand('resetQueue');
    assert(resetRes.success === true, 'resetQueue action works via debug server');

    const hybridStatus = await sendCommand('getHybridStatus');
    assert(hybridStatus.success === true, 'getHybridStatus action works');
    assert(hybridStatus.hybrid !== undefined, 'getHybridStatus returns hybrid payload');

    const hybridPoll = await sendCommand('pollAutoAccept');
    assert(hybridPoll.success === true, 'pollAutoAccept action works');

    const hybridUpdate = await sendCommand('updateHybridConfig', {
        config: {
            commandStrategy: { pollInterval: 650 }
        }
    });
    assert(hybridUpdate.success === true, 'updateHybridConfig action works');
}

async function testQueueWaitsForBusyConversation() {
    console.log('\n⏳ Testing Queue Wait-Until-Idle Behavior...');

    const uniquePrompt = `BusyWaitPrompt_${Date.now()}`;

    // Force "conversation busy" from browser side.
    await sendCommand('evaluateInBrowser', {
        code: `window.__autoAcceptIsConversationWorking = () => true; true;`
    });

    const historyBefore = await sendCommand('getPromptHistory');
    const beforeCount = Array.isArray(historyBefore.history) ? historyBefore.history.length : 0;

    await sendCommand('stopQueue');
    await delay(2200); // respect startQueue dampener

    await sendCommand('updateSchedule', {
        enabled: true,
        mode: 'queue',
        queueMode: 'consume',
        checkPromptEnabled: false,
        silenceTimeout: 30,
        prompts: [uniquePrompt]
    });
    await delay(300);

    const started = await sendCommand('startQueue');
    assert(started.success, 'Queue start accepted while conversation is busy');

    await delay(3000);

    const statusBusy = await sendCommand('getQueueStatus');
    assert(statusBusy.status.isRunningQueue === true, 'Queue remains running while waiting for busy conversation');
    assert(statusBusy.status.conversationStatus === 'waiting', 'Queue reports waiting state while conversation is busy');

    const historyDuring = await sendCommand('getPromptHistory');
    const duringCount = Array.isArray(historyDuring.history) ? historyDuring.history.length : 0;
    assert(duringCount === beforeCount, 'No prompt is sent while conversation is busy');

    // Release busy signal and verify prompt eventually sends.
    await sendCommand('evaluateInBrowser', {
        code: `window.__autoAcceptIsConversationWorking = () => false; true;`
    });

    let delivered = false;
    for (let i = 0; i < 8; i++) {
        await delay(1000);
        const h = await sendCommand('getPromptHistory');
        const list = Array.isArray(h.history) ? h.history : [];
        if (list.some(entry => entry.text && entry.text.includes(uniquePrompt))) {
            delivered = true;
            break;
        }
    }
    assert(delivered, 'Queue sends prompt after conversation becomes idle');

    await sendCommand('stopQueue');
}

async function testIntervalAndDailyModes() {
    console.log('\n⏰ Testing Interval and Daily Modes...');

    // Test Interval mode with value
    await sendCommand('updateSchedule', { mode: 'interval', value: '45' });
    await delay(200);
    const intervalCheck = await sendCommand('getSchedule');
    assert(intervalCheck.schedule.mode === 'interval', 'Interval mode set');
    assert(intervalCheck.schedule.value === '45', 'Interval value saved as 45 minutes');

    // Test Daily mode with time value
    await sendCommand('updateSchedule', { mode: 'daily', value: '14:30' });
    await delay(200);
    const dailyCheck = await sendCommand('getSchedule');
    assert(dailyCheck.schedule.mode === 'daily', 'Daily mode set');
    assert(dailyCheck.schedule.value === '14:30', 'Daily time value saved');

    // Test single prompt for interval/daily
    await sendCommand('updateSchedule', { prompt: 'Status check prompt' });
    await delay(200);
    const promptCheck = await sendCommand('getSchedule');
    assert(promptCheck.schedule.prompt === 'Status check prompt', 'Single prompt saved for interval/daily');
}

async function testScheduleEnabledToggle() {
    console.log('\n🔘 Testing Schedule Enabled Toggle...');

    // Disable schedule
    await sendCommand('updateSchedule', { enabled: false });
    await delay(200);
    const disabledCheck = await sendCommand('getSchedule');
    assert(disabledCheck.schedule.enabled === false, 'Schedule can be disabled');

    // Enable schedule
    await sendCommand('updateSchedule', { enabled: true });
    await delay(200);
    const enabledCheck = await sendCommand('getSchedule');
    assert(enabledCheck.schedule.enabled === true, 'Schedule can be enabled');

    // Clean up - disable for safety
    await sendCommand('updateSchedule', { enabled: false });
}

async function testSendPromptDirect() {
    console.log('\n💬 Testing Direct Prompt Send (CDP)...');

    // This tests the sendPrompt action which uses CDP directly
    const testMessage = 'Debug test prompt - please ignore this automated message';

    const result = await sendCommand('sendPrompt', { prompt: testMessage });
    assert(result.success, 'Send prompt command accepted');
    assert(result.method === 'CDP', 'Prompt sent via CDP method');

    // History may or may not capture this depending on scheduler state
    // Just verify we can query history (actual history capture is tested in queue control)
    await delay(300);
    const historyResult = await sendCommand('getPromptHistory');
    assert(historyResult.success, 'Can query history after send');
}

async function testQueueWaitsWhenChatBusy() {
    console.log('\n⏳ Testing Queue Wait/Retry When Chat Is Busy...');

    const busyPrompt = `Busy Retry Test ${Date.now()}`;

    await sendCommand('stopQueue');
    await delay(2200); // Respect queue start dampener

    await sendCommand('updateSchedule', {
        enabled: true,
        mode: 'queue',
        prompts: [busyPrompt],
        queueMode: 'loop',
        silenceTimeout: 300,
        checkPromptEnabled: false
    });
    await delay(300);

    // Force first prompt-send attempt to fail once (simulates busy chat), then allow success.
    await sendCommand('evaluateInBrowser', {
        code: `(function(){
            try {
                if (typeof window === 'undefined') return 'no-window';
                if (window.__mpaBusyRetryPatchInstalled) return 'already-installed';
                window.__mpaBusyRetryPatchInstalled = true;
                window.__mpaBusyRetryFailCount = 0;
                window.__mpaBusyRetryOriginalSend = window.__autoAcceptSendPrompt;
                window.__mpaBusyRetryOriginalSendConv = window.__autoAcceptSendPromptToConversation;

                window.__autoAcceptSendPrompt = async function(){
                    if (window.__mpaBusyRetryFailCount < 1) {
                        window.__mpaBusyRetryFailCount += 1;
                        return false;
                    }
                    if (typeof window.__mpaBusyRetryOriginalSend === 'function') {
                        return await window.__mpaBusyRetryOriginalSend.apply(this, arguments);
                    }
                    return false;
                };

                window.__autoAcceptSendPromptToConversation = async function(){
                    if (window.__mpaBusyRetryFailCount < 1) {
                        window.__mpaBusyRetryFailCount += 1;
                        return false;
                    }
                    if (typeof window.__mpaBusyRetryOriginalSendConv === 'function') {
                        return await window.__mpaBusyRetryOriginalSendConv.apply(this, arguments);
                    }
                    return false;
                };

                return 'installed';
            } catch (e) {
                return 'error:' + (e && e.message ? e.message : String(e));
            }
        })()`
    });

    const startResult = await sendCommand('startQueue');
    assert(startResult.success, 'Queue start accepted for busy/retry test');
    await delay(500);

    const statusAfterStart = await sendCommand('getQueueStatus');
    assert(statusAfterStart.status.isRunningQueue === true, 'Queue remains running while waiting/retrying');

    let foundInHistory = false;
    for (let i = 0; i < 12; i++) {
        await delay(1000);
        const historyRes = await sendCommand('getPromptHistory');
        if (historyRes.success && Array.isArray(historyRes.history)) {
            foundInHistory = historyRes.history.some(h => h.text && h.text.includes(busyPrompt));
            if (foundInHistory) break;
        }
    }
    assert(foundInHistory, 'Prompt eventually sends after transient busy condition');

    // Restore patched browser send functions.
    await sendCommand('evaluateInBrowser', {
        code: `(function(){
            try {
                if (typeof window === 'undefined') return 'no-window';
                if (window.__mpaBusyRetryPatchInstalled) {
                    if (window.__mpaBusyRetryOriginalSend) {
                        window.__autoAcceptSendPrompt = window.__mpaBusyRetryOriginalSend;
                    }
                    if (window.__mpaBusyRetryOriginalSendConv) {
                        window.__autoAcceptSendPromptToConversation = window.__mpaBusyRetryOriginalSendConv;
                    }
                    window.__mpaBusyRetryPatchInstalled = false;
                }
                return 'restored';
            } catch (e) {
                return 'error:' + (e && e.message ? e.message : String(e));
            }
        })()`
    });

    await sendCommand('stopQueue');
}

async function testCompleteWorkflow() {
    console.log('\n🔧 Testing Complete Workflow (End-to-End)...');

    await sendCommand('stopQueue');
    await delay(2200); // Respect scheduler startQueue dampener

    // 1. Setup a complete queue configuration
    await sendCommand('updateSchedule', {
        enabled: true,
        mode: 'queue',
        queueMode: 'keep',
        silenceTimeout: 300,
        checkPromptEnabled: false,
        prompts: ['E2E Test Prompt 1', 'E2E Test Prompt 2', 'E2E Test Prompt 3']
    });
    await delay(300);

    // 2. Verify configuration
    const config = await sendCommand('getSchedule');
    assert(config.schedule.enabled === true, 'E2E: Schedule enabled');
    assert(config.schedule.mode === 'queue', 'E2E: Mode is queue');
    assert(config.schedule.prompts.length === 3, 'E2E: 3 prompts configured');

    // 3. Check initial status
    let status = await sendCommand('getQueueStatus');
    assert(status.status.isRunningQueue === false, 'E2E: Queue not running initially');

    // 4. Start queue
    await sendCommand('startQueue');
    await delay(500);

    let runningObserved = false;
    for (let i = 0; i < 6; i++) {
        status = await sendCommand('getQueueStatus');
        if (status?.status?.isRunningQueue && status?.status?.queueLength > 0) {
            runningObserved = true;
            break;
        }
        await delay(500);
    }

    assert(runningObserved === true, 'E2E: Queue running after start');
    assert((status?.status?.queueLength || 0) > 0, 'E2E: Runtime queue has items');

    // 5. Pause and verify
    await sendCommand('pauseQueue');
    await delay(200);
    status = await sendCommand('getQueueStatus');
    assert(status.status.isPaused === true, 'E2E: Queue paused');

    // 6. Resume and verify
    await sendCommand('resumeQueue');
    await delay(200);
    status = await sendCommand('getQueueStatus');
    assert(status.status.isPaused === false, 'E2E: Queue resumed');

    // 7. Stop queue
    await sendCommand('stopQueue');
    await delay(200);
    status = await sendCommand('getQueueStatus');
    assert(status.status.isRunningQueue === false, 'E2E: Queue stopped');

    // 8. Cleanup
    await sendCommand('updateSchedule', { enabled: false, prompts: [] });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║       Queue Prompt Feature - Comprehensive Test Suite      ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`\nStarting tests at ${new Date().toISOString()}`);
    console.log(`Debug server: ${DEBUG_SERVER}`);

    const startTime = Date.now();

    try {
        // Verify debug server is reachable
        const ping = await sendCommand('getEnabled');
        if (!ping.success) {
            console.error('Cannot reach debug server. Ensure extension is running with debug mode enabled.');
            process.exit(1);
        }

        // Run all tests
        await testScheduleConfiguration();
        await testQueueModeOptions();
        await testPromptManagement();
        await testSilenceTimeout();
        await testCheckPromptFeature();
        await testCheckPromptRuntimeInterleaving();
        await testQueueStatus();
        await testQueueControl();
        await testPromptHistory();
        await testConversationTargeting();
        await testDebugActionCoverage();
        await testQueueWaitsForBusyConversation();
        await testIntervalAndDailyModes();
        await testScheduleEnabledToggle();
        await testSendPromptDirect();
        await testQueueWaitsWhenChatBusy();
        await testCompleteWorkflow();

    } catch (e) {
        console.error(`\n💥 Test runner error: ${e.message}`);
        console.error(e.stack);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                     TEST RESULTS                           ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  ⏱️  Duration: ${duration}s`);

    if (failed === 0) {
        console.log('\n🎉 All Queue Prompt tests passed!');
    } else {
        console.log('\n⚠️  Some tests failed. Review the output above.');
        console.log('\nFailed tests:');
        testResults.filter(r => r.status === 'failed').forEach(r => {
            console.log(`  - ${r.test}`);
        });
    }

    // Cleanup: Reset schedule to safe state
    await sendCommand('updateSchedule', {
        enabled: false,
        mode: 'interval',
        prompts: [],
        queueMode: 'consume'
    });

    process.exit(failed > 0 ? 1 : 0);
}

main();
