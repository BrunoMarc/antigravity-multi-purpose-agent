const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { DebugHandler } = require('./debug-handler');


// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// Lazy load AntigravityClient for direct backend connection
let AntigravityClient = null;
let antigravityClient = null;
function getAntigravityClient() {
    if (!AntigravityClient) {
        try {
            AntigravityClient = require('./antigravity/client').AntigravityClient;
        } catch (e) {
            console.error('Failed to load AntigravityClient:', e);
        }
    }
    return AntigravityClient;
}

// states

const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
const ROI_STATS_KEY = 'auto-accept-roi-stats';
const CDP_SETUP_COMPLETED_KEY = 'cdp-setup-completed';
const EXTENSION_VERSION_KEY = 'extension-version'; // Track version to detect reinstall
const SECONDS_PER_CLICK = 5; // Conservative estimate: 5 seconds saved per auto-accept

let isEnabled = false;
let isLockedOut = false; // Local tracking
let pollFrequency = 2000; // Default for Free
let bannedCommands = []; // List of command patterns to block

let pollTimer;
let statsCollectionTimer; // For periodic stats collection
let quotaPollingTimer; // For Antigravity quota polling
let statusBarItem;
let statusSettingsItem;
let statusQuotaItem; // Antigravity Quota display
let statusQueueItem; // Queue status display
let outputChannel;
let currentIDE = 'antigravity'; // 'antigravity' | 'Code'
let globalContext;

let cdpHandler;
let relauncher;
let debugHandler; // Debug Handler instance
let configuredCdpPort = 9004; // Configurable CDP port from settings
let cdpPopupShownThisSession = false; // Track if popup was shown this session
let relaunchAttemptedThisSession = false; // Track if relaunch was attempted

const extensionRoot = path.basename(__dirname).toLowerCase() === 'dist'
    ? path.join(__dirname, '..')
    : __dirname;

function formatCdpLogSuffix(d = new Date()) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const mm = pad2(d.getMinutes());
    const hh = pad2(d.getHours());
    const dd = pad2(d.getDate());
    const MM = pad2(d.getMonth() + 1);
    const yy = pad2(d.getFullYear() % 100);
    return `${mm}${hh}-${dd}${MM}${yy}`;
}

const cdpLogPath = path.join(extensionRoot, `multi-purpose-cdp-${formatCdpLogSuffix()}.log`);

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);

        // Write to log file for debug mode
        fs.appendFileSync(cdpLogPath, logLine + '\n');
    } catch (e) {
        console.error('\u{26A1} failed:', e);
    }
}

// --- Scheduler Class ---
class Scheduler {
    constructor(context, cdpHandler, logFn, options = {}) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = logFn;
        this.timer = null;
        this.silenceTimer = null;
        this.lastRunTime = Date.now();
        this.lastClickTime = 0;
        this.lastClickCount = 0;
        this.lastActivityTime = 0;
        this.enabled = false;
        this.isQuotaExhausted = false;
        this.config = {};
        this.promptQueue = Promise.resolve();

        // Queue mode state
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.isRunningQueue = false;
        this.isStopped = false; // Flag to cancel pending prompts
        this.queueRunId = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.activationTime = Date.now(); // Track when scheduler was created for activation guard
        this.ensureCdpReady = typeof options.ensureCdpReady === 'function' ? options.ensureCdpReady : null;
        this.lastCdpSyncTime = 0;

