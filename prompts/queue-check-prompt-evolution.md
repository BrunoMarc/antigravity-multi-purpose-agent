# 🛡️ Loop Autônomo — Checkpoint Rigoroso & Geração de Próximo Passo

Você acaba de concluir uma task da Fila de Autonomia. **A missão não terminou.** O seu objetivo agora é avaliar friamente o que foi construído, garantir que os padrões de qualidade foram não apenas mantidos, mas superados, e engatilhar o próximo desafio.

---

## 1. Verificação Impiedosa (Checklist Obrigatório)

Execute **todos** os seguintes comandos e analise os resultados. Se QUALQUER um falhar, PARE e corrija ANTES de prosseguir.

### 1.1 Testes Internos dos Geradores
```bash
# Parser AST + Bridges
npx tsx --test scripts/ast/__tests__/*.test.ts

# Templates E2E
npx tsx --test scripts/e2e-gen/__tests__/*.test.ts

# MSW generator
npx tsx --test scripts/msw-gen/__tests__/*.test.ts

# Unit/Integration gen
npx tsx --test scripts/unit-gen/__tests__/*.test.ts
npx tsx --test scripts/__tests__/*.test.ts
```
**Critério:** 100% pass. Zero falhas. Se falhar, o gerador está quebrado e TUDO gerado a partir dele é lixo.

### 1.2 Regeneração Total (sem falhas do gen)
```bash
npm run gen:spec:all    # E2E specs (deve gerar 6000+ tests, 0 módulos falhados)
npm run gen:msw:all     # MSW handlers
npm run gen:unit-spec:all  # Unit specs
```
**Critério:** A saída deve mostrar `❌ Failed: 0 modules` para cada gerador. Se qualquer módulo falhar na regeneração, investigue e corrija o parser/bridge.

### 1.3 Validação E2E (Playwright)
```bash
PLAYWRIGHT_FAST=1 MAX_FAILURES=60 ./scripts/run-ai-tests.sh
```
**Critério Mínimo:** ≥ 99% pass rate (scattered failures aceitáveis, bursts NÃO).

**Análise de falhas (obrigatório se houver):**
```bash
python3 -c "import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Passed: {s[\"expected\"]}/{s[\"expected\"]+s[\"unexpected\"]} ({s[\"expected\"]*100/(s[\"expected\"]+s[\"unexpected\"]):.1f}%)')"
cat test-report-for-coding-agents/all-failures.md | head -60
```

### 1.4 Distinção Flaky vs Bug Real
Se existem falhas, rode **apenas** as que falharam:
```bash
./scripts/run-ai-tests.sh --last-failed
```
- Se passam na segunda vez → **flaky** (aceitar, não refatorar tudo por causa disso)
- Se falham de novo → **bug real** (deve ser corrigido NESTE ciclo)

---

## 2. Ponto de Salvamento (Commit)

Se o resultado for um sucesso (≥ 99% E2E, 100% generator tests, 0 módulos falhando na regeneração):

```bash
git add -A
git commit -m "chore: loop checkpoint - [Resumo Técnico do Lote Resolvido]"
```

**Regras de Commit:**
- **NUNCA** dê `git push` — apenas commit local
- **NUNCA** inclua co-autoria AI
- Mensagem em inglês, no imperativo: `fix: resolve navigation timing for nested resources`
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`

---

## 3. Inventário de Saúde (Antes de Escolher o Próximo Escopo)

Antes de selecionar a próxima task, faça um inventário rápido:

```bash
# Quantos testes E2E existem vs quantos passam?
python3 -c "import json; r=json.load(open('.playwright-results.json')); s=r['stats']; print(f'Total: {s[\"expected\"]+s[\"unexpected\"]+s[\"skipped\"]} | Pass: {s[\"expected\"]} | Fail: {s[\"unexpected\"]} | Skip: {s[\"skipped\"]}')"

# Módulos com mais falhas (pelo report)
cat test-report-for-coding-agents/all-failures.md | grep '###' | head -20

# Verificar cobertura do generator sobre blueprints disponíveis
npm run gen:spec:all 2>&1 | grep -E "Failed:|Skipped:|Total tests"
```

---

## 4. O Próximo Escopo (Auto-Alimentação da Fila)

A Fila de Autonomia precisa saber o que você fará a seguir. Use a **Matriz de Prioridades** para decidir:

| Prio | O que procurar | Como detectar |
|------|----------------|---------------|
| **P0** | Bursts (≥5 F's consecutivas de um módulo) | Olhar output do terminal, analisar `.playwright-results.json` |
| **P0** | Generator crashes (módulo falha na regeneração) | `npm run gen:spec:all 2>&1 | grep "Failed"` |
| **P1** | Padrão repetitivo de falha (ex: "enable save" em 10+ módulos) | `cat test-report-for-coding-agents/all-failures.md | grep -c "enable save"` |
| **P1** | MSW data mismatch | Erro "Expected: visible" em nested resources (dados MSW errados) |
| **P2** | Coverage gaps (cenários do CJS não portados) | Comparar templates `.ts` com backup CJS |
| **P2** | Flaky tests estáveis | Re-rode `--last-failed` e se persistem, fixe timing |

**MANDATÓRIO:** Você deve terminar a sua resposta com um bloco markdown exato no seguinte formato:

### PROXIMA_TASK_DA_FILA
[Descreva aqui, com detalhes técnicos, diretórios e objetivos, qual é a exata próxima fragilidade do sistema (MSW, E2E ou Unit) que você vai arrumar quando este loop rodar de novo em 30 segundos.]