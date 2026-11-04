# Run the website locally

Last checked against checkout `d884959b5b` on 2026-11-03. The launchers use your
current branch and local edits. `Personal_Tasks/` is ignored by Git; these are
personal shortcuts around the repository commands.

## Development: frontend and backend with reload

Open terminals in the repository root:

```bash
cd /Users/akshatkumar/Desktop/Hushh/hushh-research
source "$HOME/.nvm/nvm.sh"
nvm use 24
```

Repeat this shell setup in each terminal. Node 24 is recommended; the frontend
requires at least Node 22.12. Python 3.13+, uv, npm, jq and Google Cloud tooling
are needed for the full local setup. Install Node 24 with `nvm install 24` if it
is not installed.

Set up localhost HTTPS once (macOS may ask you to approve certificate trust):

```bash
./Personal_Tasks/setup-local-https.sh --trust
```

Google's configured JavaScript origin is **https://localhost:3000**. The scheme,
host and port must match exactly; opening HTTP produces `origin_mismatch`.
The helper renews missing or expired certificates in the ignored
`hushh-webapp/certificates/` directory. After a renewal, run it with `--trust`
again. Certificates and keys must remain uncommitted.

For first-time setup, or to refresh dependencies/profiles after a branch update:

```bash
./bin/hushh bootstrap --mode local
```

Start the three components in order, keeping each terminal open for its logs:

```bash
# Terminal 1: Cloud SQL proxy
./bin/hushh proxy --mode local
```

```bash
# Terminal 2: Python backend, reloads when Python files change
APP_FRONTEND_ORIGIN=https://localhost:3000 ./bin/hushh backend --mode local --reload
```

```bash
# Terminal 3: frontend development server with hot reload
NEXT_PUBLIC_APP_URL=https://localhost:3000 ./bin/hushh web --mode local -- --experimental-https \
  --experimental-https-key ./certificates/localhost-key.pem \
  --experimental-https-cert ./certificates/localhost.pem
```

An existing proxy can be reused; if terminal 1 reports an existing listener,
leave that listener running and continue with terminals 2 and 3. Wait for the
backend's startup-complete message before using the app.

- Website: https://localhost:3000
- Backend health: http://localhost:8000/health
- API reference: http://localhost:8000/docs

Press Ctrl-C in the frontend and backend terminals to stop them. Stop a proxy
you started after the backend has shut down. Preserve a proxy used by another
session. Run only one local stack on these ports at a time.

## One terminal: optimized build without reload

For a fast app experience after compilation, rather than editing with hot reload:

```bash
./Personal_Tasks/run-main-local.sh
```

The shortcut selects a supported installed Node via nvm when needed, checks
dependencies and the local profile, builds the current frontend into the isolated
`.next-local-fast` directory, then delegates proxy/backend/frontend supervision
to `scripts/runtime/run_local_fast.sh`. The build uses a 4 GB Node heap and
finishes before backend workers start. Keep this terminal open; Ctrl-C stops
the stack's owned processes while preserving a reused proxy.

HTTPS is enabled automatically: port 3000 terminates TLS and forwards to the
standalone frontend on `127.0.0.1:3001`. The launcher supervises both processes
and stops them together. Keep both frontend ports free before starting. The
backend remains on loopback HTTP; frontend API calls use the same HTTPS origin.
Both commands set the app origin to HTTPS, including the backend's origin
allowlist and generated callbacks. The personal launcher applies those
overrides automatically; the canonical profile files may still describe the
default HTTP development origin.

This personal launcher allows up to eight async and eight SQL database
connections, with no SQL overflow. This bounds concurrent authentication and
bootstrap work without the two-connection SQL queue observed during login.
The canonical contributor commands retain their smaller defaults. The shared
UAT instance had 80 connections against a 1,000-connection limit when this
personal setting was checked; inspect capacity before raising it further.

This shortcut accepts feature branches and uncommitted edits. It does not fetch
main, reinstall dependencies, migrate a database, or deploy. Rerun it after
source edits to build fresh output. Stop the development servers before using
this mode, and stop this mode before returning to development.

Check dependencies and configuration without starting servers or changing the
active profile:

```bash
./Personal_Tasks/run-main-local.sh --check
```

The check runs the canonical doctor, including a remote model-authorization
probe. `activation_required` means the local source profile is valid but a
different frontend profile is active. Normal startup activates local mode;
you can also do that explicitly:

```bash
./bin/hushh env use --mode local
./bin/hushh doctor --mode local
```

## External services and setup problems

Local mode runs the frontend and backend on your laptop, using UAT-backed cloud
resources. It still requires network access to the database, authentication,
model providers, and connected services. Private-agent features additionally
need an admitted private runtime. One Email's inbound KYC automation needs its
Pub/Sub/webhook configuration; ordinary chat availability does not prove that
separate integration is configured.

If the doctor reports expired managed Vertex ADC, refresh it interactively:

```bash
gcloud auth application-default login
./bin/hushh doctor --mode local
```

If environment hydration reports an expired Google Cloud CLI login, refresh
that separately with `gcloud auth login`, then rerun bootstrap. CLI login and
application-default credentials are separate. Do not paste credentials into
these scripts or skip readiness checks to work around an error.

If a port is occupied, inspect it and stop the owning app terminal:

```bash
lsof -nP -iTCP:3000 -iTCP:3001 -iTCP:8000 -iTCP:6543 -sTCP:LISTEN
```

## Frontend against deployed UAT

For frontend-only work with the deployed UAT backend:

```bash
NEXT_PUBLIC_APP_URL=https://localhost:3000 ./bin/hushh web --mode uat -- --experimental-https \
  --experimental-https-key ./certificates/localhost-key.pem \
  --experimental-https-cert ./certificates/localhost.pem
```

This mode uses the same frontend port, so stop the other frontend first. Return
with the HTTPS local frontend command above when testing local backend changes.

Canonical setup reference: [Getting Started](../docs/guides/getting-started.md).

Use the HTTPS website URL above after startup; an old HTTP browser tab will
not switch protocols automatically. The launcher check also validates the
localhost certificate. The One Email KYC webhook settings above are separate
from login readiness.

Verified on 2026-11-03: optimized build and four launcher regression tests passed;
trusted HTTPS login and backend health returned 200. Google accepted the HTTPS
origin. This account then hit the backend's existing account-deletion marker;
changing the server protocol does not restore a deleted account.

The broader governance run remains failing on production-emergency/restoration
fixtures and an unrecognized `scripts/runtime/run_local_fast.sh` owner path.
