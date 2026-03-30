# Environment Model


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This repo supports exactly three contributor runtime profiles:

- `local-uatdb`
- `uat-remote`
- `prod-remote`

Anything outside that list is legacy or unsupported for normal onboarding.

## Profile Matrix

| Profile | Frontend | Backend | Environment identity | Typical use |
| --- | --- | --- | --- | --- |
| `local-uatdb` | local | local | `development` | full-stack development |
| `uat-remote` | local | deployed UAT | `uat` | reproduce UAT behavior from a local frontend |
| `prod-remote` | local | deployed production | `production` | validate production behavior safely |

## Active Files

The supported local files are:

- `consent-protocol/.env.local-uatdb.local.example`
- `consent-protocol/.env.uat-remote.local.example`
- `consent-protocol/.env.prod-remote.local.example`
- `hushh-webapp/.env.local-uatdb.local.example`
- `hushh-webapp/.env.uat-remote.local.example`
- `hushh-webapp/.env.prod-remote.local.example`

The active runtime files remain:

- `consent-protocol/.env`
- `hushh-webapp/.env.local`

Activate a profile with:

```bash
bash scripts/env/use_profile.sh local-uatdb
```

or just use the higher-level commands:

```bash
make dev PROFILE=local-uatdb
make web PROFILE=uat-remote
make backend PROFILE=local-uatdb
```

## Identity Keys

Every profile must keep these keys aligned:

- backend: `ENVIRONMENT=development|uat|production`
- frontend: `NEXT_PUBLIC_APP_ENV=development|uat|production`
- both: `APP_RUNTIME_PROFILE=<profile>`

`make doctor PROFILE=<profile>` is the quickest way to verify that alignment.

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
- Never use the old `*.dev.local`, `*.uat.local`, or `*.prod.local` files as onboarding truth

## Related Commands

```bash
make bootstrap
make doctor PROFILE=local-uatdb
make doctor PROFILE=uat-remote
make doctor PROFILE=prod-remote
```

## Deeper Reference

- [Environment Variables and Secrets Reference](../reference/operations/env-and-secrets.md)
