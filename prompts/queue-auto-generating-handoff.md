# 🌳 MIGRATION & STABILIZATION INFINITE LOOP — AST BLUEPRINT PROJECT

## A Visão Macro (O Épico)
Nós acabamos de realizar um refatoramento arquitetural massivo no projeto Blueprint: nós abandonamos a extração de configurações via Regex, que era frágil e propensa a falhas de indentação, e migramos para um parser tipado e profundo usando **AST (ts-morph / TypeScript Compiler API)**.
Nosso ecossistema possui **Geradores de Códigos** baseados nesses blueprints que geram de forma automatizada Testes Unitários/Integration, Testes E2E e Handlers MSW.

**A Missão Inegociável:** Nós não vamos apenas "consertar os quebrados" da migração AST para igualar o antigo patamar do regex. A meta é criar geradores exaustivamente inteligentes que possuam Cobertura Máxima (100% dos cenários) e gerem testes (outputs) com Pass Rate de 100%. O trabalho autônomo é infinito.

## Regras de Execução Autônoma
1. **Proatividade Absoluta:** O trabalho NUNCA acaba. Se você arrumou um gap de testes ou fixou 10 bugs E2E, não pare. Encontre a próxima fragilidade do sistema (MSW não tem branch coverage? E2E não testa *catalogToggle*? Unit não testa *fullscreenModal*?) e engate a marcha.
2. **NUNCA modifique o Output Manualmente:** Se um teste e2e (`*.generated.spec.ts`) ou unitário falhar, **NUNCA** edite o arquivo gerado para consertar. A correção deve ser SEMPRE feita no script gerador (os bridges AST, os templates, ou as funções parseadoras). Depois, você obrigatoriamente roda o gerador para atualizar o arquivo.
3. **Seja Impiedoso nos Testes:** Testar não é apenas dar "npm run test" num mock bobo. É regerar TODAS as specs afetadas da aplicação e validá-las em ambiente real contra o frontend.

## Comandos Obrigatórios do Ciclo de Vida
Você DEVE utilizar exatamente os seguintes comandos para regerar e validar os outputs:

### 1. Regeneração Total dos Outputs (Após mudar um Gerador/Template)
- **Regerar Testes E2E:** `npm run gen:spec:all` (ou use `./scripts/spec-gen.cjs <modulo>`)
- **Regerar Testes Unit/Integration:** `node scripts/unit-spec-gen.cjs <modulo> --overwrite`
- **Regerar MSW Handlers:** `npm run gen:msw <modulo>`

### 2. Validação Impiedosa dos Testes (Verificação do Output)
- **Testes E2E (Playwright 16 Workers):**
  Para rodar a bateria E2E completa de forma paralela e rápida:
  `PLAYWRIGHT_FAST=1 MAX_FAILURES=60 ./scripts/run-ai-tests.sh`
  *(Para rodar apenas os que falharam no último teste: `./scripts/run-ai-tests.sh --last-failed`)*
- **Testes Unitários/Integrados (Vitest):**
  Rode a suite de testes unitários da aplicação usando o Vitest na pasta root do frontend:
  `npx vitest run src/app/features/`
- **Testes Internos dos Próprios Geradores (Node --test):**
  `node --test scripts/e2e-gen/__tests__/*.test.cjs` e `node --test scripts/msw-gen/__tests__/*.test.cjs`

## O Que Você Deve Fazer NESTE Exato Ciclo
1. Analise o estado atual dos bugs ou a saúde da cobertura de testes lendo as saídas do Terminal.
2. Planeje qual lote de problemas você resolverá nos próximos minutos (ex: Timeouts de form validation E2E, ou Mapeamento MSW incompleto).
3. Inicie imediatamente as implementações e refatorações no código dos geradores.
4. Execute os comandos de **Regeneração Total** listados acima.
5. Execute os comandos de **Validação Impiedosa** listados acima para garantir 100% de Pass Rate no lote alterado.
6. Quando achar que terminou o lote com sucesso absoluto, NÃO pare e não pessa aprovação. Emita o seu relatório e passe a bola para o Check Prompt te validar severamente.