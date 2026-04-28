# Agent Development

> The community contribution bible. Everything you need to build, test, and ship a new Hussh agent or operon.


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Founder-language mapping:

- `TrustLink / A2A delegation` means delegated authority must inherit the same consent boundary this doc enforces
- `Capability Tokens` remain explicit here because agent entry points, tools, and operons validate concrete token scopes
- `Separation of Duties` is implemented through the DNA model: agents orchestrate, tools expose callable surfaces, operons hold business logic, and services touch persistence

---

## The DNA Model

Hussh agents are built from four composable layers. Each layer has a single responsibility and strict dependency rules.

```
┌─────────────────────────────────────────────────────┐
│ AGENT                                                │
│ Orchestrates tools, owns a manifest, enforces        │
│ consent at entry via HushhAgent.run()                │
├─────────────────────────────────────────────────────┤
│ TOOLS                                                │
│ LLM-callable functions decorated with @hushh_tool    │
│ Consent re-validated per invocation                  │
├─────────────────────────────────────────────────────┤
│ OPERONS                                              │
│ Business logic functions. PURE (math, no side        │
│ effects) or IMPURE (network/LLM, but stateless)     │
│ Never import services directly                       │
├─────────────────────────────────────────────────────┤
│ SERVICES                                             │
│ The only layer that touches the database             │
│ (PersonalKnowledgeModelService, ConsentDBService, etc.)          │
└─────────────────────────────────────────────────────┘
```

### Dependency Rules

| Layer    | Can Import       | Cannot Import    |
| -------- | ---------------- | ---------------- |
| Agent    | Tools, ADK core  | Services, DB     |
| Tool     | Operons          | Services, DB     |
| Operon   | Other operons    | Services, DB     |
| Service  | DatabaseClient   | Agents, Tools    |

**Exception**: Impure operons (fetchers, LLM, storage) may use consent validation and external APIs, but never import service classes directly.

---

## Consent Validation -- Three Layers

Consent is validated at multiple points during execution. This is belt-and-suspenders by design.

### Layer 1: Agent Entry

`HushhAgent.run()` validates the consent token against the agent's `required_scopes` before any tool executes.

```python
# hushh_mcp/hushh_adk/core.py
class HushhAgent(LlmAgent):
    def run(self, prompt, user_id, consent_token, vault_keys=None):
        # 1. Validate token against required_scopes
        for scope in self.required_scopes:
            valid, reason, _ = validate_token(consent_token, expected_scope=scope)
            if valid:
                break
        if not valid:
            raise PermissionError(f"Agent Access Denied: {reason}")

        # 2. Inject context for tools
        with HushhContext(user_id=user_id, consent_token=consent_token):
            return super().run(input=prompt)
```

### Layer 2: Tool Invocation

The `@hushh_tool` decorator re-validates consent with the tool's specific scope before the function body runs.

```python
# hushh_mcp/hushh_adk/tools.py
@hushh_tool(scope="agent.kai.analyze")
async def perform_fundamental_analysis(ticker: str) -> Dict:
    ctx = HushhContext.current()  # Access injected context
    # ... tool logic (consent already validated by decorator)
```

The decorator:
1. Checks that `HushhContext` exists (security violation if not)
2. Validates token scope matches the tool's required scope
3. Verifies `token.user_id == context.user_id` (anti-spoofing)

### Layer 3: Operon-Level (Impure Only)

Impure operons (fetchers, analysis, LLM, storage) validate consent inline as their first operation. Pure calculators skip this.

```python
# hushh_mcp/operons/kai/analysis.py
def analyze_fundamentals(ticker, user_id, sec_filings, consent_token):
    # Consent validation as first line
    valid, reason, _ = validate_token(consent_token, "agent.kai.analyze")
    if not valid:
        raise PermissionError(f"Consent denied: {reason}")
    # ... business logic
```

### HushhContext Propagation

Context flows via Python's `contextvars` module -- thread-safe, zero argument passing.

