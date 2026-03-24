# 🛡️ Loop Autônomo — Checkpoint Rigoroso & Geração de Próximo Passo

Você acaba de concluir uma task da Fila de Autonomia. **A missão não terminou.** O seu objetivo agora é avaliar friamente o que foi construído, garantir que os padrões de qualidade foram não apenas mantidos, mas superados, e engatilhar o próximo desafio.

## 1. Verificação Impiedosa
- Você rodou os testes unitários do próprio gerador (`node --test scripts/e2e-gen/__tests__/*.test.cjs`)? 
- Você rodou o comando para regerar TODOS os testes da aplicação para ver se suas alterações no template AST não quebraram outros módulos (`npm run gen:spec:all`)?
- A cobertura de testes do que você acabou de criar atende à meta de >90% e 100% de pass rate?

**Se a resposta para qualquer pergunta acima for NÃO:** PARE. Identifique o erro, corrija o script gerador agora mesmo e refaça a validação.

## 2. Ponto de Salvamento (Commit)
Se o resultado for um sucesso cirúrgico:
- Use os comandos bash `git add .` e `git commit -m "chore: auto-checkpoint do loop de evolução - [Seu Resumo Aqui]"`
- NUNCA dê push. 

## 3. O Próximo Escopo (Auto-Alimentação da Fila)
A Fila de Autonomia precisa saber o que você fará a seguir. 
Leia o contexto geral do projeto (P0, P1, P2) e declare sua próxima movimentação. 

**MANDATÓRIO:** Você deve terminar a sua resposta com um bloco markdown exato no seguinte formato:

### PROXIMA_TASK_DA_FILA
[Descreva aqui, com detalhes técnicos, diretórios e objetivos, qual é a exata próxima fragilidade do sistema (MSW, E2E ou Unit) que você vai arrumar quando este loop rodar de novo em 30 segundos.]