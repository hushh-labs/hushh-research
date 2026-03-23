# hushh_mcp/operons/kai/llm.py

"""
Kai LLM Operons - Powered by Gemini
Processes financial data through the configured Gemini model for analysis.
"""

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

# Gemini SDK (google-genai only).
try:
    from google import genai  # type: ignore
    from google.genai import types  # type: ignore

    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False
    genai = None  # type: ignore
    types = None  # type: ignore
    logging.warning("⚠️ google-genai SDK not found. Kai LLM operons are unavailable.")

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import (
    GEMINI_MODEL,
    KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
    KAI_LLM_STREAM_INCLUDE_THOUGHTS,
    KAI_LLM_TEMPERATURE,
    KAI_LLM_THINKING_ENABLED,
    KAI_LLM_THINKING_LEVEL,
    KAI_SYNTHESIS_MAX_OUTPUT_TOKENS,
    ConsentScope,
)
from hushh_mcp.types import UserID

logger = logging.getLogger(__name__)

# Configure Gemini Client (Vertex-only path).
# Explicit fail-fast configuration checks avoid silent runtime fallbacks.
_gemini_client = None
_gemini_unavailable_reason: Optional[str] = None
_gemini_model_name = ""
_gemini_use_vertex = True
_gemini_project = ""
_gemini_project_source: Optional[str] = None
_gemini_location = "global"


def _stream_concurrency_limit() -> int:
    raw = (os.getenv("KAI_GEMINI_STREAM_CONCURRENCY") or "2").strip()
    try:
        return max(1, int(raw))
    except Exception:
        return 2


_gemini_stream_semaphore = asyncio.Semaphore(_stream_concurrency_limit())


def _is_retryable_stream_error(error: Exception | str) -> bool:
    message = str(error).lower()
    markers = ("429", "too many requests", "resource_exhausted", "quota", "rate limit")
    return any(marker in message for marker in markers)


def _is_truthy(raw_value: str) -> bool:
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_vertex_mode() -> bool:
    # Vertex-only by default for Kai (legacy non-Vertex path intentionally disabled).
    raw_value = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    return _is_truthy(raw_value)


