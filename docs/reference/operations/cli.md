# Root CLI

The `hushh` root CLI is the only supported repo-level command surface.

## Visual Context

Canonical visual owner: [Operations Index](./README.md). Use that map for the full operations surface; this page is the command contract for repo-level work.

Use package-local commands only when you are working inside a package on purpose:

- `hushh-webapp/` uses npm
- `packages/hushh-mcp/` uses npm
- `consent-protocol/` has its own local shell wrapper for standalone backend work

## Core Commands

```bash
<repo-root>/bin/hushh bootstrap
<repo-root>/bin/hushh doctor --mode uat
<repo-root>/bin/hushh codex onboard
<repo-root>/bin/hushh codex route-task repo-orientation
<repo-root>/bin/hushh codex impact repo-orientation
<repo-root>/bin/hushh web --mode uat
<repo-root>/bin/hushh stack --mode local
<repo-root>/bin/hushh backend
<repo-root>/bin/hushh native ios --mode local --fresh
<repo-root>/bin/hushh lint
<repo-root>/bin/hushh test
<repo-root>/bin/hushh ci
<repo-root>/bin/hushh docs verify
```

## Operational Commands

```bash
<repo-root>/bin/hushh codex scan summary
<repo-root>/bin/hushh codex scan section skills
<repo-root>/bin/hushh codex list-workflows
<repo-root>/bin/hushh codex audit
<repo-root>/bin/hushh env bootstrap
<repo-root>/bin/hushh env use --mode prod
<repo-root>/bin/hushh db init-iam
<repo-root>/bin/hushh db verify-iam-schema
<repo-root>/bin/hushh protocol sync
<repo-root>/bin/hushh protocol push
<repo-root>/bin/hushh protocol setup
<repo-root>/bin/hushh sync check-main
<repo-root>/bin/hushh sync main
```

## Notes

- Do not document root `npm run ...` commands.
- Do not document `make`.
- Keep helper output and runbooks aligned with this CLI.
- Contributor and agent onboarding should start with `./bin/hushh codex onboard`, not direct internal script paths.
