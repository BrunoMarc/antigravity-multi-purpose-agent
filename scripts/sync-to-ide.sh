#!/bin/bash
# Script para copiar as mudanças do projeto atual direto para o Antigravity sem precisar empacotar
set -e

# O diretório oficial da extensão no seu computador
TARGET_DIR=~/.antigravity/extensions/rodhayl.multi-purpose-agent-1.0.1

echo "⚡ Compilando a extensão local..."
npm run compile

echo "📂 Copiando arquivos para $TARGET_DIR..."
cp -r main_scripts/ $TARGET_DIR/
cp package.json $TARGET_DIR/
cp dist/extension.js $TARGET_DIR/dist/

echo "✅ Sincronização concluída com sucesso!"
echo "🔄 Lembre-se de rodar 'Developer: Reload Window' no seu Antigravity para aplicar as mudanças."