```python
# Set by HushhAgent.run():
with HushhContext(user_id="abc", consent_token="HCT:..."):
    # Available everywhere in this execution scope:
    ctx = HushhContext.current()
    ctx.user_id          # "abc"
    ctx.consent_token    # "HCT:..."
    ctx.vault_keys       # {} (optional)
```

---

## The Operon Catalog

### calculators.py -- Pure Math (10 functions)

No consent needed. No side effects. Pure input-to-output.

| Function                           | Description                            |
| ---------------------------------- | -------------------------------------- |
| `calculate_financial_ratios`       | P/E, ROE, debt ratio from SEC filings  |
| `calculate_quant_metrics`          | FCF margin, R&D intensity, cash ratio  |
| `assess_fundamental_health`        | Composite health score (0-100)         |
| `calculate_sentiment_score`        | Weighted news sentiment (-1 to +1)     |
| `extract_catalysts_from_news`      | Extract key catalysts from articles    |
| `calculate_valuation_metrics`      | P/E, P/B, EV/EBITDA from market data  |
| `calculate_annualized_return`      | Annualized return from price series    |
| `calculate_annualized_volatility`  | Annualized vol from price series       |
| `calculate_sharpe_ratio`           | Risk-adjusted return                   |
| `calculate_return_and_risk_metrics`| Combined return, vol, Sharpe, max DD   |

### fetchers.py -- External Data (5 functions, IMPURE)

Each requires consent validation. No DB access.

| Function              | Source                | Description                   |
| --------------------- | --------------------- | ----------------------------- |
| `fetch_sec_filings`   | SEC EDGAR (free)      | 10-K/10-Q financial data      |
| `fetch_market_news`   | Finnhub -> PMP/FMP -> NewsAPI -> Google News RSS | Recent financial news |
| `fetch_market_data`   | Finnhub -> PMP/FMP -> yfinance -> Yahoo quote     | Price, volume, fundamentals |
| `fetch_peer_data`     | Finnhub peers -> Yahoo Finance                          | Peer company comparisons |
| `_fetch_yahoo_quote_fast` | Yahoo v7 API                                       | Fast quote fallback |

### analysis.py -- Analysis Orchestrators (3 public + helpers, IMPURE)

| Function                 | Description                              |
| ------------------------ | ---------------------------------------- |
| `analyze_fundamentals`   | Full fundamental analysis from SEC data  |
| `analyze_sentiment`      | Full sentiment analysis from news        |
| `analyze_valuation`      | Full valuation analysis from market data |

### llm.py -- Gemini Integration (5 functions, IMPURE)

| Function                          | Description                         |
| --------------------------------- | ----------------------------------- |
| `analyze_stock_with_gemini`       | Full stock analysis via Gemini      |
| `analyze_sentiment_with_gemini`   | Sentiment analysis via Gemini       |
| `analyze_valuation_with_gemini`   | Valuation analysis via Gemini       |
| `stream_gemini_response`          | Token-by-token streaming            |
| `analyze_fundamental_streaming`   | Streaming fundamental analysis      |

### storage.py -- Vault Operations (3 functions, IMPURE)

| Function                     | Description                         |
| ---------------------------- | ----------------------------------- |
| `store_decision_card`        | Encrypt and store decision          |
| `retrieve_decision_card`     | Decrypt and retrieve single card    |
| `retrieve_decision_history`  | Decrypt and list all user decisions |

---

## How to Build a New Operon (5 min)

### Step 1: Choose the Right Module

- **Pure math** with no side effects → `calculators.py`
- **External API call** → `fetchers.py`
- **LLM invocation** → `llm.py`
- **New module** for a new domain → create `hushh_mcp/operons/{domain}/{module}.py`

### Step 2: Write the Function

Example: Bollinger Band calculator (pure operon)

