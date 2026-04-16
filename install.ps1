$ErrorActionPreference = "Stop"

$GithubOrg    = "anshuladityaa-nickelfox"
$GithubRepo   = "elron-mcp"
$Branch       = "main"
$GithubRaw    = "https://raw.githubusercontent.com/$GithubOrg/$GithubRepo/$Branch"
$InstallDir   = "$env:USERPROFILE\.elron-mcp"
$ClaudeConfig = "$env:APPDATA\Claude\claude_desktop_config.json"

Write-Host ""
Write-Host "=== Elron MCP Installer ===" -ForegroundColor Cyan
Write-Host ""

# ── Check Node.js ──────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Error: Node.js is not installed." -ForegroundColor Red
  Write-Host "Install it from https://nodejs.org (v18 or higher required)"
  exit 1
}

$nodeMajor = [int](& node -e "console.log(parseInt(process.versions.node))")
if ($nodeMajor -lt 18) {
  Write-Host "Error: Node.js v18+ required. You have $(& node --version)" -ForegroundColor Red
  Write-Host "Upgrade at https://nodejs.org"
  exit 1
}

Write-Host "✓ Node.js $(& node --version)"

# ── Download server.mjs ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "Downloading server.mjs..."
Invoke-WebRequest -Uri "$GithubRaw/server.mjs" -OutFile "$InstallDir\server.mjs" -UseBasicParsing
Write-Host "✓ server.mjs downloaded"

# ── Write package.json ─────────────────────────────────────────────────────────
@'
{
  "name": "elron-mcp",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0"
  }
}
'@ | Set-Content "$InstallDir\package.json" -Encoding UTF8

# ── Install dependencies ───────────────────────────────────────────────────────
Write-Host "Installing dependencies..."
Push-Location $InstallDir
& npm install --silent
Pop-Location
Write-Host "✓ Dependencies installed"

# ── Update Claude Desktop config ──────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Split-Path $ClaudeConfig) | Out-Null

$setupScript = "$InstallDir\_setup.mjs"
@'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
const [,, configPath, serverPath] = process.argv
mkdirSync(dirname(configPath), { recursive: true })
let config = {}
try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch {}
if (!config.mcpServers) config.mcpServers = {}
config.mcpServers.elron = { command: 'node', args: [serverPath] }
writeFileSync(configPath, JSON.stringify(config, null, 2))
'@ | Set-Content $setupScript -Encoding UTF8

$serverPath = "$InstallDir\server.mjs" -replace '\\', '/'
& node $setupScript $ClaudeConfig $serverPath
Remove-Item $setupScript
Write-Host "✓ Claude Desktop config updated"

# ── Done ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✓ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart Claude Desktop"
Write-Host "  2. Ask Claude: 'Connect me to Elron'"
Write-Host "  3. Enter your Elron email when prompted"
Write-Host "  4. Enter the OTP from your email"
Write-Host "  Done — you won't need to authenticate again."
Write-Host ""
