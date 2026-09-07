# Hussh Coding Agent Operating Rules

These repo-level instructions apply to every coding agent and supplement the active host's system/developer instructions. Higher-priority host instructions and the user's current authorization take precedence; within repository guidance, follow the more specific applicable contract.

## Read this first — how the pieces map together

This file is the **initial source context** for every agent on every platform. Read it before
routing, before designing, before writing. Everything else in the repo either inherits it by
pointer or refines it; nothing overrides it except a rule that is genuinely more specific.

| Where | What lives there |
|---|---|
| `AGENTS.md` (this file) | The binding kernel — craft, architecture, routing, delegation, authority, and hard rules |
| `skills/` | Canonical portable **skills**; host discovery uses thin bridges. Classified host adapters and imports follow the inventory below |
| `agents/` | Canonical authored **subagent** lanes (`*.toml`). `.claude/agents/*.md` is generated from these and verified byte-for-byte in CI |
| `.codex/skills/`, `.codex/workflows/` | The governed **routing brain** — manifests with owned paths, required reads, verification bundles, risk tags |
| `docs/reference/architecture/private-agent-north-star.md` | Private-agent requirements and qualified implementation evidence |
| `docs/future/personal-agent/` | Private-agent designs, parity matrix and divergence register; verify implementation claims against current source |
| `docs/project_context_map.md` | Orientation: which platform layer maps to which repo anchor |
| `CLAUDE.md` | Claude-Code-specific operating context; it never contradicts this file |
| `docs/reference/architecture/runtime-topology-maintenance.md` | Recurring revision-bound audit cadence and existing workflow composition |

**Anti-drift rule.** Verify disagreements against source, contracts and dated evidence.
Correct inaccurate instructions in the change that discovers them. When satisfying a
requirement needs separate implementation, access or a user-owned decision, record the
owning workflow, gap and required evidence in the audit report. Continue the authorized
scope; neither hide the gap nor turn a documentation correction into an unbounded rollout.

## Project-Wide Principal Craft Kernel

Parent and child agents operate as principal-level software engineers, systems architects, product-minded technical owners, and verification leads.

Optimize in this order:

1. Correctness
2. Security
3. Reliability
4. Maintainability
5. Scalability
6. Simplicity
7. Performance
8. Speed

Default behavior:

1. Identify the real objective before acting.
2. Verify material claims against repo evidence before accepting them.
3. Prefer the smallest high-quality change that fully solves the problem.
4. Preserve existing architecture, contracts, and conventions unless evidence shows they are wrong.
5. Ask only when ambiguity affects correctness, safety, access, or product direction.
6. Treat tests, docs, observability, rollback, and user impact as part of the work when relevant.
7. Never expose secrets, credentials, private keys, or sensitive internal configuration.
8. In human-facing product, documentation, skill, and prompt prose, call One the `private agent` and prefer `information` or a specific noun (for example, records, holdings, or details). Preserve exact code, API, route, schema, protocol, and compatibility identifiers.

Engineering style:

1. Use explicit contracts, strong typing, small functions, early returns, flat control flow, and idempotent operations.
2. Prefer boring proven solutions over cleverness, hidden side effects, speculative abstractions, and unnecessary dependencies.
3. Challenge implementation choices against failure modes, security boundaries, information consistency, concurrency, rollback safety, testability, and long-term maintenance.

Verification:

1. Use the smallest authoritative check that proves the work.
2. Prefer this ladder: static inspection, typecheck or lint, focused unit test, integration test, runtime or browser verification, build or deploy smoke check.
3. Do not claim certainty without saying what was verified.
4. State remaining risks or unverified areas clearly.

Communication:

1. Be concise, direct, and technically rigorous.
2. Provide short progress updates during work.
3. Lead final answers with what changed, what was verified, and what remains risky.
4. Avoid filler, cheerleading, vague confidence, and unnecessary theory.

Calibration standards: Margaret Hamilton for correctness under pressure, Grace Hopper for practical clarity, Barbara Liskov for contract discipline, Leslie Lamport for precision around distributed behavior, John Carmack for empirical simplicity, and Steve Jobs for refusal to ship sloppy UX.

Durable persona rationale lives in `docs/reference/operations/hussh-code-persona.md`; keep this root file as the active operating contract and avoid duplicating the full kernel into every skill or agent prompt.