```python
# hushh_mcp/operons/kai/calculators.py

def calculate_bollinger_bands(
    prices: List[float],
    window: int = 20,
    num_std: float = 2.0,
) -> Dict[str, List[float]]:
    """
    Calculate Bollinger Bands from a price series.

    Args:
        prices: Historical closing prices (oldest first)
        window: Moving average window (default 20)
        num_std: Standard deviation multiplier (default 2.0)

    Returns:
        Dict with keys: upper, middle, lower (each a list of floats)
    """
    if len(prices) < window:
        return {"upper": [], "middle": [], "lower": []}

    middle = []
    upper = []
    lower = []

    for i in range(window - 1, len(prices)):
        w = prices[i - window + 1 : i + 1]
        avg = sum(w) / window
        std = (sum((x - avg) ** 2 for x in w) / window) ** 0.5
        middle.append(avg)
        upper.append(avg + num_std * std)
        lower.append(avg - num_std * std)

    return {"upper": upper, "middle": middle, "lower": lower}
```

### Step 3: If Impure, Add Consent Validation

```python
def fetch_earnings_calendar(
    ticker: str,
    user_id: UserID,
    consent_token: str,
) -> Dict[str, Any]:
    """Fetch upcoming earnings dates."""
    valid, reason, _ = validate_token(consent_token, "agent.kai.analyze")
    if not valid:
        raise PermissionError(f"Consent denied: {reason}")

    # ... external API call
```

### Step 4: Write a Test

```python
# tests/test_calculators.py
def test_bollinger_bands():
    prices = [float(i) for i in range(1, 31)]
    result = calculate_bollinger_bands(prices, window=10)
    assert len(result["middle"]) == 21
    assert result["upper"][0] > result["middle"][0]
    assert result["lower"][0] < result["middle"][0]
```

### Step 5: Import in Agent Tool (If Needed)

```python
# hushh_mcp/agents/kai/tools.py
from hushh_mcp.operons.kai.calculators import calculate_bollinger_bands
```

---

## How to Build a New Agent (30 min)

### Step 1: Create Directory

```bash
mkdir -p hushh_mcp/agents/my_agent
touch hushh_mcp/agents/my_agent/__init__.py
```

### Step 2: Write the Manifest (agent.yaml)

```yaml
# hushh_mcp/agents/my_agent/agent.yaml
id: agent_my_domain
name: MyDomain Agent
version: "1.0.0"
description: Analyzes user data for the my_domain domain.
model: gemini-3-flash-preview
system_instruction: |
  You are a Hussh agent specializing in [domain].
  Always respect user consent and privacy.
  Provide structured, actionable insights.
required_scopes:
  - attr.my_domain.*
tools:
  - name: analyze_domain_data
    description: Analyze user's domain data
    py_func: hushh_mcp.agents.my_agent.tools.analyze_domain_data
    required_scope: attr.my_domain.*
inputs:
  - name: query
    type: string
outputs:
  - name: analysis
    type: object
ui_type: chat
```

### Semantic Contract Requirement

For any agent that classifies user meaning or shapes PKM structure:

- the manifest-backed agent is the semantic owner
- outputs must use an exact JSON contract
- deterministic code may validate and reject, but must not replace the agent as the semantic classifier
- the feature must document its validator rules and live-eval phase

Reference:

- `./pkm-agent-north-star.md`
- `./pkm-prompt-contract.md`
- `./backend-semantic-boundary.md`

### Step 3: Subclass HushhAgent

```python
# hushh_mcp/agents/my_agent/agent.py
import os
from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from .tools import analyze_domain_data

class MyDomainAgent(HushhAgent):
    def __init__(self):
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            tools=[analyze_domain_data],
            system_prompt=self.manifest.system_instruction,
            required_scopes=self.manifest.required_scopes,
        )
```

### Step 4: Define Tools

