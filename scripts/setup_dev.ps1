# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# scripts/setup_dev.ps1
# Windows PowerShell companion for hushh-research contributor setup.
#
# Covers the gap between ./bin/hushh bootstrap (bash/macOS/Linux) and
# Windows-native contributor workflows. Wraps the same canonical CI
# scripts so local checks match GitHub Actions exactly.
#
# Usage:
#   pwsh scripts/setup_dev.ps1             # full setup + CI parity run
#   pwsh scripts/setup_dev.ps1 -LintOnly   # import-sort fix + format only
#   pwsh scripts/setup_dev.ps1 -CheckOnly  # prerequisite check only

[CmdletBinding()]
param(
    [switch]$LintOnly,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Environment Automation by Abdul Gaffar - Beast Mode Activated" -ForegroundColor Cyan
Write-Host ("=" * 64) -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Test-Command([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Write-Step([string]$Msg) {
    Write-Host "[*] $Msg" -ForegroundColor Yellow
}

function Write-Ok([string]$Msg) {
    Write-Host "[+] $Msg" -ForegroundColor Green
}

function Write-Fail([string]$Msg) {
    Write-Host "[!] $Msg" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# Locate repo root (works from any subdirectory)
# ---------------------------------------------------------------------------
$RepoRoot = git rev-parse --show-toplevel 2>$null
if (-not $RepoRoot) {
    Write-Fail "Not inside a git repository. Run this script from within hushh-research."
    exit 1
}
$RepoRoot = $RepoRoot.Replace("/", "\")

# ---------------------------------------------------------------------------
# Step 1 — Prerequisite check
# ---------------------------------------------------------------------------
Write-Step "Checking prerequisites..."

$MissingTools = @()

# uv
if (Test-Command "uv") {
    $uvVersion = (uv --version 2>&1)
    Write-Ok "uv found: $uvVersion"
} else {
    Write-Fail "uv not found."
    Write-Host "    Install via: powershell -c `"irm https://astral.sh/uv/install.ps1 | iex`"" -ForegroundColor DarkYellow
    $MissingTools += "uv"
}

# Python 3.13
$PythonOk = $false
if (Test-Command "python") {
    $pyVersion = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    if ($pyVersion -eq "3.13") {
        Write-Ok "Python $pyVersion found."
        $PythonOk = $true
    } else {
        Write-Fail "Python $pyVersion found but 3.13 is required."
    }
}
if (-not $PythonOk) {
    Write-Host "    Install via uv: uv python install 3.13" -ForegroundColor DarkYellow
    Write-Host "    Or download:    https://www.python.org/downloads/release/python-3130/" -ForegroundColor DarkYellow
    $MissingTools += "python3.13"
}

# bash (required for CI parity step)
$BashAvailable = Test-Command "bash"
if ($BashAvailable) {
    Write-Ok "bash found (Git for Windows / WSL)."
} else {
    Write-Host "    [~] bash not found. CI parity step will be skipped." -ForegroundColor DarkYellow
    Write-Host "        Install Git for Windows or enable WSL to run orchestrate.sh locally." -ForegroundColor DarkYellow
}

if ($MissingTools.Count -gt 0) {
    Write-Host ""
    Write-Fail "Missing required tools: $($MissingTools -join ', '). Install them and re-run."
    exit 1
}

if ($CheckOnly) {
    Write-Host ""
    Write-Ok "Prerequisite check passed. Run without -CheckOnly to continue setup."
    exit 0
}

# ---------------------------------------------------------------------------
# Step 2 — Monorepo sync (all pyproject.toml locations)
# ---------------------------------------------------------------------------
if (-not $LintOnly) {
    Write-Host ""
    Write-Step "Syncing Python environments (uv sync --frozen)..."

    $PyprojectFiles = Get-ChildItem -Path $RepoRoot -Recurse -Filter "pyproject.toml" `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "\\\.git\\" -and $_.FullName -notmatch "\\node_modules\\" }

    foreach ($Toml in $PyprojectFiles) {
        $Dir = $Toml.DirectoryName
        Write-Host "    -> $($Dir.Replace($RepoRoot, '.'))" -ForegroundColor DarkGray
        Push-Location $Dir
        try {
            uv sync --frozen
            Write-Ok "Synced $($Dir.Replace($RepoRoot, '.'))"
        } catch {
            Write-Fail "uv sync failed in $Dir : $_"
            Pop-Location
            exit 1
        }
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Step 3 — Pre-push import-sort fix + format (prevents I001 on every push)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Step "Running ruff import-sort fix (I001 prevention)..."

$ProtocolDir = Join-Path $RepoRoot "consent-protocol"
Push-Location $ProtocolDir
try {
    uv run ruff check --select I --fix .
    Write-Ok "Import sort fix applied."

    uv run ruff format .
    Write-Ok "Code formatted."
} catch {
    Write-Fail "ruff step failed: $_"
    Pop-Location
    exit 1
}
Pop-Location

# ---------------------------------------------------------------------------
# Step 4 — CI parity: run the monorepo protocol stage locally
# ---------------------------------------------------------------------------
if (-not $LintOnly) {
    Write-Host ""
    Write-Step "Running CI parity check (scripts/ci/orchestrate.sh protocol)..."

    if ($BashAvailable) {
        $OrchestrateScript = Join-Path $RepoRoot "scripts/ci/orchestrate.sh"

        # Convert Windows path to bash-compatible path for Git-bash / WSL
        $BashScript = $OrchestrateScript.Replace("\", "/") -replace "^([A-Z]):", { "/$($_.Groups[1].Value.ToLower())" }

        bash $BashScript protocol
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "CI parity check failed (exit $LASTEXITCODE). Fix the above errors before pushing."
            exit $LASTEXITCODE
        }
        Write-Ok "CI parity check passed. Your branch is ready to push."
    } else {
        Write-Host "    [~] Skipped (bash unavailable). Run manually in WSL:" -ForegroundColor DarkYellow
        Write-Host "        bash scripts/ci/orchestrate.sh protocol" -ForegroundColor DarkYellow
    }
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("=" * 64) -ForegroundColor DarkGray
Write-Ok "Setup complete. Your environment matches CI expectations."
Write-Host "    Next: git add -p && git commit -s && git push" -ForegroundColor DarkGray
Write-Host ""