def _resolve_project_from_credentials_file() -> tuple[str, Optional[str]]:
    credentials_path = (os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    if not credentials_path:
        return "", None

    try:
        payload = json.loads(Path(credentials_path).read_text(encoding="utf-8"))
        project_id = payload.get("project_id")
        if isinstance(project_id, str) and project_id.strip():
            return project_id.strip(), "GOOGLE_APPLICATION_CREDENTIALS.project_id"
    except Exception as creds_err:
        logger.debug("[Kai LLM] Unable to parse GOOGLE_APPLICATION_CREDENTIALS: %s", creds_err)

    return "", None


def _resolve_project_from_gcloud() -> tuple[str, Optional[str]]:
    try:
        result = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except Exception as gcloud_err:
        logger.debug("[Kai LLM] Unable to resolve project via gcloud CLI: %s", gcloud_err)
        return "", None

    if result.returncode != 0:
        return "", None

    project_id = (result.stdout or "").strip()
    if project_id and project_id.lower() != "(unset)":
        return project_id, "gcloud config"
    return "", None


def _resolve_vertex_project() -> tuple[str, Optional[str]]:
    """Resolve Vertex project from env aliases first, then ADC/credentials metadata."""
    env_project_keys = (
        "GOOGLE_CLOUD_PROJECT",
        "GCP_PROJECT",
        "GOOGLE_PROJECT",
        "GCLOUD_PROJECT",
        "VERTEX_PROJECT_ID",
    )
    for key in env_project_keys:
        value = (os.getenv(key) or "").strip()
        if value:
            return value, key

    try:
        import google.auth  # type: ignore

        _, detected_project = google.auth.default()
        if isinstance(detected_project, str) and detected_project.strip():
            return detected_project.strip(), "google.auth.default()"
    except Exception as adc_err:
        logger.debug("[Kai LLM] Unable to resolve project from ADC: %s", adc_err)

    file_project, file_source = _resolve_project_from_credentials_file()
    if file_project:
        return file_project, file_source

    gcloud_project, gcloud_source = _resolve_project_from_gcloud()
    if gcloud_project:
        return gcloud_project, gcloud_source

    return "", None


def _resolve_vertex_location() -> str:
    return (
        os.getenv("GOOGLE_CLOUD_LOCATION")
        or os.getenv("GCP_LOCATION")
        or os.getenv("VERTEX_LOCATION")
        or "global"
    ).strip()


def _initialize_gemini_client(force: bool = False) -> None:
    """Initialize or refresh the shared Gemini Vertex client."""
    global _gemini_client
    global _gemini_unavailable_reason
    global _gemini_model_name
    global _gemini_use_vertex
    global _gemini_project
    global _gemini_project_source
    global _gemini_location

    if _gemini_client is not None and not force:
        return

    _gemini_client = None
    _gemini_unavailable_reason = None
    _gemini_model_name = (os.getenv("GEMINI_MODEL") or GEMINI_MODEL).strip()
    _gemini_use_vertex = _resolve_vertex_mode()
    _gemini_project, _gemini_project_source = _resolve_vertex_project()
    _gemini_location = _resolve_vertex_location()

    if not GEMINI_AVAILABLE:
        _gemini_unavailable_reason = "LLM_SDK_MISSING: install google-genai"
    elif not _gemini_model_name:
        _gemini_unavailable_reason = "LLM_MODEL_MISSING: GEMINI_MODEL is empty"
    elif not _gemini_use_vertex:
        _gemini_unavailable_reason = (
            "LLM_VERTEX_DISABLED: GOOGLE_GENAI_USE_VERTEXAI must be true for Kai operons"
        )
    elif not _gemini_project:
        _gemini_unavailable_reason = (
            "LLM_VERTEX_PROJECT_MISSING: set GOOGLE_CLOUD_PROJECT (or configure ADC/gcloud project)"
        )
    elif not _gemini_location:
        _gemini_unavailable_reason = "LLM_VERTEX_LOCATION_MISSING: set GOOGLE_CLOUD_LOCATION"
    else:
        try:
            # Keep env aligned for downstream libs/components that rely on canonical names.
            os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
            os.environ.setdefault("GOOGLE_CLOUD_PROJECT", _gemini_project)
            os.environ.setdefault("GCP_PROJECT", _gemini_project)
            os.environ.setdefault("GOOGLE_CLOUD_LOCATION", _gemini_location)
            _gemini_client = genai.Client(
                vertexai=True,
                project=_gemini_project,
                location=_gemini_location,
            )
            logger.info(
                "[Kai LLM] Vertex client initialized (project=%s, location=%s, model=%s, source=%s)",
                _gemini_project,
                _gemini_location,
                _gemini_model_name,
                _gemini_project_source or "unknown",
            )
            return
        except Exception as init_err:
            _gemini_unavailable_reason = f"LLM_VERTEX_INIT_FAILED: {init_err}"

    if _gemini_unavailable_reason:
        logger.error("[Kai LLM] %s", _gemini_unavailable_reason)


_initialize_gemini_client()


def _gemini_unavailable_payload(default_message: str) -> Dict[str, Any]:
    message = _gemini_unavailable_reason or default_message
    return {"error": message, "fallback": True, "code": "GEMINI_UNAVAILABLE"}


def _require_gemini_ready() -> bool:
    if _gemini_client is None:
        _initialize_gemini_client()
    return bool(GEMINI_AVAILABLE and _gemini_client and _gemini_model_name)


def is_gemini_ready() -> bool:
    """Public readiness check for Kai agents/routes."""
    return _require_gemini_ready()


def get_gemini_unavailable_reason() -> Optional[str]:
    """Public diagnostic helper for richer error surfaces."""
    if _gemini_client is None and _gemini_unavailable_reason is None:
        _initialize_gemini_client()
    return _gemini_unavailable_reason


async def _generate_content_text(
    *,
    prompt: str,
    timeout_seconds: float,
    max_output_tokens: int,
    response_mime_type: Optional[str] = None,
) -> str:
    if not _require_gemini_ready() or types is None:
        raise RuntimeError(_gemini_unavailable_reason or "Gemini client unavailable")

    config_kwargs: Dict[str, Any] = {
        "temperature": KAI_LLM_TEMPERATURE,
        "max_output_tokens": max_output_tokens,
    }
    if KAI_LLM_THINKING_ENABLED:
        thinking_level = getattr(types.ThinkingLevel, str(KAI_LLM_THINKING_LEVEL).upper(), None)
        if thinking_level is None:
            thinking_level = types.ThinkingLevel.HIGH
        config_kwargs["thinking_config"] = types.ThinkingConfig(
            include_thoughts=False,
            thinking_level=thinking_level,
        )
    if response_mime_type:
        config_kwargs["response_mime_type"] = response_mime_type

    response = await asyncio.wait_for(
        _gemini_client.aio.models.generate_content(
            model=_gemini_model_name,
            contents=prompt,
            config=types.GenerateContentConfig(**config_kwargs),
        ),
        timeout=timeout_seconds,
    )

    return (response.text or "").strip()


def _extract_json(text: str) -> Dict[str, Any]:
    """Robustly extract JSON from a string, handling markdown and noise."""
    text = text.strip()

    # 1. Try standard markdown code block removal
    if text.startswith("```json"):
        text = text[7:]
    if text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]

    text = text.strip()

    # 2. Try identifying the first { and last }
    start = text.find("{")
    end = text.rfind("}")

    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logger.warning(f"[Kai LLM] JSON parse failed on text: {text[:100]}...")
        return {}


