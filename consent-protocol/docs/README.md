# consent-protocol

> Python FastAPI backend for the Hushh Consent Protocol, MCP server, and agent infrastructure.


## Visual Map

```mermaid
flowchart TD
  root["consent-protocol"]
  n1["App Review Mode Config"]
  root --> n1
  n2["Manifesto"]
  root --> n2
  n3["Mcp Setup"]
  root --> n3
  n4["Monorepo Integration"]
  root --> n4
```

---

## What This Directory Contains

```
consent-protocol/
├── server.py                  # FastAPI app entry point
├── consent_db.py              # DatabaseClient singleton
├── requirements.txt           # Python dependencies
├── Dockerfile                 # Cloud Run container
├── .env.example               # Environment template
├── api/
│   ├── middlewares/            # Rate limiting, auth helpers
│   └── routes/                # All API endpoint routers
│       ├── consent.py         # Consent token management
│       ├── developer.py       # Versioned developer API (/api/v1)
│       ├── pkm.py             # Personal Knowledge Model CRUD
│       ├── notifications.py   # FCM push tokens
│       ├── kai/               # Kai financial agent routes
│       └── ...
├── hushh_mcp/
│   ├── hushh_adk/             # HushhAgent, @hushh_tool, HushhContext
│   ├── agents/                # Agent implementations (orchestrator, kai)
│   ├── operons/               # Business logic (calculators, fetchers, LLM)
│   ├── services/              # Database access layer
│   ├── consent/               # Token validation, scope helpers
│   └── config.py              # Environment config loader
├── mcp_modules/               # MCP server tools and resources
├── db/migrations/             # SQL migration files
└── docs/                      # Backend-specific documentation
    ├── README.md              # This file (entry point)
    ├── manifesto.md           # Hushh philosophy (timeless)
    ├── mcp-setup.md           # MCP technical companion
    └── reference/
        ├── agent-development.md   # DNA model, operons, contribution guide
        ├── developer-api.md       # Published developer API contract
        ├── personal-knowledge-model.md # PKM architecture, BYOK
        ├── kai-agents.md          # 3-agent debate system
        ├── consent-protocol.md    # Token model and security
        └── fcm-notifications.md   # FCM push architecture
```

---

## Quick Start

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your Supabase, Gemini, and Firebase credentials

# Run server
python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Health check: `curl http://localhost:8000/health`

---

## Documentation

| Goal | Document |
| ---- | -------- |
| Build a new agent or operon | [reference/agent-development.md](./reference/agent-development.md) |
| Publish against the developer API / MCP | [reference/developer-api.md](./reference/developer-api.md) |
| Understand data encryption and storage | [reference/personal-knowledge-model.md](./reference/personal-knowledge-model.md) |
| Learn the 3-agent debate system | [reference/kai-agents.md](./reference/kai-agents.md) |
| Understand the consent token model | [reference/consent-protocol.md](./reference/consent-protocol.md) |
| FCM push notification architecture | [reference/fcm-notifications.md](./reference/fcm-notifications.md) |
| Understand MCP runtime and contributor-local setup | [mcp-setup.md](./mcp-setup.md) |
| Integrate into a host monorepo (subtree) | [monorepo-integration.md](./monorepo-integration.md) |
| Read the Hushh philosophy | [manifesto.md](./manifesto.md) |

---

## Key Concepts

### Service Layer

All database access goes through service classes. API routes never import `DatabaseClient` directly.

```
API Route → Service (validates consent) → DatabaseClient → PostgreSQL
```

The backend follows a layered architecture: FastAPI routes delegate to service classes which handle consent validation and database operations. Agents follow the DNA model (Agent > Tools > Operons > Services), ensuring consent is checked at every layer.

See: [Agent Development](./reference/agent-development.md)

### Agent Architecture

Agents follow the DNA model: Agent > Tools > Operons > Services.

See: [Agent Development](./reference/agent-development.md)

### Consent Protocol

All data access requires a consent token. No bypasses.

See: [Consent Protocol](./reference/consent-protocol.md)

---

## Linting and Testing

```bash
ruff check .                    # Linting
mypy .                          # Type checking
pytest                          # Tests
```

---

## Deployment

Deploys to Google Cloud Run via GitHub Actions or manual:

```bash
gcloud run deploy consent-protocol \
  --source . \
  --region us-east1 \
  --port 8000 \
  --allow-unauthenticated
```

See [env-vars.md](./reference/env-vars.md) for required environment variables and secrets.