```python
# hushh_mcp/agents/my_agent/tools.py
from hushh_mcp.hushh_adk.tools import hushh_tool
from hushh_mcp.hushh_adk.context import HushhContext

@hushh_tool(scope="attr.my_domain.*", name="analyze_domain_data")
async def analyze_domain_data(query: str) -> dict:
    """Analyze domain data based on user query."""
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context")

    # Call operons (never services)
    return {"result": "analysis complete", "user_id": ctx.user_id}
```

### Step 5: Create API Routes

```python
# api/routes/my_agent/__init__.py
from fastapi import APIRouter
router = APIRouter(prefix="/api/my-agent", tags=["my-agent"])

# api/routes/my_agent/chat.py
@router.post("/chat")
async def chat(request: Request):
    # ... validate consent, call agent
```

### Step 6: Register in server.py

```python
# server.py (add 2 lines)
from api.routes.my_agent import router as my_agent_router
app.include_router(my_agent_router)
```

### Step 7: Optionally Add to Orchestrator

```python
# hushh_mcp/agents/orchestrator/tools.py
@hushh_tool(scope="vault.owner", name="delegate_to_my_agent")
async def delegate_to_my_agent(query: str) -> dict:
    """Delegate to MyDomain agent."""
    # ... forward to MyDomainAgent
```

---

## Existing Agents

| Agent               | Directory                    | Scopes                          | Tools                            |
| ------------------- | ---------------------------- | ------------------------------- | -------------------------------- |
| OrchestratorAgent   | `agents/orchestrator/`       | `vault.owner`                   | `delegate_to_kai`                |
| KaiAgent            | `agents/kai/`                | `attr.financial.*`              | `perform_fundamental_analysis`, `perform_sentiment_analysis`, `perform_valuation_analysis` |
| PortfolioImportAgent| (inline in `kai/portfolio.py`)| `vault.owner`                  | File parsing + LLM fallback      |

---

## Manifest Schema

Full YAML schema based on the `AgentManifest` Pydantic model:

```yaml
id: string                    # Unique agent identifier
name: string                  # Human-readable name
version: string               # Semver (default "1.0.0")
description: string           # What this agent does
model: string                 # LLM model identifier
system_instruction: string    # System prompt
required_scopes: string[]     # Scopes needed to start agent
tools:
  - name: string              # Tool name
    description: string       # What the tool does
    py_func: string           # Python import path
    required_scope: string    # Scope for this specific tool
inputs:
  - name: string              # Input parameter name
    type: string              # Type (string, object, etc.)
outputs:
  - name: string              # Output field name
    type: string              # Type
ui_type: string               # "chat" | "form" | "dashboard"
icon: string                  # Optional UI icon
```

---

## A2A Communication

Agent-to-agent communication uses the `KaiA2AServer` pattern:

- Consent tokens are passed in HTTP headers
- Agent cards describe capabilities (manifest-based)
- Delegation uses `@hushh_tool` wrappers

See the Kai agent for the reference implementation.

### ADK/A2A Compliance Verification

Run static contract checks before release:

```bash
python scripts/verify_adk_a2a_compliance.py
```

The verifier checks:
- `X-Consent-Token` enforcement in A2A entry points.
- Token validation using `ConsentScope.VAULT_OWNER`.
- Google A2A compatibility flag and route wiring.
- Required agent -> operon data-source calls for fundamental/sentiment/valuation paths.

---

## Requirements

| Tool         | Version   | Purpose              |
| ------------ | --------- | -------------------- |
| Python       | 3.13+     | Runtime              |
| ruff         | latest    | Linting              |
| mypy         | latest    | Type checking        |
| pytest       | latest    | Testing              |

**All database access must go through the service layer.** Never import `DatabaseClient` or `consent_db` directly from an agent, tool, or operon.

---

## See Also

- [Kai Agents](./kai-agents.md) -- Reference implementation
- [Personal Knowledge Model](./personal-knowledge-model.md) -- Encrypted data architecture
- [Consent Protocol](./consent-protocol.md) -- Token lifecycle and validation
- [Environment Variables](./env-vars.md) -- Backend configuration reference
