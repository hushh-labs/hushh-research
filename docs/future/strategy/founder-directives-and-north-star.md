# Founder directives + north star (durable memory)

Faithful capture of the founder's standing strategic direction for this workstream,
so future sessions and the codex brain build against it. Direction is quoted/
paraphrased from the founder; execution status is code-cited and honest.

## Visual Context

Canonical visual owner: [docs index](../../README.md).

## The three directives

1. **Agents are marketplace-deployable.** The 🤫 Agent One *service agents* should
   be deployable onto external agent marketplaces — Google's Agent Marketplace /
   Agentspace / Vertex AI Agent Builder — for **both enterprise and consumer**
   agents, and eventually onto a **🤫-hosted agent marketplace** of our own. The
   point is to make **connection, commerce, and communication** seamless for humans
   at large — two-sided and agent-to-agent.

2. **Meet AND exceed the three-letter-agency bar, in the actual code.** Agents from
   U.S. federal agencies are onboarding imminently. We hold the NIST/FedRAMP-High /
   DoD-IL / IC bar as always-on and **exceed it by a wide margin in the real
   codebase**, not in slideware. The real bars: FedRAMP High (NIST 800-53 Rev 5),
   DoD Cloud SRG IL4/5/6 + CNSSI 1253, ICD 503, FIPS 140-3, CNSA 2.0 (PQC),
   NIST 800-63 IAL2/AAL2/AAL3, Zero Trust (M-22-09 / 800-207), ConMon, SBOM.
   **Honesty bar is non-negotiable:** every certification is **"in pursuit"** until a
   3PAO / ATO says otherwise — a cert we do not hold is never claimed.

3. **Code is the truth; product usage is the only metric.** The only truth is the
   running code and the product that users and agents consume. **Consumption/usage of
   the product is the single real signal** of whether it is working, and the job is to
   improve that. **North star: 8B useful, daily-used 🤫 agents** on the Agent One
   Platform — humans, agents, and machines integrating well for a best-in-class
   experience for the human end user and buyer.

## The unifying insight

**Consent-first is the shared wedge, not a compliance tax.** The same spine a federal
assessor demands — a cryptographic **consent receipt per access**, tamper-evident
audit, phishing-resistant identity, KMS-custodied keys — is *also* the cross-tenant
trust bridge a marketplace agent needs to be safely callable by strangers. A 🤫 Agent
One that returns a signed consent receipt on every call is something no generic
marketplace listing can match: it exceeds the agency bar **and** differentiates in the
marketplace with the same code.

## Execution status (honest, code-cited)

**Agency-grade spine — shipped (flag-off, dev-only, branch
`claude/hushh-infrastructure-analysis-7o991c`):**

| Control | NIST family | What shipped | Flag | Commit |
|---|---|---|---|---|
| Tamper-evident consent-audit chain | AU-9 / AU-10 | `consent_audit_receipts` hash-chain + HMAC + `verify_chain`; fail-safe mirror on the live consent write | `CONSENT_AUDIT_CHAIN_ENABLED` | `dcdcd1212` |
| KMS envelope key custody | SC-12 / SC-13 / SC-28 | `APP_SIGNING_KEY`/`VAULT_DATA_KEY` unwrapped from KMS-wrapped ciphertext via an HSM KEK; transparent KEK rotation | `KMS_KEY_RESOLUTION_ENABLED` (+`_STRICT`) | `3709aa477` |
| FIDO-MDS attestation → real AAL3 | IA-2 (800-63B) | hardware-key + UV elevates `AAL3-candidate` → `AAL3` when the AAGUID is MDS-verified | `WEBAUTHN_MDS_ENABLED` | `6558cb336` |

Each is flag-off by default (zero behavior change), hermetically tested, ruff/mypy/
bandit-clean, and carries an honest control doc under `consent-protocol/docs/reference/`.

**Documented follow-ups (honest limits, not yet built):** same-transaction atomic
audit + internal-event coverage + an append-only primary ledger (AU); DEK rotation
with version-aware verification + KMS-side signing (SC); MDS BLOB signature
verification + privileged-cohort enablement + step-up on sensitive actions (IA).

**Marketplace thread — scoped, next:** the ADK runtime + agent manifests are real; the
official A2A transport exists (`hushh_mcp/adk_bridge/official_a2a.py`) but is gated and
the standard `/.well-known/agent-card.json` is deliberately 404. Smallest-highest-jump
next step: serve a conformant agent card (flag-gated) for one service agent, then the
Vertex/Agentspace deploy adapter and the cross-tenant consent bridge.

## Open items outside the spine

- Pre-existing architecture-compliance violation: `api/routes/health.py` +
  `api/routes/one/relay_auth.py` import `db.connection` directly (from the earlier
  `/health/ready` work) — small, separate fix.
- 33 Dependabot vulnerabilities on the default branch (1 critical, 23 high) — triage.
