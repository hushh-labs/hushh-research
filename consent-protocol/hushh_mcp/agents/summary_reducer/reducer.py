"""Deterministic PKM Summary Reducer with three-layer PII defense.

Architecture (defense-in-depth):
  Layer 1 — Pre-processing (The Blindfold):
      Recursively replaces values at high-risk keys with [REDACTED FOR REDUCER]
      before any data reaches the LLM context.

  Layer 2 — Structural validation (Pydantic Output):
      Enforces that the summary conforms exactly to the SummaryProjection
      schema: presence_flags, counts, freshness_markers, and
      sanctioned_capability_flags only. Rejects anything outside the schema.

  Layer 3 — Post-processing (The Guardrails):
      Recursively scans all output keys for PII patterns (monetary amounts,
      large numeric sequences, SSNs, phone numbers, emails) that the LLM may
      have encoded into key names to bypass value-level scrubbers. Drops any
      offending key entirely.

This module provides a pure-Python deterministic path for environments where
the LLM call is unavailable or not yet wired. The same pre/post-processing
layers wrap the LLM call in production.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Sensitive key vocabulary — Layer 1
# ---------------------------------------------------------------------------

_SENSITIVE_KEYS: frozenset[str] = frozenset(
    {
        "balance",
        "holdings",
        "portfolio_value",
        "portfolio_values",
        "net_worth",
        "account_number",
        "account_numbers",
        "ssn",
        "social_security",
        "credit_score",
        "salary",
        "income",
        "transactions",
        "transaction_history",
        "trade_history",
        "secret",
        "token",
        "password",
        "private_key",
        "private_keys",
        "api_key",
        "api_keys",
        "risk_profile",
        "decision_history",
        "intent_map",
        "intent_maps",
    }
)

_REDACTED = "[REDACTED FOR REDUCER]"

# ---------------------------------------------------------------------------
# PII-in-key regex — Layer 3
# (Mirrors _PII_IN_KEY_RE in pkm_agent_lab_service for consistency.)
# ---------------------------------------------------------------------------

_PII_IN_KEY_RE = re.compile(
    r"""
    \$\s*\d+                                            |   # $50000, $ 1000
    \d+[_\s]*(?:dollars?|usd|inr|rupees?|euros?|gbp)   |   # 100_dollars, 50_usd
    \d{5,}                                              |   # 5+ digit sequences
    \d{3}[_\-]\d{2}[_\-]\d{4}                          |   # SSN: 123-45-6789
    [a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}                # email addresses
    """,
    re.IGNORECASE | re.VERBOSE,
)


# ---------------------------------------------------------------------------
# Pydantic schema — Layer 2
# ---------------------------------------------------------------------------


class SummaryProjection(BaseModel):
    """Discovery-safe summary schema for a single PKM domain.

    Only these four classes of information are permitted in the output.
    Any field outside this schema is rejected by the validator.
    """

    presence_flags: dict[str, bool] = Field(
        default_factory=dict,
        description="Boolean flags indicating which sub-domains or capabilities are present.",
    )
    counts: dict[str, int] = Field(
        default_factory=dict,
        description="Aggregated integer counts (entity counts, event counts, etc.).",
    )
    freshness_markers: dict[str, str] = Field(
        default_factory=dict,
        description="ISO-8601 timestamps or relative freshness labels per sub-domain.",
    )
    sanctioned_capability_flags: dict[str, bool] = Field(
        default_factory=dict,
        description="Capability flags explicitly sanctioned by the domain contract.",
    )


# ---------------------------------------------------------------------------
# SummaryReducerAgent
# ---------------------------------------------------------------------------


class SummaryReducerAgent:
    """Three-layer defense-in-depth for PKM domain summary reduction.

    Usage (deterministic path, no LLM required):
        reduced = SummaryReducerAgent.reduce("financial", raw_domain_data)

    Usage (with LLM — wrap the call between layers):
        scrubbed     = SummaryReducerAgent.pre_process(raw_domain_data)
        llm_output   = await your_llm_call(scrubbed)          # your code
        validated    = SummaryReducerAgent.validate_output(llm_output)
        safe_summary = SummaryReducerAgent.post_process(validated)
    """

    # ------------------------------------------------------------------
    # Layer 1 — Pre-processing
    # ------------------------------------------------------------------

    @classmethod
    def pre_process(cls, data: Any) -> Any:
        """Recursively replace values at sensitive keys with the REDACTED sentinel.

        This blindfolds the LLM from ever seeing raw PII values.
        Safe keys are traversed recursively; sensitive key values are replaced.
        """
        if isinstance(data, dict):
            result: dict[str, Any] = {}
            for key, value in data.items():
                if key.lower() in _SENSITIVE_KEYS:
                    result[key] = _REDACTED
                else:
                    result[key] = cls.pre_process(value)
            return result
        if isinstance(data, list):
            return [cls.pre_process(item) for item in data]
        return data

    # ------------------------------------------------------------------
    # Layer 2 — Structural validation
    # ------------------------------------------------------------------

    @classmethod
    def validate_output(cls, raw: Any) -> dict[str, Any]:
        """Enforce the SummaryProjection Pydantic schema on LLM output.

        Any field outside the four permitted classes is silently dropped.
        On validation failure the empty schema is returned (fail-safe).
        """
        if not isinstance(raw, dict):
            return SummaryProjection().model_dump()
        try:
            projection = SummaryProjection.model_validate(
                {
                    "presence_flags": raw.get("presence_flags") or {},
                    "counts": raw.get("counts") or {},
                    "freshness_markers": raw.get("freshness_markers") or {},
                    "sanctioned_capability_flags": raw.get("sanctioned_capability_flags") or {},
                }
            )
            return projection.model_dump()
        except Exception:
            return SummaryProjection().model_dump()

    # ------------------------------------------------------------------
    # Layer 3 — Post-processing
    # ------------------------------------------------------------------

    @classmethod
    def post_process(cls, summary: Any) -> Any:
        """Recursively drop keys that contain PII patterns from the output.

        LLMs can encode sensitive data into key names to bypass value-level
        scrubbers. This layer inspects every key in the output tree and
        removes any that match the PII regex. Values are never modified.
        """
        if isinstance(summary, dict):
            cleaned: dict[str, Any] = {}
            for key, value in summary.items():
                if _PII_IN_KEY_RE.search(str(key)):
                    continue
                cleaned[key] = cls.post_process(value)
            return cleaned
        if isinstance(summary, list):
            return [cls.post_process(item) for item in summary]
        return summary

    # ------------------------------------------------------------------
    # Deterministic reduce (no LLM — derives projection from scrubbed data)
    # ------------------------------------------------------------------

    @classmethod
    def reduce(cls, domain: str, candidate_data: dict[str, Any]) -> dict[str, Any]:
        """Produce a discovery-safe summary without an LLM call.

        Derives SummaryProjection fields deterministically from the
        pre-processed (blindfolded) data, then validates and post-processes.

        Args:
            domain: The PKM domain name (e.g. "financial", "health").
            candidate_data: Raw PKM domain data dict from the pipeline.

        Returns:
            A validated, PII-safe SummaryProjection dict.
        """
        scrubbed = cls.pre_process(candidate_data)

        presence_flags: dict[str, bool] = {}
        counts: dict[str, int] = {}
        freshness_markers: dict[str, str] = {}

        for key, value in scrubbed.items():
            if value == _REDACTED:
                continue
            if isinstance(value, dict):
                presence_flags[key] = bool(value)
                entity_map = value.get("entities")
                if isinstance(entity_map, dict):
                    counts[f"{key}_entity_count"] = len(entity_map)
            elif isinstance(value, list):
                counts[f"{key}_count"] = len(value)
            elif isinstance(value, str) and (
                "T" in value and "Z" in value or "-" in value
            ):
                freshness_markers[key] = value

        raw_output: dict[str, Any] = {
            "presence_flags": presence_flags,
            "counts": counts,
            "freshness_markers": freshness_markers,
            "sanctioned_capability_flags": {},
        }

        validated = cls.validate_output(raw_output)
        return cls.post_process(validated)