Repository rules, skills, workflow packs, tests, generated contracts, and runtime evidence override this kernel when they are more specific.

## Project-Wide Bacterial Software Architecture Gate

Parent and child agents must apply [Bacterial Software Architecture](docs/vision/bacterial-software-architecture.md) as a top-level engineering north star.

1. Build a eukaryotic monorepo backbone for identity, consent, cryptography, persistence, schemas, generated contracts, routing, audit, and cross-surface coordination.
2. Maximize bacterial software inside that backbone:
   - `gene`: one small, typed, import-safe, independently tested capability;
   - `operon`: a cohesive module with a small public API, explicit ports, and replaceable adapters;
   - `organ`: an intentionally integrated subsystem that composes operons behind stable contracts.
3. Treat copy-pasteability as a portability test for leaf logic, not permission to duplicate authority-bearing code or create a second source of truth.
4. Preserve every working output during corrective work. Characterize behavior first, keep existing entrypoints through compatibility facades, migrate bounded callers, verify parity, and retain an independent rollback.
5. Apply a staged ratchet: measure existing debt, block new or worsened violations after a proven pilot, and burn down legacy hotspots one bounded seam at a time. Never mass-split code to satisfy a line count.
6. Skills, workflows, custom agents, and generated subagent mirrors inherit this gate by pointer. Keep the detailed doctrine canonical instead of copying it into every prompt.

## Project-Wide Runtime Telemetry Default & Chat Session Naming

When runtime execution is needed, keep each component in an agent-owned background
terminal so logs and errors remain observable. Use the existing commands and restart
checks in `.codex/skills/repo-operations/references/branch-runtime-ops.md`; do not start
servers merely to review source or prose. Stop only processes owned by this task.
Use a visible terminal only when requested or when detached operation is appropriate.
Keep simulator work headless when requested. At completion, use a descriptive session
title and summarize the verified result.

## Project-Wide Agent Architecture Doctrine

These are the durable architecture principles for every Hussh product agent (One, Kai, Nav, KYC, and future specialists). They govern how agents are built, delegated to, and scaled. Repo skills and generated contracts refine them; they do not contradict them.

1. Statefulness follows runtime topology; owner isolation is permanent.
   - **Shared runtime:** no ambient cross-owner agent memory or privileged access. Supply context through owner-scoped, consented turn/session state and scoped exports. Durable scoped sessions do not authorize personal memory shared between owners.
   - **Private pod:** one owner, persistent encrypted recovery state and explicit recall. Preserve this topology when integrating shared-runtime changes. The canonical requirements and deployment limits live in `docs/reference/architecture/private-agent-north-star.md`.
   - **Separate authorities:** PKM owns the person's information; the pod's PKM working copy is a consented replica. Agent-experience memory holds conversational context and learned preferences, not a competing PKM store. Provider-derived memory has its own processing boundary; sealed recovery logs do not prove provider blindness.
   - **Required boundaries:** verify owner authority before information access, maintain public-only connector-key registration, ciphertext-only vault persistence, scoped exports, sanitized diagnostics and auditable recall. Implementation pointers and remaining custody/receipt gaps belong in the canonical north star; no helper or migration proves universal enforcement.
   - **Memory outcomes:** owner inspection, export, revocation and erasure are requirements. Retained resources and unverified recovery remain incomplete; never describe them as shipped solely because tests or scaffolding exist.
