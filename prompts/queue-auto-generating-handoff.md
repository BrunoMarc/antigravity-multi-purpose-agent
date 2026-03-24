# 🌳 MIGRATION & STABILIZATION INFINITE LOOP — AST BLUEPRINT PROJECT

## A Visão Macro (O Épico)
Nós acabamos de realizar um refatoramento arquitetural massivo no projeto Blueprint: nós abandonamos a extração de configurações via Regex, que era frágil e propensa a falhas de indentação, e migramos para um parser tipado e profundo usando **AST (ts-morph / TypeScript Compiler API)**.
Nosso ecossistema possui **Geradores de Códigos** baseados nesses blueprints que geram de forma automatizada Testes Unitários/Integration, Testes E2E e Handlers MSW.

**A Missão Inegociável:** Nós não vamos apenas "consertar os quebrados" da migração AST para igualar o antigo patamar do regex. A meta é criar geradores exaustivamente inteligentes que possuam Cobertura Máxima (100% dos cenários) e gerem testes (outputs) com Pass Rate de 100%. O trabalho autônomo é infinito.

---

## Regras de Execução Autônoma
1. **Proatividade Absoluta:** O trabalho NUNCA acaba. Se você arrumou um gap de testes ou fixou 10 bugs E2E, não pare. Encontre a próxima fragilidade do sistema (MSW não tem branch coverage? E2E não testa *catalogToggle*? Unit não testa *fullscreenModal*?) e engate a marcha.
2. **NUNCA modifique o Output Manualmente:** Se um teste e2e (`*.generated.spec.ts`) ou unitário falhar, **NUNCA** edite o arquivo gerado para consertar. A correção deve ser SEMPRE feita no script gerador (os bridges AST em `scripts/ast/`, os templates em `scripts/e2e-gen/templates/`, ou o metadata-builder `scripts/e2e-gen/test-metadata-builder.ts`). Depois, você obrigatoriamente roda o gerador para atualizar o arquivo.
3. **Seja Impiedoso nos Testes:** Testar não é apenas dar "npm run test" num mock bobo. É regerar TODAS as specs afetadas da aplicação e validá-las em ambiente real contra o frontend.

---

## Pipeline de Dados (Conheça os Bridges)

O E2E generator usa um pipeline de 4 camadas que você DEVE dominar:

```
Blueprint (.blueprint.ts)
  → AST Parser (scripts/ast/blueprint-parser.ts)
    → Bridge (scripts/ast/e2egen-bridge.ts)
      → Metadata Builder (scripts/e2e-gen/test-metadata-builder.ts)
        → Templates (scripts/e2e-gen/templates/*.template.ts)
          → Generated Spec (e2e/*.generated.spec.ts)
```

**ATENÇÃO:** Existem bridges DIFERENTES para cada gerador:
| Gerador | Bridge | Runner |
|---------|--------|--------|
| E2E Spec | `scripts/ast/e2egen-bridge.ts` | `scripts/e2e-gen/generator.ts` |
| MSW Handler | `scripts/ast/mswgen-bridge.ts` | `scripts/msw-gen.ts` |
| Unit Spec | `scripts/ast/specgen-bridge.ts` | `scripts/spec-gen.ts` (legacy) |
| Integration | `scripts/ast/intgen-bridge.ts` | `scripts/integration-gen/index.ts` |

Se você alterar o `blueprint-parser.ts`, **TODOS** os bridges são afetados. Se alterar apenas um bridge, só afeta o gerador correspondente. Regere tudo que for afetado.

---

## Comandos Obrigatórios do Ciclo de Vida

> **IMPORTANTE:** Todos os scripts usam `npx tsx` (TypeScript executado via tsx). NÃO existe `.cjs` — a migração para `.ts` já foi concluída.

### 1. Regeneração Total dos Outputs (Após mudar um Gerador/Template)
```bash
# Regerar Testes E2E (TODOS os módulos)
npm run gen:spec:all

# Regerar MSW Handlers (TODOS os módulos)
npm run gen:msw:all

# Regerar Testes Unit/Integration (TODOS os módulos)
npm run gen:unit-spec:all

# Regerar Integration specs
npm run gen:integration -- --all
```

