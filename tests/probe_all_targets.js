/**
 * Probe all CDP targets via browser-level WebSocket.
 * This mimics what the AntiGravity-AutoAccept reference repo does with
 * multiplexCdpWebviews() — connecting to the browser WS, enabling target
 * discovery, and finding webviews that /json/list doesn't show.
 */
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9004;

function getBrowserWsUrl() {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    resolve(info.webSocketDebuggerUrl || null);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function main() {
    const browserWsUrl = await getBrowserWsUrl();
    console.log('Browser WS URL:', browserWsUrl);
    
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    const pending = {};

    function send(method, params = {}, sessionId = null) {
        return new Promise((res, rej) => {
            const id = msgId++;
            const timer = setTimeout(() => { delete pending[id]; rej(new Error('timeout')); }, 5000);
            pending[id] = { res: (v) => { clearTimeout(timer); res(v); }, rej };
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
        });
    }

    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && pending[msg.id]) {
            pending[msg.id].res(msg);
            delete pending[msg.id];
        }
    });

    ws.on('open', async () => {
        try {
            // Enable target discovery
            await send('Target.setDiscoverTargets', { discover: true });
            
            // Get ALL targets
            const targetsMsg = await send('Target.getTargets');
            const allTargets = targetsMsg.result?.targetInfos || [];
            
            console.log(`\n=== ALL TARGETS (${allTargets.length}) ===`);
            allTargets.forEach((t, i) => {
                console.log(`\n[${i}] type=${t.type}, attached=${t.attached}`);
                console.log(`    title: ${t.title}`);
                console.log(`    url: ${(t.url || '').substring(0, 120)}`);
                console.log(`    targetId: ${t.targetId}`);
                if (t.browserContextId) console.log(`    browserContextId: ${t.browserContextId}`);
            });

            // Categorize
            const webviews = allTargets.filter(t => t.type === 'webview');
            const pages = allTargets.filter(t => t.type === 'page');
            const iframes = allTargets.filter(t => t.type === 'iframe');
            const other = allTargets.filter(t => !['webview', 'page', 'iframe'].includes(t.type));
            
            console.log(`\n=== SUMMARY ===`);
            console.log(`Pages: ${pages.length}, Webviews: ${webviews.length}, Iframes: ${iframes.length}, Other: ${other.length}`);
            
            // For each webview, try attaching and checking for agent panel  
            if (webviews.length > 0) {
                console.log(`\n=== PROBING WEBVIEWS ===`);
                for (const wv of webviews) {
                    try {
                        const attachMsg = await send('Target.attachToTarget', { targetId: wv.targetId, flatten: true });
                        const sessionId = attachMsg.result?.sessionId;
                        if (!sessionId) { console.log(`  [${wv.targetId.substring(0,8)}] Could not attach`); continue; }
                        
                        // Check for agent panel markers
                        const evalMsg = await send('Runtime.evaluate', {
                            expression: `JSON.stringify({
                                hasReactApp: !!document.querySelector('.react-app-container'),
                                hasAgentClass: !!document.querySelector('.antigravity-agent-side-panel'),
                                hasConversation: !!document.getElementById('conversation'),
                                hasInputBox: !!document.getElementById('antigravity.agentSidePanelInputBox'),
                                bodyTextLen: (document.body?.innerText || '').length,
                                title: document.title,
                                url: location.href.substring(0, 100)
                            })`
                        }, sessionId);
                        
                        const result = evalMsg.result?.result?.value;
                        console.log(`  [${wv.targetId.substring(0,8)}] ${wv.title}: ${result}`);
                        
                        await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                    } catch (e) {
                        console.log(`  [${wv.targetId.substring(0,8)}] Error: ${e.message}`);
                    }
                }
            }

            // Also probe pages
            console.log(`\n=== PROBING PAGES ===`);
            for (const pg of pages) {
                try {
                    const attachMsg = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
                    const sessionId = attachMsg.result?.sessionId;
                    if (!sessionId) { console.log(`  [${pg.targetId.substring(0,8)}] Could not attach`); continue; }
                    
                    const evalMsg = await send('Runtime.evaluate', {
                        expression: `JSON.stringify({
                            hasReactApp: !!document.querySelector('.react-app-container'),
                            hasAgentClass: !!document.querySelector('.antigravity-agent-side-panel'),
                            hasConversation: !!document.getElementById('conversation'),
                            hasInputBox: !!document.getElementById('antigravity.agentSidePanelInputBox'),
                            bodyTextLen: (document.body?.innerText || '').length,
                            title: document.title,
                            url: location.href.substring(0, 100)
                        })`
                    }, sessionId);
                    
                    const result = evalMsg.result?.result?.value;
                    console.log(`  [${pg.targetId.substring(0,8)}] ${pg.title}: ${result}`);
                    
                    await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                } catch (e) {
                    console.log(`  [${pg.targetId.substring(0,8)}] Error: ${e.message}`);
                }
            }

            ws.close();
            process.exit(0);
        } catch (e) {
            console.error('Error:', e.message);
            ws.close();
            process.exit(1);
        }
    });

    ws.on('error', (e) => { console.error('WS Error:', e.message); process.exit(1); });
}

main().catch(e => { console.error(e); process.exit(1); });
