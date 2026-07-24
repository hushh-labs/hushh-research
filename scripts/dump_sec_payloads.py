#!/bin/bash

echo "Checking Hushh Research Development Environment..."

# Check Git
if command -v git &> /dev/null
then
    GIT_VERSION=$(git --version)
    echo "Git is installed"
    echo "$GIT_VERSION"
else
    echo "Git is NOT installed"
fi

echo ""

# Check Node.js
if command -v node &> /dev/null
then
    NODE_VERSION=$(node -v)
    echo "Node.js is installed"
    echo "Node.js version: $NODE_VERSION"

    NODE_MAJOR=$(node -v | cut -d '.' -f1 | tr -d 'v')

    if [ "$NODE_MAJOR" -ge 18 ]; then
        echo "Node.js version is compatible"
    else
        echo "Node.js version is too old (minimum v18 required)"
    fi
else
    echo "Node.js is NOT installed"
fi

echo ""

# Check npm
if command -v npm &> /dev/null
then
    NPM_VERSION=$(npm -v)
    echo "npm is installed"
    echo "npm version: $NPM_VERSION"
else
    echo "npm is NOT installed"
fi

echo ""

echo "Environment validation completed."