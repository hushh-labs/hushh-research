# security-audit — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "The user is signed in, so the operation is consented" | "Treating signed-in as consent" is this family's canonical failure (security-consent-audit workflow). Signed-in is authentication; every protected operation still validates scope. This is also AGENTS.md onboarding critical rule #2. |
| "The delegated agent already had a broader scope upstream" | "Allowing delegated scope escalation" — delegation authority per hop is a scoped export, never a standing grant (Agent Architecture Doctrine #2). Each hop is validated at that hop. |
| "The vault/PKM boundary docs are old, code is truth" | "Ignoring vault or PKM boundary docs" is a named failure. If docs and code disagree on a trust boundary, that disagreement IS the finding — classify drift, don't silently pick one side. |
| "This surface was audited last quarter" | Audits attach to code states, not calendars. A moved route, new caller, or schema change re-opens the boundary. Verify at the current head. |
| "Ciphertext crosses the boundary, so the flow is BYOK-safe" | BYOK requires keys client-side AND minimal browser storage (memory-only for decrypted PKM). Ciphertext transport alone proves half the contract. |
| "It's an internal route, no attacker reaches it" | Trust boundaries are defined by data authority, not network reachability. Internal routes with consent-bypassing reads are exactly what the premise gate's double-verification rule for high-risk surfaces exists for. |
| "The specialist spoke will catch it later" | The owner intake IS the routing moment. Handing off without classifying the boundary risk forwards an unverified premise to the spoke. |

## Red Flags

- An approval that never names which trust boundary was inspected
- Scope-validation logic reasoned about from memory instead of read at the current head
- A consent claim accepted from PR description or user prompt without repo evidence
- A high-risk surface (auth, consent, vault, PKM, finance) verified from a single evidence source when two were feasible