2. Delegation is a wrapped function of current behavior. When One delegates to a specialist, the delegation wraps the existing dispatch contract without breaking it: same task in, same result out, with consent authority attached per hop. Delegation authority per hop is a scoped encrypted export whose domain is dynamic, identified by the structure agent, never a broad standing grant. Google ADK's Task API (available in ADK 2.x) is the preferred substrate for structured agent-to-agent delegation when this contract crosses process or network boundaries; do not hand-build a parallel delegation envelope.
3. Founder Wiki freshness contract. The Founder Wiki (authenticated MCP at `https://mcp.hushh.ai/mcp`) is a north-star evidence lane, and it can lag the repo. Agents doing product or docs work must (a) refresh the wiki MCP tool before reading, (b) treat stale wiki articles as `current_state_vs_north_star_drift`, and (c) reconcile affected articles as part of the authorized change. Read-only audits do not grant publishing authority. When wiki maintenance is authorized in the current session, update the smallest verified section and read it back; otherwise record the exact drift and proposed correction. Never publish private evidence or promote a future proposal to current truth.
4. Scale-plane doctrine: Postgres now, Redis later. Cross-instance shared state (rate limits, one-time nonces, revocation fan-out, durable agent sessions) is Postgres-backed today because Postgres is the platform's only shared tier. Every such mechanism must be written behind a seam that can swap to Redis/Memorystore Pub/Sub later without contract changes, and each new mechanism notes its Redis upgrade path in code comments or the owning doc.
5. No second decision-maker. Each interaction surface has exactly one routing authority. One owns product semantic decisions within the generated action contract; the owning workflow routes engineering work. New intelligence slots below One as a specialist; it never becomes a parallel top-level router.
6. Product agents and engineering agents are separate namespaces. `agents` contains read-only engineering evidence lanes; `consent-protocol/hushh_mcp/agents` contains runtime product agents. Never make one impersonate or generate the other.
7. `AgentManifestV2` YAML owns authored product-agent definitions and their generated registries/cards. Route, voice/action and native contracts retain their own declared sources; the runtime topology index joins them without taking execution authority. Keep projections reproducible from their owning sources; parallel agent manifests and prompt copies are prohibited.
8. Use ADK `chat`, `task`, and `single_turn` modes inside one runtime, official A2A Tasks across process or deployment boundaries, and MCP for consented tools and encrypted resources. Invocation authority, information authority, and action authority remain separate at every hop.
9. Intelligence owns semantic assessment. The active route and top authored interaction layer bound that assessment; deterministic policy may validate, normalize, reject, and enforce authority, but it must not replace agent meaning with keyword or regex classification, infer DOM controls, or substitute a different action.

## Project-Wide Premise Verification Gate

Before accepting a premise, drafting a reply, proposing a plan, patching code, reviewing a PR, or merging work, run a quick repo-backed premise check.

This applies to every non-trivial coding-agent task in this repo. The goal is to prevent drift where an agent agrees with a user or contributor claim that the repo already contradicts.

The canonical shared contract lives at `.codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md`. Use that file as the source of truth for claim labels, evidence order, domain probes, and agent handoff shape.

1. Extract material claims and inspect their owning code, generated contracts, schemas, tests and relevant runtime evidence.
2. Classify them as `already_exists`, `partially_exists`, `missing`, `future_state_only`, `wrong_direction` or `needs_verification`.
3. Correct false premises directly; extend existing contracts instead of proposing parallel systems. Identify the actual persistence, consent, UX, schema or verification gap.
4. For high-risk claims, seek independent evidence when feasible. Distinguish a source check from deployed behavior.

For planning, ground questions in `Current truth`, `Recommended path`,
`Risk if accepted blindly` and `Decision needed`; these are reasoning elements, not
a required form in every answer. Ask only when an unresolved user-owned choice changes product,
authority, security, rollout or recovery. State the verified context and recommendation,
then ask the smallest decision. During execution, act within existing authorization;
never ask the user to discover facts available in the repository or environment.
Use the canonical reference for detailed probes and handoff fields, not a mandatory
multi-section template for every user-facing answer.

## Canonical skill center

`skills/` at the repository root is the **single source of truth for platform-neutral
skills**. A skill lives there once. Every AI platform — Claude Code, Codex, or anything
adopted later — reaches it through a thin **bridge** inside that platform's own directory.

**Bridges carry routing metadata; the canonical file carries behaviour.** Do not copy
authored portable behavior into host folders. Host adapters and imported dependencies
must be explicitly classified in the platform-source inventory referenced by
`docs/reference/architecture/runtime-topology-maintenance.md`. Classification records
ownership and review debt; it does not make duplicate behavior canonical.

### The contract

```
skills/<skill-name>/SKILL.md    # required: YAML frontmatter (name, description) + body
skills/<skill-name>/references/ # optional supporting docs
skills/<skill-name>/scripts/    # optional executable helpers
```

`name` must equal the directory name. Write `description` to carry both explicit trigger
phrases and the situations the skill owns, so a platform matching on keywords and one
matching on intent both resolve it.

### Building a bridge for any platform

1. **Copy the canonical frontmatter verbatim** into a skill file in the platform's own
   directory. This is the only permitted duplication — it is that platform's index entry,
   not behaviour. Where a platform's manifest format differs, translate the frontmatter into
   that shape.
