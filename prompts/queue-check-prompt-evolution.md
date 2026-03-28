# 🛡️ Loop Autônomo — Checkpoint Rigoroso & Validador de Evolução

Você acaba de concluir a evolução de inteligência (Unit, Integration ou E2E). O ciclo não acabou: assuma as vestes de **Auditor Severo**. Sua entrega subiu a régua de Inteligência de fato ou você criou ruído/instabilidade na esteira C-I?

## 1. Verificação Impiedosa: Saúde Estrutural (Obrigatório)
Se o gerador falha na base, a fundação está apodrecendo com o seu update. Prove a saúde:
```bash
npx tsx --test scripts/ast/__tests__/*.test.ts
npx tsx --test scripts/e2e-gen/__tests__/*.test.ts
npx tsx --test scripts/msw-gen/__tests__/*.test.ts
npx tsx --test scripts/unit-gen/__tests__/*.test.ts
npx tsx --test scripts/__tests__/*.test.ts
```
**Critério:** Zero falhas. Se a lógica crashear, conserte o template/bridge imediatamente (ou decida declarar rollback forçado caso atinja limite de tentativas da fase de fix).

## 2. Regeneração Ligeira e sem Corrupção de Tipos
A semântica original deve ser mantida ao escalar pros 77 módulos:
```bash
npm run gen:msw:all && npm run gen:unit-spec:all && npm run gen:integration -- --all && npm run gen:spec:all
```
**Critério:** A saída de console não pode conter `Failed to generate...`, e nenhum erro estático de TypeScript sintático deve ser injetado nas saídas finais `.generated.spec.ts`.

## 3. Qualidade Prática (Executar as Baterias Modificadas)
Execute o framework que foi beneficiado por sua meta-programação recente:
```bash
# Se o alvo foi E2E/MSW Gen:
./scripts/run-ai-tests.sh --last-failed

# Se o alvo foi Unit/Integration Gen:
CI=true npm test -- --watch=false
```

## 4. Análise Profunda via Python (Prova Inegável de Sucesso)
Para garantir que você não opera às cegas, use scripts auxiliares:

Se for **E2E**, dissecamos a sanidade e taxa de acertos brutos:
```bash
python3 -c "import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Passed: {s[\"expected\"]}/{s[\"expected\"]+s[\"unexpected\"]} ({s[\"expected\"]*100/(s[\"expected\"]+s[\"unexpected\"]):.1f}%)')"
cat test-report-for-coding-agents/all-failures.md | head -60
```

Se for **Unit/Integration**, dissecamos o avanço dos metadados de Branches da aplicação:
```bash
python3 -c "import json; data = json.load(open('coverage/apollo-ng/coverage-summary.json')); print('Branches:', data['total']['branches']['pct'], '%');"
```

## 5. Ponto de Salvamento (Commit Autônomo Seguro)
Se o output passar (ou se bugs forem apenas timing flaky tests espalhados), legitime o avanço de inteligência:
```bash
git add -A
git commit -m "test(generators): [Resumo Evolutivo Específico - Ex: E2E Create Template refinado para validar preenchimento de M2M relations e MultiSelect inputs]"
```
**Regras de Git:** NUNCA execute `git push` no modo loop. Nunca adicione co-autoria IA (`Co-Authored-By`). Registre o pilar que evoluiu.

## 6. O Próximo Escopo de Balanceamento Autônomo
Para a excelência de uma máquina infinita, seu próximo ciclo não pode depender da intervenção humana. Force sua dedução e analise o código base: Qual pilar precisa ser alimentado à força e receber inteligência magna na próxima rotação de contexto?

Alguns insights mentais para sua decisão final de escopo:
- **[E2E Gen Cego]** List Fields M2M em sub-nested resources estão vazios nos clicks de geração autônoma? Ensinar a preencher.
- **[Unit Gen Cego]** O Parser AST cruza propriedades do field (type "email" / máscara) contra formControls e checa o Primeng UI render error? Injetar isso!
- **[Coverage Gen Cego]** O próprio AST ou Bridge possui funções complexas que sequer são engajadas pelos test runners internos nativos `*.test.ts`? Exterminar debito tecnico base.

**MANDATÓRIO:** Termine rigorosamente com o bloco de Markdown exigido! A sua autonomia existencial pro próximo clico depende destas linhas:

### PROXIMA_TASK_DA_FILA
[Declare ESTRATEGICAMENTE o pilar (Unit, Integration, E2E ou Meta-Parsers em si) que vai absorver a atenção. Relate o ponto cego ou a fragilidade lógica dele exata atual baseada no código e defina a ordem de execução do que deve ser tocado (ex: "Evoluirei o tests-metadata-builder.ts para arrastar metadados X, permitindo testar campos Y") para o novo modelo de agente devorar operando inércia autônoma de forma perfeita em 30 segundos.]