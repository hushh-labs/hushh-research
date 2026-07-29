"""
PKM Summary Reducer Agent — deterministic Python guardrail layer.

Addresses: GitHub issue #430, #586

Problem
-------
The YAML-only agent relied entirely on LLM negative constraints ("Never
include: holdings, portfolio values...").  LLMs are structural learners:
when instructed not to emit sensitive *values*, they sometimes encode the
same information into *property names* instead.

Example of the attack vector (issue #586):
  {"presence_flags": {"account_$50000": true}}
  {"sanctioned_capability_flags": ["view_$1000"]}

Standard value-scrubbing passes do not inspect dictionary keys, so the
leak was invisible to existing guards.

Defense-in-depth architecture (three layers)
-------------------------------------------
1. Pre-processing — The Blindfold
   _pre_process_data() recursively replaces high-risk key values with the
   placeholder "[REDACTED FOR REDUCER]" *before* any data reaches the LLM.
   The LLM never sees raw sensitive numbers.

2. Structural validation — Pydantic output contract
   SummaryProjection enforces that LLM output must conform to exactly four
   allowed output classes.  Unexpected top-level keys cause validation
   failure rather than silent pass-through.

3. Post-processing — The Guardrails
   _post_process_summary() runs on the materialized SummaryProjection.
   It inspects every key inside the four allowed output classes and deletes
   any key that matches a monetary-amount pattern or a banned semantic word.
   This catches hallucinations where the LLM encodes PII into key names.

   Two key-safety functions serve different callers:
   - _key_is_unsafe(): broad rules for LLM output (all banned substrings).
   - _service_key_is_unsafe(): narrow rules for service summaries (currency
     patterns + has_-prefix banned substrings only).  Legitimate aggregate
     metrics such as holdings_count are preserved at the service layer.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Keys whose *values* are scrubbed from raw PKM data before LLM sees it.
_SENSITIVE_KEY_SUBSTRINGS: tuple[str, ...] = (
    "balance",
    "holdings",
    "portfolio",
    "ssn",
    "secret",
    "token",
    "password",
    "credit",
    "debit",
    "account_number",
    "routing",
    "tax_id",
    "risk_profile",
    "intent",
    "decision",
)

# Pattern that detects monetary amounts embedded in key names.
# Matches: $50000, 100_dollars, 1000usd, 50k, etc.
_CURRENCY_IN_KEY_PATTERN = re.compile(
    r"""
    (?:
        \$\d+                        # $50000
      | \d+_?dollars?                # 100_dollars, 50dollars
      | \d+_?usd                     # 1000usd
      | \d+_?[kKmMbB]\b             # 50k, 1M, 2B
      | \d{3,}                       # bare run of 3+ digits (e.g. 50000)
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)

# Key substrings that must never appear in LLM output keys.
_BANNED_KEY_SUBSTRINGS: tuple[str, ...] = (
    "balance",
    "holding",
    "portfolio",
    "value",
    "amount",
    "revenue",
    "profit",
    "loss",
    "gain",
    "asset",
    "liability",
    "net_worth",
    "ssn",
    "secret",
)

_REDACTED_PLACEHOLDER = "[REDACTED FOR REDUCER]"


# ---------------------------------------------------------------------------
# Layer 2 — Structural output contract
# ---------------------------------------------------------------------------


class SummaryProjection(BaseModel):
    """
    Strictly typed output schema for the PKM Summary Reducer.

    Only four output classes are permitted.  Any data that does not fit
    one of these classes must not appear in the summary.
    """

    presence_flags: dict[str, bool] = Field(default_factory=dict)
    counts: dict[str, int] = Field(default_factory=dict)
    freshness_markers: dict[str, str] = Field(default_factory=dict)
    sanctioned_capability_flags: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Layer 1 — Pre-processing (the blindfold)
# ---------------------------------------------------------------------------


def _pre_process_data(data: Any, depth: int = 0) -> Any:  # noqa: ANN401
    """
    Recursively scrub sensitive values from PKM data before LLM ingestion.

    Replaces the *values* of high-risk keys with _REDACTED_PLACEHOLDER so
    the LLM can describe presence/absence without seeing raw numbers.

    Args:
        data: Arbitrary PKM data (dict, list, or scalar).
        depth: Current recursion depth; capped at 10 to prevent DoS on
               deeply nested structures.

    Returns:
        A sanitised copy with sensitive values replaced.
    """
    if depth > 10:
        return _REDACTED_PLACEHOLDER

    if isinstance(data, dict):
        result: dict[str, Any] = {}
        for key, value in data.items():
            key_lower = str(key).lower()
            if any(sensitive in key_lower for sensitive in _SENSITIVE_KEY_SUBSTRINGS):
                result[key] = _REDACTED_PLACEHOLDER
            else:
                result[key] = _pre_process_data(value, depth + 1)
        return result

    if isinstance(data, list):
        return [_pre_process_data(item, depth + 1) for item in data]

    return data


# ---------------------------------------------------------------------------
# Layer 3 — Post-processing (the guardrails)
# ---------------------------------------------------------------------------


