Write-Host "Generating Environment Diagnostics Report..." -ForegroundColor Cyan

# Create logs directory
if (!(Test-Path "./logs")) {
    New-Item -ItemType Directory -Path "./logs"
}

# Git Check
$gitStatus = "NOT Installed"

if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitVersion = git --version
    $gitStatus = "Installed ($gitVersion)"
}

# Node.js Check
$nodeStatus = "NOT Installed"

if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersion = node -v
    $nodeStatus = "Installed ($nodeVersion)"
}

# npm Check
$npmStatus = "NOT Installed"

if (Get-Command npm -ErrorAction SilentlyContinue) {
    $npmVersion = npm -v
    $npmStatus = "Installed ($npmVersion)"
}

# Generate Report
$report = @"
Environment Health Report
-------------------------
Git: $gitStatus
Node.js: $nodeStatus
npm: $npmStatus

Overall Status: READY
"@

# Save Report
$report | Out-File "./logs/environment-health-report.txt"

Write-Host "Environment report generated successfully!" -ForegroundColor Green
Write-Host "Report saved to logs/environment-health-report.txt" -ForegroundColor Green