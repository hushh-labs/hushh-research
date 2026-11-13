# Contributing to Consent Protocol

Thank you for your interest in contributing to the Hussh Consent Protocol. This document explains how to contribute code, agents, operons, and documentation.

---

## Prerequisites

- Python 3.13+
- `uv`
- Dependencies installed: `uv sync --frozen --group dev`

---

## Development Workflow

### 1. Choose the Right Contribution Surface

If you are working inside the `hushh-research` monorepo, use the root contributor path:

```bash
cd ..
./bin/hushh bootstrap
./bin/hushh terminal backend --mode local --reload
```

If you are working on the standalone upstream backend:

### 2. Fork and Clone

```bash
git clone https://github.com/<your-username>/consent-protocol.git
cd consent-protocol
uv sync --frozen --group dev
```

### 3. Create a Branch

```bash
git checkout -b feat/my-new-operon
```

### 4. Make Your Changes

Follow the architecture and coding standards below.

### 5. Run All Checks

Every PR must pass these before merge:

```bash
./bin/consent-protocol ci  # Runs all checks (lint, format, typecheck, test, security)
```

Or run individually:

```bash
./bin/consent-protocol lint          # Lint
./bin/consent-protocol format-check  # Format check
./bin/consent-protocol typecheck     # Type check
./bin/consent-protocol test          # Tests
./bin/consent-protocol security      # Security scan
```

### 6. Open a Pull Request

- Target: `main`
- Fill out the PR template (tests, ruff, mypy, consent validation, docs)
- One approval required
- Every commit must include `Signed-off-by` (`git commit -s`)

---

## Coding Standards

### Python

- **Formatter**: ruff format (double quotes, 100 char line length)
- **Linter**: ruff check (E, F, B, I, S rules)
- **Type checker**: mypy (gradual adoption; new code should be typed)
- **Security**: bandit scans `hushh_mcp/` and `api/`

### Architecture Rules

1. **API routes never access the database directly.** All DB operations go through service classes in `hushh_mcp/services/`.
2. **Agents never call services directly.** The stack is: Agent > Tool > Operon > Service.
3. **Consent is validated at every layer.** Use `HushhAgent` for agents, `@hushh_tool` for tools.
4. **No `sessionStorage` or `localStorage` patterns.** The backend is stateless; state management is the frontend's concern.
5. **Canonical PKM semantics must be agent-derived.** If a backend feature interprets user meaning, it must declare the owning agent, prompt contract, validator rules, and required live-eval phase. See `docs/reference/pkm-agent-north-star.md`.

---

## Adding a New Operon

Operons are the business logic building blocks. See [docs/reference/agent-development.md](docs/reference/agent-development.md) for the full guide.

Quick steps:

1. Choose the right module in `hushh_mcp/operons/kai/`:
   - `calculators.py` -- pure math, no side effects
   - `fetchers.py` -- external API calls (SEC, yfinance, news)
   - `analysis.py` -- orchestration of calculators + fetchers
   - `llm.py` -- Gemini LLM integration
   - `storage.py` -- encrypted vault operations
2. Add your function with full type annotations
3. Add tests in `tests/`
4. Update the operon catalog in `docs/reference/agent-development.md`

### Operon Purity Rules

| Type | Side Effects | DB Access | Example |
| ---- | ------------ | --------- | ------- |
| **PURE** | None | No | `calculators.py` -- math, ratios |
| **IMPURE** | Yes | Via service | `fetchers.py` -- API calls, DB reads |

Pure operons are preferred. Impure operons must validate consent if they access user data.

---

## Adding a New Agent

1. Create a directory: `hushh_mcp/agents/<agent_name>/`
2. Create `agent.py` extending `HushhAgent`:

```python
from hushh_mcp.hushh_adk.core import HushhAgent

class MyAgent(HushhAgent):
    REQUIRED_SCOPES = ["attr.domain.*"]
    
    async def run(self, context, request):
        self._validate_consent(context)  # Mandatory
        # Agent logic here
```

3. Create `agent.yaml` manifest:

```yaml
name: my-agent
version: "1.0.0"
description: "What this agent does"
required_scopes:
  - attr.domain.*
tools:
  - name: my_tool
    function: hushh_mcp.agents.my_agent.tools.my_tool
```

4. Create `tools.py` with `@hushh_tool` decorated functions
5. Wire tools to operons (never directly to services)
6. Add tests
7. Register in `hushh_mcp/agents/__init__.py`

### Semantic Feature Declaration

If the feature classifies or restructures user meaning, the PR must declare:

- owning agent
- manifest path
- structured output contract
- deterministic validator rules
- live-eval phase required before promotion

Reference docs:

- `docs/reference/pkm-agent-north-star.md`
- `docs/reference/pkm-prompt-contract.md`
- `docs/reference/backend-semantic-boundary.md`

---

## Adding API Routes

1. Create or extend a router in `api/routes/`
2. Use service classes for all DB operations
3. Add the route to `server.py` router registration
4. Update `docs/reference/consent-protocol.md` if it involves consent
5. Update route documentation in `docs/`

---

## Documentation

- All documentation lives in `docs/` within this repository
- Every new agent or operon must be documented
- Use relative paths for all internal links

## Migration Authority

Treat only these as release authority:

- `db/migrations/`
- `db/release_migration_manifest.json`

Do not treat legacy/bootstrap SQL or one-off repair scripts as the normal migration lane for contributor work.

---

## PR Checklist

Before submitting, verify:

- [ ] `./bin/consent-protocol ci` passes (or run checks individually)
- [ ] Consent validation is present at agent entry AND tool invocation
- [ ] Tests cover the new code
- [ ] Documentation is updated
- [ ] Commits are signed off (`git log --format=%B -n 1`)

---

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Questions?

Open an issue or check [docs/README.md](docs/README.md) for the full documentation index.
