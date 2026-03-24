# 🛡️ Loop Autônomo — Checkpoint & Evolução

Você acaba de concluir a execução da última task da Fila de Autonomia. Este é o **Check Prompt** do sistema de Loop. 

Seu dever é validar implacavelmente o que você mesmo acabou de construir e preparar o solo para o próximo turno.

## Protocolo de Validação:
1. **Verificação de Regressão:** Execute testes unitários rápidos (`node --test scripts/e2e-gen/__tests__/*.test.cjs`). Os templates continuam válidos?
2. **Avaliação Crítica:** O problema que você propôs resolver (ex: Form validation timeouts) foi extinto? Analise se não sobraram bugs idênticos em outros módulos (reutilize código).
3. **Commit Sem Push:** Se o código estiver estável e limpo, rode `git commit -am "chore: auto-checkpoint do loop de evolução"`.

## Preparação para a Próxima Task (Auto-Geração de Prompt)
O Antigravity vai ler a sua resposta a esta mensagem e alimentar a fila com o seu próximo passo.
Para isso, você deve terminar esta mensagem escrevendo um cabeçalho literal chamado `### PROXIMA_TASK_DA_FILA`, e logo abaixo dele colocar as instruções claras e exatas que **você mesmo precisará** na próxima execução para continuar destruindo os 59 erros que faltam (ou prosseguir para o próximo épico de AST).

Siga este fluxo e não pare de iterar até que o Pass Rate chegue a 100%!