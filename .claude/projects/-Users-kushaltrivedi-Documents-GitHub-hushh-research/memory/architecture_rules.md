---
name: Architecture Invariants
description: Four non-negotiable architecture rules enforced across all code changes
type: project
---

1. **BYOK** — Vault keys remain client-side memory only. Never store keys server-side. Client-side encryption means users cannot recover lost keys.

2. **Consent-First** — All data access requires consent token. No implicit access, no bypasses. Three validation layers: agent entry, tool invocation, operon-level.

3. **Tri-Flow Parity** — Web (Next.js proxy), iOS (Capacitor), Android (Capacitor) must stay contract-aligned. No platform-specific behavior divergence.

4. **Minimal Browser Storage** — Secrets (vault key, VAULT_OWNER token) stored in React state only (memory). Never localStorage for secrets.

**Why:** Legal/compliance requirements + core product promise. These are not tech debt items to "fix later."

**How to apply:** Every PR touching API routes, encryption, consent, or PKM behavior must verify these invariants. Components never call APIs directly — all network work goes through `lib/services/*`.
