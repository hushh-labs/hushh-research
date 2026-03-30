# Consent Protocol

> **Status**: Production Ready  
> **Last Updated**: February 2026  
> **Principle**: Consent-First, BYOK, Zero-Knowledge


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## Overview

The Hushh platform enforces a **consent-first architecture** where all data access is gated by consent tokens. This document is the authoritative reference for the consent protocol implementation.

**Core Principle**: All data access requires a consent token. Vault owners are NOT special - they use VAULT_OWNER tokens.

```
Traditional     ❌  if (userOwnsVault) { allow(); }
Hushh Approach  ✅  if (validateToken(VAULT_OWNER)) { allow(); }
```

---

## Security Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                     User Authentication Flow                     │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Firebase Auth    → OAuth (ACCOUNT - who you are)       │
│          Google Sign-In → Firebase ID token                     │
│                                                                  │
│ Layer 2: Vault Unlock     → Passphrase/Recovery (KNOWLEDGE)     │
│          PBKDF2 key derivation (100k iterations)                │
│          Zero-knowledge (passphrase never sent to server)       │
│                                                                  │
│ Layer 3: VAULT_OWNER Token → Cryptographic Consent (DATA ACCESS)│
│          Issued after vault unlock, 24h expiry                  │
│                                                                  │
│ Layer 4: Agent Tokens     → Scoped Operations                   │
│          Domain-specific, 7-day expiry                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Token Hierarchy

### Single Token Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTHENTICATION FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    Firebase Token    ┌──────────────────────┐ │
│  │   Firebase   │ ─────────────────────▶ /vault-owner-token   │ │
│  │   Sign-In    │                      │ (Bootstrap ONLY)     │ │
│  └──────────────┘                      └──────────┬───────────┘ │
│                                                   │             │
│                                        Issues VAULT_OWNER       │
│                                                   │             │
│                                                   ▼             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    VAULT_OWNER TOKEN                      │  │
│  │  Contains: user_id, agent_id, scope, expires_at, sig     │  │
│  │  Proves: Identity + Consent + Vault Unlocked             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│       ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│       │ Kai Chat │    │ Portfolio│    │ World    │             │
│       │ Routes   │    │ Routes   │    │ Model    │             │
│       └──────────┘    └──────────┘    └──────────┘             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Token Types

| Token Type             | Purpose                    | When Used                            | Duration |
| ---------------------- | -------------------------- | ------------------------------------ | -------- |
| **Firebase ID Token**  | Identity verification only | Bootstrap: issuing VAULT_OWNER token | 1 hour   |
| **VAULT_OWNER Token**  | Consent + Identity         | ALL consent-gated data operations    | 24 hours |
| **Agent Scoped Token** | Delegated access           | Third-party agent operations         | 7 days   |

**Key Principle**: VAULT_OWNER token proves both identity AND consent. Firebase is ONLY used to bootstrap the VAULT_OWNER token issuance.

### Automated Test Token Policy

- Automated test suites must use fixture-issued tokens from `consent-protocol/tests/conftest.py`.
- `consent-protocol/tests/dev_test_token.py` is for manual/debug workflows only.
- CI must not depend on `.env` token helpers or `HUSHH_DEVELOPER_TOKEN` for consent-route coverage.

### Streaming Contract Policy

- All Kai streaming routes use canonical SSE envelopes (`schema_version`, `stream_id`, `stream_kind`, `seq`, `event`, `terminal`, `payload`).
- Route producers must emit explicit `event:` frames with envelope `event` parity.
- No legacy stream shape support is permitted for new work.
- Contract reference: `docs/reference/streaming/streaming-contract.md`.

---

## Route Categories

### 1. Public Routes (No Auth)

```
GET  /health
GET  /kai/health
GET  /api/investors/*          # Public SEC data
GET  /api/v1/list-scopes
```

### 2. Developer Routes (Developer API Enabled)

```
GET  /api/v1/list-scopes              # Generic scope catalog
GET  /api/v1/user-scopes/{user_id}    # Developer-token protected dynamic scope discovery
POST /api/v1/request-consent          # Create or reuse consent for one discovered scope
```

### 3. Bootstrap Routes (Firebase Only)

These routes issue or manage VAULT_OWNER tokens:

```
POST /api/consent/vault-owner-token    # Issues VAULT_OWNER token
GET  /api/consent/pending              # View pending before vault unlock
POST /api/consent/pending/approve      # Approve before having token
POST /api/consent/pending/deny         # Deny before having token
```

### 4. Consent-Gated Routes (VAULT_OWNER Required)

