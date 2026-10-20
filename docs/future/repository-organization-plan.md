# Repository organization and unified development agents

## Status

**Implementation candidate — updated 2026-10-20.** Main and frozen local ADK
were integrated through `f3132dff38`; canonical-source consolidation is under local verification.
Continue on `claude/hushh-infrastructure-analysis-7o991c`; preserve concurrent work.
The current execution authorization permits a verified dev release. Main merge,
UAT and production deployment remain separate. The
[normal release transition](./personal-agent/NORMAL-RELEASE-TRANSITION.md) retains
the private-agent implementation, migration and release prerequisites.

## Visual Context

Use the [documentation architecture map](../reference/operations/documentation-architecture-map.md)
and [recursive knowledge model](../reference/operations/documentation-recursive-knowledge-model.md)
for current placement rules. Their current skills map must change with the migration,
not ahead of the executable routing sources.

## Decision

Use `.agents/` as the single authored home for repository development instructions,
skills, subagents and workflows. Keep host-required entrypoints as thin adapters or
generated projections. Organize the rest of the repository around existing package
and domain ownership, with deeper folders only for distinct responsibilities.

The canonical operating contract now lives in `.agents/instructions.md`, loaded
explicitly by root `AGENTS.md`. Skill, workflow, and lane consumers move together;
host settings and projections live under `.agents/adapters`, exposed through checked relative native links. Codex reads canonical skills directly; copied discovery is removed.

## Inspected baseline

| Surface | Current source | Migration requirement |
| --- | --- | --- |
| Portable development skills | 22 classified practices under `.agents/skills/` after integration | Preserve behavior and relative resource graphs |
| Governed owner/spoke skills | 45 under `.agents/skills/` | Preserve `skill.json`, ownership, routing and verification contracts |
| Development subagents | 19 authored TOML files under `.agents/subagents/` | Preserve lane IDs, read-only authority and generated host mirrors |
| Recurring workflows | 40 under `.agents/workflows/` | Preserve workflow IDs and existing CLI commands |
| Host discovery | Exact relative links; 19 Claude projections under `.agents/adapters` | No copied skill discovery. Preserve native settings, current MCP entries and classified imports |
| Routing cases / pinned imports | 45 cases under `.agents/evals`; 156 unchanged imported files under `.agents/imports/impeccable` | Preserve case bytes, original licenses/hashes and pending-review restrictions |
| Maintained documentation | 321 pages in the existing inventory | Classify every page; 37 flagged review candidates are not deletion decisions |
| Concurrent work | Ten dirty/untracked peer paths; active ADK worktree | Preserve hashes, coordinate ownership and reconcile before relocation |

Counts describe this revision. Recount after concurrent work is integrated. Portable
and governed skill names currently have no collisions; semantic duplicates still
need review. Source references occur in CLI, hooks, tests, manifests, generators,
documentation and host discovery: a directory rename alone is insufficient.

## Target structure

```text
.agents/
  README.md                   # one development-system map
  instructions.md             # shared operating contract
  skills/<skill-id>/          # one authored procedure per capability
    SKILL.md
    skill.json                # governed owners/spokes; not forced on portable skills
    references/               # loaded when relevant
    scripts/                  # existing bounded tooling
  subagents/<lane-id>.toml    # authored development lanes
  workflows/<workflow-id>/    # routing metadata and playbooks
  adapters/<host>/            # native settings and generated projections
  evals/cases/                # shared deterministic routing evidence
  imports/<dependency>/       # pinned resources, licenses and review classification
```

Root `AGENTS.md` remains the required repository entrypoint and explicitly loads
`.agents/instructions.md`. `CLAUDE.md` and host discovery files point to the same
contract. Do not assume a host automatically reads a nested instructions file.
Verify loading and scoped package instructions before moving the root kernel.
Existing policy validators must inspect both the root pointer and canonical body;
a missing target must fail. Preserve package-level instruction precedence.

Native `.codex` and `.claude` entrypoints are relative compatibility links to
`.agents`. Codex skills need no bridge. Claude skill directories resolve to the
canonical procedure or classified invocation adapter. Settings, engineering lane
projections, evals and pinned imports have one physical home under `.agents`.
Validators reject copied discovery, wrong targets and a second authored fleet.
The active `.claude/worktrees/adk-orchestration` remains untouched; this local
worktree is not portable policy and is not removed while another agent uses it.

Product-agent manifests in `consent-protocol/hushh_mcp/agents/` retain their existing
ownership and generators. They are runtime product code, separate from development
subagents. Imported skill bundles keep their licenses, provenance and authority
classification; relocation never activates imported writers or bypass commands.

## Repository and documentation organization

| Home | Responsibility and treatment |
| --- | --- |
| Root | Short product explanation, repository map, working bootstrap and audience links; host/build/policy entrypoints that require root paths |
| `docs/` | Cross-cutting knowledge: current `reference/`, task `guides/`, durable `vision/`, explicit `future/`, active scoped `superpowers/` plans |
| `consent-protocol/`, `hushh-webapp/`, `packages/` | Preserve package boundaries, standalone use and native build layouts; organize internal code at proven domain seams |
| `scripts/`, `deploy/`, `config/`, `contracts/` | Preserve executable ownership; move only after checking callers, build contexts, permissions and generators |
| Other root collections | Classify `archive/`, `artifacts/`, `.planning/`, `.qwen/`, `clawhub/`, `skillsagentic/` and root map generators/assets before retaining, consolidating or deleting |
| Temporary/ignored material | Reconcile owner, source preservation and required evidence; dispose only finished task-owned resources |

