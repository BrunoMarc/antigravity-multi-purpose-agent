# 🌳 Autonomous AST Migration Loop — Auto-Generating Handoff Prompt

## Contexto e Objetivo
Você é o engenheiro autônomo responsável pela **Migração AST** dos geradores de teste do projeto Blueprint. Nossa arquitetura E2E agora roda com `navigationSectionMap` recursivo e timings corretos via `waitFor`.

O seu objetivo principal não é apenas corrigir os bugs listados, mas sim **operar como uma máquina autônoma de diagnóstico, implementação e reavaliação**.

## O Ciclo Infinito de Resiliência
Você deve adotar um modelo mental onde não há "fim" real enquanto houver falhas. O Antigravity rodará sua Queue periodicamente. Você DEVE:
1. **Nunca parar silenciosamente** ao deparar-se com problemas fora da sua área de atuação original. Adapte-se e conserte-os.
2. **Ser Exaustivamente Proativo:** Se identificar 59 falhas não-sistêmicas, não corrija apenas uma e termine. Agrupe-as e resolva-as por lotes.
3. Ao finalizar sua geração, você será validado pelo Check Prompt da extensão de Loop. Se você deixou gaps, o Check Prompt irá cobrar você.

## Problemas Atuais (O Foco Imediato)
Nós estabilizamos a navegação raiz e estamos com 99.0% de Pass Rate, mas restam 59 falhas módulo-específicas:
- **Timeouts de form validation (~20):** O teste "should enable save when valid values are entered" esgota o tempo. O Angular pode estar precisando de blur ou focus events para computar a revalidação.
- **Sub-nested resources (~15 em `usuarios`):** `history` e `user-tickets` não encontram o botão `add`. A navegação interna desses nested forms diverge do fluxo principal.
- **Vacations section (~10):** Timeout deletando/adicionando férias (`employees`, `controle-ferias`).
- **Permissions/Tags (~14):** `usuarios` tem falhas em blocos aninhados.

## Instrução Base de Execução (Siga estritamente)
1. **Descobrir:** Analise o histórico e os arquivos do projeto para os pontos acima (ex: `nested-resources.template.ts`, form validation em testes anteriores).
2. **Implementar:** Aplique a correção nos *templates geradores* (NUNCA nos `.generated.spec.ts` diretamente).
3. **Gerar:** Rode os scripts correspondentes para espelhar as alterações nos arquivos gerados (`npm run gen:spec:all` ou específico).
4. **Validar:** Execute os testes localmente (`node --test scripts/e2e-gen/__tests__/*.test.cjs` e/ou os E2Es das últimas falhas `--last-failed`).
5. **Autonomia (Novo Handoff):** Antes de concluir, DEIXE DOCUMENTADO qual é o PRÓXIMO BUG e o PRÓXIMO ESCOPO no formato de um relatório Handoff para você mesmo na próxima iteração da fila.

Trabalhe agora no Lote 1 de falhas (Sub-nested resources ou Form Validation timeouts). Resolva, teste e documente a saída.