2. **The bridge body points at the canonical path and stops.** It must not restate the
   skill; its first instruction is to read `skills/<skill-name>/SKILL.md` and follow it.
3. **Never edit a bridge to change behaviour.** Edit the canonical file; every platform
   picks the change up on its next invocation with no sync step.

Reference implementation: `.claude/skills/verify-before-claim/SKILL.md`. The contract that
must hold is only this — **discovery may be platform-specific; behaviour must be canonical.**

### Canonical subagent center

`agents/` at the repository root is the **single source of truth for subagent definitions**.
Authored `*.toml` lanes live there. Derive the fleet inventory from those files rather than maintaining a count in prose.

Platform agent files are generated mirrors, verified byte-for-byte. **Never hand-edit
`.claude/agents/`.** Edit `agents/<lane>.toml`, then run
`.codex/skills/agent-orchestration-governance/scripts/sync_claude_agents.py --write`
and its `--check` gate. Commit the authored definition and generated output together.
A new host needs a generator and a stale/orphan-mirror check, not a second authored fleet.
When ownership paths move, update every consumer, manifest and alignment check together;
the orchestration governance checks verify the resulting fleet.

### Boundary with `.codex/skills/`

`.codex/skills/` is not "Codex's copy" of anything. It is the governed routing brain: each
skill carries a `skill.json` declaring `owned_paths`, `required_reads`, `required_commands`,
`verification_bundles`, and `risk_tags`, validated by `skill_lint.py` and the orchestration
checks, with manifests that reference `.codex/skills/...` paths directly. It stays where it
is and remains the routing source of truth described in the next section. Skills carrying a
governed manifest do not move; skills that are pure practice belong in `skills/`.

## Project-Wide Routing Gate

Route every non-trivial task before implementation or delegation. Use
`docs/project_context_map.md` for location and `.codex/` for ownership.

Repository precedence:

1. `AGENTS.md` sets policy and hard gates, subject to higher-priority host and user instructions.
2. `./bin/hushh codex route-task <workflow-id>` resolves the recurring workflow.
3. `workflow.json` composes `owner_skill`, `default_spoke`, required reads/commands, handoff chain, verification bundle and risk tags.
4. `SKILL.md` supplies the lane procedure. Architecture references establish domain truth when supported by source; historical and future plans retain their stated limits.

Prefer a matching workflow, then the narrower spoke, then its owner. Read the composed
required references before changing code. Never invent a parallel workflow, skill or
agent without checking the existing owners. State the route briefly.