### 2. Testes Internos dos Geradores (Rápido, rode PRIMEIRO)
Antes de regerar, valide que os geradores em si não quebraram:
```bash
# Testes do AST extractor (blueprint-parser + bridges)
npx tsx --test scripts/ast/__tests__/*.test.ts

# Testes dos templates E2E
npx tsx --test scripts/e2e-gen/__tests__/*.test.ts

# Testes do MSW generator
npx tsx --test scripts/msw-gen/__tests__/*.test.ts

# Testes do unit-spec generator
npx tsx --test scripts/unit-gen/__tests__/*.test.ts
npx tsx --test scripts/unit-spec-gen/__tests__/*.test.ts

# Testes do validator
npx tsx --test scripts/__tests__/*.test.ts
```

### 3. Validação E2E Impiedosa (Playwright 16 Workers)
```bash
# Suite completa (bail após 60 falhas)
PLAYWRIGHT_FAST=1 MAX_FAILURES=60 ./scripts/run-ai-tests.sh

# Re-rodar APENAS os que falharam (economiza 10+ min)
./scripts/run-ai-tests.sh --last-failed

# Analisar falhas em detalhe (JSON + markdown report)
cat test-report-for-coding-agents/all-failures.md | head -80
python3 -c "import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Pass: {s[\"expected\"]}/{s[\"expected\"]+s[\"unexpected\"]} ({s[\"expected\"]*100/(s[\"expected\"]+s[\"unexpected\"]):.1f}%)')"
```

### 4. Testes Unitários da Aplicação (Vitest 4.0)
O projeto usa Angular 21 com `@angular/build:unit-test` e **Vitest 4.0** (config em `vitest.config.ts`).
```bash
# Rodar unit tests com coverage (Vitest via ng test)
npm run test:coverage 2>&1 | tail -40

# Rodar unit tests rápido (sem coverage, watch desabilitado)
CI=true npm test -- --watch=false

# Rodar um módulo específico
CI=true npm test -- --watch=false --include='**/features/banks/**'
```

---

## Estratégia Anti-Flaky (16 Workers Paralelos)

Com 16 workers Playwright rodando em paralelo, timing issues são comuns. Siga essas regras:

1. **Sempre distinga falha sistêmica de flaky:** Se um teste falha em TODAS as execuções, é bug no gerador. Se falha 1 em 3 vezes, é timing issue.
2. **Use `--last-failed` para confirmar:** Re-rode falhas isoladas com `./scripts/run-ai-tests.sh --last-failed`. Se passam na segunda vez, são flaky.
3. **waitFor > isVisible:** Em templates, use `waitFor({state:'attached', timeout: 5000})` ao invés de `isVisible()` para detectar elementos Angular que podem demorar a renderizar.
4. **Nunca use `page.goto()` para sub-navigation.** Use click no menu-item + `waitForURL` conforme padrão CJS original.
5. **Threshold de aprovação realista:** Se > 99% passam e as falhas restantes são scattered (não burst de um módulo), investigue individualmente antes de refatorar tudo.

---

## Prioridades (P0 → P2) — Matriz de Triage

| Prio | Categoria | Critério | Ação |
|------|-----------|----------|------|
| **P0** | Burst Failures | ≥ 5 falhas consecutivas do mesmo módulo | Bug sistêmico no template/bridge. Corrigir IMEDIATAMENTE |
| **P0** | Generator Crash | `gen:spec:all` falha para algum módulo | Parser ou bridge com bug. Fix antes de qualquer teste |
| **P1** | Scattered Tests | Falhas em 3-5 módulos diferentes | Padrão comum nos templates (ex: botão add, form validation) |
| **P1** | MSW Data Mismatch | Teste E2E falha por dados MSW incorretos | Bridge MSW não extrai campo corretamente |
| **P2** | Flaky Tests | Passa 2/3 vezes, falha 1/3 | Timing issue — adicionar waitFor ou aumentar timeout |
| **P2** | Coverage Gap | Cenário existente no CJS não migrado para TS | Adicionar ao template correspondente |

---

## O Que Você Deve Fazer NESTE Exato Ciclo
1. Analise o estado atual dos bugs ou a saúde da cobertura de testes lendo as saídas do Terminal.
2. Planeje qual lote de problemas você resolverá nos próximos minutos (ex: Timeouts de form validation E2E, ou Mapeamento MSW incompleto).
3. Inicie imediatamente as implementações e refatorações no código dos geradores.
4. Execute os comandos de **Testes Internos dos Geradores** (Passo 2 acima) para validar sem regerar.
5. Execute os comandos de **Regeneração Total** (Passo 1 acima).
6. Execute os comandos de **Validação E2E** (Passo 3 acima) para garantir 100% de Pass Rate.
7. Quando achar que terminou o lote com sucesso absoluto, NÃO pare e não peça aprovação. Emita o seu relatório e passe a bola para o Check Prompt te validar severamente.