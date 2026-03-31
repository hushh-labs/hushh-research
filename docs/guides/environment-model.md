# Environment Model


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This repo supports exactly three contributor runtime modes:

- `local`
- `uat`
- `prod`

Anything outside that list is legacy or unsupported for normal onboarding.

Those supported backend and frontend profile files now share one canonical key shape. The files are allowed to differ by value, but not by “which keys exist,” except for legacy unsupported env variants outside this three-profile model.

## Profile Matrix

| Profile | Frontend | Backend | Environment identity | Typical use |
| --- | --- | --- | --- | --- |
| `local` | local | local | `development` | full-stack development with UAT-backed DB/resources |
| `uat` | local | deployed UAT | `uat` | reproduce UAT behavior from a local frontend |
| `prod` | local | deployed production | `production` | validate production behavior safely |

## Active Files

The supported local files are:

- `consent-protocol/.env.example`
- `hushh-webapp/.env.local.local.example`
- `hushh-webapp/.env.uat.local.example`
- `hushh-webapp/.env.prod.local.example`

The active runtime files remain:

- `consent-protocol/.env`
- `hushh-webapp/.env.local`

Activate a profile with:

```bash
bash scripts/env/use_profile.sh local
```

or use the public command surface:

```bash
npm run web -- --mode=uat
npm run native:ios -- --mode=uat
npm run native:android -- --mode=uat
```

The local backend path still exists for deeper development work, but it is not the first-run path:

```bash
npm run backend
```

## Identity Keys

Every profile must keep these keys aligned:

- backend: `ENVIRONMENT=development|uat|production`
- frontend: `NEXT_PUBLIC_APP_ENV=development|uat|production`
- both: `APP_RUNTIME_PROFILE=<profile>`

`npm run doctor -- --mode=<mode>` is the quickest way to verify that alignment.

## Runtime Resolution Rules

- Local development may default to `http://127.0.0.1:8000` only when the selected environment is `development`
- Hosted Next.js route handlers must receive an explicit runtime backend origin
- UAT frontend runtime must talk only to the UAT backend
- Production frontend runtime must talk only to the production backend
- Hosted runtimes must fail fast if the backend origin is missing instead of guessing

## Contributor Rules

- Never create a fourth profile for convenience
- Never teach a new contributor to hand-wire `.env.local` manually
- Never rely on `DATABASE_URL`; this repo uses the `DB_*` contract
- Never use the old `*remote*` or `local-uatdb` runtime names as onboarding truth
- Never introduce a second public bootstrap path when the profile model can handle the need

## Related Commands

```bash
npm run bootstrap
npm run doctor -- --mode=local
npm run doctor -- --mode=uat
npm run doctor -- --mode=prod
python3 scripts/ops/verify-runtime-profile-env-shape.py --include-runtime
```

## Deeper Reference

- [Environment Variables and Secrets Reference](../reference/operations/env-and-secrets.md)
