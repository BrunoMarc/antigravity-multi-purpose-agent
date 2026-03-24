#!/bin/bash
# Script para copiar as mudanças do projeto atual direto para o Antigravity sem precisar empacotar
set -e

# O diretório oficial da extensão no seu computador (encontra a versão instalada mais recente)
TARGET_DIR=$(ls -d ~/.antigravity/extensions/rodhayl.multi-purpose-agent-* | head -n 1)

if [ -z "$TARGET_DIR" ]; then
    echo "❌ Erro: Não foi possível encontrar a extensão instalada no Antigravity."
    exit 1
fi

echo "⚡ Compilando a extensão local..."
npm run compile

echo "📂 Copiando arquivos para $TARGET_DIR..."
cp -r main_scripts/ $TARGET_DIR/
cp package.json $TARGET_DIR/
cp dist/extension.js $TARGET_DIR/dist/

echo "✅ Sincronização concluída com sucesso!"
echo "🔄 Lembre-se de rodar 'Developer: Reload Window' no seu Antigravity para aplicar as mudanças."