        // Multi-queue ready architecture (single conversation for now)
        this.targetConversation = '';  // '' = current active tab
        this.promptHistory = [];       // HistoryEntry[]
        this.conversationStatus = 'idle'; // 'idle'|'running'|'waiting'
        this.isPaused = false;         // User-initiated pause
    }

    async ensureCdpReadyNow(reason, force = false) {
        if (!this.ensureCdpReady) return;
        const now = Date.now();
        if (!force && this.lastCdpSyncTime && (now - this.lastCdpSyncTime) < 2000) return;
        this.lastCdpSyncTime = now;
        try {
            this.log(`Scheduler: Syncing CDP (${reason})...`);
            await this.ensureCdpReady();
        } catch (e) {
            this.log(`Scheduler: CDP sync failed: ${e?.message || String(e)}`);
        }
    }

    start() {
        this.loadConfig();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), 60000);

        // Silence detection timer (runs more frequently)
        if (this.silenceTimer) clearInterval(this.silenceTimer);
        this.silenceTimer = setInterval(() => this.checkSilence(), 5000);

        // Reset activation time when scheduler starts (for accurate grace period)
        this.activationTime = Date.now();
        this.log('Scheduler started.');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.silenceTimer) {
            clearInterval(this.silenceTimer);
            this.silenceTimer = null;
        }
        this.isRunningQueue = false;
        this.isStopped = true;
        this.queueRunId++;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.promptQueue = Promise.resolve();
    }

    loadConfig() {
        const cfg = vscode.workspace.getConfiguration('auto-accept.schedule');
        const newEnabled = cfg.get('enabled', false);

        // Reset timer on rising edge (Disabled -> Enabled)
        if (!this.enabled && newEnabled) {
            this.lastRunTime = Date.now();
            this.log('Scheduler: Enabled via config update - Timer reset');
        }
        this.enabled = newEnabled;
        this.config = {
            mode: cfg.get('mode', 'interval'),
            value: cfg.get('value', '30'),
            prompt: cfg.get('prompt', "# 🌳 MIGRATION & STABILIZATION INFINITE LOOP — AST BLUEPRINT PROJECT\n\n## A Visão Macro (O Épico)\nNós acabamos de realizar um refatoramento arquitetural massivo no projeto Blueprint: nós abandonamos a extração de configurações via Regex, que era frágil e propensa a falhas de indentação, e migramos para um parser tipado e profundo usando **AST (ts-morph / TypeScript Compiler API)**.\nNosso ecossistema possui **Geradores de Códigos** baseados nesses blueprints que geram de forma automatizada Testes Unitários/Integration, Testes E2E e Handlers MSW.\n\n**A Missão Inegociável:** Nós não vamos apenas \"consertar os quebrados\" da migração AST para igualar o antigo patamar do regex. A meta é criar geradores exaustivamente inteligentes que possuam Cobertura Máxima (100% dos cenários) e gerem testes (outputs) com Pass Rate de 100%. O trabalho autônomo é infinito.\n\n---\n\n## Regras de Execução Autônoma\n1. **Proatividade Absoluta:** O trabalho NUNCA acaba. Se você arrumou um gap de testes ou fixou 10 bugs E2E, não pare. Encontre a próxima fragilidade do sistema (MSW não tem branch coverage? E2E não testa *catalogToggle*? Unit não testa *fullscreenModal*?) e engate a marcha.\n2. **NUNCA modifique o Output Manualmente:** Se um teste e2e (`*.generated.spec.ts`) ou unitário falhar, **NUNCA** edite o arquivo gerado para consertar. A correção deve ser SEMPRE feita no script gerador (os bridges AST em `scripts/ast/`, os templates em `scripts/e2e-gen/templates/`, ou o metadata-builder `scripts/e2e-gen/test-metadata-builder.ts`). Depois, você obrigatoriamente roda o gerador para atualizar o arquivo.\n3. **Seja Impiedoso nos Testes:** Testar não é apenas dar \"npm run test\" num mock bobo. É regerar TODAS as specs afetadas da aplicação e validá-las em ambiente real contra o frontend.\n\n---\n\n## Pipeline de Dados (Conheça os Bridges)\n\nO E2E generator usa um pipeline de 4 camadas que você DEVE dominar:\n\n```\nBlueprint (.blueprint.ts)\n  → AST Parser (scripts/ast/blueprint-parser.ts)\n    → Bridge (scripts/ast/e2egen-bridge.ts)\n      → Metadata Builder (scripts/e2e-gen/test-metadata-builder.ts)\n        → Templates (scripts/e2e-gen/templates/*.template.ts)\n          → Generated Spec (e2e/*.generated.spec.ts)\n```\n\n**ATENÇÃO:** Existem bridges DIFERENTES para cada gerador:\n| Gerador | Bridge | Runner |\n|---------|--------|--------|\n| E2E Spec | `scripts/ast/e2egen-bridge.ts` | `scripts/e2e-gen/generator.ts` |\n| MSW Handler | `scripts/ast/mswgen-bridge.ts` | `scripts/msw-gen.ts` |\n| Unit Spec | `scripts/ast/specgen-bridge.ts` | `scripts/spec-gen.ts` (legacy) |\n| Integration | `scripts/ast/intgen-bridge.ts` | `scripts/integration-gen/index.ts` |\n\nSe você alterar o `blueprint-parser.ts`, **TODOS** os bridges são afetados. Se alterar apenas um bridge, só afeta o gerador correspondente. Regere tudo que for afetado.\n\n---\n\n## Comandos Obrigatórios do Ciclo de Vida\n\n> **IMPORTANTE:** Todos os scripts usam `npx tsx` (TypeScript executado via tsx). NÃO existe `.cjs` — a migração para `.ts` já foi concluída.\n\n### 1. Regeneração Total dos Outputs (Após mudar um Gerador/Template)\n```bash\n# Regerar Testes E2E (TODOS os módulos)\nnpm run gen:spec:all\n\n# Regerar MSW Handlers (TODOS os módulos)\nnpm run gen:msw:all\n\n# Regerar Testes Unit/Integration (TODOS os módulos)\nnpm run gen:unit-spec:all\n\n# Regerar Integration specs\nnpm run gen:integration -- --all\n```\n\n### 2. Testes Internos dos Geradores (Rápido, rode PRIMEIRO)\nAntes de regerar, valide que os geradores em si não quebraram:\n```bash\n# Testes do AST extractor (blueprint-parser + bridges)\nnpx tsx --test scripts/ast/__tests__/*.test.ts\n\n# Testes dos templates E2E\nnpx tsx --test scripts/e2e-gen/__tests__/*.test.ts\n\n# Testes do MSW generator\nnpx tsx --test scripts/msw-gen/__tests__/*.test.ts\n\n# Testes do unit-spec generator\nnpx tsx --test scripts/unit-gen/__tests__/*.test.ts\nnpx tsx --test scripts/unit-spec-gen/__tests__/*.test.ts\n\n# Testes do validator\nnpx tsx --test scripts/__tests__/*.test.ts\n```\n\n### 3. Validação E2E Impiedosa (Playwright 16 Workers)\n```bash\n# Suite completa (bail após 60 falhas)\nPLAYWRIGHT_FAST=1 MAX_FAILURES=60 ./scripts/run-ai-tests.sh\n\n# Re-rodar APENAS os que falharam (economiza 10+ min)\n./scripts/run-ai-tests.sh --last-failed\n\n# Analisar falhas em detalhe (JSON + markdown report)\ncat test-report-for-coding-agents/all-failures.md | head -80\npython3 -c \"import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Pass: {s[\\\"expected\\\"]}/{s[\\\"expected\\\"]+s[\\\"unexpected\\\"]} ({s[\\\"expected\\\"]*100/(s[\\\"expected\\\"]+s[\\\"unexpected\\\"]):.1f}%)')\"\n```\n\n### 4. Testes Unitários da Aplicação (Vitest 4.0)\nO projeto usa Angular 21 com `@angular/build:unit-test` e **Vitest 4.0** (config em `vitest.config.ts`).\n```bash\n# Rodar unit tests com coverage (Vitest via ng test)\nnpm run test:coverage 2>&1 | tail -40\n\n# Rodar unit tests rápido (sem coverage, watch desabilitado)\nCI=true npm test -- --watch=false\n\n# Rodar um módulo específico\nCI=true npm test -- --watch=false --include='**/features/banks/**'\n```\n\n---\n\n## Estratégia Anti-Flaky (16 Workers Paralelos)\n\nCom 16 workers Playwright rodando em paralelo, timing issues são comuns. Siga essas regras:\n\n1. **Sempre distinga falha sistêmica de flaky:** Se um teste falha em TODAS as execuções, é bug no gerador. Se falha 1 em 3 vezes, é timing issue.\n2. **Use `--last-failed` para confirmar:** Re-rode falhas isoladas com `./scripts/run-ai-tests.sh --last-failed`. Se passam na segunda vez, são flaky.\n3. **waitFor > isVisible:** Em templates, use `waitFor({state:'attached', timeout: 5000})` ao invés de `isVisible()` para detectar elementos Angular que podem demorar a renderizar.\n4. **Nunca use `page.goto()` para sub-navigation.** Use click no menu-item + `waitForURL` conforme padrão CJS original.\n5. **Threshold de aprovação realista:** Se > 99% passam e as falhas restantes são scattered (não burst de um módulo), investigue individualmente antes de refatorar tudo.\n\n---\n\n## Prioridades (P0 → P2) — Matriz de Triage\n\n| Prio | Categoria | Critério | Ação |\n|------|-----------|----------|------|\n| **P0** | Burst Failures | ≥ 5 falhas consecutivas do mesmo módulo | Bug sistêmico no template/bridge. Corrigir IMEDIATAMENTE |\n| **P0** | Generator Crash | `gen:spec:all` falha para algum módulo | Parser ou bridge com bug. Fix antes de qualquer teste |\n| **P1** | Scattered Tests | Falhas em 3-5 módulos diferentes | Padrão comum nos templates (ex: botão add, form validation) |\n| **P1** | MSW Data Mismatch | Teste E2E falha por dados MSW incorretos | Bridge MSW não extrai campo corretamente |\n| **P2** | Flaky Tests | Passa 2/3 vezes, falha 1/3 | Timing issue — adicionar waitFor ou aumentar timeout |\n| **P2** | Coverage Gap | Cenário existente no CJS não migrado para TS | Adicionar ao template correspondente |\n\n---\n\n## O Que Você Deve Fazer NESTE Exato Ciclo\n1. Analise o estado atual dos bugs ou a saúde da cobertura de testes lendo as saídas do Terminal.\n2. Planeje qual lote de problemas você resolverá nos próximos minutos (ex: Timeouts de form validation E2E, ou Mapeamento MSW incompleto).\n3. Inicie imediatamente as implementações e refatorações no código dos geradores.\n4. Execute os comandos de **Testes Internos dos Geradores** (Passo 2 acima) para validar sem regerar.\n5. Execute os comandos de **Regeneração Total** (Passo 1 acima).\n6. Execute os comandos de **Validação E2E** (Passo 3 acima) para garantir 100% de Pass Rate.\n7. Quando achar que terminou o lote com sucesso absoluto, NÃO pare e não peça aprovação. Emita o seu relatório e passe a bola para o Check Prompt te validar severamente."),
            prompts: cfg.get('prompts', []),
            queueMode: cfg.get('queueMode', 'consume'),
            silenceTimeout: cfg.get('silenceTimeout', 120) * 1000, // Convert to ms
            checkPromptEnabled: cfg.get('checkPrompt.enabled', false),
            checkPromptText: cfg.get('checkPrompt.text', "# 🛡️ Loop Autônomo — Checkpoint Rigoroso & Geração de Próximo Passo\n\nVocê acaba de concluir uma task da Fila de Autonomia. **A missão não terminou.** O seu objetivo agora é avaliar friamente o que foi construído, garantir que os padrões de qualidade foram não apenas mantidos, mas superados, e engatilhar o próximo desafio.\n\n---\n\n## 1. Verificação Impiedosa (Checklist Obrigatório)\n\nExecute **todos** os seguintes comandos e analise os resultados. Se QUALQUER um falhar, PARE e corrija ANTES de prosseguir.\n\n### 1.1 Testes Internos dos Geradores\n```bash\n# Parser AST + Bridges\nnpx tsx --test scripts/ast/__tests__/*.test.ts\n\n# Templates E2E\nnpx tsx --test scripts/e2e-gen/__tests__/*.test.ts\n\n# MSW generator\nnpx tsx --test scripts/msw-gen/__tests__/*.test.ts\n\n# Unit/Integration gen\nnpx tsx --test scripts/unit-gen/__tests__/*.test.ts\nnpx tsx --test scripts/__tests__/*.test.ts\n```\n**Critério:** 100% pass. Zero falhas. Se falhar, o gerador está quebrado e TUDO gerado a partir dele é lixo.\n\n### 1.2 Regeneração Total (sem falhas do gen)\n```bash\nnpm run gen:spec:all    # E2E specs (deve gerar 6000+ tests, 0 módulos falhados)\nnpm run gen:msw:all     # MSW handlers\nnpm run gen:unit-spec:all  # Unit specs\n```\n**Critério:** A saída deve mostrar `❌ Failed: 0 modules` para cada gerador. Se qualquer módulo falhar na regeneração, investigue e corrija o parser/bridge.\n\n### 1.3 Validação E2E (Playwright)\n```bash\nPLAYWRIGHT_FAST=1 MAX_FAILURES=60 ./scripts/run-ai-tests.sh\n```\n**Critério Mínimo:** ≥ 99% pass rate (scattered failures aceitáveis, bursts NÃO).\n\n**Análise de falhas (obrigatório se houver):**\n```bash\npython3 -c \"import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Passed: {s[\\\"expected\\\"]}/{s[\\\"expected\\\"]+s[\\\"unexpected\\\"]} ({s[\\\"expected\\\"]*100/(s[\\\"expected\\\"]+s[\\\"unexpected\\\"]):.1f}%)')\"\ncat test-report-for-coding-agents/all-failures.md | head -60\n```\n\n### 1.4 Distinção Flaky vs Bug Real\nSe existem falhas, rode **apenas** as que falharam:\n```bash\n./scripts/run-ai-tests.sh --last-failed\n```\n- Se passam na segunda vez → **flaky** (aceitar, não refatorar tudo por causa disso)\n- Se falham de novo → **bug real** (deve ser corrigido NESTE ciclo)\n\n---\n\n## 2. Ponto de Salvamento (Commit)\n\nSe o resultado for um sucesso (≥ 99% E2E, 100% generator tests, 0 módulos falhando na regeneração):\n\n```bash\ngit add -A\ngit commit -m \"chore: loop checkpoint - [Resumo Técnico do Lote Resolvido]\"\n```\n\n**Regras de Commit:**\n- **NUNCA** dê `git push` — apenas commit local\n- **NUNCA** inclua co-autoria AI\n- Mensagem em inglês, no imperativo: `fix: resolve navigation timing for nested resources`\n- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`\n\n---\n\n## 3. Inventário de Saúde (Antes de Escolher o Próximo Escopo)\n\nAntes de selecionar a próxima task, faça um inventário rápido:\n\n```bash\n# Quantos testes E2E existem vs quantos passam?\npython3 -c \"import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Total: {s[\\\"expected\\\"]+s[\\\"unexpected\\\"]+s[\\\"skipped\\\"]} | Pass: {s[\\\"expected\\\"]} | Fail: {s[\\\"unexpected\\\"]} | Skip: {s[\\\"skipped\\\"]}')\"\n\n# Módulos com mais falhas (pelo report)\ncat test-report-for-coding-agents/all-failures.md | grep '###' | head -20\n\n# Verificar cobertura do generator sobre blueprints disponíveis\nnpm run gen:spec:all 2>&1 | grep -E \"Failed:|Skipped:|Total tests\"\n```\n\n---\n\n## 4. O Próximo Escopo (Auto-Alimentação da Fila)\n\nA Fila de Autonomia precisa saber o que você fará a seguir. Use a **Matriz de Prioridades** para decidir:\n\n| Prio | O que procurar | Como detectar |\n|------|----------------|---------------|\n| **P0** | Bursts (≥5 F's consecutivas de um módulo) | Olhar output do terminal, analisar `.playwright-results.json` |\n| **P0** | Generator crashes (módulo falha na regeneração) | `npm run gen:spec:all 2>&1 | grep \"Failed\"` |\n| **P1** | Padrão repetitivo de falha (ex: \"enable save\" em 10+ módulos) | `cat test-report-for-coding-agents/all-failures.md | grep -c \"enable save\"` |\n| **P1** | MSW data mismatch | Erro \"Expected: visible\" em nested resources (dados MSW errados) |\n| **P2** | Coverage gaps (cenários do CJS não portados) | Comparar templates `.ts` com backup CJS |\n| **P2** | Flaky tests estáveis | Re-rode `--last-failed` e se persistem, fixe timing |\n\n**MANDATÓRIO:** Você deve terminar a sua resposta com um bloco markdown exato no seguinte formato:\n\n### PROXIMA_TASK_DA_FILA\n[Descreva aqui, com detalhes técnicos, diretórios e objetivos, qual é a exata próxima fragilidade do sistema (MSW, E2E ou Unit) que você vai arrumar quando este loop rodar de novo em 30 segundos.]")
        };
        this.log(`Scheduler Config: mode=${this.config.mode}, enabled=${this.enabled}, prompts=${this.config.prompts.length}`);
    }

    buildRuntimeQueue() {
        const prompts = [...this.config.prompts];
        if (prompts.length === 0) return [];

        const queue = [];
        for (let i = 0; i < prompts.length; i++) {
            queue.push({ type: 'task', text: prompts[i], index: i });
            if (this.config.checkPromptEnabled) {
                queue.push({ type: 'check', text: this.config.checkPromptText, afterIndex: i });
            }
        }
        return queue;
    }

    async check() {
        this.loadConfig();
        if (!this.enabled || !this.cdpHandler) return;

        const now = new Date();
        const mode = this.config.mode;
        const val = this.config.value;

        if (mode === 'interval') {
            const minutes = parseInt(val) || 30;
            const ms = minutes * 60 * 1000;
            if (Date.now() - this.lastRunTime > ms) {
                this.log(`Scheduler: Interval triggered (${minutes}m)`);
                await this.trigger();
            }
        } else if (mode === 'daily') {
            const [targetH, targetM] = val.split(':').map(Number);
            if (now.getHours() === targetH && now.getMinutes() === targetM) {
                if (Date.now() - this.lastRunTime > 60000) {
                    this.log(`Scheduler: Daily triggered (${val})`);
                    await this.trigger();
                }
            }
        }
        // Queue mode is handled via startQueue() and silence detection
    }

    async checkSilence() {
        // Queue advancement only requires: running queue + CDP connection + queue mode
        // Note: this.enabled is for scheduled runs; manual "Run Queue" doesn't need it
        if (!this.cdpHandler || !this.isRunningQueue) return;
        if (this.config.mode !== 'queue') return;
        if (this.isPaused) return; // User paused - wait for resume
        if (this.isQuotaExhausted) return; // Don't advance if quota exhausted

        // Get current click count from CDP
        try {
            const stats = await this.cdpHandler.getStats();
            const currentClicks = stats?.clicks || 0;

            // If clicks happened, update last click time
            if (currentClicks > this.lastClickCount) {
                this.lastClickTime = Date.now();
                this.lastActivityTime = this.lastClickTime;
                this.lastClickCount = currentClicks;
                this.log(`Scheduler: Activity detected (${currentClicks} clicks)`);
            }

            // GRACE PERIOD: If we just sent a prompt in the last 15 seconds, 
            // ALWAYS consider the agent busy to give the UI time to render 'Running' or 'Thinking'
            const timeSinceLastSend = Date.now() - this.taskStartTime;
            const inGracePeriod = timeSinceLastSend < 15000;

            // Check if the agent is busy (e.g., generating)
            const isBusy = await this.cdpHandler.isBusy() || inGracePeriod;
            
            if (isBusy) {
                this.lastActivityTime = Date.now();
                if (!this.wasBusy) {
                    this.log(`Scheduler: Agent is busy (or in grace period), resetting silence timeout`);
                    this.wasBusy = true;
                }
            } else {
                this.wasBusy = false;
            }

            // Check if silence timeout reached (only after we've successfully sent the current queue item)
            const silenceDuration = Date.now() - (this.lastActivityTime || this.lastClickTime || Date.now());
            const taskDuration = Date.now() - this.taskStartTime;

            // Only advance if:
            // 1. We've been running this task for at least 15 seconds (Grace Period)
            // 2. We successfully sent the current queue item
            // 3. Silence duration exceeds timeout
            if (taskDuration > 15000 && this.hasSentCurrentItem && silenceDuration > this.config.silenceTimeout) {
                this.log(`Scheduler: Silence detected (${Math.round(silenceDuration / 1000)}s), advancing queue`);
                await this.advanceQueue();
            }
        } catch (e) {
            this.log(`Scheduler: Error checking silence: ${e.message}`);
        }
    }

    async startQueue(options) {
        // CRITICAL: Require explicit source for all startQueue calls
        const validSources = ['manual', 'debug-server', 'resume', 'test'];
        const source = options?.source;

        // DEBUG: Trace caller if no valid source
        if (!source || !validSources.includes(source)) {
            this.log(`Scheduler: BLOCKED startQueue - invalid source: "${source}". Valid: ${validSources.join(', ')}`);
            this.log('Scheduler: Stack trace: ' + new Error().stack);
            return; // Block phantom callers
        }

        this.log(`Scheduler: startQueue called with source: ${source}`);

        // Dampener: Prevent rapid restarts/loops (2 second cooldown)
        if (this.lastStartQueueTime && Date.now() - this.lastStartQueueTime < 2000) {
            this.log('Scheduler: Ignoring rapid startQueue call (< 2s)');
            return;
        }
        this.lastStartQueueTime = Date.now();

        // ACTIVATION GUARD: Block non-manual starts during activation grace period.
        // Prevents config/debug automation from triggering queue start on reload, while still allowing user clicks.
        if (this.activationTime && Date.now() - this.activationTime < 5000 && source !== 'manual' && source !== 'test') {
            this.log(`Scheduler: BLOCKED startQueue during activation grace period (${Math.round((Date.now() - this.activationTime) / 1000)}s < 5s)`);
            return;
        }

        // Load config first to get current state
        this.loadConfig();

        // Prevent auto-starting queue when scheduler is enabled but user hasn't explicitly started it
        if (this.config.mode === 'queue' && this.isRunningQueue) {
            this.log('Scheduler: Queue is already running, ignoring duplicate startQueue call');
            return;
        }

        this.log(`Scheduler: Queue start proceeding (source: ${source})`);

        if (this.config.mode !== 'queue') {
            this.log('Scheduler: Not in queue mode, ignoring startQueue');
            vscode.window.showWarningMessage('Multi Purpose: Set mode to "Queue" first.');
            return;
        }

        // Ensure we have fresh CDP connections and injected helpers (chat webviews may not exist at activation time).
        await this.ensureCdpReadyNow('startQueue', true);

        this.runtimeQueue = this.buildRuntimeQueue();
        this.queueIndex = 0;
        this.isRunningQueue = true;
        this.isStopped = false; // Clear stopped flag when starting
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;

        this.log(`Scheduler: Starting queue with ${this.runtimeQueue.length} items`);

        if (this.runtimeQueue.length === 0) {
            this.log('Scheduler: Queue is empty, nothing to run');
            if (options && options.source === 'manual') {
                // Warning Dampener: Prevent spamming warnings loop
                const now = Date.now();
                if (this.queueWarningDampener && (now - this.queueWarningDampener < 5000)) {
                    this.log('Scheduler: Suppressed empty queue warning (dampener active)');
                } else {
                    vscode.window.showWarningMessage('Multi Purpose: Prompt queue is empty. Add prompts first.');
                    this.queueWarningDampener = now;
                }
            } else {
                this.log('Scheduler: Suppressing empty queue warning (auto-start or no source)');
            }
            this.isRunningQueue = false;
            this.hasSentCurrentItem = false;
            return;
        }

        await this.executeCurrentQueueItem();
    }

    async advanceQueue() {
        if (!this.isRunningQueue) return;

        // In consume mode, remove the completed prompt from config immediately
        if (this.config.queueMode === 'consume') {
            await this.consumeCurrentPrompt();
        }

        this.queueIndex++;
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;

        if (this.queueIndex >= this.runtimeQueue.length) {
            if (this.config.queueMode === 'loop' && this.runtimeQueue.length > 0) {
                this.log('Scheduler: Queue completed, looping...');
                this.queueIndex = 0;
                // Rebuild queue to respect any config changes
                this.loadConfig();
                this.runtimeQueue = this.buildRuntimeQueue();
            } else {
                this.log('Scheduler: Queue completed, stopping');
                this.isRunningQueue = false;
                vscode.window.showInformationMessage('Multi Purpose: Prompt queue completed!');
                return;
            }
        }

        await this.executeCurrentQueueItem();
    }

    async executeCurrentQueueItem() {
        const runId = this.queueRunId;
        if (!this.isRunningQueue || this.isStopped) return;
        if (this.queueIndex >= this.runtimeQueue.length) return;

        const item = this.runtimeQueue[this.queueIndex];
        const itemType = item.type === 'check' ? 'Check Prompt' : `Task ${item.index + 1}`;

        this.log(`Scheduler: Executing ${itemType}: "${item.text.substring(0, 50)}..."`);
        this.conversationStatus = 'running';
        vscode.window.showInformationMessage(`Multi Purpose: Sending ${itemType}`);

        if (this.isStopped || runId !== this.queueRunId) return;
        await this.sendPrompt(item.text);
        // Note: addToHistory is called inside queuePrompt after successful send
    }

    async resume() {
        this.isQuotaExhausted = false;

        const resumeConfig = vscode.workspace.getConfiguration('auto-accept.antigravityQuota.resume');
        const queueResumeEnabled = resumeConfig.get('enabled', true);

        const autoContinueConfig = vscode.workspace.getConfiguration('auto-accept.autoContinue');
        const autoContinueEnabled = autoContinueConfig.get('enabled', false);

        // 1. Handle Queue Resume (Prioritized)
        if (this.isRunningQueue && this.config.mode === 'queue') {
            if (queueResumeEnabled) {
                this.log('Scheduler: Quota reset, resuming queue task');
                vscode.window.showInformationMessage('Multi Purpose: Quota reset! Resuming queue...');
                this.lastClickTime = Date.now();
                this.lastActivityTime = this.lastClickTime;
                this.taskStartTime = Date.now();
                this.lastClickCount = 0;
                this.hasSentCurrentItem = false;
                // Re-send current item to continue
                await this.executeCurrentQueueItem();
                return;
            } else {
                this.log('Scheduler: Quota reset, but queue resume disabled.');
            }
        }

        // 2. Handle Generic Auto-Continue (if not in queue or queue resume disabled)
        if (autoContinueEnabled) {
            this.log('Scheduler: Quota reset, sending "Continue" prompt');
            vscode.window.showInformationMessage('Multi Purpose: Quota reset! Sending "Continue"...');
            await this.sendPrompt('Continue');
        } else {
            this.log('Scheduler: Quota reset, but auto-continue disabled.');
        }

        // NOTE: Do NOT auto-start queue if not running - user must explicitly click Start Queue.
    }

    async consumeCurrentPrompt() {
        try {
            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
            const prompts = config.get('prompts', []);
            if (prompts.length > 0) {
                // Remove the first prompt (the one that was just completed)
                const remaining = prompts.slice(1);
                await config.update('prompts', remaining, vscode.ConfigurationTarget.Global);
                this.log(`Scheduler: Consumed prompt, ${remaining.length} remaining`);
            }
        } catch (e) {
            this.log(`Scheduler: Error consuming prompt: ${e.message}`);
        }
    }

    async consumeCompletedPrompts() {
        try {
            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
            // Clear the prompts array after successful completion
            await config.update('prompts', [], vscode.ConfigurationTarget.Global);
            this.log('Scheduler: Consumed prompts cleared from config');
        } catch (e) {
            this.log(`Scheduler: Error clearing consumed prompts: ${e.message}`);
        }
    }

    async setQuotaExhausted(exhausted) {
        const wasExhausted = this.isQuotaExhausted;
        this.isQuotaExhausted = exhausted;

        if (wasExhausted && !exhausted) {
            this.log('Scheduler: Quota transitioned from exhausted to available');
            this.resume();
        } else if (exhausted && !wasExhausted) {
            this.log('Scheduler: Quota became exhausted. Checking for fallback model...');
            
            const fallbackModel = vscode.workspace.getConfiguration('auto-accept').get('fallbackModel', 'gemini 3.1');
            let switched = false;
            
            if (fallbackModel && fallbackModel.trim().length > 0 && this.config.mode === 'queue' && this.isRunningQueue) {
                try {
                    switched = await this.cdpHandler.switchModel(fallbackModel);
                } catch(e) {
                    this.log('Scheduler: Error trying to switch fallback model.');
                }
            }

            if (switched) {
                this.log(`Scheduler: Successfully switched to fallback model '${fallbackModel}'. Resuming queue.`);
                vscode.window.showInformationMessage(`Quota exhausted! Switched to fallback model: ${fallbackModel}`);
                // Since we switched models, we can continue the queue.
                this.isQuotaExhausted = false;
            } else {
                this.log('Scheduler: Quota exhausted, pausing queue');
                if (this.config.mode === 'queue' && this.isRunningQueue) {
                    vscode.window.showWarningMessage('Antigravity Quota Exhausted. Queue paused.');
                }
            }
        }
    }

    async queuePrompt(text) {
        const runId = this.queueRunId;
        this.promptQueue = this.promptQueue.then(async () => {
            // Check if queue was stopped before we could send
            if (this.isStopped || runId !== this.queueRunId) {
                this.log('Scheduler: Prompt cancelled (queue stopped)');
                return;
            }

            this.lastRunTime = Date.now();
            if (!text) return;

            this.log(`Scheduler: Sending prompt "${text.substring(0, 50)}..."`);

            // Use CDP only - the verified working method
            if (this.cdpHandler) {
                try {
                    let sentCount = 0;
                    let retries = 0;
                    const maxRetries = 15; // 15 retries * 10 seconds = 2.5 minutes of waiting

                    while (sentCount === 0 && retries < maxRetries) {
                        if (this.isStopped || runId !== this.queueRunId) return;

                        // Ensure CDP has scanned/injected latest chat surfaces before attempting to send.
                        await this.ensureCdpReadyNow(retries === 0 ? 'queuePrompt' : `queuePrompt-retry-${retries}`, true);
                        if (this.isStopped || runId !== this.queueRunId) return;

                        const rawSentCount = await this.cdpHandler.sendPrompt(text, this.targetConversation);
                        sentCount = typeof rawSentCount === 'number' ? rawSentCount : (rawSentCount ? 1 : 0);
                        if (this.isStopped || runId !== this.queueRunId) return;

                        if (sentCount === 0) {
                            retries++;
                            if (retries < maxRetries) {
                                this.log(`Scheduler: Prompt not delivered (Attempt ${retries}/${maxRetries}). Chat UI might be hidden or loading. Waiting 10s...`);
                                await new Promise(r => setTimeout(r, 10000));
                            }
                        }
                    }

                    if (sentCount === 0) {
                        this.log('Scheduler: Exhausted all retries. No chat input found. Pausing queue to wait for UI readiness.');
                        vscode.window.showWarningMessage('Multi Purpose: Could not find chat input after 2.5 minutes. Queue paused. Open chat and resume.');
                        this.pauseQueue();
                        return;
                    }

                    this.addToHistory(text, this.targetConversation);
                    if (this.isRunningQueue && this.config.mode === 'queue') {
                        this.hasSentCurrentItem = true;
                        this.lastActivityTime = Date.now();
                    }
                    this.log(`Scheduler: Prompt sent via CDP (${sentCount} tabs)`);
                } catch (err) {
                    this.log(`Scheduler: CDP failed: ${err.message}`);
                    vscode.window.showErrorMessage(`Queue Error: ${err.message}`);
                    // Force pause queue on critical error to allow recovery instead of destroying progress
                    this.pauseQueue();
                    return;
                }
            } else {
                this.log('Scheduler: CDP handler not available');
                if (this.isRunningQueue && this.config.mode === 'queue') {
                    vscode.window.showErrorMessage('Queue Error: CDP handler not available.');
                    this.stopQueue();
                }
            }
        }).catch(err => {
            this.log(`Scheduler Error: ${err.message}`);
        });
        return this.promptQueue;
    }

    async sendPrompt(text) {
        return this.queuePrompt(text);
    }

    async trigger() {
        const text = this.config.prompt;
        return this.queuePrompt(text);
    }

    getStatus() {
        return {
            enabled: this.enabled,
            mode: this.config.mode,
            isRunningQueue: this.isRunningQueue,
            queueLength: this.runtimeQueue.length,
            queueIndex: this.queueIndex,
            isQuotaExhausted: this.isQuotaExhausted,
            targetConversation: this.targetConversation,
            conversationStatus: this.conversationStatus,
            isPaused: this.isPaused,
            currentPrompt: this.getCurrentPrompt()
        };
    }

    async getConversations() {
        if (!this.cdpHandler) return [];
        try {
            return await this.cdpHandler.getConversations();
        } catch (e) {
            this.log(`Scheduler: Error getting conversations: ${e.message}`);
            return [];
        }
    }

    addToHistory(text, conversationId) {
        const entry = {
            text: text.substring(0, 100),
            fullText: text,
            timestamp: Date.now(),
            status: 'sent',
            conversationId: conversationId || this.targetConversation || 'current'
        };
        this.promptHistory.push(entry);
        // Keep last 50 entries
        if (this.promptHistory.length > 50) {
            this.promptHistory.shift();
        }
        this.log(`Scheduler: Added to history: "${entry.text.substring(0, 50)}..."`);
    }

    getHistory() {
        return this.promptHistory.map(h => ({
            text: h.text,
            timestamp: h.timestamp,
            timeAgo: this.formatTimeAgo(h.timestamp),
            status: h.status,
            conversation: h.conversationId
        }));
    }

    formatTimeAgo(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return Math.floor(diff / 86400000) + 'd ago';
    }

    setTargetConversation(conversationId) {
        this.targetConversation = conversationId || '';
        this.log(`Scheduler: Target conversation set to: "${this.targetConversation || 'current'}"`);
    }

    // Queue control methods
    pauseQueue() {
        if (!this.isRunningQueue || this.isPaused) return false;
        this.isPaused = true;
        this.log('Scheduler: Queue paused by user');
        vscode.window.showInformationMessage('Queue paused.');
        return true;
    }

    resumeQueue() {
        if (!this.isRunningQueue || !this.isPaused) return false;
        this.isPaused = false;
        this.log('Scheduler: Queue resumed by user');
        vscode.window.showInformationMessage('Queue resumed.');
        // Trigger next check immediately
        this.checkSilence();
        return true;
    }

    async skipPrompt() {
        if (!this.isRunningQueue) return false;
        this.log('Scheduler: Skipping current prompt');
        vscode.window.showInformationMessage('Skipping to next prompt...');

        // Advance without sending current
        this.queueIndex++;
        this.isPaused = false; // Clear pause if set
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;

        if (this.queueIndex >= this.runtimeQueue.length) {
            this.log('Scheduler: No more prompts to skip to, queue complete');
            this.isRunningQueue = false;
            this.conversationStatus = 'idle';
            return true;
        }

        // Execute next item
        await this.executeCurrentQueueItem();
        return true;
    }

    stopQueue() {
        if (!this.isRunningQueue && this.runtimeQueue.length === 0) return false;
        this.isRunningQueue = false;
        this.isStopped = true; // Signal pending prompts to cancel
        this.queueRunId++;
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.lastClickCount = 0;
        this.lastClickTime = 0;
        this.lastActivityTime = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        // Reset the prompt queue to cancel pending operations
        this.promptQueue = Promise.resolve();
        this.log('Scheduler: Queue stopped by user');
        vscode.window.showInformationMessage('Queue stopped.');
        return true;
    }

    async resetQueue() {
        // Stop the queue if running
        this.isRunningQueue = false;
        this.isStopped = false; // Reset the stopped flag
        this.queueRunId++;
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.lastClickCount = 0;
        this.lastClickTime = 0;
        this.lastActivityTime = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.promptQueue = Promise.resolve(); // Clear pending prompts

        // Clear prompts from config
        try {
            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
            await config.update('prompts', [], vscode.ConfigurationTarget.Global);
            this.log('Scheduler: Queue reset - all prompts cleared');
        } catch (e) {
            this.log(`Scheduler: Error resetting queue: ${e.message}`);
        }

        vscode.window.showInformationMessage('Queue reset.');
        return true;
    }

    getCurrentPrompt() {
        if (!this.isRunningQueue || this.queueIndex >= this.runtimeQueue.length) return null;
        return this.runtimeQueue[this.queueIndex];
    }
}