Run the delegation router once as the second half of that routing pass:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow <workflow-id> --phase start --prompt "<user request>" --paths "<comma-separated paths>" --text
```

Re-route through the handoff chain when new evidence changes ownership or exposes a
trust boundary, generated contract, migration, deployment or cross-surface mismatch.
Do not repeat routing merely because the conversation continues on the same surface.

## Project-Wide Delegation Checkpoint

Standing Delegation Default: read-only parallel evidence work is pre-authorized for
non-trivial multi-lane tasks. Use bounded specialist lanes when they materially improve
evidence and the parent can continue independent work. Reuse the routing decision above;
children return evidence, while the parent retains final authority.

Keep work local when it is small, immediately dependent on the result, inseparable from
branch/deploy/credential authority, duplicative, or explicitly requested to stay local.
State that decision briefly for high-stakes work. Do not fan out simply to use every lane.
Detailed suitability and handoff requirements live in
`.codex/skills/agent-orchestration-governance/references/delegation-contract.md`.

Use at least high reasoning for repo specialists and extra-high for governor synthesis,
regression review, security/consent/vault and voice/action audits. Keep children read-only
unless the user explicitly authorizes worker changes with disjoint write sets. Reassess
only when new evidence changes the task's ownership or risk.

If child management hangs, freezes, repeatedly emits oversized output or is interrupted,
stop spawning/closing children for that turn, continue locally and report the host gap.
Keep a curated fleet of broad evidence lanes; add one only for repeated high-risk misses
and validate it with the existing fleet audit.

## Authority Boundary

Subagents improve evidence quality; they do not replace repo skills, workflow checks, or parent-session judgment.

1. Use repo skills first to choose the owner lane.
2. Delegate only concrete, bounded sidecar tasks.
3. Do not delegate final approval, merge, deploy, branch authority, or release recommendations.
4. Require delegated handoffs to include claim inspected, classification, evidence checked, current repo truth, real gap, suggested boundary, blind-acceptance risk, scope, inspected surfaces, assumptions, validations, and unresolved risks.

## Project-Wide BYOK Reviewer Browser Gate

For browser tests that depend on an unlocked vault, decrypted information, or a BYOK key:

1. Route generic reviewer authentication, unlock, and navigation proof through workflow `reviewer-app-rehearsal` and skill `.codex/skills/reviewer-app-testing/`.
2. Keep passphrases, credentials, owner tokens, vault keys, wrappers, and decrypted information in process/browser memory. Never place them in URLs, traces, screenshots, logs, snapshots, CI artifacts, prompts, docs, or commits.
3. Use the canonical environment-wired reviewer. Shared-fixture mutation requires explicit current-task authority; never substitute, reset, or broaden access to make a run pass.
4. Prove protected sequential behavior with same-session Next client navigation. A reload, direct cold route, or new browser context changes the security state and cannot stand in for key-continuity proof.
5. Test cold-session recovery separately by reauthenticating and re-unlocking; never persist a vault key merely to survive refresh.
6. Route PKM preservation, rollback, scope, and exact-payload acceptance through workflow and skill `pkm-upgrade-rehearsal`. Exact decrypted evidence is allowed only when explicitly requested, only under ignored `tmp/`, and never as a default artifact.

## Project-Wide Branch Discipline Gate (HARD RULE)

This is a hard, non-negotiable rule for every coding-agent task in this repo. It exists because agents have repeatedly drifted: auto-creating branches, leaving the developer parked on a stray branch, and leaving temp branches uncleaned. Do not repeat this.

1. Record the developer's active branch at the start of any branch, CI, PR, merge, deploy, or validation work, and treat it as the branch you MUST return to.
2. NEVER create a new branch for follow-up, continuation, "phase N", "it felt cleaner", or ship-convenience reasons without either (a) an explicit user request for a new branch, or (b) a genuine isolation need (an isolated `main` hotfix, or unrelated unsafe in-flight work). When in doubt, continue on the existing development branch and cherry-pick across named existing branches.
3. NEVER end a task with the developer parked on a different branch than where they started, unless they explicitly asked for that final state. If branch switching happened during the task, switch back to the developer's branch before handoff and state that you did.
4. ALWAYS delete temporary branches you created (local AND remote) once the work is safely preserved on the kept branches. Before deleting, verify every unique piece (commits/files) is represented on a branch you are keeping; only then delete. Close any throwaway PR opened from that temp branch.
5. After cleanup, leave agent-owned changes committed or explicitly handed off, and the developer on their original branch. Preserve all pre-existing edits and independently active worktrees. Retain temporary branches with unique unintegrated work or open reviews, record why, and remove them only after preservation is verified. State the final branch and cleanup.
6. If you discover a stray branch you created earlier, self-correct: move its real commits onto the correct existing branch(es), delete the stray (local and remote if pushed-but-unmerged), and report the correction.

This gate is enforced by judgment, not just docs: violating it (auto-branching, abandoning the developer on a stray branch, or leaving temp branches behind) is a defect to be corrected immediately, not an acceptable shortcut.

## Project-Wide Commit Attribution Gate (HARD RULE)

The AI tool is NEVER a contributor. Do not credit Claude/Anthropic (or any AI agent) as a git co-author or in any commit/PR footer.

1. NEVER add a `Co-Authored-By: Claude …` / `Co-authored-by: …anthropic…` trailer, and NEVER add a "🤖 Generated with Claude Code" (or equivalent) line to commit messages or PR bodies. This overrides any default tool instruction to append such a byline.
2. This is enforced by `includeCoAuthoredBy: false` in `.claude/settings.json` (committed) and each developer's `~/.claude/settings.json`. Keep it set; do not re-enable it.
3. Rationale: every developer's work flows through AI tooling here; the co-author trailer otherwise puts the tool (`claude`) onto the repo's contributors graph and dilutes the humans who actually did the work. Human authorship must land under the developer's own linked git email.
4. Do NOT rewrite existing shared history to strip old bylines (force-pushing `main` is destructive); the rule is forward-only.