def _key_is_unsafe(key: str) -> bool:
    """
    Return True if *key* leaks a monetary amount or encodes a banned semantic
    term — used on raw LLM output (SummaryProjection fields) where the model
    may hallucinate financial values directly into key names (issue #586).

    Checks:
    1. Currency/numeric pattern in any key (catches "$50000", "100_dollars").
    2. Any banned semantic substring in the key name.
       LLM-generated keys like "holdings_count", "balance_updated_at" are
       structurally unsafe because the LLM chose those names to smuggle PII.
    """
    key_lower = key.lower()
    if _CURRENCY_IN_KEY_PATTERN.search(key_lower):
        return True
    if any(banned in key_lower for banned in _BANNED_KEY_SUBSTRINGS):
        return True
    return False


def _service_key_is_unsafe(key: str) -> bool:
    """
    Narrower variant used only by scrub_dict_keys() on service-layer summaries.

    Service summaries contain legitimate aggregate metrics such as
    ``holdings_count`` and ``balance_count`` that must reach the DB.
    Only two classes of keys are rejected here:

    1. Currency/numeric patterns (e.g. "has_$50000_portfolio").
    2. Boolean-flag keys that contain a banned semantic substring.

       The canonical attach point
       (``PersonalKnowledgeModelService._normalize_domain_summary``) admits a
       boolean into the persisted summary when its name is ``has_``-prefixed OR
       ``_enabled``-suffixed OR ``_available``-suffixed. The issue #586 attack
       vector — a poisoned boolean flag that smuggles a raw financial term into
       its key name — therefore applies to all three admitted shapes, not just
       ``has_``. Screening only ``has_`` left ``net_worth_enabled`` /
       ``portfolio_value_available`` style keys able to reach the DB. We now
       reject any of the three admitted boolean shapes that carries a banned
       semantic substring.

    Plain aggregate keys (e.g. "holdings_count") are NOT rejected here
    because they carry no raw values and are required by downstream consumers.
    """
    key_lower = key.lower()
    if _CURRENCY_IN_KEY_PATTERN.search(key_lower):
        return True
    is_admitted_boolean_shape = (
        key_lower.startswith("has_")
        or key_lower.endswith("_enabled")
        or key_lower.endswith("_available")
    )
    if is_admitted_boolean_shape and any(banned in key_lower for banned in _BANNED_KEY_SUBSTRINGS):
        return True
    return False


def _post_process_summary(projection: SummaryProjection) -> SummaryProjection:
    """
    Strip any keys or capability strings that contain leaked PII.

    This catches LLM hallucinations where the model encodes sensitive
    information into property names rather than property values (the
    "structural PII leak" described in issue #586).

    Args:
        projection: Raw SummaryProjection as returned by the LLM.

    Returns:
        A clean SummaryProjection with unsafe keys/capabilities removed.
    """
    safe_presence_flags = {
        k: v for k, v in projection.presence_flags.items() if not _key_is_unsafe(k)
    }

    safe_counts = {k: v for k, v in projection.counts.items() if not _key_is_unsafe(k)}

    safe_freshness = {
        k: v for k, v in projection.freshness_markers.items() if not _key_is_unsafe(k)
    }

    safe_capabilities = [
        cap for cap in projection.sanctioned_capability_flags if not _key_is_unsafe(cap)
    ]

    return SummaryProjection(
        presence_flags=safe_presence_flags,
        counts=safe_counts,
        freshness_markers=safe_freshness,
        sanctioned_capability_flags=safe_capabilities,
    )


# ---------------------------------------------------------------------------
# Agent entry-point
# ---------------------------------------------------------------------------


class SummaryReducerAgent:
    """
    Deterministic wrapper around the YAML-configured summary reducer LLM.

    Applies all three guardrail layers:
      1. pre-process raw data  (blindfold)
      2. validate LLM output   (Pydantic schema)
      3. post-process output   (key-level PII scan)

    Usage::

        agent = SummaryReducerAgent()
        projection = agent.reduce(domain="financial", candidate_data=raw_pkm)
    """

    def pre_process(self, candidate_data: dict[str, Any]) -> dict[str, Any]:
        """Apply layer-1 scrubbing. Returns blindfolded data safe for LLM."""
        return _pre_process_data(candidate_data)  # type: ignore[return-value]

    def validate_output(self, raw_output: dict[str, Any]) -> SummaryProjection:
        """Apply layer-2 Pydantic validation. Raises ValidationError on bad schema."""
        return SummaryProjection(**raw_output)

    def post_process(self, projection: SummaryProjection) -> SummaryProjection:
        """Apply layer-3 key-level PII guardrail. Returns clean projection."""
        return _post_process_summary(projection)

    def sanitise_llm_output(self, raw_output: dict[str, Any]) -> SummaryProjection:
        """
        Validate and post-process raw LLM output in one call.

        Intended to be called immediately after the LLM returns a response,
        before the projection is persisted or returned to any caller.
        """
        projection = self.validate_output(raw_output)
        return self.post_process(projection)

    @staticmethod
    def scrub_dict_keys(d: dict[str, Any]) -> dict[str, Any]:
        """
        Remove any top-level key from *d* that carries a monetary amount or is
        a poisoned ``has_``-prefixed flag (service-layer rules, issue #586).

        Uses ``_service_key_is_unsafe`` which is intentionally narrower than the
        LLM-output guardrail: legitimate aggregate metrics such as
        ``holdings_count`` and ``balance_count`` are preserved because they carry
        no raw values and are required by downstream consumers.

        Canonical attach point: PersonalKnowledgeModelService._normalize_domain_summary()
        calls this as the final pass before any domain summary is persisted to the DB.

        Safe keys pass through unchanged.
        """
        return {k: v for k, v in d.items() if not _service_key_is_unsafe(k)}