let scheduler;

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'Code'; // VS Code base
}

/**
 * Show a one-time popup with instructions for launching with remote debugging port
 * Only shows once per session after relaunch has been attempted
 */
async function showCDPConnectionPopup() {
    if (cdpPopupShownThisSession) return;
    if (!relaunchAttemptedThisSession) return; // Only show after relaunch was attempted

    cdpPopupShownThisSession = true;

    const osModule = require('os');
    const platform = osModule.platform();
    const port = configuredCdpPort;

    let exampleCmd;
    if (platform === 'win32') {
        exampleCmd = `"C:\\Users\\USER\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --remote-debugging-port=${port}`;
    } else if (platform === 'darwin') {
        exampleCmd = `open -a "Antigravity" --args --remote-debugging-port=${port}`;
    } else {
        exampleCmd = `antigravity --remote-debugging-port=${port}`;
    }

    log(`CDP connection failed. Showing one-time popup with launch instructions.`);

    await vscode.window.showWarningMessage(
        `Multi Purpose Agent could not connect to CDP port ${port}. Please launch Antigravity with the remote debugging flag:\n\n${exampleCmd}`,
        { modal: true },
        'OK'
    );
}

async function activate(context) {
    globalContext = context;
    console.log('Multi Purpose Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-accept.toggle';
        statusBarItem.text = '\u{23F3} Multi Purpose: Loading...';
        statusBarItem.tooltip = 'Multi Purpose Agent is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'auto-accept.openSettings';
        statusSettingsItem.text = '\u{2699}\u{FE0F}';
        statusSettingsItem.tooltip = 'Multi Purpose Settings';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Antigravity Quota status bar item
        statusQuotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
        statusQuotaItem.command = 'auto-accept.openSettings';
        statusQuotaItem.text = '\u{1F4CA} Quota: --';
        statusQuotaItem.tooltip = 'Antigravity Quota - Click to open settings';
        context.subscriptions.push(statusQuotaItem);
        // Show based on config setting

        // Queue Status bar item
        statusQueueItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
        statusQueueItem.command = 'auto-accept.showQueueMenu';
        statusQueueItem.text = '\u{1F4CB} Queue: Idle';
        statusQueueItem.tooltip = 'Prompt Queue - Click for controls';
        context.subscriptions.push(statusQueueItem);
        // Hidden by default, shown when queue is running

        console.log('Multi Purpose: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);

        // Load frequency
        pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.globalState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Multi Purpose Agent');
        context.subscriptions.push(outputChannel);

        log(`Multi Purpose: Activating...`);
        log(`Multi Purpose: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isEnabled) {
                log(`[Away] Window focus detected by VS Code API. Checking for away actions...`);
                // Wait a tiny bit for CDP to settle after focus state is pushed
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - 🤖h IDEs use CDP now
        try {
            const { CDPHandler } = require('./cdp-handler');
            const { Relauncher } = require('./relauncher');

            // Read configured CDP port from settings
            configuredCdpPort = vscode.workspace.getConfiguration('auto-accept').get('cdpPort', 9004);
            log(`Configured CDP port: ${configuredCdpPort}`);

            cdpHandler = new CDPHandler(log, configuredCdpPort);
            relauncher = new Relauncher(log, configuredCdpPort);
            log(`CDP handlers initialized for ${currentIDE}.`);



            // CRITICAL: Start CDP connections immediately to establish browser communication
            // This connects to the configured CDP port and injects the browser script
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const detectedWorkspace = workspaceFolders && workspaceFolders.length > 0
                ? workspaceFolders[0].name
                : null;

            const cdpConfig = {
                ide: currentIDE,
                bannedCommands: context.globalState.get(BANNED_COMMANDS_KEY, []),
                pollInterval: context.globalState.get(FREQ_STATE_KEY, 1000),
                workspaceName: detectedWorkspace,
                port: configuredCdpPort
            };
            cdpHandler.start(cdpConfig).then(() => {
                log(`CDP connections established. Active connections: ${cdpHandler.getConnectionCount()}`);
            }).catch(e => {
                log(`CDP start warning: ${e.message}`);
            });

            // Initialize Scheduler
            scheduler = new Scheduler(context, cdpHandler, log, { ensureCdpReady: syncSessions });

            debugHandler = new DebugHandler(context, {
                log,
                getScheduler: () => scheduler,
                getAntigravityClient: () => antigravityClient,
                getLockedOut: () => isLockedOut,
                getCDPHandler: () => cdpHandler,
                getRelauncher: () => relauncher,
                syncSessions: async () => syncSessions()
            });
            debugHandler.startServer();
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Multi Purpose Error: ${err.message}`);
        }

        // 3.5 Initialize Antigravity Client and Quota Display
        const quotaConfig = vscode.workspace.getConfiguration('auto-accept.antigravityQuota');
        const quotaEnabled = quotaConfig.get('enabled', true);
        const quotaPollInterval = quotaConfig.get('pollInterval', 60) * 1000; // Convert to ms

        if (quotaEnabled) {
            // Show quota status bar
            if (statusQuotaItem) {
                statusQuotaItem.show();
            }

            // Initialize and start quota polling (works for all IDEs, not just Antigravity)
            initAntigravityClient().then(connected => {
                if (connected) {
                    log('[Antigravity] Connected to language server, starting quota polling');
                    startQuotaPolling(quotaPollInterval);
                } else {
                    log('[Antigravity] Could not connect to language server');
                    updateQuotaStatusBar('N/A', 'Antigravity not detected');
                }
            }).catch(e => {
                log(`[Antigravity] Init error (non-critical): ${e.message}`);
                updateQuotaStatusBar('N/A', 'Connection error');
            });
        } else {
            log('[Antigravity] Quota display disabled in settings');
            if (statusQuotaItem) {
                statusQuotaItem.hide();
            }
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('auto-accept.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('auto-accept.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('auto-accept.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('auto-accept.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('auto-accept.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('auto-accept.getROIStats', async () => {
                const stats = await loadROIStats(context);
                const timeSavedSeconds = stats.clicksThisWeek * SECONDS_PER_CLICK;
                const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
                return {
                    ...stats,
                    timeSavedMinutes,
                    timeSavedFormatted: timeSavedMinutes >= 60
                        ? `${(timeSavedMinutes / 60).toFixed(1)} hours`
                        : `${timeSavedMinutes} minutes`
                };
            }),
            vscode.commands.registerCommand('auto-accept.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            }),
            vscode.commands.registerCommand('auto-accept.checkAntigravityStatus', () => handleCheckAntigravityStatus()),
            vscode.commands.registerCommand('auto-accept.getAntigravityQuota', () => handleGetAntigravityQuota()),
            vscode.commands.registerCommand('auto-accept.toggleAntigravityQuota', (value) => handleToggleAntigravityQuota(value)),
            vscode.commands.registerCommand('auto-accept.getAntigravityQuotaEnabled', () => {
                const config = vscode.workspace.getConfiguration('auto-accept.antigravityQuota');
                return config.get('enabled', true);
            }),
            vscode.commands.registerCommand('auto-accept.startQueue', async (options) => {
                if (!isEnabled) {
                    vscode.window.showWarningMessage('Multi Purpose Agent is currently OFF. Please enable it first.');
                    return;
                }
                log('[Scheduler] Queue start requested via command');
                if (scheduler) {
                    // Ensure CDP connects/injects the active chat surface before starting the queue.
                    await syncSessions();
                    await scheduler.startQueue(options);
                    log('[Scheduler] Queue start handled via command');
                } else {
                    log('[Scheduler] Cannot start queue - scheduler not initialized');
                    vscode.window.showWarningMessage('Multi Purpose: Scheduler not ready. Please try again.');
                }
            }),
            vscode.commands.registerCommand('auto-accept.getQueueStatus', () => {
                if (scheduler) {
                    const status = scheduler.getStatus();
                    status.isExtensionEnabled = isEnabled;
                    return status;
                }
                return { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0, isQuotaExhausted: false, isExtensionEnabled: isEnabled };
            }),
            vscode.commands.registerCommand('auto-accept.getConversations', async () => {
                if (scheduler) {
                    return await scheduler.getConversations();
                }
                return [];
            }),
            vscode.commands.registerCommand('auto-accept.getPromptHistory', () => {
                if (scheduler) {
                    return scheduler.getHistory();
                }
                return [];
            }),
            vscode.commands.registerCommand('auto-accept.setTargetConversation', (conversationId) => {
                if (scheduler) {
                    scheduler.setTargetConversation(conversationId);
                }
            }),
            vscode.commands.registerCommand('auto-accept.pauseQueue', () => {
                if (!isEnabled) return;
                if (scheduler) {
                    scheduler.pauseQueue();
                }
            }),
            vscode.commands.registerCommand('auto-accept.resumeQueue', () => {
                if (!isEnabled) return;
                if (scheduler) {
                    scheduler.resumeQueue();
                }
            }),
            vscode.commands.registerCommand('auto-accept.skipPrompt', async () => {
                if (!isEnabled) return;
                if (scheduler) {
                    await scheduler.skipPrompt();
                }
            }),
            vscode.commands.registerCommand('auto-accept.stopQueue', () => {
                if (scheduler) {
                    scheduler.stopQueue();
                }
            }),
            vscode.commands.registerCommand('auto-accept.showQueueMenu', async () => {
                if (!scheduler) return;

                const status = scheduler.getStatus();
                const items = [];

                if (status.isRunningQueue) {
                    if (status.isPaused) {
                        items.push({ label: '\u{25B6}\u{FE0F} Resume', action: 'resume' });
                    } else {
                        items.push({ label: '\u{23F8}\u{FE0F} Pause', action: 'pause' });
                    }
                    items.push({ label: '\u{23ED}\u{FE0F} Skip Current', action: 'skip' });
                    items.push({ label: '\u{23F9}\u{FE0F} Stop Queue', action: 'stop' });
                }
                items.push({ label: '\u{2699}\u{FE0F} Open Settings', action: 'settings' });

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `Queue: ${status.queueIndex + 1}/${status.queueLength}${status.isPaused ? ' (Paused)' : ''}`
                });

                if (selected) {
                    switch (selected.action) {
                        case 'pause': scheduler.pauseQueue(); break;
                        case 'resume': scheduler.resumeQueue(); break;
                        case 'skip': await scheduler.skipPrompt(); break;
                        case 'stop': scheduler.stopQueue(); break;
                        case 'settings': vscode.commands.executeCommand('auto-accept.openSettings'); break;
                    }
                }
            }),
            vscode.commands.registerCommand('auto-accept.resetSettings', async () => {
                // Reset all extension settings
                await context.globalState.update(GLOBAL_STATE_KEY, false);
                await context.globalState.update(FREQ_STATE_KEY, 1000);
                await context.globalState.update(BANNED_COMMANDS_KEY, undefined);
                await context.globalState.update(ROI_STATS_KEY, undefined);
                isEnabled = false;
                bannedCommands = [];
                vscode.window.showInformationMessage('Multi Purpose: All settings reset to defaults.');
                updateStatusBar();
            }),
            // Debug Mode Command - Allows AI agent programmatic control
            vscode.commands.registerCommand('auto-accept.debugCommand', async (action, params = {}) => {
                if (debugHandler) {
                    return await debugHandler.handleCommand(action, params);
                }
                return { success: false, error: 'DebugHandler not ready' };
            })
        );

        // Monitor configuration changes for Debug Mode
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('auto-accept.debugMode.enabled') && debugHandler) {
                const enabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
                if (enabled) {
                    debugHandler.startServer();
                } else {
                    debugHandler.stopServer();
                }
            }
        }));


        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        log('Multi Purpose: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Multi Purpose Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return false;

    log('Checking for active CDP session...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        log('CDP is active and available.');
        return true;
    } else {
        log(`CDP not found on port ${configuredCdpPort}.`);
        if (showPrompt && relauncher) {
            log('Initiating CDP setup and relaunch flow...');
            await relauncher.ensureCDPAndRelaunch();
        }
        return false;
    }
}

