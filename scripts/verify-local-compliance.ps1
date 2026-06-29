# PowerShell Local Compliance Verification Script
# Runs Ruff checks, Doc Governance, and Doc Runtime Parity checks.

$ErrorActionPreference = "Stop"

Write-Host "Running Local Compliance Verification..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$Fail = 0
$RepoRoot = (Get-Item -Path ".").FullName

# 1. Locate Node.exe
$NodePath = "node"
$CachedNode = "C:\Users\vrish\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path $CachedNode) {
    $NodePath = $CachedNode
    Write-Host "[INFO] Using cached Node executable: $NodePath" -ForegroundColor Gray
} else {
    Write-Host "[INFO] Using global Node command" -ForegroundColor Gray
}

# 2. Python Ruff Lint Check
Write-Host ""
Write-Host "[1/3] Running Ruff Lint Check..." -ForegroundColor Yellow
try {
    Push-Location "consent-protocol"
    & uv run ruff check .
    Write-Host "[OK] Ruff check passed!" -ForegroundColor Green
} catch {
    $Fail = 1
    Write-Host "[FAIL] Ruff check failed!" -ForegroundColor Red
} finally {
    Pop-Location
}

# 3. Doc Governance Check
Write-Host ""
Write-Host "[2/3] Running Doc Governance Check..." -ForegroundColor Yellow
try {
    & $NodePath "$RepoRoot\scripts\verify-doc-governance.cjs"
    Write-Host "[OK] Doc governance check passed!" -ForegroundColor Green
} catch {
    $Fail = 1
    Write-Host "[FAIL] Doc governance check failed!" -ForegroundColor Red
}

# 4. Doc Runtime Parity Check
Write-Host ""
Write-Host "[3/3] Running Doc Runtime Parity Check..." -ForegroundColor Yellow
try {
    & $NodePath "$RepoRoot\scripts\verify-doc-runtime-parity.cjs"
    Write-Host "[OK] Doc runtime parity check passed!" -ForegroundColor Green
} catch {
    $Fail = 1
    Write-Host "[FAIL] Doc runtime parity check failed!" -ForegroundColor Red
}

# 5. Final Result
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
if ($Fail -eq 0) {
    Write-Host "[SUCCESS] ALL LOCAL COMPLIANCE CHECKS PASSED!" -ForegroundColor Green
    Exit 0
} else {
    Write-Host "[ERROR] COMPLIANCE VERIFICATION FAILED!" -ForegroundColor Red
    Exit 1
}
