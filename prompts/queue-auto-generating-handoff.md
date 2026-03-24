# 🌳 MIGRATION & STABILIZATION INFINITE LOOP — AST BLUEPRINT PROJECT

## A Visão Macro (O Épico)
Nós acabamos de realizar um refatoramento arquitetural massivo no projeto Blueprint: nós abandonamos a extração de configurações via Regex, que era frágil e propensa a falhas de indentação, e migramos para um parser tipado e profundo usando **AST (ts-morph / TypeScript Compiler API)**.
Nosso ecossistema possui **Geradores de Códigos** baseados nesses blueprints que geram de forma automatizada:
1. **Testes Unitários (Jest)** - via `scripts/unit-spec-gen.cjs`
2. **Testes E2E (Playwright)** - via `scripts/spec-gen.cjs` / `templates/*.template.cjs`
3. **Mocks e Handlers (MSW)** - via `scripts/msw-gen/`

**A Missão Inegociável:** Nós não vamos apenas "consertar os quebrados" da migração AST para igualar o antigo patamar do regex. A meta é criar geradores exaustivamente inteligentes que possuam Cobertura Máxima (100% dos cenários) e gerem testes (outputs) com Pass Rate de 100%. NENHUM bug, NENHUMA task deixada para depois. O trabalho autônomo é infinito.

## Regras de Execução Autônoma
Como um Agente Autônomo Antigravity, você responderá a este prompt repetidas vezes num loop infinito (orquestrado pelo Multi Purpose Agent).
1. **Proatividade Absoluta:** O trabalho NUNCA acaba. Se você arrumou um gap de testes ou fixou 10 bugs E2E, não pare. Encontre a próxima fragilidade do sistema (MSW não tem branch coverage? E2E não testa *catalogToggle*? Unit não testa *fullscreenModal*?) e engate a marcha.
2. **NUNCA modifique o Output Manualmente:** Se um teste e2e (`*.generated.spec.ts`) ou unitário falhar, **NUNCA** edite o arquivo gerado para consertar. A correção deve ser SEMPRE feita no script gerador (os bridges AST, os templates, ou as funções parseadoras). Depois, você obrigatoriamente roda o gerador para atualizar o arquivo.
3. **Seja Impiedoso nos Testes:** Testar não é apenas dar "npm run test" num mock bobo. É regerar TODAS as specs afetadas da aplicação e validá-las em ambiente real contra o frontend.

## A Fila de Ataque Prioritária (Ajuste à medida que resolveres)
*(Atualmente focados nos ecos do E2E Stabilization)*

**P0: Falhas Residuais do E2E (As 59 falhas não-sistêmicas do último batch)**
- Resolver timeouts de *Form Validation* em testes onde o botão Save deveria habilitar.
- Consertar navegação e adição de *Sub-nested resources* (ex: `history` e `user-tickets` no módulo `usuarios`).
- Corrigir a deleção intermitente da seção de *Vacations/Férias* (`employees`).

**P1: Aprofundamento da Cobertura AST (Features que o Regex nunca sonhou)**
- Validar profundamente se os campos tipo `editor` (Rich Text), `statusConfig`, `linkTo`, `catalogToggle` e validações compostas (`requiredIf`) agora estão sendo extraídos com todo o seu contexto pelo AST e gerando testes unitários/E2E agressivos.

**P2: Cobertura Interna dos Próprios Geradores (>90%)**
- Auditar cada pasta `__tests__` em `scripts/`. Tem template E2E ou classe utilitária do AST sem teste unitário dedicado? Crie-o. Use Jest coverage para garantir que não existam *blind spots* na nossa arquitetura geradora.

## O Que Você Deve Fazer NESTE Exato Ciclo
1. Analise o estado atual dos bugs ou a saúde da cobertura de testes.
2. Planeje qual lote de problemas da lista acima (ou da sua própria análise técnica de falhas) você resolverá nos próximos minutos.
3. Inicie imediatamente as implementações e refatorações no código dos geradores.
4. Execute os scripts para REGERAR as specs do projeto.
5. Quando achar que terminou, NÃO conclua declarando vitória definitiva. Conclua com um **Relatório de Transição**, preparando o terreno para o Check Prompt te validar severamente.