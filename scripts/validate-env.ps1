Write-Host "Checking Hushh Research Development Environment..." -ForegroundColor Cyan

# Check Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "Git is installed" -ForegroundColor Green
} else {
    Write-Host "Git is NOT installed" -ForegroundColor Red
}

# Check Node.js
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js is installed" -ForegroundColor Green
} else {
    Write-Host "Node.js is NOT installed" -ForegroundColor Red
}

# Check bootstrap script
if (Test-Path "./bin/hushh") {
    Write-Host "Bootstrap script found" -ForegroundColor Green
} else {
    Write-Host "Bootstrap script missing" -ForegroundColor Red
}

# Check docs folder
if (Test-Path "./docs") {
    Write-Host "Docs directory found" -ForegroundColor Green
} else {
    Write-Host "Docs directory missing" -ForegroundColor Red
}

# Check scripts folder
if (Test-Path "./scripts") {
    Write-Host "Scripts directory found" -ForegroundColor Green
} else {
    Write-Host "Scripts directory missing" -ForegroundColor Red
}

Write-Host ""
Write-Host "Environment validation completed." -ForegroundColor Cyan