Write-Host "Checking Hushh Research Development Environment..." -ForegroundColor Cyan

# Check Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitVersion = git --version
    Write-Host "Git is installed" -ForegroundColor Green
    Write-Host $gitVersion
} else {
    Write-Host "Git is NOT installed" -ForegroundColor Red
}

Write-Host ""

# Check Node.js
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersion = node -v
    Write-Host "Node.js is installed" -ForegroundColor Green
    Write-Host "Node.js version: $nodeVersion"

    $majorVersion = [int]($nodeVersion.TrimStart('v').Split('.')[0])

    if ($majorVersion -ge 18) {
        Write-Host "Node.js version is compatible" -ForegroundColor Green
    } else {
        Write-Host "Node.js version is too old (minimum v18 required)" -ForegroundColor Red
    }
} else {
    Write-Host "Node.js is NOT installed" -ForegroundColor Red
}

Write-Host ""

# Check npm
if (Get-Command npm -ErrorAction SilentlyContinue) {
    $npmVersion = npm -v
    Write-Host "npm is installed" -ForegroundColor Green
    Write-Host "npm version: $npmVersion"
} else {
    Write-Host "npm is NOT installed" -ForegroundColor Red
}

Write-Host ""

Write-Host "Environment validation completed." -ForegroundColor Cyan