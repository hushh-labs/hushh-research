#!/bin/bash

echo "Detecting operating system..."

OS="$(uname)"

if [[ "$OS" == "Linux" || "$OS" == "Darwin" ]]; then
    echo "Running Bash environment validation..."
    bash "$(dirname "$0")/validate-env.sh"

elif [[ "$OS" =~ "MINGW" || "$OS" =~ "MSYS" || "$OS" =~ "CYGWIN" ]]; then
    echo "Running PowerShell environment validation..."
    powershell -ExecutionPolicy Bypass -File "$(dirname "$0")/validate-env.ps1"

else
    echo "Unsupported operating system."
fi