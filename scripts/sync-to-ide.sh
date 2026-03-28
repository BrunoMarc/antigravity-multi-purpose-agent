#!/bin/bash
# Script para copiar as mudanças do projeto atual direto para o Antigravity sem precisar empacotar
set -e

# O diretório oficial da extensão no seu computador
TARGET_DIR="$HOME/.antigravity/extensions/rodhayl.multi-purpose-agent-999.0.0"

if [ ! -d "$TARGET_DIR" ]; then
    echo "⚙️ Diretório da extensão não encontrado. Recriando estrutura em $TARGET_DIR..."
    mkdir -p "$TARGET_DIR/dist"
fi

echo "⚡ Compilando a extensão local..."
npm run compile

echo "📂 Copiando arquivos para $TARGET_DIR..."
cp -r main_scripts/ "$TARGET_DIR/"
cp -r media/ "$TARGET_DIR/"
cp package.json "$TARGET_DIR/"
cp dist/extension.js "$TARGET_DIR/dist/"
cp README.md CHANGELOG.md LICENSE.md "$TARGET_DIR/" 2>/dev/null || true

echo "✅ Sincronização concluída com sucesso!"
echo "🔄 Lembre-se de rodar 'Developer: Reload Window' no seu Antigravity para aplicar as mudanças."