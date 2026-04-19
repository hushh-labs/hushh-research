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
<repo-root>/bin/hushh codex ci-status --watch
<repo-root>/bin/hushh web
<repo-root>/bin/hushh web --mode uat
<repo-root>/bin/hushh stack --mode local
<repo-root>/bin/hushh terminal backend --mode local --reload
<repo-root>/bin/hushh terminal web --mode local
<repo-root>/bin/hushh terminal web --mode uat
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
<repo-root>/bin/hushh codex ci-status
<repo-root>/bin/hushh codex audit
<repo-root>/bin/hushh codex rca --surface runtime
<repo-root>/bin/hushh codex rca --surface uat
<repo-root>/bin/hushh env bootstrap
<repo-root>/bin/hushh env use --mode prod
<repo-root>/bin/hushh db init-iam
<repo-root>/bin/hushh db verify-iam-schema
<repo-root>/bin/hushh db verify-release-contract
<repo-root>/bin/hushh db verify-uat-schema
<repo-root>/bin/hushh db report-prod-posture
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
- `./bin/hushh web` defaults to `local`; use `--mode uat` or `--mode prod` only when you explicitly want a hosted backend target.
- Use `./bin/hushh terminal backend --mode local --reload` and `./bin/hushh terminal web --mode <mode>` as the preferred visible-terminal dev flow.
- Use `./bin/hushh terminal stack --mode local` only when you explicitly want one combined terminal window to own both processes.
- Use `uv` as the canonical Python install surface for `consent-protocol`; `requirements*.txt` are generated compatibility artifacts, not contributor commands.
- Treat `./bin/hushh db verify-release-contract`, `./bin/hushh db verify-uat-schema`, and `./bin/hushh db report-prod-posture` as the authoritative DB governance surface.
- Use `./bin/hushh codex rca --surface runtime|uat|ci` as the canonical machine-readable RCA surface for core runtime, CI, and UAT release failures.
