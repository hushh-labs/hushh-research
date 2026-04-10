# Repo Context Index Contract

Use the repo context index as a progressive-disclosure router, workflow engine, and coverage map, not as a giant inventory dump.

## Load order

1. `summary`
2. one `section <name>`
3. use compact output by default and escalate to `--verbose` only when needed
4. the canonical docs or paths listed by that section
5. the recommended owner skill
6. the narrower spoke skill if needed
7. the matching workflow pack and impact bundle when the task is recurring

## Summary fields

`summary` must expose:

1. `owners`
2. `spokes_by_owner`
3. `surface_coverage`
4. `uncovered_surfaces`
5. `owners` and `spokes_by_owner` built from `skill.json`

## Sections

### `section docs`

Returns:

1. docs homes
2. root and domain indexes
3. owner/spoke routing for documentation work

### `section frontend`

Returns:

1. route families
2. API proxy groups
3. UI-layer ownership surfaces
4. service-layer surfaces
5. frontend and mobile owner entrypoints

### `section backend`

Returns:

1. route modules grouped by domain
2. backend services, agents, tools, and operons
3. backend docs and package surfaces
4. backend and security owner entrypoints

Default mode should return grouped modules with counts.
`--verbose` may expand to full file-level route lists.

### `section skills`

Returns:

1. owner skills first
2. spokes grouped by owner
3. per-skill routing metadata and owned repo surfaces
4. full surface coverage and uncovered surfaces

Default mode should stay compact and routing-first.
`--verbose` may expand to full per-skill metadata.

### `section commands`

Returns:

1. repo-level command surfaces
2. package-level command surfaces
3. verification commands grouped by subsystem

## Workflow commands

The router must also support:

1. `list-workflows`
2. `route-task <workflow-id>`
3. `impact <workflow-id> [--path <repo-path>]...`
4. `onboard`
5. `audit`

These commands must use `.codex/workflows/*/workflow.json` plus the per-skill `skill.json` manifests.

## Validation goal

`validate` should prove the index can still route the repo cleanly:

1. required entrypoints exist
2. owner skills exist
3. meaningful repo surfaces are covered by owner skills
4. workflow packs exist
5. section dependencies resolve on disk

## Output modes

The scanner must support:

1. stable JSON for tooling
2. concise `--text` output for low-token human/Codex routing
3. compact default payloads for heavy sections, with `--verbose` available when deeper inspection is required

## Advisory audit

`audit` is advisory only. It should report:

1. coverage score
2. routing integrity score
3. verification integrity score
4. onboarding readiness score
5. findings grouped by severity
