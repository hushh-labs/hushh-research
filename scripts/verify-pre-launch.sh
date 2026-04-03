#!/bin/bash
# Hushh Pre-Launch Verification Script
# Run this before any public release to ensure everything passes

set -e

echo "🔍 Hushh Pre-Launch Verification"
echo "================================"
echo ""

FAIL=0
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# 1. Backend Tests
echo "▶ [1/6] Backend Tests..."
cd consent-protocol
# Project standard: .venv (see getting_started.md). Use only one; remove venv if you have both.
if [ -d ".venv" ]; then
  source .venv/bin/activate
elif [ -d "venv" ]; then
  source venv/bin/activate
fi
SECRET_KEY="test_key_32chars_minimum_length!" \
TESTING="true" \
python3 -m pytest tests/ -v --tb=short || { FAIL=1; echo "❌ Backend tests failed"; }
cd "$REPO_ROOT"
echo ""

# 2. TypeScript
echo "▶ [2/6] TypeScript Check..."
cd hushh-webapp
npx tsc --noEmit || { FAIL=1; echo "❌ TypeScript failed"; }
cd "$REPO_ROOT"
echo ""

# 3. Frontend Tests
echo "▶ [3/6] Frontend Tests..."
cd hushh-webapp
npm test || { FAIL=1; echo "❌ Frontend tests failed"; }
cd "$REPO_ROOT"
echo ""

# 4. Frontend Build
echo "▶ [4/6] Frontend Build..."
cd hushh-webapp
npm run build || { FAIL=1; echo "❌ Frontend build failed"; }
cd "$REPO_ROOT"
echo ""

# 5. iOS Native Tests
echo "▶ [5/6] iOS Native Tests..."
cd hushh-webapp
npm run ios:test || { FAIL=1; echo "❌ iOS native tests failed"; }
cd "$REPO_ROOT"
echo ""

# 6. Git Status (strict blocking)
echo "▶ [6/6] Git Status (Strict)..."
MODIFIED=$(git status --porcelain | grep "^ M" | wc -l | tr -d ' ')
UNTRACKED=$(git status --porcelain | grep "^??" | wc -l | tr -d ' ')
STAGED=$(git status --porcelain | grep "^[AMDRC]" | wc -l | tr -d ' ')
echo "   Modified files: $MODIFIED"
echo "   Untracked files: $UNTRACKED"
echo "   Staged/non-clean entries: $STAGED"
if [ "$MODIFIED" -gt 0 ] || [ "$UNTRACKED" -gt 0 ] || [ "$STAGED" -gt 0 ]; then
  echo "❌ Working tree is not clean (strict launch gate):"
  git status --short
  FAIL=1
fi
echo ""

# Result
echo "================================"
if [ $FAIL -eq 0 ]; then
  echo "✅ ALL CHECKS PASSED"
  echo ""
  echo "Ready for public release!"
  exit 0
else
  echo "❌ VERIFICATION FAILED"
  echo ""
  echo "Fix the issues above before launch."
  exit 1
fi
