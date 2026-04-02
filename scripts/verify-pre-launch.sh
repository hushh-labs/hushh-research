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
API_BASE="${KAI_AUDIT_API_BASE:-http://localhost:8000}"
WEB_BASE="${KAI_AUDIT_WEB_BASE:-http://localhost:3000}"

# 1. Backend Tests
echo "▶ [1/12] Backend Tests..."
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

# 2. Architecture Compliance
echo "▶ [2/12] Architecture Compliance..."
if grep -rq "get_supabase()" consent-protocol/api/routes/ 2>/dev/null; then
  echo "❌ Direct Supabase access found in API routes!"
  grep -r "get_supabase()" consent-protocol/api/routes/
  FAIL=1
else
  echo "✅ No direct Supabase access in routes"
fi
echo ""

# 3. Frontend Lint
echo "▶ [3/12] Frontend Lint..."
cd hushh-webapp
npm run lint || { FAIL=1; echo "❌ Lint failed"; }
cd "$REPO_ROOT"
echo ""

# 4. TypeScript
echo "▶ [4/12] TypeScript Check..."
cd hushh-webapp
npx tsc --noEmit || { FAIL=1; echo "❌ TypeScript failed"; }
cd "$REPO_ROOT"
echo ""

# 5. Route Contract Verification
echo "▶ [5/12] Route Contract Verification..."
cd hushh-webapp
npm run verify:routes || { FAIL=1; echo "❌ Route contract verification failed"; }
cd "$REPO_ROOT"
echo ""

# 6. Native Parity Verification
echo "▶ [6/13] Tri-Flow Parity Verification..."
cd hushh-webapp
npm run verify:tri-flow || { FAIL=1; echo "❌ Tri-flow parity verification failed"; }
cd "$REPO_ROOT"
echo ""

# 7. Native Parity Verification
echo "▶ [7/13] Native Parity Verification..."
cd hushh-webapp
npm run verify:parity || { FAIL=1; echo "❌ Native parity verification failed"; }
cd "$REPO_ROOT"
echo ""

# 8. Capacitor Route Verification
echo "▶ [8/13] Capacitor Route Verification..."
cd hushh-webapp
npm run verify:capacitor:routes || { FAIL=1; echo "❌ Capacitor route verification failed"; }
cd "$REPO_ROOT"
echo ""

# 9. Cache Coherence Verification
echo "▶ [9/13] Cache Coherence Verification..."
cd hushh-webapp
npm run verify:cache || { FAIL=1; echo "❌ Cache coherence verification failed"; }
cd "$REPO_ROOT"
echo ""

# 10. Browser API Native Compatibility Verification
echo "▶ [10/13] Browser API Native Compatibility Verification..."
cd hushh-webapp
npm run verify:native:browser-compat || { FAIL=1; echo "❌ Browser API native compatibility verification failed"; }
cd "$REPO_ROOT"
echo ""

# 11. Docs Runtime Parity Verification
echo "▶ [11/13] Docs Runtime Parity Verification..."
cd hushh-webapp
npm run verify:docs || { FAIL=1; echo "❌ Docs/runtime parity verification failed"; }
cd "$REPO_ROOT"
echo ""

# 12. Env/Secrets/Deploy parity (strict blocking)
echo "▶ [12/13] Env/Secrets/Deploy Parity..."
if command -v gcloud >/dev/null 2>&1; then
  python3 scripts/ops/verify-env-secrets-parity.py \
    --project "${GCP_PROJECT_ID:-hushh-pda}" \
    --region "${GCP_REGION:-us-central1}" \
    --backend-service "${BACKEND_SERVICE:-consent-protocol}" \
    --frontend-service "${FRONTEND_SERVICE:-hushh-webapp}" \
    --require-market-data || {
      FAIL=1
      echo "❌ Env/secrets/deploy parity verification failed"
    }
else
  echo "❌ gcloud not found; cannot verify live env/secrets parity"
  FAIL=1
fi
echo ""

# 13. Git Status (strict blocking)
echo "▶ [13/13] Git Status (Strict)..."
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
