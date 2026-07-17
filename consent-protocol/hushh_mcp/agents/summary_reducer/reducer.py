"""
PKM Summary Reducer - deterministic privacy-safe summarisation agent.

Three-layer defence-in-depth:
  1. Pre-processing  -- redact high-risk keys before data touches the LLM
  2. Structural validation -- Pydantic schema enforces allowed output shape
  3. Post-processing -- regex sweep destroys any leaked PII in LLM output

The agent can operate in a "dry-run" mode (no LLM call) when `run_llm` is
False, which is the default for unit tests and for callers that only need the
deterministic layers.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Redaction configuration
# ---------------------------------------------------------------------------

_REDACTED = "[REDACTED FOR REDUCER]"

_HIGH_RISK_KEYS: frozenset[str] = frozenset(
    {
        "balance",
        "balances",
        "holdings",
        "holding",
        "portfolio_value",
        "portfolio_values",
        "total_value",
        "net_worth",
        "account_value",
        "ssn",
        "social_security",
        "tax_id",
        "ein",
        "secret",
        "secrets",
        "token",
        "tokens",
        "password",
        "passwords",
        "api_key",
        "api_keys",
        "private_key",
        "private_keys",
        "passphrase",
        "passphrases",
        "credit_card",
        "cvv",
        "account_number",
        "routing_number",
        "risk_profile",
        "decision_history",
        "intent_map",
        "intent_maps",
        "raw_text",
        "personal_text",
        "pii",
    }
)

# Regex patterns that indicate leaked financial/PII data in LLM output
_LEAK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\$[\d,]+(?:\.\d+)?"),  # dollar amounts: $15,000.00
    re.compile(r"\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b"),  # comma-separated numbers
    re.compile(r"\bholdings?\b", re.IGNORECASE),
    re.compile(r"\bbalances?\b", re.IGNORECASE),
    re.compile(r"\bportfolio[_\s]value\b", re.IGNORECASE),
    re.compile(r"\bnet[_\s]worth\b", re.IGNORECASE),
    re.compile(r"\bssn\b", re.IGNORECASE),
    re.compile(r"\brisk[_\s]profile\b", re.IGNORECASE),
    re.compile(r"\bdecision[_\s]history\b", re.IGNORECASE),
    re.compile(r"\bintent[_\s]map\b", re.IGNORECASE),
    re.compile(r"\bpassword\b", re.IGNORECASE),
    re.compile(r"\bprivate[_\s]key\b", re.IGNORECASE),
    re.compile(r"\baccount[_\s]number\b", re.IGNORECASE),
]


# ---------------------------------------------------------------------------
# Output schema
# ---------------------------------------------------------------------------


class SummaryProjection(BaseModel):
    """
    Strictly enforced output schema for PKM summaries.

    Only these four classes are allowed - no free-text fields, no raw values.
    Strict mode is enabled so Pydantic does not silently coerce non-bool values
    into booleans (e.g. int 1 would otherwise become True).
    """

    model_config = ConfigDict(strict=True)

    presence_flags: dict[str, bool] = Field(
        default_factory=dict,
        description="Boolean flags indicating whether a data domain is populated.",
    )
    counts: dict[str, int] = Field(
        default_factory=dict,
        description="Aggregate integer counts (e.g. number of accounts, transactions).",
    )
    freshness_markers: dict[str, str] = Field(
        default_factory=dict,
        description="ISO-8601 timestamps or human-readable freshness labels.",
    )
    sanctioned_capability_flags: dict[str, bool] = Field(
        default_factory=dict,
        description="Flags that signal which Kai features the user's data can support.",
    )

    @field_validator("counts")
    @classmethod
    def counts_must_be_non_negative(cls, v: dict[str, int]) -> dict[str, int]:
        for key, val in v.items():
            if not isinstance(val, int) or val < 0:
                raise ValueError(f"counts[{key!r}] must be a non-negative int, got {val!r}")
        return v

    @field_validator("sanctioned_capability_flags", "presence_flags")
    @classmethod
    def flag_values_must_be_bool(cls, v: dict[str, bool]) -> dict[str, bool]:
        for key, val in v.items():
            if not isinstance(val, bool):
                raise ValueError(f"Flag value for {key!r} must be bool, got {type(val).__name__}")
        return v


# ---------------------------------------------------------------------------
# Deterministic layers
# ---------------------------------------------------------------------------


def _pre_process_data(data: Any, depth: int = 0) -> Any:
    """
    Recursively scrub high-risk keys from a dict before it reaches the LLM.

    Lists are traversed; leaf values for matched keys are replaced with the
    redaction sentinel. Depth is capped at 32 to prevent stack overflow on
    adversarial inputs.
    """
    if depth > 32:
        return _REDACTED

    if isinstance(data, dict):
        result: dict[str, Any] = {}
        for k, v in data.items():
            if k.lower() in _HIGH_RISK_KEYS:
                result[k] = _REDACTED
                logger.debug("summary_reducer.pre_process.redacted key=%s", k)
            else:
                result[k] = _pre_process_data(v, depth + 1)
        return result

    if isinstance(data, list):
        return [_pre_process_data(item, depth + 1) for item in data]

    return data


def _scan_string_for_leaks(value: str) -> list[str]:
    """Return names of patterns that match in *value*.

    Also scans a normalised copy where underscores are replaced by spaces so
    that compound identifiers like ``holdings_available`` are caught by the
    word-boundary patterns (since ``_`` is a ``\\w`` character and does not
    create a ``\\b`` boundary).
    """
    normalised = value.replace("_", " ")
    return [p.pattern for p in _LEAK_PATTERNS if p.search(value) or p.search(normalised)]


def _post_process_summary(summary: dict[str, Any]) -> dict[str, Any]:
    """
    Walk the LLM-produced summary dict and sanitise any leaked data.

    Strategy:
    - String values that match any leak pattern are replaced with the redaction
      sentinel and a warning is logged.
    - Dict keys that match leak patterns cause the entire entry to be dropped.
    - Lists have each element scanned independently.
    """

    def _clean_value(v: Any) -> Any:
        if isinstance(v, str):
            matched = _scan_string_for_leaks(v)
            if matched:
                logger.warning(
                    "summary_reducer.post_process.leak_detected patterns=%s value_snippet=%s",
                    matched,
                    v[:80],
                )
                return _REDACTED
            return v
        if isinstance(v, dict):
            return _clean_dict(v)
        if isinstance(v, list):
            return [_clean_value(item) for item in v]
        return v

    def _clean_dict(d: dict[str, Any]) -> dict[str, Any]:
        cleaned: dict[str, Any] = {}
        for k, v in d.items():
            key_matched = _scan_string_for_leaks(k)
            if key_matched:
                logger.warning(
                    "summary_reducer.post_process.leak_in_key key=%s patterns=%s", k, key_matched
                )
                continue  # drop the key entirely
            cleaned[k] = _clean_value(v)
        return cleaned

    return _clean_dict(summary)


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class SummaryReducerAgent:
    """
    Deterministic privacy-safe PKM summary reducer.

    Usage::

        agent = SummaryReducerAgent()
        projection = agent.reduce(domain="finance", candidate_data={...})
    """

    def reduce(
        self,
        domain: str,
        candidate_data: dict[str, Any],
        *,
        run_llm: bool = True,
    ) -> SummaryProjection:
        """
        Produce a discovery-safe summary projection from raw PKM data.

        Steps:
          1. Pre-process: redact high-risk keys
          2. Build presence/count/freshness from the scrubbed data (deterministic)
          3. Post-process: scan output for leaks and sanitise
          4. Validate with Pydantic before returning

        When run_llm=False the method skips any future LLM integration and
        returns only the deterministic layers (steps 1-2-4).  This is
        suitable for unit tests and for callers that need zero-latency
        sanitisation without a model call.
        """
        logger.info("summary_reducer.reduce domain=%s run_llm=%s", domain, run_llm)

        scrubbed = _pre_process_data(candidate_data)
        raw_projection = self._build_projection(domain, scrubbed)
        clean_projection = _post_process_summary(raw_projection)

        return SummaryProjection(**clean_projection)

    def sanitize_input(self, data: Any) -> Any:
        """Redact high-risk keys recursively without changing the data schema.

        Unlike ``reduce()``, this method preserves the original structure so
        that callers can safely pass the result to both LLM prompts and
        deterministic logic that depends on the shape of the input (e.g. a
        ``memories`` list or ``domains`` array).
        """
        return _pre_process_data(data)

    # ------------------------------------------------------------------
    # Internal: deterministic projection builder
    # ------------------------------------------------------------------

    def _build_projection(self, domain: str, scrubbed: dict[str, Any]) -> dict[str, Any]:
        """
        Build a projection dict from scrubbed data without LLM involvement.

        The heuristics here are intentionally conservative - we surface only
        structural facts (is there data? how many items? when was it updated?).
        """
        presence_flags: dict[str, bool] = {}
        counts: dict[str, int] = {}
        freshness_markers: dict[str, str] = {}
        sanctioned_capability_flags: dict[str, bool] = {}

        # Walk top-level keys of the scrubbed data
        for key, value in scrubbed.items():
            safe_key = re.sub(r"[^a-z0-9_]", "_", key.lower())

            if value is None or value == _REDACTED:
                presence_flags[f"has_{safe_key}"] = False
                continue

            if isinstance(value, list):
                presence_flags[f"has_{safe_key}"] = len(value) > 0
                counts[f"{safe_key}_count"] = len(value)
            elif isinstance(value, dict):
                presence_flags[f"has_{safe_key}"] = bool(value)
                counts[f"{safe_key}_count"] = len(value)
            elif isinstance(value, str):
                presence_flags[f"has_{safe_key}"] = bool(value)
                # Detect ISO timestamps
                if re.match(r"\d{4}-\d{2}-\d{2}", value):
                    freshness_markers[f"{safe_key}_freshness"] = value[:10]
            elif isinstance(value, bool):
                presence_flags[f"has_{safe_key}"] = value
            elif isinstance(value, (int, float)):
                # Never surface the actual number - only whether it exists and is positive
                presence_flags[f"has_{safe_key}"] = value > 0

        # Derive capability flags from what data is present
        has_accounts = presence_flags.get("has_accounts", False)
        has_transactions = presence_flags.get("has_transactions", False)
        has_connected_accounts = presence_flags.get("has_connected_accounts", False)

        sanctioned_capability_flags["can_run_spending_analysis"] = has_transactions and has_accounts
        sanctioned_capability_flags["can_run_portfolio_summary"] = (
            has_accounts or has_connected_accounts
        )
        sanctioned_capability_flags["can_receive_personalized_alerts"] = (
            has_accounts or has_transactions
        )
        sanctioned_capability_flags[f"has_{domain}_domain"] = bool(
            presence_flags or counts or freshness_markers
        )

        return {
            "presence_flags": presence_flags,
            "counts": counts,
            "freshness_markers": freshness_markers,
            "sanctioned_capability_flags": sanctioned_capability_flags,
        }