async def analyze_stock_with_gemini(
    ticker: str,
    user_id: UserID,
    consent_token: str,
    sec_data: Dict[str, Any],
    market_data: Optional[Dict[str, Any]] = None,
    sentiment_data: Optional[List[Dict[str, Any]]] = None,
    quant_metrics: Optional[Dict[str, Any]] = None,
    user_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Operon: Deep financial analysis using Gemini-2.0-flash.

    Validates: agent.kai.analyze
    Context: All available specialist data (SEC, Market, Sentiment, Quant Trends)
    """
    # 1. Validate Consent
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        logger.error(f"[Gemini Operon] Permission denied: {reason}")
        raise PermissionError(f"Gemini analysis denied: {reason}")

    if not _require_gemini_ready():
        return _gemini_unavailable_payload("Gemini unavailable")

    logger.info(f"[Gemini Operon] Starting deep analyst session for {ticker}")

    # 2. Build Rich Context (Trends + Fundamentals)
    latest_10k = sec_data.get("latest_10k", {})

    # Extract User Context (Personalization) — tolerant to missing keys (backward compatible).
    user_context = user_context or {}

    def _safe_list(val: Any) -> List[Any]:
        return val if isinstance(val, list) else []

    def _safe_dict(val: Any) -> Dict[str, Any]:
        return val if isinstance(val, dict) else {}

    def _tickers_from_holdings(val: Any) -> List[str]:
        out: List[str] = []
        for h in _safe_list(val):
            if isinstance(h, dict):
                t = h.get("ticker") or h.get("symbol")
                if isinstance(t, str) and t.strip():
                    out.append(t.strip().upper())
        return out

    # Strategy
    risk = user_context.get("risk_tolerance") or "Balanced"
    style = _safe_list(user_context.get("investment_style"))
    time_horizon = user_context.get("time_horizon") or "Unknown"
    turnover = user_context.get("portfolio_turnover") or "Unknown"

    # Identity / scale
    firm = user_context.get("firm") or "—"
    title = user_context.get("title") or "—"
    investor_type = user_context.get("investor_type") or "—"
    aum_b = user_context.get("aum_billions")

    # Portfolio footprint
    holdings = user_context.get("top_holdings")
    holdings_tickers = _tickers_from_holdings(holdings)
    sector_exposure = _safe_dict(user_context.get("sector_exposure"))
    recent_buys = _safe_list(user_context.get("recent_buys"))
    recent_sells = _safe_list(user_context.get("recent_sells"))

    # Insider
    is_insider = bool(user_context.get("is_insider"))
    insider_ticker = user_context.get("insider_company_ticker") or "—"

    # Provenance (optional)
    last_13f_date = user_context.get("last_13f_date") or "—"
    last_form4_date = user_context.get("last_form4_date") or "—"

    personalization = f"""
    --- INVESTOR PROFILE (AUDIENCE) ---
    Name: {user_context.get("name", "—")}
    Firm/Title: {firm} / {title}
    Investor Type: {investor_type}
    Risk Tolerance: {risk}
    Time Horizon: {time_horizon}
    Portfolio Turnover: {turnover}
    AUM (B): {aum_b if aum_b is not None else "—"}

    Investment Style: {style if style else "—"}
    Current Holdings (tickers): {holdings_tickers if holdings_tickers else "—"}
    Sector Exposure (if provided): {sector_exposure if sector_exposure else "—"}
    Recent Buys/Sells: {recent_buys if recent_buys else "—"} / {recent_sells if recent_sells else "—"}

    Insider: {is_insider} (company: {insider_ticker})
    Data Freshness (optional): last_13F={last_13f_date}, last_Form4={last_form4_date}

    INSTRUCTION: Tailor your \"Bull Case\" and \"Bear Case\" specifically for this profile.
    - If Conservative: penalize high volatility, leverage, weak FCF conversion; prioritize downside protection.
    - If Aggressive/Growth: allow higher multiples if durability + growth are supported by SEC numbers; prioritize upside capture.
    - If Time Horizon is short: emphasize near-term catalysts + downside risk.
    - If Turnover is low: emphasize moat durability + long-run compounding.
    - Use sector exposure/holdings to avoid redundant bets and highlight concentration risks.
    """

    context = f"""
    --- SENIOR ANALYST TERMINAL ({ticker}) ---
    Company: {sec_data.get("entity_name", ticker)}
    {personalization}
    
    [Current Fundamentals]
    Revenue: ${latest_10k.get("revenue", 0):,}
    Net Income: ${latest_10k.get("net_income", 0):,}
    Operating Income: ${latest_10k.get("operating_income", 0):,}
    Operating Cash Flow: ${latest_10k.get("operating_cash_flow", 0):,}
    Free Cash Flow: ${latest_10k.get("free_cash_flow", 0):,}
    R&D Investment: ${latest_10k.get("research_and_development", 0):,}
    
    [3-Year Quant Trends]
    Revenue Trend: {quant_metrics.get("revenue_trend_data") if quant_metrics else "N/A"}
    Net Income Trend: {quant_metrics.get("net_income_trend_data") if quant_metrics else "N/A"}
    OCF Trend: {quant_metrics.get("ocf_trend_data") if quant_metrics else "N/A"}
    R&D Trend: {quant_metrics.get("rnd_trend_data") if quant_metrics else "N/A"}
    
    [Efficiency Ratios]
    Revenue CAGR (3Y): {quant_metrics.get("revenue_cagr_3y", 0) * 100:.2f}%
    Revenue Growth (YoY): {quant_metrics.get("revenue_growth_yoy", 0) * 100:.2f}%
    Net Income Growth (YoY): {quant_metrics.get("net_income_growth_yoy", 0) * 100:.2f}%
    
    --- MARKET DATA ---
    Current Price: {market_data.get("price", "N/A") if market_data else "N/A"}
    Market Cap: {market_data.get("market_cap", "N/A") if market_data else "N/A"}
    Sector: {market_data.get("sector", "Unknown") if market_data else "Unknown"}
    """

    system_instruction = """
You are a **Senior Quant Analyst** at a Top-Tier Hedge Fund.
Your mission is to perform a high-conviction, data-driven "Earnings Quality & Moat Audit".

### HUSHH CORE PRINCIPLES
- **Explain with Receipts**: Every claim must be backed by the SEC numbers provided.
- **Data Integrity**: If numbers don't add up (e.g., Net Income > OCF), flag it as a quality issue.
- **Institutional Rigor**: No generic advice. Be specific.

### REPORT STRUCTURE (Strict JSON)
- `business_moat`: (String) Depth of the "castle moat". Use Revenue CAGR and R&D trends to justify if the moat is expanding or shrinking.
- `financial_resilience`: (String) Audit the balance sheet. Evaluate the relationship between OCF and Net Income. Is the cash real?
- `growth_efficiency`: (String) Capital allocation audit. Are they getting a good return on their R&D spend? 
- `bull_case`: (String) Upside based on compounding or inflection points.
- `bear_case`: (String) Hard risks (e.g., growth slowing vs high R&D cost).
- `summary`: (String) 1-paragraph institutional summary.
- `confidence`: (Float 0.0-1.0)
- `recommendation`: (String: "buy", "hold", "reduce")

### OPERATIONAL RULES
- Use Billions ($B) for all monetary values.
- Keep language clear for everyday investors while preserving institutional rigor.
- If data is missing (N/A), use your knowledge of the sector to explain what that missing piece usually signifies for a company like this.
- DO NOT use markdown formatting inside the JSON strings.
"""

    # 3. Call Gemini
    try:
        response_text = await _generate_content_text(
            prompt=f"{system_instruction}\n\nCONTEXT DATA:\n{context}",
            timeout_seconds=40.0,
            max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
            response_mime_type="application/json",
        )

        analysis = _extract_json(response_text)
        if not analysis:
            raise ValueError("Failed to parse JSON from Gemini response")

        # Fallback to defaults if keys missing to prevent "N/A"
        analysis.setdefault("bull_case", "Growth potential through market expansion.")
        analysis.setdefault("bear_case", "Risks include competitive pressure and macro headwinds.")

        logger.info(f"[Gemini Operon] Deep Fundamental Report success for {ticker}")
        return analysis

    except asyncio.TimeoutError:
        logger.warning(
            f"[Gemini Operon] Gemini timed out for {ticker}; falling back to deterministic analysis"
        )
        return {"error": "Gemini timeout", "fallback": True}
    except Exception as e:
        logger.error(f"[Gemini Operon] Error calling Gemini: {e}")
        return {"error": str(e), "fallback": True}


async def analyze_sentiment_with_gemini(
    ticker: str,
    user_id: UserID,
    consent_token: str,
    news_articles: List[Dict[str, Any]],
    market_data: Optional[Dict[str, Any]] = None,
    user_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Operon: Sentiment analysis using Gemini-2.0-flash.

    Analyzes news articles and market sentiment for investment signals.
    """
    # 1. Validate Consent
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        logger.error(f"[Gemini Sentiment] Permission denied: {reason}")
        raise PermissionError(f"Sentiment analysis denied: {reason}")

    if not _require_gemini_ready():
        return _gemini_unavailable_payload("Gemini unavailable")

    logger.info(f"[Gemini Sentiment] Analyzing sentiment for {ticker}")

    # 2. Build Context from news articles
    news_context = (
        "\n".join(
            [
                f"- [{a.get('source', {}).get('name', 'Unknown')}] {a.get('title', 'No title')}: {a.get('description', '')[:200]}"
                for a in news_articles[:10]
            ]
        )
        if news_articles
        else "No recent news available."
    )

    user_risk = user_context.get("risk_tolerance", "Balanced") if user_context else "Balanced"

    context = f"""
    --- SENTIMENT ANALYSIS TERMINAL ({ticker}) ---
    
    [Recent News Articles]
    {news_context}

    [Market Snapshot]
    Current Price: {market_data.get("price", "N/A") if market_data else "N/A"}
    Day Change %: {market_data.get("change_percent", market_data.get("change_pct", "N/A")) if market_data else "N/A"}
    Volume: {market_data.get("volume", "N/A") if market_data else "N/A"}
    Market Cap: {market_data.get("market_cap", "N/A") if market_data else "N/A"}
    Sector: {market_data.get("sector", "Unknown") if market_data else "Unknown"}
    
    [Investor Profile]
    Risk Tolerance: {user_risk}
    """

    system_instruction = """
You are a **Market Sentiment Analyst** specializing in news-driven momentum signals.

Analyze the provided news articles and assess market sentiment for this stock.

### REPORT STRUCTURE (Strict JSON)
- `summary`: (String) 1-paragraph summary of current market sentiment
- `sentiment_score`: (Float -1.0 to 1.0) Overall sentiment (-1=very bearish, 0=neutral, 1=very bullish)
- `key_catalysts`: (List[String]) Top 3-5 near-term catalysts or events driving sentiment
- `momentum_signal`: (String) "positive", "neutral", or "negative" momentum
- `confidence`: (Float 0.0-1.0)
- `recommendation`: (String: "bullish", "neutral", "bearish")

### RULES
- Focus on actionable insights, not generic observations
- Weight recent news more heavily
- Identify both positive and negative signals
- Use plain investor language and avoid internal system jargon
- DO NOT use markdown inside JSON strings
"""

    # 3. Call Gemini
    try:
        text = await _generate_content_text(
            prompt=f"{system_instruction}\n\nCONTEXT:\n{context}",
            timeout_seconds=30.0,
            max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
            response_mime_type="application/json",
        )
        if text.startswith("```json"):
            text = text[7:-3].strip()
        elif text.startswith("```"):
            text = text[3:-3].strip()

        analysis = json.loads(text)
        logger.info(f"[Gemini Sentiment] Analysis complete for {ticker}")
        return analysis

    except asyncio.TimeoutError:
        logger.warning(f"[Gemini Sentiment] Timed out for {ticker}")
        return {"error": "Gemini timeout", "fallback": True}
    except Exception as e:
        logger.error(f"[Gemini Sentiment] Error: {e}")
        return {"error": str(e), "fallback": True}


async def analyze_valuation_with_gemini(
    ticker: str,
    user_id: UserID,
    consent_token: str,
    market_data: Dict[str, Any],
    peer_data: Optional[List[Dict[str, Any]]] = None,
    user_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Operon: Valuation analysis using Gemini-2.0-flash.

    Performs relative and intrinsic valuation analysis.
    """
    # 1. Validate Consent
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        logger.error(f"[Gemini Valuation] Permission denied: {reason}")
        raise PermissionError(f"Valuation analysis denied: {reason}")

    if not _require_gemini_ready():
        return _gemini_unavailable_payload("Gemini unavailable")

    logger.info(f"[Gemini Valuation] Analyzing valuation for {ticker}")

    # 2. Build Context
    peer_context = (
        "\n".join(
            [
                f"- {p.get('ticker', 'N/A')}: P/E={p.get('pe_ratio', 'N/A')}, Growth={p.get('growth', 'N/A')}"
                for p in (peer_data or [])[:5]
            ]
        )
        if peer_data
        else "No peer data available."
    )

    user_risk = user_context.get("risk_tolerance", "Balanced") if user_context else "Balanced"

    context = f"""
    --- VALUATION ANALYSIS TERMINAL ({ticker}) ---
    
    [Market Data]
    Current Price: ${market_data.get("price", "N/A")}
    P/E Ratio: {market_data.get("pe_ratio", "N/A")}
    Forward P/E: {market_data.get("forward_pe", "N/A")}
    P/B Ratio: {market_data.get("pb_ratio", "N/A")}
    P/S Ratio: {market_data.get("ps_ratio", "N/A")}
    EV/EBITDA: {market_data.get("ev_ebitda", "N/A")}
    Market Cap: ${market_data.get("market_cap", "N/A")}
    Dividend Yield: {market_data.get("dividend_yield", "N/A")}
    52-Week Range: ${market_data.get("52w_low", "N/A")} - ${market_data.get("52w_high", "N/A")}
    
    [Peer Comparison]
    {peer_context}
    
    [Investor Profile]
    Risk Tolerance: {user_risk}
    """

    system_instruction = """
You are a **Quantitative Valuation Analyst** at an institutional investment firm.

Perform a comprehensive valuation analysis with focus on relative and intrinsic value.

### REPORT STRUCTURE (Strict JSON)
- `summary`: (String) 1-paragraph valuation assessment
- `valuation_verdict`: (String) "undervalued", "fair", or "overvalued"
- `valuation_metrics`: (Dict) Key metrics analyzed with values
- `peer_ranking`: (String) How this stock ranks vs peers
- `price_targets`: (Dict) {"conservative": X, "base_case": Y, "optimistic": Z}
- `upside_downside`: (Dict) {"upside_pct": X, "downside_pct": Y}
- `confidence`: (Float 0.0-1.0)
- `recommendation`: (String: "undervalued", "fair", "overvalued")

### RULES
- Use multiple valuation methods (P/E, EV/EBITDA, DCF if possible)
- Compare to sector averages
- Consider growth rates when evaluating multiples
- Keep wording concise and investor-friendly
- DO NOT use markdown inside JSON strings
"""

    # 3. Call Gemini
    try:
        text = await _generate_content_text(
            prompt=f"{system_instruction}\n\nCONTEXT:\n{context}",
            timeout_seconds=30.0,
            max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
            response_mime_type="application/json",
        )
        if text.startswith("```json"):
            text = text[7:-3].strip()
        elif text.startswith("```"):
            text = text[3:-3].strip()

        analysis = json.loads(text)
        logger.info(f"[Gemini Valuation] Analysis complete for {ticker}")
        return analysis

    except asyncio.TimeoutError:
        logger.warning(f"[Gemini Valuation] Timed out for {ticker}")
        return {"error": "Gemini timeout", "fallback": True}
    except Exception as e:
        logger.error(f"[Gemini Valuation] Error: {e}")
        return {"error": str(e), "fallback": True}


async def synthesize_debate_recommendation_card(
    *,
    ticker: str,
    risk_profile: str,
    user_context: Dict[str, Any],
    renaissance_context: Dict[str, Any],
    fundamental_payload: Dict[str, Any],
    sentiment_payload: Dict[str, Any],
    valuation_payload: Dict[str, Any],
    debate_payload: Dict[str, Any],
    highlights: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Build a rich post-debate synthesis card using Gemini.

    Returns strict JSON fields for frontend decision-card rendering.
    """
    if not _require_gemini_ready():
        return _gemini_unavailable_payload("Gemini synthesis unavailable")

    synthesis_prompt = f"""
You are Kai Chief Investment Strategist.
You are given finalized multi-agent debate artifacts for {ticker}.

Your task: produce a concise, institution-grade synthesis that explicitly fuses:
1) AlphaAgents debate outputs,
2) PKM portfolio/user context,
3) Renaissance screening signals.

Return STRICT JSON with keys:
- thesis: string (1 short paragraph)
- key_drivers: string[] (3-6 bullets, specific and evidence-backed)
- key_risks: string[] (3-6 bullets, concrete downside risks)
- action_plan: string[] (3-5 practical next actions for this user)
- watchlist_triggers: string[] (3-6 measurable triggers users should monitor)
- horizon_fit: string (how this fits user's horizon/style/risk)

Constraints:
- No markdown.
- No generic filler.
- Use investor-friendly language suitable for portfolio owners.
- Must mention Renaissance tier/screening signal explicitly.
- Must include at least one concrete user-context personalization (holdings/risk/horizon/style).
- Must include at least one portfolio impact statement (concentration, diversification, drawdown, or risk tradeoff).
- If Renaissance signal conflicts with debate recommendation, state the conflict and risk-control framing.
- Keep each bullet <= 140 chars.

INPUT:
risk_profile={risk_profile}
user_context={json.dumps(user_context, default=str)[:7000]}
renaissance_context={json.dumps(renaissance_context, default=str)[:4000]}
fundamental={json.dumps(fundamental_payload, default=str)[:5000]}
sentiment={json.dumps(sentiment_payload, default=str)[:4000]}
valuation={json.dumps(valuation_payload, default=str)[:4000]}
debate={json.dumps(debate_payload, default=str)[:4000]}
highlights={json.dumps(highlights[:24], default=str)[:4000]}
"""

    try:
        text = await _generate_content_text(
            prompt=synthesis_prompt,
            timeout_seconds=25.0,
            max_output_tokens=KAI_SYNTHESIS_MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
        )
        parsed = _extract_json(text)
        if not parsed:
            raise ValueError("Empty synthesis JSON")
        return parsed
    except Exception as err:
        logger.warning("[Kai LLM] Debate synthesis failed for %s: %s", ticker, err)
        return {
            "error": f"LLM_SYNTHESIS_FAILED: {err}",
            "fallback": True,
        }


# ============================================================================
# STREAMING GENERATORS - Real-time Token Streaming
# ============================================================================


async def stream_gemini_response(
    prompt: str,
    agent_name: str = "gemini",
    timeout: float = 60.0,
) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Generic streaming generator for Gemini responses.

    Yields events:
    - {"type": "token", "text": "..."} for each token chunk
    - {"type": "complete", "text": "full response"} when done
    - {"type": "error", "message": "..."} on error

    Uses Gemini 3 Flash with synchronous streaming wrapped in async context.
    This is more reliable than async iteration which may not yield correctly.
    """
    if not _require_gemini_ready():
        logger.error("[Gemini Streaming] No client configured!")
        yield {
            "type": "error",
            "message": _gemini_unavailable_reason or "Gemini client not configured",
        }
        return

    logger.info(f"[Gemini Streaming] Starting stream for {agent_name}")

    # Use ASYNC streaming to prevent blocking the event loop.
    if types is None:
        yield {
            "type": "error",
            "message": "Gemini streaming unavailable (google.genai.types missing)",
        }
        return

    config_kwargs: Dict[str, Any] = {
        "temperature": KAI_LLM_TEMPERATURE,
        "max_output_tokens": KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
    }
    if KAI_LLM_THINKING_ENABLED:
        thinking_level = getattr(types.ThinkingLevel, str(KAI_LLM_THINKING_LEVEL).upper(), None)
        if thinking_level is None:
            thinking_level = types.ThinkingLevel.HIGH
        config_kwargs["thinking_config"] = types.ThinkingConfig(
            include_thoughts=bool(KAI_LLM_STREAM_INCLUDE_THOUGHTS),
            thinking_level=thinking_level,
        )
    config = types.GenerateContentConfig(**config_kwargs)

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            async with _gemini_stream_semaphore:
                stream = await _gemini_client.aio.models.generate_content_stream(
                    model=_gemini_model_name,
                    contents=prompt,
                    config=config,
                )

                full_text = ""
                token_count = 0

                async for chunk in stream:
                    try:
                        emitted = False
                        if hasattr(chunk, "candidates") and chunk.candidates:
                            for candidate in chunk.candidates:
                                content = getattr(candidate, "content", None)
                                parts = getattr(content, "parts", None) or []
                                for part in parts:
                                    text_value = getattr(part, "text", None)
                                    if not text_value:
                                        continue
                                    is_thought = bool(getattr(part, "thought", False))
                                    token_count += 1
                                    full_text += str(text_value)
                                    emitted = True
                                    if token_count % 10 == 0:
                                        logger.info(
                                            "[Gemini Streaming] Token #%s for %s",
                                            token_count,
                                            agent_name,
                                        )
                                    yield {
                                        "type": "token",
                                        "text": str(text_value),
                                        "agent": agent_name,
                                        "token_source": "thought" if is_thought else "response",
                                    }

                        if not emitted:
                            chunk_text = chunk.text if hasattr(chunk, "text") else ""
                            if chunk_text:
                                token_count += 1
                                full_text += str(chunk_text)
                                if token_count % 10 == 0:
                                    logger.info(
                                        "[Gemini Streaming] Token #%s for %s",
                                        token_count,
                                        agent_name,
                                    )
                                yield {
                                    "type": "token",
                                    "text": str(chunk_text),
                                    "agent": agent_name,
                                    "token_source": "response",
                                }
                    except Exception as e:
                        logger.warning(f"[Gemini Streaming] Skipped chunk for {agent_name}: {e}")
                        continue

            yield {
                "type": "complete",
                "text": full_text,
                "agent": agent_name,
            }
            logger.info(f"[Gemini Streaming] Complete for {agent_name}, {token_count} tokens")
            return
        except Exception as e:
            retryable = _is_retryable_stream_error(e)
            if retryable and attempt < max_attempts:
                delay_seconds = min(6.0, 2.0**attempt)
                logger.warning(
                    "[Gemini Streaming] Retryable error for %s (attempt %s/%s): %s. Retrying in %.1fs",
                    agent_name,
                    attempt,
                    max_attempts,
                    e,
                    delay_seconds,
                )
                await asyncio.sleep(delay_seconds)
                continue

            logger.error(f"[Gemini Streaming] Error for {agent_name}: {e}", exc_info=True)
            yield {
                "type": "error",
                "message": str(e),
                "agent": agent_name,
            }
            return


async def analyze_fundamental_streaming(
    ticker: str,
    user_id: UserID,
    consent_token: str,
    sec_data: Dict[str, Any],
    market_data: Optional[Dict[str, Any]] = None,
    quant_metrics: Optional[Dict[str, Any]] = None,
    user_context: Optional[Dict[str, Any]] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Streaming version of fundamental analysis.
    Yields tokens in real-time as Gemini generates them.
    """
    # 1. Validate Consent
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        yield {"type": "error", "message": f"Permission denied: {reason}"}
        return

    if not _require_gemini_ready():
        yield {"type": "error", "message": _gemini_unavailable_reason or "Gemini unavailable"}
        return

    logger.info(f"[Fundamental Streaming] Starting for {ticker}")

    # Build context (same as non-streaming version)
    latest_10k = sec_data.get("latest_10k", {})
    user_context = user_context or {}

    risk = user_context.get("risk_tolerance") or "Balanced"

    context = f"""
    --- SENIOR ANALYST TERMINAL ({ticker}) ---
    Company: {sec_data.get("entity_name", ticker)}
    Risk Profile: {risk}
    
    [Current Fundamentals]
    Revenue: ${latest_10k.get("revenue", 0):,}
    Net Income: ${latest_10k.get("net_income", 0):,}
    Operating Cash Flow: ${latest_10k.get("operating_cash_flow", 0):,}
    Free Cash Flow: ${latest_10k.get("free_cash_flow", 0):,}
    
    [3-Year Quant Trends]
    Revenue Trend: {quant_metrics.get("revenue_trend_data") if quant_metrics else "N/A"}
    
    --- MARKET DATA ---
    Current Price: {market_data.get("price", "N/A") if market_data else "N/A"}
    Market Cap: {market_data.get("market_cap", "N/A") if market_data else "N/A"}
    """

    system_instruction = """
You are a Senior Quant Analyst performing a deep fundamental analysis.

Provide your analysis in a conversational, thinking-out-loud style.
Walk through your reasoning step by step.

Cover:
1. Business moat assessment
2. Financial health audit  
3. Growth efficiency review
4. Bull case and bear case
5. Final recommendation (buy/hold/reduce) with confidence

Be specific and cite the numbers provided.
"""

    prompt = f"{system_instruction}\n\nCONTEXT DATA:\n{context}"

    # Stream the response
    async for event in stream_gemini_response(prompt, agent_name="fundamental"):
        yield event