async function checkEnvironmentAndStart() {
    const vscode = require('vscode');
    const currentVersion = vscode.extensions.getExtension('Rodhayl.multi-purpose-agent')?.packageJSON?.version || '0.0.0';
    const storedVersion = globalContext.globalState.get(EXTENSION_VERSION_KEY, null);

    // Detect fresh install or reinstall (version changed)
    const isNewInstall = storedVersion === null;
    const isReinstall = storedVersion !== null && storedVersion !== currentVersion;

    if (isNewInstall || isReinstall) {
        log(`${isReinstall ? 'Reinstall' : 'New install'} detected (${storedVersion} → ${currentVersion}). Resetting CDP setup state.`);
        await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, false);
        await globalContext.globalState.update(EXTENSION_VERSION_KEY, currentVersion);
    }

    const cdpSetupCompleted = globalContext.globalState.get(CDP_SETUP_COMPLETED_KEY, false);
    const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

    // First install or reinstall: CDP not set up yet, prompt for restart
    if (!cdpSetupCompleted && !cdpAvailable && relauncher) {
        log('CDP not available, showing restart prompt...');
        await relauncher.ensureCDPAndRelaunch();
        await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, true);
        updateStatusBar();
        return;
    }

    // Restart was done but CDP still not available (wrong port) - show error popup
    if (cdpSetupCompleted && !cdpAvailable) {
        log('Restart was done but CDP still not available. Showing port error popup...');
        relaunchAttemptedThisSession = true;
        await showCDPConnectionPopup();
    }

    // Mark setup complete if CDP is already working
    if (!cdpSetupCompleted && cdpAvailable) {
        log('CDP already available, marking setup complete.');
        await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, true);
    }

    // Normal startup: if extension was enabled, try to restore state
    if (isEnabled) {
        log('Initializing Multi Purpose environment...');
        if (!cdpAvailable) {
            log('Multi Purpose was enabled but CDP not available. Resetting to OFF.');
            isEnabled = false;
            await globalContext.globalState.update(GLOBAL_STATE_KEY, false);
        } else {
            await startPolling();
            startStatsCollection(globalContext);
        }
    }
    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        // Check CDP availability first
        const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

        // If trying to enable but CDP not available, prompt for relaunch (don't change state)
        if (!isEnabled && !cdpAvailable && relauncher) {
            log('Multi Purpose: CDP not available. Prompting for setup/relaunch.');
            const result = await relauncher.ensureCDPAndRelaunch();
            relaunchAttemptedThisSession = true;

            // If relaunch was not chosen (user clicked "Later" or modification failed), 
            // show the one-time popup with manual launch instructions
            if (!result.relaunched) {
                await showCDPConnectionPopup();
            }
            return; // Don't change state - toggle stays OFF
        }

        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        // Update state and UI IMMEDIATELY (non-blocking)
        await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        log('  Calling updateStatusBar...');
        updateStatusBar();
        
        // Ensure settings panel updates immediately
        const panelClass = getSettingsPanel();
        if (panelClass && panelClass.currentPanel) {
            panelClass.currentPanel.panel.webview.postMessage({
                command: 'updateExtensionState',
                isEnabled: isEnabled
            });
        }
        
        if (isEnabled) {
            vscode.window.showInformationMessage('Multi Purpose Agent: ON');
        } else {
            vscode.window.showInformationMessage('Multi Purpose Agent: OFF');
        }

        // Do CDP operations in background (don't block toggle)
        if (isEnabled) {
            log('Multi Purpose: Enabled');
            // These operations happen in background
            ensureCDPOrPrompt(true).then(() => startPolling());
            startStatsCollection(context);
            incrementSessionCount(context);
        } else {
            log('Multi Purpose: Disabled');

            // Fire-and-forget: Show session summary notification (non-blocking)
            if (cdpHandler) {
                cdpHandler.getSessionSummary()
                    .then(summary => showSessionSummaryNotification(context, summary))
                    .catch(() => { });
            }

            // Fire-and-forget: collect stats and stop in background
            collectAndSaveStats(context).catch(() => { });
            stopPolling().catch(() => { });
        }

        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }

    log('Initiating Relaunch sequence...');
    await relauncher.ensureCDPAndRelaunch();
}

