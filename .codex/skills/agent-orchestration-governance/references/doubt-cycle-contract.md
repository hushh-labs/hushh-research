# Doubt-Cycle Contract

Adversarial fresh-context review for non-trivial decisions, adapted from the doubt-driven-development mechanism in addyosmani/agent-skills and fitted to the hushh delegation model. Runs INSIDE the existing delegation checkpoint — it does not replace routing, the truth-first kernel, or the governor's authority. The kernel checks premises coming IN; the doubt cycle checks conclusions going OUT.

## When it applies

A decision is non-trivial when at least one holds: it modifies branching logic across a module or service boundary; it asserts a property the type system cannot verify (thread safety, idempotence, ordering, consent invariants); its blast radius is irreversible (deploy, migration, public contract change); or the surface is high-risk per the premise gate (auth, consent, vault, PKM, finance, generated contracts, migrations).

Do NOT run it for mechanical operations, clear single-surface instructions, read-only summaries, or when the operator explicitly chose speed. A doubt cycle on a rename is drift, not rigor.

## The cycle

```
Doubt cycle:
- [ ] 1 CLAIM     — parent writes the claim + why it matters (2-3 lines)
- [ ] 2 EXTRACT   — isolate ARTIFACT + CONTRACT; strip the parent's reasoning
- [ ] 3 DOUBT     — read-only reviewer lane gets the adversarial prompt
- [ ] 4 RECONCILE — parent classifies every finding against the artifact text
- [ ] 5 STOP      — trivial findings, 3 cycles, or operator override
```

**1 CLAIM.** Name what stands: `CLAIM: "the new consent check is race-free under concurrent scope revocation." WHY IT MATTERS: a race here silently widens a consent grant.` If the claim cannot be written that compactly, there is a vibe, not a decision — surface it first.

**2 EXTRACT.** The reviewer needs the ARTIFACT (the diff, the function, the proposal in 3-5 sentences) and the CONTRACT (the constraints it must satisfy — the skill gate, the generated contract, the doctrine item). Strip the parent's reasoning: hand over conclusions and you get back validation of conclusions. If the artifact is too big to hold in one read, decompose before doubting.

**3 DOUBT.** Spawn the `reviewer` lane (xhigh) with this framing, verbatim:

```
Adversarial review. Find what is wrong with this artifact.
Assume the author is overconfident. Look for: unstated assumptions,
unhandled edge cases, hidden coupling or shared state, ways the
contract could be violated, conventions this breaks, failure modes
under unexpected input. Do NOT validate. Do NOT summarize. Find
issues, or state explicitly that you cannot find any after thorough
examination.
ARTIFACT: <artifact>
CONTRACT: <contract>
```

**Hard rule: never pass the CLAIM to the reviewer.** Handing the reviewer the parent's conclusion biases it toward agreement — the reviewer must independently determine whether the artifact satisfies the contract. The adversarial framing overrides the reviewer's default balanced-verdict shape for this invocation; the truth-first handoff fields still apply to its output.

**4 RECONCILE.** Reviewer output is evidence, not verdict — the parent (or governor) re-reads the artifact against each finding before classifying, in this precedence order: (1) `contract_misread` — the CONTRACT given was unclear; fix the contract, re-cycle; (2) `valid_actionable` — real issue; change the artifact, re-loop; (3) `valid_tradeoff` — real but cost exceeds benefit; document explicitly for the operator; (4) `noise` — correct under context the reviewer lacked; note whether adding that context to the contract would have prevented the false flag. Rubber-stamping the reviewer is the same failure as ignoring it.

**5 STOP.** Stop when the next cycle returns only trivial or already-considered findings, OR 3 cycles complete (escalate to the operator — three unresolved cycles is information about the artifact, not a reason for a fourth), OR the operator says ship. If 3 cycles feel insufficient because the artifact is large, the artifact is too big: return to EXTRACT and decompose. Never lift the bound.

## Red flags

- The CLAIM (or the parent's reasoning) appears anywhere in the reviewer's input
- Reviewer prompted with "is this good?" instead of "find what is wrong"
- Reviewer findings adopted without re-reading the artifact (deference ≠ reconciliation)
- Re-spawning on an unchanged artifact (same findings return; that is stalling)
- **Doubt theater**: across 2+ cycles with substantive findings, zero classified `valid_actionable` — the parent is validating, not doubting; stop and escalate
- A doubt cycle spawned for a mechanical change (budget drift in the other direction)

## Relationship to existing contracts

- **Truth-first kernel**: verifies inbound premises. Doubt cycle: verifies outbound conclusions. Same evidence discipline, opposite direction.
- **Delegation checkpoint (AGENTS.md)**: decides WHETHER a lane is spawned. This contract defines HOW the reviewer lane is framed when the decision is non-trivial.
- **Governor**: RECONCILE authority for delegated workflows sits with the governor; child lanes never self-authorize outcomes (existing authority boundary, unchanged).
