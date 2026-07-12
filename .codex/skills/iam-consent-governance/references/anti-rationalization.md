# iam-consent-governance — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "The scope name says what it grants" | Scope semantics live in the verification policy and actor model, not the identifier. Widening what a name "obviously implies" is scope escalation through vocabulary. |
| "This actor is trusted, skip per-hop validation" | Delegation authority per hop is a scoped encrypted export whose domain is dynamic (Doctrine #2). Trust is per-hop and per-domain, never standing. |
| "Marketplace access is read-only, low risk" | Marketplace access contracts are an owned surface of this lane precisely because read paths leak. Read-only across a consent boundary still requires scope validation. |
| "The frontend already checks consent" | Client checks are UX, not enforcement. Consent-first means the backend validates scope on every protected operation regardless of caller discipline. |
| "Adding one field to the actor model is mechanical" | Actor-model changes cascade into verification policy, delegation boundaries, and generated contracts. The premise gate's double-verification rule for consent surfaces applies. |
| "Tests pass, so the policy change is safe" | Tests encode yesterday's policy. A policy change needs the boundary docs and generated contracts re-read, not just a green suite. |

## Red Flags

- A scope or actor-model diff with no corresponding verification-policy read
- A delegation change reviewed without tracing one full hop chain end-to-end
- Consent enforcement reasoned from frontend code only
- A "mechanical" IAM change merged without the security-audit owner intake seeing it