async function handleFrequencyUpdate(context, freq) {
    pollFrequency = freq;
    await context.globalState.update(FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isEnabled) {
        await syncSessions();
    }
}

async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions...`);
        try {
            await cdpHandler.start({
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands
            });
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        }
    }
}

// Update Queue Status Bar
function updateQueueStatusBar() {
    if (!statusQueueItem || !scheduler) return;

    const status = scheduler.getStatus();

    if (status.isRunningQueue) {
        statusQueueItem.show();
        const pauseIndicator = status.isPaused ? ' \u{23F3}' : '';
        statusQueueItem.text = `\u{1F4CB} Queue ${status.queueIndex + 1}/${status.queueLength}${pauseIndicator}`;
        statusQueueItem.tooltip = status.isPaused
            ? 'Queue is paused - Click to resume'
            : `Running prompt ${status.queueIndex + 1} of ${status.queueLength} - Click for controls`;
    } else {
        statusQueueItem.hide();
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Multi Purpose: Monitoring session...');

    // Initial trigger
    await syncSessions();
    if (scheduler) scheduler.start();

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isEnabled) return;

        // Check for instance locking - only the first extension instance should control CDP
        const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
        const activeInstance = globalContext.globalState.get(lockKey);
        const myId = globalContext.extension.id;

        if (activeInstance && activeInstance !== myId) {
            const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
            if (lastPing && (Date.now() - lastPing) < 15000) {
                if (!isLockedOut) {
                    log(`CDP Control: Locked by another instance (${activeInstance}). Standby mode.`);
                    isLockedOut = true;
                    updateStatusBar();
                }
                return;
            }
        }

        // We are the leader or lock is dead
        globalContext.globalState.update(lockKey, myId);
        globalContext.globalState.update(`${lockKey}-ping`, Date.now());

        if (isLockedOut) {
            log('CDP Control: Lock acquired. Resuming control.');
            isLockedOut = false;
            updateStatusBar();
        }

        await syncSessions();
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (statsCollectionTimer) {
        clearInterval(statsCollectionTimer);
        statsCollectionTimer = null;
    }
    if (scheduler) scheduler.stop();
    if (cdpHandler) await cdpHandler.stop();
    log('Multi Purpose: Polling stopped');
}

// --- ROI Stats Collection ---

function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

async function loadROIStats(context) {
    const defaultStats = {
        weekStart: getWeekStart(),
        clicksThisWeek: 0,
        blockedThisWeek: 0,
        sessionsThisWeek: 0
    };

    let stats = context.globalState.get(ROI_STATS_KEY, defaultStats);

    // Check if we need to reset for a new week
    const currentWeekStart = getWeekStart();
    if (stats.weekStart !== currentWeekStart) {
        log(`ROI Stats: New week detected. Showing summary and resetting.`);

        // Show weekly summary notification if there were meaningful stats
        if (stats.clicksThisWeek > 0) {
            await showWeeklySummaryNotification(context, stats);
        }

        // Reset for new week
        stats = { ...defaultStats, weekStart: currentWeekStart };
        await context.globalState.update(ROI_STATS_KEY, stats);
    }

    // Calculate formatted time for UI
    const timeSavedSeconds = (stats.clicksThisWeek || 0) * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)}h`;
    } else {
        timeStr = `${timeSavedMinutes}m`;
    }
    stats.timeSavedFormatted = timeStr;

    return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
    const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
    } else {
        timeStr = `${timeSavedMinutes} minutes`;
    }

    const message = `\u{1F4CA} Last week, Multi Purpose saved you ${timeStr} by auto-clicking ${lastWeekStats.clicksThisWeek} buttons!`;

    let detail = '';
    if (lastWeekStats.sessionsThisWeek > 0) {
        detail += `Recovered ${lastWeekStats.sessionsThisWeek} stuck sessions. `;
    }
    if (lastWeekStats.blockedThisWeek > 0) {
        detail += `Blocked ${lastWeekStats.blockedThisWeek} dangerous commands.`;
    }

    const choice = await vscode.window.showInformationMessage(
        message,
        { detail: detail.trim() || undefined },
        'View Details'
    );

    if (choice === 'View Details') {
        const panel = getSettingsPanel();
        if (panel) {
            panel.createOrShow(context.extensionUri, context);
        }
    }
}

