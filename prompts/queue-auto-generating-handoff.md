# 🌳 MIGRATION & STABILIZATION INFINITE LOOP — TEST GENERATOR EVOLUTION & COVERAGE EXPANSION

## A Visão Macro (O Épico)
Nós finalizamos a **Phase 5 (Amplitude Coverage)** e abolimos o código legado de Regex, consolidando o ecossistema **AST (ts-morph)**. A pipeline de testes (E2E, Unit, MSW) executa mais de 8.000 testes locais robustos.

Nosso **NOVO OBJETIVO DO ÉPICO** é a **Evolução da Inteligência e Amplitude de Cobertura de TODOS os Geradores (Unit, Integration e E2E)**. A meta é criar templates exaustivamente inteligentes que explorem todos os cenários de UI/Integração com 100% de Pass Rate e >90% de Coverage.

**A Missão Inegociável:**
1. **Saúde dos Geradores:** Todos os scripts de parser/bridge devem passar 100% em seus próprios testes.
2. **Amplitude Inteligente (Generated Output):** Testar regras profundas de fato: Unit Specs atritando com a DOM real via TestBed (ex: `hideIf` injetando `.hidden`); E2E manipulando paginação severa e payloads cruzados; Integration checkando 100% de match de rotas.

---

## 🧭 O Ciclo de Execução Autônoma (Seu Roteiro Mental)
Para não se perder na autonomia infinita, você deve seguir este loop mental rigorosamente:

1. **Investigação (Read Before Write):** Leia o `.playwright-results.json`, logs do `npm run test:coverage` ou código fonte dos templates E2E/Unit atuais. Descubra o elo fraco da bateria de testes.
2. **Evolua a Origem:** NUNCA edite `*.generated.spec.ts`. O fix *sempre* ocorre nos `scripts/` (bridges, templates). Depois regere.
3. **Smart Testing (Test-Driven):** Não rode a suite total de cara se não for necessário. Gere para 1 módulo e rode o arquivo isolado. Deu verde? Aí sim, gere pra todos os 77 módulos e verifique impacto sistêmico.
4. **Protocolo Anti-Stuck (Evite Loops Infinitos):** Se você tentou arrumar o mesmo gerador/template 3 vezes e os testes continuam quebrando o build dos projetos, **PARE E FAÇA ROLLBACK (`git checkout -- <arquivo>`)**. Assuma a derrota tática, limpe o arquivo e ataque a próxima tarefa da pilha de prioridades. Não persista em becos sem saída lógicos.

---

## Pipeline de Dados (Conheça os Bridges)
```
Blueprint (.blueprint.ts)
  → AST Parser (scripts/ast/blueprint-parser.ts)
    → Bridge (scripts/ast/*-bridge.ts)
      → Metadata Builder (scripts/*-gen/test-metadata-builder.ts)
        → Templates (scripts/*/templates/*.template.ts)
          → Generated Spec (*.generated.spec.ts)
```
*Se alterar `blueprint-parser.ts`, TODOS afetam. Se alterar um template, afeta apenas sua engine. Os runners são diferentes: `e2e-gen/generator.ts`, `msw-gen.ts`, `spec-gen.ts`, `integration-gen/index.ts`.*

---

## Comandos Obrigatórios do Ciclo de Vida (NÃO EXISTE .cjs, use `npx tsx`)

### 1. Testes Internos dos Geradores (Sempre rode antes de regerar o projeto inteiro)
```bash
npx tsx --test scripts/ast/__tests__/*.test.ts
npx tsx --test scripts/e2e-gen/__tests__/*.test.ts
npx tsx --test scripts/msw-gen/__tests__/*.test.ts
npx tsx --test scripts/unit-gen/__tests__/*.test.ts
npx tsx --test scripts/__tests__/*.test.ts
```

### 2. Regeneração Massiva dos Outputs
```bash
npm run gen:spec:all && npm run gen:msw:all && npm run gen:unit-spec:all && npm run gen:integration -- --all
```

### 3. Validação E2E (Playwright 16 Workers) e Unitária (Vitest 4.0)
```bash
# E2E - Rápido para Debug:
./scripts/run-ai-tests.sh --last-failed

# E2E - Validação Final:
PLAYWRIGHT_FAST=1 MAX_FAILURES=60 ./scripts/run-ai-tests.sh

# Unit - Rápido e Nichado (Testando apenas o que você está evoluindo):
CI=true npm test -- --watch=false --include='**/features/seu-modulo/**'

# Unit - Coverage Global:
npm run test:coverage 2>&1 | tail -40
```

---

## Estratégia Anti-Flaky (E2E)
1. **Flaky vs Bug:** Falha 100% das vezes = Bug no seu template. Falha 1/3 das vezes = Timing issue proveniente do Playwright vs PrimeNG.
2. **Confirme:** Use `--last-failed`. Passou de 2ª vez? É flaky. Você não quebrou nada massivamente.
3. **Resiliência Angular:** Use `waitFor({state:'attached', timeout: 5000})` no Playwright em vez de `isVisible()` para modais ou dropdowns. Nunca use `page.goto()` para subnav (use cliques nos submenus de layout + `waitForURL()`).

---

## Matriz de Triage Dinâmica (P0 → P2)
| Prio | Foco | Critério | Ação |
|------|------|----------|------|
| **P0** | Quebras Fatais | Geradores falhando (`tsx --test` vermelho) ou erro em `npm run gen:*`. | Conserto IMEDIATO da meta-lógica. Sem isso nada existe. Use o Anti-Stuck caso falhe após múltiplas tentativas. |
| **P1** | Unit/Int Intelligence | Testbed ignora observables, validators assíncronos não testados no DOM. | Injectar mocks e asserções visuais reais via Unit Templates. |
| **P1** | E2E Intelligence | Payloads `state.body` divergem da UI, inputs `multiselect` intocados. | Elevar assertividade cruzada dos helpers/templates do Playwright. |
| **P2** | Meta-Testes Faltantes | Novas lógicas e functions exportadas nos Parsers/Bridges não tem coverage. | Adicionar coverage ao meta-gerador criando mais cenários para os scripts. |

---

## Ordem de Trabalho NESTE Ciclo
1. **Escolha o Alvo:** Decida friamente de quem será a evolução (Unit, E2E, Int, Parser) baseado nas métricas passadas.
2. **Desenhe o Hack:** Deixe claro internamente o que o template atual suporta e a inteligência que você vai injetar agora.
3. **Ataque e Crie:** Evolua o core TS responsável pela lógica (`scripts/ast/...` ou `scripts/*/templates/...`).
4. **Valide Nichadamente:** Teste interno do gerador via TSX Test + Teste unitário gerado de apenas um Output (se cabível).
5. **Massifique e Prove:** Regere a imensidão dos scripts pra todos os 77 módulos e execute Playwright `--last-failed` ou Vitest.
6. Emita relatório técnico perfeito pro Check Prompt seguir.