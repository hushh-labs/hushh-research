# Contributing to Hussh Research

Welcome! This guide will help you get started contributing to the Hussh Research platform. We're excited to have you join our community.

## Visual Context

This guide inherits its layout and contributor expectations from [Contributor Branch Governance](../reference/operations/branch-governance.md).

## Contributor Flow

```text
Contributor Flow
  -> Local setup (`./bin/hushh bootstrap`)
  -> Service-oriented changes (`consent-protocol/hushh_mcp/services/`)
  -> Route integration (`consent-protocol/api/routes/`)
  -> Validation (lint + tests + architecture checks)
  -> Signed PR (`git commit -s`, conventional title)
```

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [Architecture Overview](#architecture-overview)
4. [Git Workflow](#git-workflow)
5. [Making Your First PR](#making-your-first-pr)
6. [Common Debugging Scenarios](#common-debugging-scenarios)
7. [Testing Guidelines](#testing-guidelines)
8. [Code Quality Standards](#code-quality-standards)

---

## Prerequisites

Before you begin, ensure you have:

- **Git** (v2.40+)
- **Node.js** (v18+)
- **Python** (v3.13 with `uv` package manager)
- **Docker** (for backend services)
- **PostgreSQL** (v15+, or use Supabase)
- A **GitHub account** with SSH keys configured

### Verify Prerequisites

```bash
git --version          # Should be >= 2.40
node --version         # Should be >= 18.0
python --version       # Should be >= 3.13
uv --version           # Should exist
docker --version       # Should be >= 20.10
```

### Set Up SSH for GitHub

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -C "your-email@example.com"

# Add to ssh-agent
ssh-add ~/.ssh/id_ed25519

# Verify connection
ssh -T git@github.com
```

---

## Local Development Setup

### 1. Clone the Repository

```bash
git clone git@github.com:hushh-labs/hushh-research.git
cd hushh-research
```

### 2. Run Bootstrap Setup

The project includes a bootstrap script to set up everything:

```bash
./bin/hushh bootstrap
```

This will:
- Install frontend dependencies (npm)
- Install backend dependencies (Python with `uv`)
- Set up pre-commit hooks
- Configure Git hooks for code quality checks

### 3. Set Up Environment Variables

Create a `.env.local` file in the root:

```bash
# Backend (consent-protocol)
DATABASE_URL=postgresql://user:password@localhost:5432/hussh_dev
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
OPENAI_API_KEY=sk-...

# Frontend (hushh-webapp)
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_KEY=your-anon-key
```

### 4. Start Development Servers

**Backend (FastAPI)**:
```bash
./bin/hushh terminal backend --mode local --reload
# Backend runs on http://localhost:8000
```

**Frontend (Next.js)**:
```bash
./bin/hushh web
# Frontend runs on http://localhost:3000
```

**Database (if not using Supabase)**:
```bash
docker run -d \
  --name hussh-db \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:15
```

### 5. Verify Setup

```bash
# Check backend health
curl http://localhost:8000/health

# Check frontend
open http://localhost:3000
```

---

## Architecture Overview

Hussh has a **three-layer architecture**:

### 1. **Vault Layer** (Encrypted Storage)
- User holds encryption keys (BYOK)
- Backend stores only ciphertext + metadata
- Located in `consent-protocol/hushh_mcp/services/`

### 2. **Consent Layer** (Access Control)
- Consent tokens determine what agents can access
- Enforced per request in `consent-protocol/api/routes/`
- Scopes follow pattern: `attr.{domain}.*` or `pkm.read` / `pkm.write`

### 3. **PKM Layer** (Personal Knowledge Model)
- Centralized knowledge store for user insights
- Replaces deprecated VaultDBService
- Located in `consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py`

### Key Files to Know

```
consent-protocol/
├── api/routes/          # API endpoints (must use service layer)
├── hushh_mcp/services/  # Business logic (vault, consent, PKM)
├── models/              # Data schemas
├── tests/
│   ├── quality/         # Architecture compliance tests
│   └── unit/            # Service tests
└── utils/               # Helpers

hushh-webapp/
├── app/                 # Next.js App Router
├── components/          # React components
├── services/            # Frontend service layer
├── lib/                 # Utilities
└── __tests__/           # Unit + E2E tests
```

---

## Git Workflow

### 1. Create a Feature Branch

Follow the naming convention: `{type}/{description}`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`

```bash
git checkout main
git pull origin main
git checkout -b feat/add-consent-token-rotation
```

### 2. Make Your Changes

Write code following the architecture rules:
- **No direct Supabase in routes** → Use service layer
- **All vault ops need consent tokens**
- **PKM scopes only**: `attr.{domain}.*` or `pkm.read` / `pkm.write`
- **Tests must pass** → Architecture compliance is enforced

### 3. Commit with Sign-Off

**All commits must be signed-off** (required by DCO):

```bash
git commit -s -m "feat: add consent token rotation

This implements automatic 90-day token rotation to reduce
compromise window. Users' tokens auto-refresh before expiry."
```

The `-s` flag adds `Signed-off-by: Your Name <email>` automatically.

### 4. Push and Create PR

```bash
git push origin feat/add-consent-token-rotation
# Open GitHub and create a PR
```

### PR Title Format

```
{type}({scope}): {description}

Example:
feat(consent): add automatic token rotation after 90 days
fix(vault): handle decryption errors gracefully
docs(contributing): add onboarding guide
perf(pkm): add Redis cache layer
```

### PR Description Template

```markdown
## Description
Brief explanation of what this PR does and why.

## Type of Change
- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Performance
- [ ] Code quality

## Testing
- [ ] Architecture compliance tests pass
- [ ] Unit tests added/updated
- [ ] E2E tests added (if applicable)
- [ ] Manual testing verification

## Checklist
- [ ] Commits are signed-off
- [ ] No direct Supabase in routes
- [ ] Consent token validation in place
- [ ] Mobile parity checked
- [ ] Analytics/PII scrubbing verified
- [ ] Docs updated
```

---

## Making Your First PR

### Step 1: Pick an Issue

Look for issues labeled:
- `good-first-issue` — Beginner-friendly
- `help-wanted` — Needs community help
- `documentation` — Docs improvements

### Step 2: Comment "I'll work on this"

This prevents duplicate effort. Maintainers will assign it to you.

### Step 3: Implement Changes

Follow the code standards:

**Python (Backend)**:
```python
from typing import Optional
from pydantic import BaseModel

class ConsentToken(BaseModel):
    """Represents a scoped access grant."""
    token_id: str
    scopes: list[str]
    expires_at: datetime
    
    def is_valid(self) -> bool:
        return datetime.utcnow() < self.expires_at
```

**TypeScript (Frontend)**:
```typescript
import { Result, Ok, Err } from '@/lib/result';

async function getVaultData(
  consentToken: string
): Promise<Result<VaultData, VaultError>> {
  try {
    const data = await api.get('/vault', {
      headers: { 'Authorization': `Bearer ${consentToken}` }
    });
    return Ok(data);
  } catch (error) {
    return Err(new VaultError(error.message));
  }
}
```

### Step 4: Test Your Changes

```bash
# Backend tests
cd consent-protocol
pytest tests/quality/          # Architecture compliance
pytest tests/unit/             # Unit tests

# Frontend tests
cd hushh-webapp
npm run test               # Unit tests
npm run test:e2e           # Playwright E2E tests
```

### Step 5: Run Pre-Commit Hooks

```bash
# Linting and formatting (runs automatically before commit)
npm run lint
npm run format
```

### Step 6: Push and Create PR

```bash
git push origin feat/your-feature
# Go to GitHub and create the PR
```

---

## Common Debugging Scenarios

### Scenario 1: Vault Unlock Fails

**Symptom**: "Decryption failed: invalid key"

**Debug**:
```python
# Check if user key is correct
from consent_protocol.services.vault_service import VaultService

vault = VaultService()
result = vault.validate_key(user_id, user_key)
print(result.error)  # See specific error
```

**Fix**: Verify the key derivation from passphrase matches client-side.

### Scenario 2: Consent Token Rejected

**Symptom**: "Consent scope {attr.portfolio.holdings} not granted"

**Debug**:
```python
# Check token scopes
from consent_protocol.services.consent_service import ConsentService

consent = ConsentService()
token_data = consent.decode_token(token)
print(token_data.scopes)  # See granted scopes
print(token_data.expires_at)  # Check expiration
```

**Fix**: User needs to grant the scope in consent center before agent can access.

### Scenario 3: PKM Service Errors

**Symptom**: "PersonalKnowledgeModelService: key not found"

**Debug**:
```python
# Check PKM store
from consent_protocol.services.pkm_service import PersonalKnowledgeModelService

pkm = PersonalKnowledgeModelService()
data = pkm.read(user_id, 'attr.portfolio.holdings')
print(data)  # None if key doesn't exist
```

**Fix**: Initialize PKM with expected attributes on user signup.

### Scenario 4: Streaming Response Incomplete

**Symptom**: "Voice agent cuts off mid-sentence"

**Debug**:
```bash
# Check client-side buffering
curl -N http://localhost:8000/agent/chat \
  -H "Authorization: Bearer {token}" \
  -d '{"message": "What is my portfolio?"}'
# Watch for partial chunks
```

**Fix**: Ensure client waits for `[DONE]` marker before processing.

---

## Testing Guidelines

### Unit Tests

Write tests alongside implementation:

```python
# consent-protocol/tests/unit/test_vault_service.py
import pytest
from consent_protocol.services.vault_service import VaultService

@pytest.fixture
def vault():
    return VaultService()

def test_encrypt_decrypt_roundtrip(vault):
    """Verify encryption and decryption work correctly."""
    plaintext = {"portfolio": {"AAPL": 100}}
    user_key = "test-key-123"
    
    encrypted = vault.encrypt(plaintext, user_key)
    decrypted = vault.decrypt(encrypted, user_key)
    
    assert decrypted == plaintext
```

### E2E Tests

Test complete user flows:

```typescript
// hushh-webapp/__tests__/e2e/consent-flow.spec.ts
import { test, expect } from '@playwright/test';

test('user can grant and revoke consent', async ({ page }) => {
  await page.goto('http://localhost:3000/consent');
  
  // Grant access
  await page.click('text=Grant Access to Portfolio');
  await page.click('button:has-text("Confirm")');
  
  // Verify consent is active
  await expect(page.locator('text=Access Granted')).toBeVisible();
  
  // Revoke consent
  await page.click('text=Revoke Access');
  await expect(page.locator('text=Access Revoked')).toBeVisible();
});
```

### Architecture Compliance Tests

These run automatically before merge:

```bash
cd consent-protocol
pytest tests/quality/test_architecture_compliance.py -v
```

Key compliance rules:
1. ✅ No `supabase.from()` in routes — use service layer
2. ✅ All vault ops have consent tokens
3. ✅ PKM scopes match pattern
4. ✅ Tests verify behavior

---

## Code Quality Standards

### Python (Backend)

- **Type hints required**: Use `typing` module
- **Docstrings required**: Google-style docstrings
- **Max line length**: 100 characters
- **Format**: `black`, `isort`
- **Linting**: `pylint`, `flake8`

```python
def rotate_consent_token(
    user_id: str,
    old_token: str,
    ttl_days: int = 90
) -> str:
    """Rotate user's consent token.
    
    Args:
        user_id: User identifier
        old_token: Current token to revoke
        ttl_days: Time-to-live for new token
        
    Returns:
        New consent token
        
    Raises:
        TokenExpiredError: If old token is expired
        AccessDeniedError: If user lacks permission
    """
    ...
```

### TypeScript (Frontend)

- **Type hints required**: No `any` types
- **JSDoc optional**: Comments for complex logic
- **Max line length**: 100 characters
- **Format**: `prettier`
- **Linting**: `eslint`

```typescript
/**
 * Decrypt vault data using user's key.
 * @param ciphertext - Encrypted data
 * @param userKey - User's encryption key
 * @returns Decrypted plaintext
 */
async function decryptVault(
  ciphertext: string,
  userKey: string
): Promise<Record<string, unknown>> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: extractIV(ciphertext) },
    await deriveKey(userKey),
    extractCiphertext(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}
```

### Security Scanning

All contributions that touch trust-boundary files must pass the local security scan before opening a PR.

#### Running the scan

```bash
bash scripts/ops/run-security-scan.sh
```

This runs **bandit** (Python static vulnerability analysis) and **npm audit** (Node dependency scan).
The script uses `set -euo pipefail` and exits non-zero if any check fails.
A passing scan (exit code 0) is required before the CI gate will go green.

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
{type}({scope}): {description}

{body}

{footer}
```

Example:
```
feat(consent): add automatic token rotation

Add automatic consent token rotation after 90 days to reduce
compromise window. Tokens are refreshed transparently before
expiry via background service worker.

Closes #597
```

---

## Getting Help

- **Questions?** Ask in GitHub Discussions
- **Bug found?** Create an Issue with reproduction steps
- **Security issue?** Email security@hussh-labs.dev (do not create public issue)
- **Stuck on setup?** Check `.devcontainer/` for Docker setup

---

## Next Steps

1. ✅ Set up local development environment
2. ✅ Find a [good-first-issue](https://github.com/hushh-labs/hushh-research/labels/good-first-issue)
3. ✅ Read the [architecture docs](../reference/)
4. ✅ Make your first commit (with `-s` flag!)
5. ✅ Create a PR and iterate with maintainers

Welcome to the Hussh community! 🚀