// --- SESSION SUMMARY NOTIFICATION ---
// Called when user finishes a session (e.g., leaves conversation view)
async function showSessionSummaryNotification(context, summary) {
    log(`[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`);
    if (!summary || summary.clicks === 0) {
        log(`[Notification] Session summary skipped: no clicks`);
        return;
    }
    log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

    const lines = [
        `\u{1F7E2} This session:`,
        `- ${summary.clicks} actions auto-accepted`,
        `- ${summary.terminalCommands} terminal commands`,
        `- ${summary.fileEdits} file edits`,
        `- ${summary.blocked} interruptions blocked`
    ];

    if (summary.estimatedTimeSaved) {
        lines.push(`\n\u{23F3} Estimated time saved: ~${summary.estimatedTimeSaved} minutes`);
    }

    const message = lines.join('\n');

    vscode.window.showInformationMessage(
        `\u{1F916} Multi Purpose: ${summary.clicks} actions handled this session`,
        { detail: message },
        'View Stats'
    ).then(choice => {
        if (choice === 'View Stats') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `\u{1F680} Multi Purpose handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
    if (!cdpHandler || !isEnabled) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}

async function collectAndSaveStats(context) {
    if (!cdpHandler) return;

    try {
        // Get stats from browser and reset them
        const browserStats = await cdpHandler.resetStats();

        if (browserStats.clicks > 0 || browserStats.blocked > 0) {
            const currentStats = await loadROIStats(context);
            currentStats.clicksThisWeek += browserStats.clicks;
            currentStats.blockedThisWeek += browserStats.blocked;

            await context.globalState.update(ROI_STATS_KEY, currentStats);
            log(`ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`);

            // Broadcast update to real-time dashboard
            const panel = getSettingsPanel();
            if (panel) {
                panel.sendROIStats();
            }
        }
    } catch (e) {
        // Silently fail - stats collection should not interrupt normal operation
    }
}

async function incrementSessionCount(context) {
    const stats = await loadROIStats(context);
    stats.sessionsThisWeek++;
    await context.globalState.update(ROI_STATS_KEY, stats);
    log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
    if (statsCollectionTimer) clearInterval(statsCollectionTimer);

    // Collect stats every 30 seconds and check for away actions
    statsCollectionTimer = setInterval(() => {
        if (isEnabled) {
            collectAndSaveStats(context);
            checkForAwayActions(context); // Check if user returned from away
        }
    }, 30000);

    log('ROI Stats: Collection started (every 30s)');
}


function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Multi Purpose is running.`;
        let bgColor = undefined;
        let icon = '\u{2705}';

        const cdpConnected = cdpHandler && cdpHandler.getConnectionCount() > 0;

        if (cdpConnected) {
            tooltip += ' (CDP Connected)';
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            icon = '\u{1F504}';
        }

        statusBarItem.text = `${icon} Multi Purpose: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

    } else {
        statusBarItem.text = '\u{2B55} Multi Purpose: OFF';
        statusBarItem.tooltip = 'Click to enable Multi Purpose.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}


// --- Antigravity Backend Integration ---

/**
 * Initialize the Antigravity client connection (non-blocking)
 */
async function initAntigravityClient() {
    try {
        const ClientClass = getAntigravityClient();
        if (!ClientClass) {
            log('[Antigravity] Failed to load AntigravityClient class');
            return false;
        }

        antigravityClient = new ClientClass(log);
        const connected = await antigravityClient.connect();

        if (connected) {
            log('[Antigravity] Client connected successfully');
            return true;
        } else {
            log('[Antigravity] Client connection failed');
            return false;
        }
    } catch (e) {
        log(`[Antigravity] Init error: ${e.message}`);
        return false;
    }
}

/**
 * Handle the checkAntigravityStatus command
 */
async function handleCheckAntigravityStatus() {
    log('[Antigravity] Checking status...');

    // Try to connect if not already connected
    if (!antigravityClient || !antigravityClient.isConnected()) {
        const connected = await initAntigravityClient();

        if (!connected) {
            vscode.window.showWarningMessage(
                'Antigravity: Could not connect to language server. Is Antigravity running?'
            );
            return { connected: false };
        }
    }

    const status = antigravityClient.getStatus();
    vscode.window.showInformationMessage(`Antigravity: ${status}`);
    return { connected: true, status };
}

/**
 * Handle the getAntigravityQuota command - returns quota data for settings panel
 */
async function handleGetAntigravityQuota() {
    log('[Antigravity] Fetching quota...');

    // Try to connect if not already connected
    if (!antigravityClient || !antigravityClient.isConnected()) {
        const connected = await initAntigravityClient();
        if (!connected) {
            return null;
        }
    }

    try {
        return await antigravityClient.getUserStatus();
    } catch (e) {
        log(`[Antigravity] Quota fetch error: ${e.message}`);
        return null;
    }
}

/**
 * Update the quota status bar item
 */
function updateQuotaStatusBar(text, tooltip) {
    if (statusQuotaItem) {
        statusQuotaItem.text = `\u{1F4CA} ${text}`;
        statusQuotaItem.tooltip = tooltip || 'Antigravity Quota - Click to view details';
    }
}

/**
 * Fetch quota and update status bar
 */
async function refreshQuotaStatus() {
    if (!antigravityClient || !antigravityClient.isConnected()) {
        updateQuotaStatusBar('N/A', 'Not connected to Antigravity');
        return;
    }

    try {
        const snapshot = await antigravityClient.getUserStatus();

        // Determine if any model is exhausted
        let anyExhausted = false;

        if (snapshot.models && snapshot.models.length > 0) {
            // Find the model with lowest quota for the icon
            // Find the model with lowest quota for the icon
            const sortedModels = snapshot.models
                .sort((a, b) => {
                    // Exhausted first
                    if (a.isExhausted && !b.isExhausted) return -1;
                    if (!a.isExhausted && b.isExhausted) return 1;

                    // Then by percentage
                    const pA = a.remainingPercentage !== undefined ? a.remainingPercentage : 0;
                    const pB = b.remainingPercentage !== undefined ? b.remainingPercentage : 0;
                    return pA - pB;
                });

            const lowestModel = sortedModels[0];

            // Check if any model is exhausted
            anyExhausted = snapshot.models.some(m => m.isExhausted === true);

            if (lowestModel) {
                const pct = (lowestModel.remainingPercentage !== undefined ? lowestModel.remainingPercentage : 0).toFixed(0) + '%';
                const icon = lowestModel.isExhausted ? '\u{1F534}' :
                    lowestModel.remainingPercentage < 20 ? '\u{1F7E0}' : '\u{1F7E2}';

                // Build tooltip with ALL model quotas
                const tooltipLines = ['\u{1F4CA} Antigravity Model Quotas:'];
                for (const model of snapshot.models) {
                    const mIcon = model.isExhausted ? '\u{1F534}' :
                        model.remainingPercentage < 20 ? '\u{1F7E0}' : '\u{1F7E2}';
                    const mPct = (model.remainingPercentage !== undefined ? model.remainingPercentage : 0).toFixed(0) + '%';

                    const resetInfo = model.timeUntilResetFormatted ? ` - ${model.timeUntilResetFormatted}` : '';
                    tooltipLines.push(`${mIcon} ${model.label}: ${mPct}${resetInfo}`);
                }
                tooltipLines.push('', 'Click to view details');

                updateQuotaStatusBar(
                    `${icon} ${pct}`,
                    tooltipLines.join('\n')
                );
            } else {
                updateQuotaStatusBar('OK', 'Quota available');
            }
        } else if (snapshot.promptCredits) {
            const pct = snapshot.promptCredits.remainingPercentage.toFixed(0);
            updateQuotaStatusBar(
                `${pct}%`,
                `Prompt Credits: ${snapshot.promptCredits.available}/${snapshot.promptCredits.monthly}`
            );
        } else {
            updateQuotaStatusBar('OK', 'Connected to Antigravity');
        }

        // Notify scheduler of quota status change
        if (scheduler) {
            scheduler.setQuotaExhausted(anyExhausted);
        }
    } catch (e) {
        log(`[Antigravity] Quota refresh error: ${e.message}`);
        updateQuotaStatusBar('ERR', `Error: ${e.message}`);
    }
}

/**
 * Start polling for quota updates
 */
function startQuotaPolling(intervalMs = 120000) {
    stopQuotaPolling();

    // Initial fetch
    refreshQuotaStatus();

    // Start polling
    quotaPollingTimer = setInterval(() => {
        refreshQuotaStatus();
    }, intervalMs);

    log(`[Antigravity] Quota polling started (interval: ${intervalMs}ms)`);
}

/**
 * Stop quota polling
 */
function stopQuotaPolling() {
    if (quotaPollingTimer) {
        clearInterval(quotaPollingTimer);
        quotaPollingTimer = null;
        log('[Antigravity] Quota polling stopped');
    }
}

/**
 * Toggle Antigravity Quota display
 */
function handleToggleAntigravityQuota(enabled) {
    const config = vscode.workspace.getConfiguration('auto-accept.antigravityQuota');
    config.update('enabled', enabled, vscode.ConfigurationTarget.Global);

    if (enabled) {
        if (statusQuotaItem) statusQuotaItem.show();

        if (antigravityClient && antigravityClient.isConnected()) {
            const pollInterval = config.get('pollInterval', 120) * 1000;
            startQuotaPolling(pollInterval);
        } else {
            initAntigravityClient().then(connected => {
                if (connected) {
                    const pollInterval = config.get('pollInterval', 120) * 1000;
                    startQuotaPolling(pollInterval);
                }
            });
        }
    } else {
        stopQuotaPolling();
        if (statusQuotaItem) statusQuotaItem.hide();
    }
}

// --- Debug HTTP Server ---
function startDebugServer() {
    if (debugServer) return;

    // Check if debug mode is enabled
    const debugEnabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
    if (!debugEnabled) return;

    try {
        debugServer = http.createServer(async (req, res) => {
            // CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method !== 'POST') {
                res.writeHead(405);
                res.end('Method not allowed');
                return;
            }

            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    let data = {};
                    if (body) {
                        data = JSON.parse(body);
                    }
                    const { action, params } = data;
                    log(`[DebugServer] Received action: ${action}`);

                    const result = await vscode.commands.executeCommand('auto-accept.debugCommand', action, params);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
        });

        debugServer.listen(54321, '127.0.0.1', () => {
            log('Debug Server running on http://127.0.0.1:54321');
        });

        debugServer.on('error', (e) => {
            log(`Debug Server Error: ${e.message}`);
            debugServer = null;
        });

    } catch (e) {
        log(`Failed to start Debug Server: ${e.message}`);
    }
}

function stopDebugServer() {
    if (debugServer) {
        debugServer.close();
        debugServer = null;
        log('Debug Server stopped');
    }
}

async function deactivate() {
    stopPolling();
    stopQuotaPolling();
    stopDebugServer();
    if (cdpHandler) {
        cdpHandler.stop();
    }
    if (antigravityClient) {
        antigravityClient.disconnect();
        antigravityClient = null;
    }

    // Cleanup: Clear all extension state (for uninstall)
    if (globalContext) {
        try {
            await globalContext.globalState.update(GLOBAL_STATE_KEY, undefined);
            await globalContext.globalState.update(FREQ_STATE_KEY, undefined);
            await globalContext.globalState.update(BANNED_COMMANDS_KEY, undefined);
            await globalContext.globalState.update(ROI_STATS_KEY, undefined);
            await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, undefined);
            await globalContext.globalState.update(EXTENSION_VERSION_KEY, undefined);
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    // Cleanup: Remove log files
    try {
        const fs = require('fs');
        const path = require('path');
        const logPattern = /^multi-purpose-cdp-.*\.log$/;
        const files = fs.readdirSync(extensionRoot);
        for (const file of files) {
            if (logPattern.test(file)) {
                fs.unlinkSync(path.join(extensionRoot, file));
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}

module.exports = { activate, deactivate };