Use package → domain → responsibility → leaf structure where justified. A folder
must have an owner and a useful entrypoint; its parent can index a small child set.
No arbitrary depth or line-count target, empty hierarchy, or repository-wide symbol
rewrite. Preserve route, service, authorization, schema and generated contracts.

Make documentation navigable as a wiki through the existing indexes: root README →
docs index → domain index → canonical reference or task guide. Every maintained page
must be reachable from its owning index, and link to its owner and related contracts.
Use descriptive relative links and real heading anchors; repair inbound links in
the same change as a move. Keep compatibility headings only for demonstrated callers.

The root README should answer: what Hussh is; what works and where readiness is
recorded; how the platform fits together; how to start; where Founder/CTO,
contributors, operators and developers go next. Use one clear overview figure and
compact tables where useful. Qualify security and capability claims against source;
link detailed invariants and rollout evidence instead of repeating them.

Classify pages with the existing dispositions: canonical, pointer/index, future-plan,
planning-archive, historical-provenance, merge-then-delete or delete. Merge unique
facts into their owner, update callers, then delete redundant pages. Do not create
another archive to hide cleanup. Age, length and the word “plan” do not establish
obsolescence. Retain unique active decisions and operating guidance.

The skills map now follows executable routing. Seven stale UI migration
snapshots were removed after their useful acceptance criteria and semantic-accent
rules were merged into the existing quality owners. Incomplete statuses and the
contradictory blanket motion limit were not promoted. Other inventory flags remain
review prompts, not deletion decisions; preserve unique operating guidance.

## Execution sequence and exit evidence

| Stage | Bounded work | Exit evidence |
| --- | --- | --- |
| 1. Freeze ownership | Record revisions, peer hashes, all authored sources, imported bundles and inbound callers; coordinate active ADK/PDF/config work | Reviewed source-to-destination/disposition inventory; preserved peer changes |
| 2. Prepare routing | Extend existing scanner, scaffold, linter, delegation router and mirror generator to read `.agents/`; keep one shared resolver and unchanged IDs | Existing routing fixtures agree on owner, reads, commands, risk and lane authority; missing/duplicate definitions fail |
| 3. Relocate atomically | Move skills, workflows, subagents and adapter logic; update CLI, CI selectors, hooks, config, topology inventory and generated mirrors together | Canonical discovery and required legacy entrypoints work; generated output reproducible; no stale executable path |
| 4. Consolidate knowledge | Process documentation by domain; fix maps, fold unique facts into owners, remove reviewed duplicates, repair all links | Every maintained page has a disposition and index path; removed pages have no unresolved callers |
| 5. Refine structure | Move only proven misplaced code/assets; preserve import facades where needed; move generated material through its generator | Imports, package/standalone builds, routes, native resources and affected contracts still hold |
| 6. Review and freeze | Render README/indexes/changed diagrams; review navigation, clarity and geometry; integrate missing main/ADK changes once with authority review | One dependency-complete candidate and current readiness matrix; then required core mirror before an authorized push |

Stages are separate reviewable commits within the existing branch. Move a complete
resource tree, not just `SKILL.md`; reconcile imported relative paths and installed
hook callers without running imported installers. Do not modify another host's
global configuration or terminate peer sessions. Existing sessions may retain old
discovery paths; document the checkpointed refresh boundary and test fresh discovery.

## Verification and completion

- Extend existing core checks for canonical resolution, host loading, stale/orphaned
  projections and old-path refusal. Keep portable skills discoverable without
  pretending they satisfy the governed manifest schema.
- Run skill lint, routing/trigger fixtures, orchestration/fleet checks, mirror
  reproducibility and scoped instruction checks from their relocated owners.
- Use existing doc inventory, links, anchors, placement, brand and diagram checks.
  Render the root README and changed visual owners; inspect mobile and desktop
  layout, code blocks, tables and figures. Structural Mermaid checks alone do not
  prove rendering or visual quality. Reuse the pinned renderer and clean its workers.
- Verify affected imports, generators, native/package paths and standalone protocol
  entrypoints after code moves. Add no parallel CI lane; use existing ownership gates.
  Update changed-path selectors and account for relocated architecture-debt entries
  exactly; neither a move nor a baseline refresh may erase a measured violation.
- Compare semantics before/after relocation: same authorization, delegation,
  verification and release controls. A green link checker alone is insufficient.
- Preserve private-agent acceptance and user-migration requirements in the existing
  readiness memo and release transition. Folder cleanup is not product readiness.
  Its [Shared defaults and UX](./personal-agent/NORMAL-RELEASE-TRANSITION.md#shared-defaults-and-unavailable-state-copy)
  define unavailable actions without blocking supported Shared journeys. Its
  [built-in Browser completion sequence](./personal-agent/NORMAL-RELEASE-TRANSITION.md#5-complete-built-in-browser-independently-on-gcp-and-azure)
  requires separate GCP and Azure execution, responsive control and lifecycle proof;
  both remain unavailable until their own evidence passes.

Completion means one authored development system under `.agents/`, verified host
adapters, no unclassified maintained page or unresolved moved-path caller, a rendered
and reviewed root README, and no lost peer work or abandoned task resources. Record
any justified compatibility adapter explicitly. Keep all work local until the user
authorizes the separate exact-SHA validation and release path.

## Promotion rule

After implementation and verification, update the existing documentation architecture
map, operating contract, contributor entrypoints and owned skills to describe actual
paths. Fold unique remaining guidance into those owners and remove this completed
planning page. Do not present the target tree as current implementation beforehand.