ALL data access routes require VAULT_OWNER token:

```
# Kai Chat
POST /kai/chat
GET  /kai/chat/history/{id}
GET  /kai/chat/conversations/{user_id}
GET  /kai/chat/initial-state/{user_id}
POST /kai/chat/analyze-loser

# Kai Portfolio & PKM Data Retrieval
POST /kai/portfolio/import
GET  /kai/portfolio/summary/{user_id}
GET  /api/consent/data                  # MCP: Get encrypted export
GET  /api/consent/active                # MCP: List active tokens
POST /api/consent/request-consent       # MCP: Request token
GET  /api/consent/pending               # Dashboard: View pending
POST /api/consent/pending/approve      # Dashboard: Approve request

# Kai personalization storage
# Optional intro data is stored in encrypted PKM path `financial.profile`.
# No `/api/kai/preferences/*` endpoints exist.

# MCP Server Data Access
# MCP tools access vault data via the consent-gated endpoint:
GET  /api/consent/data                   # MCP reads data with consent token
```

---

## Implementation

### Backend Middleware

The `require_vault_owner_token` dependency validates VAULT_OWNER tokens:

```python
# consent-protocol/api/middleware.py
from api.middleware import require_vault_owner_token

@router.post("/chat")
async def kai_chat(
    request: KaiChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    # token_data contains: user_id, agent_id, scope, token
    if token_data["user_id"] != request.user_id:
        raise HTTPException(status_code=403, detail="User ID mismatch")
    # Proceed with consent-gated operation
```

### Token Validation (Hierarchical)

```python
# consent-protocol/hushh_mcp/consent/token.py
def validate_token(token_str, expected_scope=None):
    """
    Validates token and checks scope.
    HIERARCHICAL CHECK: VAULT_OWNER satisfies ALL scopes.
    """
    # Check in-memory revocation
    if token_str in _revoked_tokens:
        return False, "Token has been revoked", None

    # Decode and verify signature...

    # VAULT_OWNER satisfies any scope (Master Key)
    is_owner = scope == ConsentScope.VAULT_OWNER

    # Use scope_str for dynamic dot-notation matching
    granted_scope_str = token_obj.scope_str
    if expected_scope and not is_owner:
        from hushh_mcp.consent.scope_helpers import scope_matches
        if not scope_matches(granted_scope_str, expected_scope):
            return False, f"Scope mismatch: token has '{granted_scope_str}', but '{expected_scope}' required", None

    return True, None, token_obj
```

### Frontend Credential Storage (Memory-Only for Secrets)

**CRITICAL SECURITY MODEL**: Both vault key and VAULT_OWNER token are stored in React state (Zustand / memory only). Browser storage may still be used for selected non-sensitive UI/cache data.

```typescript
// hushh-webapp/lib/vault/vault-context.tsx
const unlockVault = useCallback(
  (key: string, token: string, expiresAt: number) => {
    // SECURITY: Both key and token stored in React state (memory only)
    // XSS attacks cannot access React component state
    setVaultKey(key);
    setVaultOwnerToken(token);
    setTokenExpiresAt(expiresAt);

    // Sensitive credentials stay in memory; no storage persistence for key/token
  },
  [],
);
```

**Storage Policy**: Sensitive credentials remain memory-only. Non-sensitive cache/settings values may use `localStorage`/`sessionStorage` where explicitly documented.

### Service Layer Token Access

Services MUST receive the token as an explicit parameter from components that have access to `useVault()` hook:

```typescript
// ✅ CORRECT - Token passed explicitly from useVault() hook
async deleteAccount(vaultOwnerToken: string): Promise<Result> {
  if (!vaultOwnerToken) {
    throw new Error("VAULT_OWNER token required");
  }
  // Use token...
}

// ✅ CORRECT - Component passes token from context
const { vaultOwnerToken } = useVault();
await AccountService.deleteAccount(vaultOwnerToken);
```

---

## Tri-Flow Architecture

### Web Flow

```
Component → Service → Next.js Proxy → Python Backend
                         ↓
              Authorization: Bearer {vault_owner_token}

### Integrated Notification Flow (FCM-Only)
The system uses a unified FCM (Firebase Cloud Messaging) pipeline for both Web and Native.
1. **Backend** triggers FCM push via `send_consent_notification`.
2. **Device** receives notification (Foreground: custom event, Background: system tray).
3. **App** UI polls/refreshes state based on notification type.
```

### Native Flow (iOS/Android)

```
Component → Service → Capacitor Plugin → Python Backend
                           ↓
              Authorization: Bearer {vault_owner_token}
```

### Plugin Implementation

**iOS (Swift)**:

```swift
@objc func chat(_ call: CAPPluginCall) {
    guard let vaultOwnerToken = call.getString("vaultOwnerToken") else {
        call.reject("Missing vaultOwnerToken")
        return
    }
    request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
}
```

**Android (Kotlin)**:

```kotlin
@PluginMethod
fun chat(call: PluginCall) {
    val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
        call.reject("Missing vaultOwnerToken")
        return
    }
    requestBuilder.addHeader("Authorization", "Bearer $vaultOwnerToken")
}
```

---

## Consent Scopes

### Master Scope

| Scope           | Value         | Description                                                                           |
| --------------- | ------------- | ------------------------------------------------------------------------------------- |
| **VAULT_OWNER** | `vault.owner` | Master scope - satisfies ANY other scope. Granted only to vault owner via BYOK login. |

### Static Scopes

| Category | Scope | Description |
| -------- | ----- | ----------- |
| **Master** | `vault.owner` | Master scope - satisfies ALL other scopes |
| **Portfolio** | `portfolio.import` | Import portfolio data |
| | `portfolio.analyze` | Analyze portfolio holdings |
| | `portfolio.read` | Read portfolio summaries |
| **Chat** | `chat.history.read` | Read chat conversation history |
| | `chat.history.write` | Write/create chat messages |
| **Embeddings** | `embedding.profile.read` | Read computed embedding profiles |
| | `embedding.profile.compute` | Compute new embedding profiles |
| **PKM** | `pkm.read` | Read PKM attributes |
| | `pkm.write` | Write PKM attributes |
| | `pkm.metadata` | Access PKM metadata |
| **Agent Kai** | `agent.kai.analyze` | Run Kai analysis pipelines |
| | `agent.kai.debate` | Run Kai debate/reasoning |
| | `agent.kai.infer` | Run Kai inference |
| | `agent.kai.chat` | Kai chat interactions |
| **External** | `external.sec.filings` | Access SEC filing data |
| | `external.news.api` | Access news API data |
| | `external.market.data` | Access market data feeds |
| | `external.renaissance.data` | Access Renaissance data |

### Dynamic Scopes

```
attr.{domain}.{attribute_key}   # Specific attribute
attr.{domain}.*                  # All attributes in domain
attr.{domain}.{subintent}.*      # All attributes under a subintent subtree
```

Examples:

- `attr.financial.holdings`
- `attr.{domain}.{path}`
- `attr.{domain}.*`
- `attr.financial.profile.*`

Dynamic scopes are discovered at runtime from PKM metadata and `domain_registry`.
Use `GET /api/pkm/scopes/{user_id}` (or MCP `discover_user_domains`) instead of hardcoding domains.

### Scope Hierarchy

```
vault.owner (Master - satisfies ALL scopes)
    ├── portfolio.*
    ├── chat.history.*
    ├── embedding.profile.*
    ├── pkm.*
    ├── agent.kai.*
    ├── external.*
    └── Dynamic attribute scopes:
        pkm.read
            └── attr.{domain}.*
                └── attr.{domain}.{key}
```

---

## Token Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    VAULT_OWNER TOKEN LIFECYCLE                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ 1. ISSUANCE                                                      │
│    User unlocks vault → Backend issues token → Stored in DB     │
│                                                                  │
│ 2. REUSE                                                         │
│    User unlocks again → Backend finds existing → Returns same   │
│                         (while valid, >1h remaining)             │
│                                                                  │
│ 3. VALIDATION                                                    │
│    Every API call → validate_token() → Allow/Deny               │
│                                                                  │
│ 4. EXPIRY                                                        │
│    After 24h → Token invalid → User must unlock again           │
│                                                                  │
│ 5. LOGOUT                                                        │
│    User logs out → Token cleared from memory → Session ended    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Database Tables

### consent_audit (PRIMARY TABLE)

The `consent_audit` table is the **single source of truth** for all consent token operations. It uses an event-sourcing pattern where each action (REQUESTED, CONSENT_GRANTED, CONSENT_DENIED, REVOKED) creates a new row, and the latest row per scope determines current state.

```sql
CREATE TABLE consent_audit (
  id SERIAL PRIMARY KEY,
  token_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,          -- 'self' for VAULT_OWNER, agent name otherwise
  scope TEXT NOT NULL,             -- 'vault.owner', 'agent.kai.analyze', etc.
  action TEXT NOT NULL,            -- 'REQUESTED', 'CONSENT_GRANTED', 'CONSENT_DENIED', 'REVOKED'
  issued_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  metadata JSONB,
  token_type VARCHAR(20) DEFAULT 'consent',
  ip_address VARCHAR(45),
  user_agent TEXT,
  request_id VARCHAR(32),          -- For consent request tracking
  scope_description TEXT,
  poll_timeout_at BIGINT           -- For pending consent requests
);

CREATE INDEX idx_consent_user ON consent_audit(user_id);
CREATE INDEX idx_consent_token ON consent_audit(token_id);
CREATE INDEX idx_consent_audit_created ON consent_audit(issued_at DESC);
CREATE INDEX idx_consent_audit_user_action ON consent_audit(user_id, action);
CREATE INDEX idx_consent_audit_request_id ON consent_audit(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_consent_audit_pending ON consent_audit(user_id) WHERE action = 'REQUESTED';
```

---

## Security Properties

### 1. Consent-First

- No data access without valid VAULT_OWNER token
- Token proves user has unlocked their vault (consented)
- All routes enforce token validation at middleware level

### 2. BYOK (Bring Your Own Key)

- Vault key stays client-side (memory only)
- Backend stores ciphertext only
- VAULT_OWNER token proves key possession without revealing key

### 3. Zero-Knowledge

- Server cannot decrypt user data
- Token validation is cryptographic (HMAC signature)
- Cross-instance revocation via database check

### 4. Token Hierarchy

- VAULT_OWNER scope satisfies ALL other scopes
- Scoped tokens for delegated access
- Time-limited tokens with expiration

### 5. XSS Protection (Memory-Only Storage)

**CRITICAL**: Both vault key AND VAULT_OWNER token are stored ONLY in React state (memory). This prevents XSS attacks from stealing credentials.

```
┌─────────────────────────────────────────────────────────────┐
│                    MEMORY ONLY (XSS Protected)              │
├─────────────────────────────────────────────────────────────┤
│  Vault Key        → React State (VaultContext / Zustand)    │
│  VAULT_OWNER Token → React State (VaultContext / Zustand)   │
├─────────────────────────────────────────────────────────────┤
│  Secrets in memory: vault key/token are not persisted       │
│  Non-sensitive cache/settings may use browser storage       │
└─────────────────────────────────────────────────────────────┘
```

**Why this matters**:
- XSS attacks can read `sessionStorage` and `localStorage`
- XSS attacks CANNOT read React component state
- Sensitive credential theft via storage APIs is prevented by memory-only key/token handling

**Service layer pattern**:
- Services MUST receive token as explicit parameter
- Services MUST NOT access browser storage APIs
- Components with `useVault()` access pass token to services

---

## Compliance

### CCPA

| Requirement      | Implementation                            |
| ---------------- | ----------------------------------------- |
| Right to Know    | Export `consent_audit` table              |
| Right to Delete  | Token revocation + vault deletion         |
| Right to Opt-Out | No data sharing without consent tokens    |
| Proof of Consent | Cryptographic tokens = verifiable consent |

### GDPR

| Requirement        | Implementation                        |
| ------------------ | ------------------------------------- |
| Lawful Basis       | Consent tokens = explicit consent     |
| Consent Management | Token expiry, revocation, audit trail |
| Data Minimization  | Scoped tokens limit agent access      |
| Right to Erasure   | Vault deletion + token revocation     |

---

## Files Reference

### Backend

- `consent-protocol/api/middleware.py` - Token validation dependencies
- `consent-protocol/hushh_mcp/consent/token.py` - Token crypto + validation
- `consent-protocol/api/routes/consent.py` - Consent endpoints
- `consent-protocol/api/routes/kai/chat.py` - Chat endpoints
- `consent-protocol/api/routes/kai/portfolio.py` - Portfolio endpoints

### Frontend

- `hushh-webapp/lib/vault/vault-context.tsx` - Token storage
- `hushh-webapp/lib/services/api-service.ts` - Service layer
- `hushh-webapp/lib/capacitor/kai.ts` - Plugin interface
- `hushh-webapp/lib/capacitor/plugins/kai-web.ts` - Web fallback

### Native

- `hushh-webapp/ios/App/App/Plugins/KaiPlugin.swift` - iOS plugin
- `hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/Kai/KaiPlugin.kt` - Android plugin

---

## See Also

- [Personal Knowledge Model](./personal-knowledge-model.md) -- Database architecture
- [Agent Development](./agent-development.md) -- Building new agents and operons
- [Kai Agents](./kai-agents.md) -- Multi-agent financial analysis system
- [Environment Variables](./env-vars.md) -- Backend configuration reference
