#!/usr/bin/env bash
set -euo pipefail

GITHUB_ORG="anshuladityaa-nickelfox"
GITHUB_REPO="elron-mcp"
BRANCH="main"
GITHUB_RAW="https://raw.githubusercontent.com/$GITHUB_ORG/$GITHUB_REPO/$BRANCH"
INSTALL_DIR="$HOME/.elron-mcp"

echo ""
echo "=== Elron MCP Installer ==="
echo ""

# ── Check Node.js ──────────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed."
  echo "Install it from https://nodejs.org (v18 or higher required)"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js v18+ required. You have $(node --version)"
  echo "Upgrade at https://nodejs.org"
  exit 1
fi

echo "✓ Node.js $(node --version)"

# ── Download server.mjs ────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
echo "Downloading server.mjs..."
curl -fsSL "$GITHUB_RAW/server.mjs" -o "$INSTALL_DIR/server.mjs"
echo "✓ server.mjs downloaded"

# ── Write package.json ─────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/package.json" << 'EOF'
{
  "name": "elron-mcp",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0"
  }
}
EOF

# ── Install dependencies ───────────────────────────────────────────────────────
echo "Installing dependencies..."
npm install --prefix "$INSTALL_DIR" --silent
echo "✓ Dependencies installed"

# ── Find Claude Desktop config path ───────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
else
  CLAUDE_CONFIG="$HOME/.config/Claude/claude_desktop_config.json"
fi

# ── Update Claude Desktop config ──────────────────────────────────────────────
cat > "$INSTALL_DIR/_setup.mjs" << 'JSEOF'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
const [,, configPath, serverPath] = process.argv
mkdirSync(dirname(configPath), { recursive: true })
let config = {}
try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch {}
if (!config.mcpServers) config.mcpServers = {}
config.mcpServers.elron = { command: 'node', args: [serverPath] }
writeFileSync(configPath, JSON.stringify(config, null, 2))
JSEOF

node "$INSTALL_DIR/_setup.mjs" "$CLAUDE_CONFIG" "$INSTALL_DIR/server.mjs"
rm -f "$INSTALL_DIR/_setup.mjs"
echo "✓ Claude Desktop config updated"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "✓ Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Desktop"
echo "  2. Ask Claude: 'Connect me to Elron'"
echo "  3. Enter your Elron email when prompted"
echo "  4. Enter the OTP from your email"
echo "  Done — you won't need to authenticate again."
echo ""
