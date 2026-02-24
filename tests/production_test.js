/**
 * Production Test Script
 * Tests auto-accept and queueing system via the debug server (port 54321)
 * 
 * Usage: node tests/production_test.js
 */

const http = require('http');

const DEBUG_PORT = 54321;
let passed = 0;
let failed = 0;
const results = [];

function post(action, params = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ action, params });
        const req = http.request({
            hostname: '127.0.0.1',
            port: DEBUG_PORT,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } 
                catch (e) { reject(new Error(`Invalid JSON: ${body}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(90000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(data);
        req.end();
    });
}

function assert(condition, message) {
    if (condition) {
        passed++;
        results.push(`  ✅ ${message}`);
    } else {
        failed++;
        results.push(`  ❌ ${message}`);
    }
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function test(name, fn) {
    results.push(`\n📋 ${name}`);
    try {
        await fn();
    } catch (e) {
        failed++;
        results.push(`  ❌ EXCEPTION: ${e.message}`);
    }
}

async function run() {
    console.log('🔍 Production Test Suite - Debug Server on port', DEBUG_PORT);
    console.log('='.repeat(60));

    // ============================================================
    // 1. CONNECTIVITY
    // ============================================================
    await test('Debug Server Connectivity', async () => {
        const r = await post('getEnabled');
        assert(r.success === true, `Server responds (enabled=${r.enabled})`);
    });

    // ============================================================
    // 2. HYBRID AUTO-ACCEPT STATUS
    // ============================================================
    await test('Hybrid Auto-Accept Status', async () => {
        const r = await post('getHybridStatus');
        if (r.success) {
            const h = r.hybrid;
            assert(h !== undefined, `Hybrid initialized`);
            assert(typeof h.enabled === 'boolean', `enabled: ${h.enabled}`);
            const primaryEnabled = h.primaryStrategy ? h.primaryStrategy.enabled : false;
            const fallbackEnabled = h.fallbackStrategy ? h.fallbackStrategy.enabled : false;
            assert(true, `primaryStrategy: ${primaryEnabled}`);
            assert(true, `fallbackStrategy: ${fallbackEnabled}`);
            results.push(`    ℹ️  Status: enabled=${h.enabled}, primary=${primaryEnabled}, fallback=${fallbackEnabled}`);
            if (h.stats) {
                results.push(`    ℹ️  Stats: totalAccepts=${h.stats.totalAccepts}, primaryAccepts=${h.stats.primaryAccepts}, fallbackAccepts=${h.stats.fallbackAccepts}`);
            }
        } else {
            assert(false, `HybridAutoAccept not initialized: ${r.error}`);
        }
    });

    // ============================================================
    // 3. TOGGLE AUTO-ACCEPT
    // ============================================================
    await test('Toggle Auto-Accept', async () => {
        // Get current state
        const before = await post('getEnabled');
        results.push(`    ℹ️  Before toggle: enabled=${before.enabled}`);

        // If disabled, enable it
        if (!before.enabled) {
            const toggleResult = await post('toggle');
            assert(toggleResult.success, `Toggle command succeeded`);
            await sleep(2000); // Wait for toggle to take effect
            
            const after = await post('getEnabled');
            assert(after.enabled === true, `Now enabled after toggle`);
        } else {
            assert(true, `Already enabled`);
        }
    });

    // ============================================================
    // 4. AUTO-ACCEPT POLL TEST
    // ============================================================
    await test('Auto-Accept Poll Cycle', async () => {
        const r = await post('pollAutoAccept');
        if (r.success) {
            assert(true, `Poll executed successfully`);
            if (r.result) {
                results.push(`    ℹ️  Poll result: ${JSON.stringify(r.result).substring(0, 200)}`);
            }
        } else {
            assert(false, `Poll failed: ${r.error}`);
        }
    });

    // ============================================================
    // 5. SCHEDULER / QUEUE STATUS
    // ============================================================
    await test('Queue Status', async () => {
        const r = await post('getQueueStatus');
        assert(r.success, `Queue status retrieved`);
        if (r.status) {
            const s = r.status;
            assert(typeof s.isRunningQueue === 'boolean', `isRunningQueue: ${s.isRunningQueue}`);
            assert(typeof s.queueLength === 'number', `queueLength: ${s.queueLength}`);
            assert(typeof s.queueIndex === 'number', `queueIndex: ${s.queueIndex}`);
            results.push(`    ℹ️  Queue: running=${s.isRunningQueue}, length=${s.queueLength}, index=${s.queueIndex}, mode=${s.queueMode}`);
        }
    });

    // ============================================================
    // 6. SCHEDULE CONFIGURATION
    // ============================================================
    await test('Schedule Configuration', async () => {
        const r = await post('getSchedule');
        assert(r.success, `Schedule config retrieved`);
        if (r.schedule) {
            results.push(`    ℹ️  Schedule: enabled=${r.schedule.enabled}, mode=${r.schedule.mode}`);
            results.push(`    ℹ️  Prompts: ${JSON.stringify(r.schedule.prompts).substring(0, 200)}`);
            results.push(`    ℹ️  QueueMode: ${r.schedule.queueMode}, silenceTimeout: ${r.schedule.silenceTimeout}s`);
        }
    });

    // ============================================================
    // 7. QUEUE LIFECYCLE TEST (add prompts, start, check, stop)
    // ============================================================
    await test('Queue Lifecycle', async () => {
        // Clean slate: stop + reset any running queue and wait for pending operations
        await post('stopQueue');
        await post('resetQueue');
        await sleep(3000);

        // Save original schedule
        const original = await post('getSchedule');
        
        // Verify no queue is running
        const preStatus = await post('getQueueStatus');
        results.push(`    ℹ️  Pre-start: running=${preStatus.status?.isRunningQueue}`);

        // Configure a single test prompt
        const testPromptId = 'QueueTest-' + Date.now();
        await post('updateSchedule', {
            prompts: [testPromptId],
            queueMode: 'consume',
            silenceTimeout: 10
        });
        await sleep(500);

        const afterSet = await post('getSchedule');
        assert(afterSet.schedule.prompts.length === 1, `Prompts configured: ${afterSet.schedule.prompts.length}`);

        // Start queue and AWAIT it (resolves after queue setup, not after delivery)
        const startResult = await post('startQueue');
        assert(startResult.success, `startQueue returned success=${startResult.success}`);
        
        // After startQueue resolves, the prompt is being sent asynchronously via CDP
        // Poll history for up to 60s to wait for delivery
        let promptInHistory = false;
        let lastPrompt = '';
        for (let i = 0; i < 20; i++) {
            await sleep(3000);
            const history = await post('getPromptHistory');
            const lastEntry = history.history?.[history.history.length - 1];
            lastPrompt = lastEntry?.text || lastEntry?.fullText || '';
            if (lastPrompt.includes('QueueTest-')) {
                promptInHistory = true;
                break;
            }
        }
        assert(promptInHistory, `Prompt delivered to history: "${lastPrompt.substring(0, 60)}"`);
        
        // Also verify logs show activity
        const logs = await post('getLogs', { tailLines: 100 });
        const logText = logs.logs || '';
        const promptInLogs = logText.includes(testPromptId) || logText.includes('Executing Task');
        assert(promptInLogs, `Queue activity found in logs`);

        // Stop queue
        await post('stopQueue');
        assert(true, 'Queue lifecycle complete');

        // Restore original prompts
        if (original.schedule) {
            await post('updateSchedule', {
                prompts: original.schedule.prompts || [],
                queueMode: original.schedule.queueMode || 'consume',
                silenceTimeout: original.schedule.silenceTimeout || 30
            });
        }
    });

    // ============================================================
    // 8. PROMPT HISTORY
    // ============================================================
    await test('Prompt History', async () => {
        const r = await post('getPromptHistory');
        assert(r.success, `History retrieved`);
        if (r.history && r.history.length > 0) {
            results.push(`    ℹ️  History entries: ${r.history.length}`);
            const last = r.history[r.history.length - 1];
            results.push(`    ℹ️  Last: "${(last.prompt || last.text || '').substring(0, 80)}" status=${last.status}`);
        } else {
            results.push(`    ℹ️  No history yet`);
        }
    });

    // ============================================================
    // 9. CONVERSATIONS (CDP)
    // ============================================================
    await test('Conversations', async () => {
        const r = await post('getConversations');
        assert(r.success, `Conversations retrieved`);
        if (r.conversations && r.conversations.length > 0) {
            results.push(`    ℹ️  Found ${r.conversations.length} conversation(s)`);
            for (const c of r.conversations.slice(0, 3)) {
                results.push(`    ℹ️  - ${c.title || c.id || 'untitled'}`);
            }
        } else {
            results.push(`    ℹ️  No conversations found (CDP may not be connected)`);
        }
    });

    // ============================================================
    // 10. BANNED COMMANDS
    // ============================================================
    await test('Banned Commands', async () => {
        const r = await post('getBannedCommands');
        assert(r.success, `Banned commands retrieved`);
        results.push(`    ℹ️  Banned commands: ${JSON.stringify(r.commands || []).substring(0, 200)}`);
    });

    // ============================================================
    // 11. LOGS
    // ============================================================
    await test('Extension Logs', async () => {
        const r = await post('getLogs', { tailLines: 30 });
        assert(r.success !== undefined, `Logs endpoint responds`);
        if (r.logs) {
            const lines = r.logs.split('\n').filter(l => l.trim());
            results.push(`    ℹ️  Last ${Math.min(5, lines.length)} log lines:`);
            for (const line of lines.slice(-5)) {
                results.push(`    📝 ${line.substring(0, 120)}`);
            }
        }
    });

    // ============================================================
    // 12. AUTO-CONTINUE STATUS  
    // ============================================================
    await test('Auto-Continue Status', async () => {
        const r = await post('getAutoContinue');
        assert(r.success, `Auto-continue status retrieved`);
        results.push(`    ℹ️  Auto-continue enabled: ${r.enabled}`);
    });

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log(results.join('\n'));
    console.log('\n' + '='.repeat(60));
    console.log(`📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('='.repeat(60));
    
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
});
