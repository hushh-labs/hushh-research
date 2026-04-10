# Repo-Local Skill Contract

This is the canonical contract for the Codex operating system under `.codex/skills/` and `.codex/workflows/`.

## Machine-readable source of truth

Every repo-local skill must have:

1. `SKILL.md`: thin human procedure layer
2. `skill.json`: machine-readable routing and impact-analysis layer

Every workflow pack must have:

1. `.codex/workflows/<workflow-id>/workflow.json`
2. `.codex/workflows/<workflow-id>/PLAYBOOK.md`

`skill.json` and `workflow.json` are the canonical machine-readable source of truth.

## Required sections

Every `SKILL.md` must contain these sections exactly once and in this order:

1. `## Purpose and Trigger`
2. `## Coverage and Ownership`
3. `## Do Use`
4. `## Do Not Use`
5. `## Read First`
6. `## Workflow`
7. `## Handoff Rules`
8. `## Required Checks`

## Purpose and Trigger rules

Every repo-local skill must declare:

- `Primary scope: \`...\``
- `Trigger on ...`
- `Avoid overlap with ...`

The primary scope must be unique across the local skill fleet.

## Coverage and Ownership rules

Every repo-local skill must declare:

- `Role: \`owner\`` or `Role: \`spoke\``
- `Owner family: \`...\``
- `Owned repo surfaces:` with explicit repo paths in backticks
- `Non-owned surfaces:` with explicit repo paths or sibling owner domains in backticks

Owner-skill rules:

1. The skill folder name must match `Owner family`.
2. Owner skills are the default entrypoint for broad requests in that domain.
3. Every meaningful repo surface must map to at least one owner skill.

Spoke-skill rules:

1. `Owner family` must point at an existing owner skill.
2. Spokes reject broad intake and route broad requests back to their owner.
3. Spokes own narrower contracts, paths, or workflows inside the owner family.

## Skill manifest rules

Every `skill.json` must define:

1. `id`
2. `role`
3. `owner_family`
4. `primary_scope`
5. `description`
6. `owned_paths`
7. `non_owned_paths`
8. `task_types`
9. `required_reads`
10. `required_commands`
11. `verification_bundles`
12. `handoff_targets`
13. `adjacent_skills`
14. `risk_tags`

Parity rules:

1. `description`, `primary_scope`, `role`, `owner_family`, `owned_paths`, and `required_reads` must stay aligned with `SKILL.md`.
2. `task_types` must map to actual workflow packs.
3. `verification_bundles` must be present and non-empty.

## Workflow-pack rules

Every `workflow.json` must define:

1. `id`
2. `title`
3. `goal`
4. `owner_skill`
5. `default_spoke`
6. `task_type`
7. `affected_surfaces`
8. `required_reads`
9. `required_commands`
10. `verification_bundle`
11. `deliverables`
12. `impact_fields`
13. `handoff_chain`
14. `common_failures`

Workflow-routing rules:

1. Routing is deterministic by workflow id, not natural-language guessing.
2. `owner_skill` must be an owner skill.
3. `default_spoke` may be null, but when present it must resolve to a spoke skill.
4. `task_type` must equal workflow id for deterministic routing.

## Authoring rules

1. Keep `SKILL.md` thin and procedural.
2. Put bulky details into `references/` only when they are actually needed.
3. Add `scripts/` only when deterministic logic would otherwise be rewritten repeatedly.
4. Be explicit about what the skill does not own.
5. Hand off to owner or sibling skills instead of absorbing adjacent workflows.
6. Do not create a new skill when tightening an existing owner or spoke is enough.

## Coverage baseline

The local validator treats these as meaningful maintained surfaces:

1. `README.md`
2. `bin`
3. `scripts`
4. `config`
5. `deploy`
6. `docs`
7. `hushh-webapp/app`
8. `hushh-webapp/components`
9. `hushh-webapp/lib`
10. `hushh-webapp/__tests__`
11. `hushh-webapp/scripts`
12. `hushh-webapp/docs`
13. `hushh-webapp/ios`
14. `hushh-webapp/android`
15. `consent-protocol/api`
16. `consent-protocol/hushh_mcp`
17. `consent-protocol/tests`
18. `consent-protocol/docs`
19. `consent-protocol/scripts`
20. `packages/hushh-mcp`
21. `data`
22. `.codex/skills`

## Validation rules

The local lint tool checks for:

1. required sections
2. required skill manifest keys
3. required workflow-pack keys
4. unique primary scope
5. declared role and owner family
6. owner/spoke consistency
7. explicit handoff guidance
8. missing referenced docs, scripts, or owned repo surfaces
9. broad trigger language inside spokes
10. orphaned meaningful repo surfaces
11. workflow-pack owner/default-skill consistency
12. workflow-pack routing, verification, and handoff completeness
