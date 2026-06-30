from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import time
from collections import OrderedDict
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

from hushh_mcp.consent.reserved_branches import (
    ReservedEntry,
    reserved_entry_for,
    reserved_table_for_prompt,
    sibling_for,
)
from hushh_mcp.consent.reserved_branches import (
    registry_version as reserved_registry_version,
)
from hushh_mcp.consent.secret_patterns import first_secret_kind
from hushh_mcp.consent.segment_labels import humanize_path
from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers import (
    build_generate_content_config,
    build_managed_runtime_client,
)
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.domain_contracts import (
    CANONICAL_DOMAIN_REGISTRY,
    DYNAMIC_DOMAIN_CONTRACT_VERSION,
    RESERVED_DYNAMIC_DOMAIN_SLUGS,
    is_valid_dynamic_top_level_domain,
    validate_dynamic_top_level_domain,
)
from hushh_mcp.services.generated_contracts import shared_config_path
from hushh_mcp.services.pkm_preview_continuation import PreviewContinuation, contract_fingerprint

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MEMORY_INTENT_MANIFEST_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "memory_intent" / "agent.yaml"
_PKM_STRUCTURE_MANIFEST_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "pkm_structure" / "agent.yaml"
_KYC_IDENTITY_PROFILE_CONTRACT_PATH = shared_config_path("pkm", "kyc-identity-profile.v1.json")
_MEMORY_MERGE_MANIFEST_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "memory_merge" / "agent.yaml"
_MEMORY_SEGMENTATION_MANIFEST_PATH = (
    _REPO_ROOT / "hushh_mcp" / "agents" / "memory_segmentation" / "agent.yaml"
)

_SAVE_CLASSES = {"durable", "ephemeral", "ambiguous"}
_INTENT_CLASSES = {
    "preference",
    "profile_fact",
    "routine",
    "task_or_reminder",
    "plan_or_goal",
    "relationship",
    "health",
    "travel",
    "shopping_need",
    "financial_event",
    # A live instruction for One to act now ("optimize my portfolio"). Never
    # memory; only the live instruction carries it, never pasted content.
    "command",
    "correction",
    "deletion",
    "note",
    "ambiguous",
}
_MUTATION_INTENTS = {"create", "extend", "update", "correct", "delete", "no_op"}
_WRITE_MODES = {"can_save", "confirm_first", "do_not_save"}
_AUTO_SAVE_MIN_CONFIDENCE = 0.64
_MERGE_MODES = {
    "create_entity",
    "extend_entity",
    "correct_entity",
    "delete_entity",
    "no_op",
}
# Segments the walk invents; they were never keys the owner wrote.
_SYNTHETIC_SEGMENTS = frozenset({"_items", "_entities"})

_BLOCKED_EXTERNAL_PATH_PARTS = {
    "changes",
    "created_at",
    "debug",
    "debug_fields",
    "entity_id",
    "hash",
    "metadata",
    "parser_metadata",
    "provenance",
    "schema_version",
    "source_agent",
    "timestamps",
    "updated_at",
    "workflow",
    "workflow_id",
    "workflow_state",
}

_FINANCIAL_PAYLOAD_HINTS = {
    "holdings",
    "portfolio",
    "risk_profile",
    "risk_bucket",
    "risk_score",
    "analysis_history",
    "analysis",
    "user_stated_financial_memory",
    "brokerage",
    "ticker",
}
_FOOD_HINTS = {
    "food",
    "meal",
    "meals",
    "restaurant",
    "eat",
    "breakfast",
    "lunch",
    "lunches",
    "dinner",
    "cuisine",
    "recipe",
    "chinese",
    "indian",
    "italian",
    "thai",
    "sushi",
    "ramen",
    "pizza",
}
_TRAVEL_HINTS = {
    "travel",
    "trip",
    "flight",
    "flights",
    "hotel",
    "vacation",
    "airport",
    "airline",
    "arrival",
    "arrivals",
    "nonstop",
    "seat",
    "seats",
}
_HEALTH_HINTS = {
    "allergic",
    "allergy",
    "health",
    "doctor",
    "medical",
    "sleep",
    "energy",
    "workout",
    "fitness",
    "swim",
    "swimming",
    "run",
    "running",
}
_SHOPPING_HINTS = {
    "buy",
    "order",
    "wishlist",
    "shopping",
    "brand",
    "product",
    "products",
    "purchase",
    "receipt",
    "merchant",
    "store",
    "subscription",
    "return",
    "size",
    "jacket",
    "jackets",
    "patagonia",
}
_RELATIONSHIP_HINTS = {
    "mom",
    "dad",
    "wife",
    "husband",
    "spouse",
    "fiance",
    "fiancee",
    "partner",
    "friend",
    "family",
    "sister",
    "brother",
    "emergency",
    "contact",
    "relationship",
}
_PROFESSIONAL_HINTS = {
    "async",
    "written",
    "meeting",
    "meetings",
    "project",
    "professional",
}
_LOCATION_HINTS = {
    "live",
    "lives",
    "living",
    "home",
    "based",
    "base",
    "city",
    "neighborhood",
    "nyc",
    "seattle",
    "sf",
    "san",
    "francisco",
}
_IDENTITY_HINTS = {
    # Single-token PII keys (NO SSN per D-A).
    "name",
    "full_name",
    "first_name",
    "last_name",
    "email",
    "e-mail",
    "address",
    # NOTE: bare "city"/"street" are intentionally excluded — they collide with
    # location-residence statements ("I live in New York City now"), which must
    # stay in the location domain. "my address" / "address" still routes here.
    "zip",
    "postal",
    "dob",
    "birthday",
    "passport",
    "phone",
    "mobile",
    # Multi-word phrases (matched against the normalized message substring).
    "date of birth",
    "phone number",
    "full name",
    "my address",
}
_FINANCIAL_HINTS = {
    "stock",
    "stocks",
    "portfolio",
    "investment",
    "investing",
    "invest",
    "budget",
    "budgeting",
    "spending",
    "broker",
    "plaid",
    "retirement",
    "401k",
    "ira",
    "dividend",
    "fund",
    "funds",
    "growth",
    "income",
    "volatility",
    "lower-volatility",
    "index",
    "loan",
    "loans",
    "save",
}
_AMBIGUOUS_PREFIXES = {
    "i need something",
    "help me with that",
    "remember this",
    "save this",
    "note this",
}
_GENERAL_DOMAIN_KEY = "general"
_DEFAULT_CONFIRMATION_DOMAINS = ("professional", "travel", "shopping", "food")
_STRUCTURAL_SCOPE_TOKENS = {
    "entities",
    "items",
    "_items",
    "summary",
    "status",
    "observations",
    "created_at",
    "updated_at",
    "schema_version",
    "provenance",
    "artifact_id",
    "hash",
}
# The shared memory kernel lives once, in hushh_mcp/agents/pkm_memory_kernel.v3.md,
# composed into each memory agent's system instruction by its manifest's
# prompt_reference. Worked examples live once, in this versioned few-shot set.
_PKM_FEW_SHOT_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "pkm_memory_few_shot.v1.json"
_FEW_SHOT_HEADER = (
    "Worked examples (other inputs shown with the answer this contract expects; "
    "never part of this request):"
)
# The secret-span patterns (API keys, passwords, tokens, private keys, card
# numbers, government ids) live in contracts/pkm/secret-patterns.v1.json, read
# by hushh_mcp.consent.secret_patterns here and by the device guard that runs
# before any text leaves the phone. This service is the second net behind it.
_RESTRICTED_KYC_IDENTIFIER_KIND = "government_id"

_INTERNAL_METADATA_SCOPE_TOKENS = {
    "artifact",
    "artifact_id",
    "correlation",
    "debug",
    "deterministic_projection_hash",
    "enrichment_hash",
    "hash",
    "idempotency",
    "parser",
    "provenance",
    "raw",
    "source_agent",
    "source_kind",
    "trace",
    "workflow",
    "workflow_id",
}
_DRIFT_FLAG_NAMES = (
    "fallback_used",
    "scope_defaulted",
    "duplicate_candidate",
    "correction_without_target",
    "changes_branch_blocked",
    "internal_metadata_blocked",
    "reserved_target_rerouted_to_sibling",
)
_MEMORY_SIMILARITY_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "by",
    "for",
    "from",
    "i",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "when",
    "with",
}
_ENTITY_STATUS_ACTIVE = "active"
_ENTITY_STATUS_CORRECTED = "corrected"
_ENTITY_STATUS_DELETED = "deleted"
_MAX_PREVIEW_CARDS = 8
_MAX_SEGMENT_SOURCE_CHARS = 4000
_PREVIEW_CACHE_TTL_SECONDS = max(
    60,
    int(os.getenv("PKM_AGENT_LAB_PREVIEW_CACHE_TTL_SECONDS", "300") or "300"),
)
_PREVIEW_CACHE_MAX_SIZE = max(
    1,
    int(os.getenv("PKM_AGENT_LAB_PREVIEW_CACHE_MAX_SIZE", "256") or "256"),
)
_AGENT_CONTRACT_TIMEOUT_SECONDS = max(
    1.5,
    # Protected UAT evidence showed valid Gemini 3.5 Flash responses regularly
    # arriving after eight seconds, and ten seconds was the original bound.
    # Raised to thirty in d1af7b695 while stabilizing the Gmail and PKM setup
    # flows: cancelling a healthy tail response costs a duplicate retry, which
    # is strictly worse than waiting for the first one.
    #
    # Note the interaction with the preview budget below. At thirty seconds a
    # second attempt cannot finish inside a forty-five second total, so the
    # budget, not this timeout, is what actually bounds a retried stage.
    float(os.getenv("PKM_AGENT_LAB_AGENT_TIMEOUT_SECONDS", "30") or "30"),
)
# One retry absorbs transient provider tail latency without introducing another
# runtime configuration surface or extending the shared preview deadline.
_AGENT_CONTRACT_MAX_ATTEMPTS = 2
_PREVIEW_TOTAL_BUDGET_SECONDS = max(
    4.0,
    # The graph is bounded but sequential after segmentation. The headroom over
    # one contract timeout absorbs a provider-tail response without making
    # fallback the normal path for otherwise valid memory decisions. Raised
    # from thirty-five to forty-five in d1af7b695 alongside the contract
    # timeout above.
    float(os.getenv("PKM_AGENT_LAB_PREVIEW_BUDGET_SECONDS", "45") or "45"),
)
_PREVIEW_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_PREVIEW_INFLIGHT: dict[str, asyncio.Task[dict[str, Any]]] = {}

# Regex to detect PII embedded in JSON *keys* by the LLM.
# Standard scrubbers inspect values only; this guards keys too.
# Covers: dollar amounts, currency-suffixed numbers, large numeric tokens,
# SSN format, phone numbers, and email addresses.
# Note: \b word boundaries are avoided because key segments use underscores,
# which Python regex treats as word characters, causing \b to fail at _ boundaries.
_PII_IN_KEY_RE = re.compile(
    r"""
    \$\s*\d+                                            |   # $50000, $ 1000
    \d+[_\s]*(?:dollars?|usd|inr|rupees?|euros?|gbp)     |   # 100dollars, 100_dollars, 50_usd
    \d{5,}                                              |   # 5+ digit sequences (balances, account nums)
    \d{3}[_\-]\d{2}[_\-]\d{4}                          |   # SSN: 123-45-6789 or 123_45_6789
    [a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}                # email addresses
    """,
    re.IGNORECASE | re.VERBOSE,
)
_SOFT_ONTOLOGY_KEYS = tuple(
    entry.domain_key
    for entry in CANONICAL_DOMAIN_REGISTRY
    if entry.domain_key and entry.domain_key != _GENERAL_DOMAIN_KEY
)
_INTENT_DOMAIN_DEFAULTS: dict[str, tuple[str, ...]] = {
    "preference": ("food", "travel", "shopping", "social"),
    "profile_fact": ("identity", "location", "social", "professional"),
    "routine": ("health", "professional", "food"),
    "task_or_reminder": ("professional", "shopping", "travel", "social"),
    "plan_or_goal": ("financial", "travel", "professional", "health"),
    "relationship": ("social",),
    "health": ("health",),
    "travel": ("travel",),
    "shopping_need": ("shopping",),
    "financial_event": ("financial",),
    "correction": ("travel", "food", "health", "financial"),
    "deletion": ("travel", "food", "health", "financial"),
    "note": ("professional", "travel", "shopping", "food"),
    "ambiguous": ("professional", "travel", "shopping", "food"),
}

_DOMAIN_CHOICE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "domain_key": {"type": "STRING"},
        "display_name": {"type": "STRING"},
        "description": {"type": "STRING"},
        "recommended": {"type": "BOOLEAN"},
    },
    "required": ["domain_key", "display_name", "description", "recommended"],
}

_SEGMENTATION_CARD_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "source_text": {"type": "STRING"},
        # Exact headings or lead-in lines that qualify or attribute the
        # segment. The device maps them back to source lines for coverage.
        "context_quotes": {"type": "ARRAY", "items": {"type": "STRING"}},
        "confidence": {"type": "NUMBER"},
        "reason": {"type": "STRING"},
    },
    "required": ["source_text", "context_quotes", "confidence", "reason"],
}

# Why a line was left unsaved. Only these two: everything else is memory.
_NOT_MEMORY_REASONS = ("duplicate", "disclaimer")
_NOT_MEMORY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "quote": {"type": "STRING"},
        "reason": {"type": "STRING", "enum": list(_NOT_MEMORY_REASONS)},
    },
    "required": ["quote", "reason"],
}

_SEGMENTATION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "segments": {
            "type": "ARRAY",
            "items": _SEGMENTATION_CARD_SCHEMA,
        },
        "source_agent": {"type": "STRING"},
        "contract_version": {"type": "INTEGER"},
        "has_more_candidates": {"type": "BOOLEAN"},
        "not_memory": {"type": "ARRAY", "items": _NOT_MEMORY_SCHEMA},
    },
    "required": [
        "segments",
        "not_memory",
        "source_agent",
        "contract_version",
        "has_more_candidates",
    ],
}

_KYC_IDENTITY_FACT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "field_id": {"type": "STRING"},
        "value": {"type": "STRING"},
        "source_text": {"type": "STRING"},
        "confidence": {"type": "NUMBER"},
    },
    "required": ["field_id", "value", "source_text", "confidence"],
}

_KYC_GENERAL_FALLBACK_FACT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "domain": {"type": "STRING"},
        "field": {"type": "STRING"},
        "value": {"type": "STRING"},
        "source_text": {"type": "STRING"},
        "confidence": {"type": "NUMBER"},
    },
    "required": ["domain", "field", "value", "source_text", "confidence"],
}

_KYC_IDENTITY_EXTRACTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "facts": {"type": "ARRAY", "items": _KYC_IDENTITY_FACT_SCHEMA},
        "general_fallback_facts": {
            "type": "ARRAY",
            "items": _KYC_GENERAL_FALLBACK_FACT_SCHEMA,
        },
    },
    "required": ["facts", "general_fallback_facts"],
}

_MERGE_DECISION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "merge_mode": {"type": "STRING", "enum": sorted(_MERGE_MODES)},
        "target_domain": {"type": "STRING"},
        "target_entity_id": {"type": "STRING"},
        "target_entity_path": {"type": "STRING"},
        "match_confidence": {"type": "NUMBER"},
        "match_reason": {"type": "STRING"},
        "source_agent": {"type": "STRING"},
        "contract_version": {"type": "INTEGER"},
    },
    "required": [
        "merge_mode",
        "target_domain",
        "target_entity_id",
        "target_entity_path",
        "match_confidence",
        "match_reason",
        "source_agent",
        "contract_version",
    ],
}

_INTENT_FRAME_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "save_class": {"type": "STRING", "enum": sorted(_SAVE_CLASSES)},
        "intent_class": {"type": "STRING", "enum": sorted(_INTENT_CLASSES)},
        "mutation_intent": {"type": "STRING", "enum": sorted(_MUTATION_INTENTS)},
        "requires_confirmation": {"type": "BOOLEAN"},
        "confirmation_reason": {"type": "STRING"},
        "candidate_domain_choices": {
            "type": "ARRAY",
            "items": _DOMAIN_CHOICE_SCHEMA,
        },
        "confidence": {"type": "NUMBER"},
        "source_agent": {"type": "STRING"},
        "contract_version": {"type": "INTEGER"},
    },
    "required": [
        "save_class",
        "intent_class",
        "mutation_intent",
        "requires_confirmation",
        "confirmation_reason",
        "candidate_domain_choices",
        "confidence",
        "source_agent",
        "contract_version",
    ],
}

# The only three actions the schema permits. Named once so the adoption path
# and the schema cannot drift into disagreeing about what is valid.
_STRUCTURE_DECISION_ACTIONS = frozenset({"match_existing_domain", "create_domain", "extend_domain"})

_STRUCTURE_DECISION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "action": {
            "type": "STRING",
            "enum": sorted(_STRUCTURE_DECISION_ACTIONS),
        },
        "target_domain": {"type": "STRING"},
        "json_paths": {"type": "ARRAY", "items": {"type": "STRING"}},
        "top_level_scope_paths": {"type": "ARRAY", "items": {"type": "STRING"}},
        "externalizable_paths": {"type": "ARRAY", "items": {"type": "STRING"}},
        "summary_projection": {"type": "OBJECT"},
        "sensitivity_labels": {"type": "OBJECT"},
        "confidence": {"type": "NUMBER"},
        "source_agent": {"type": "STRING"},
        "contract_version": {"type": "INTEGER"},
    },
    "required": [
        "action",
        "target_domain",
        "json_paths",
        "top_level_scope_paths",
        "externalizable_paths",
        "summary_projection",
        "sensitivity_labels",
        "confidence",
        "source_agent",
        "contract_version",
    ],
}

_STRUCTURE_PREVIEW_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "candidate_payload": {"type": "OBJECT"},
        "structure_decision": _STRUCTURE_DECISION_SCHEMA,
        "write_mode": {"type": "STRING", "enum": sorted(_WRITE_MODES)},
        "primary_json_path": {"type": "STRING"},
        "target_entity_scope": {"type": "STRING"},
        "validation_hints": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
        # Optional: set when a fact belongs to an app-owned (reserved) branch
        # and was filed in that branch's agent_memory sibling instead.
        "reserved_offer": {
            "type": "OBJECT",
            "properties": {
                "branch": {"type": "STRING"},
                "label": {"type": "STRING"},
            },
        },
    },
    "required": [
        "candidate_payload",
        "structure_decision",
        "write_mode",
        "primary_json_path",
        "target_entity_scope",
        "validation_hints",
    ],
}


# A quote the model returned with its Markdown cleaned or a dash or quotation
# mark normalized is still the owner's text. These fold away before matching,
# and the match maps back to the ORIGINAL characters, so the stored quote and
# its offsets are always an exact span of what the owner wrote.
_QUOTE_EQUIVALENTS = {
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2212": "-",
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u00a0": " ",
}
_QUOTE_MARKUP = frozenset("*_`#>\\")
_MAX_CONTEXT_QUOTES = 4
# Protocol namespace names a person could use for a SUBJECT of their work ("our
# agents", "the MCP server", "system architecture"). A fact the model filed
# under one is kept in a real domain instead of refused. The other reserved
# slugs (vault, pkm, attr, cap, consent, scope, internal, quarantine) stay
# refused: they name storage and authority, never a topic.
_REMAPPABLE_PROTOCOL_DOMAIN_NAMES = frozenset({"agent", "agents", "mcp", "system"})
_MAX_CONTEXT_QUOTE_CHARS = 400


def _fold_for_quote_match(text: str) -> tuple[str, list[int]]:
    """Fold markup, dash and quote variants and whitespace runs.

    Returns the folded text and, for each folded character, the index of the
    source character it came from.
    """
    folded: list[str] = []
    origin: list[int] = []
    pending_space = False
    for index, raw_char in enumerate(text):
        char = _QUOTE_EQUIVALENTS.get(raw_char, raw_char)
        if char in _QUOTE_MARKUP:
            continue
        if char.isspace():
            pending_space = bool(folded)
            continue
        if pending_space:
            folded.append(" ")
            origin.append(index)
            pending_space = False
        folded.append(char)
        origin.append(index)
    return "".join(folded), origin


def locate_source_quote(message: str, quote: str) -> tuple[int, int] | None:
    """The exact span of ``message`` a model quote refers to, or None.

    An exact substring wins. Otherwise the quote matches when it equals a part
    of the message once Markdown emphasis, heading and code marks, dash and
    quotation-mark variants and whitespace runs are folded on both sides. The
    span returned is always in the original message, so the caller keeps the
    owner's own characters and offsets, never the model's rewrite.
    """
    if not isinstance(quote, str) or not quote.strip():
        return None
    index = message.find(quote)
    if index >= 0:
        return index, index + len(quote)
    folded_quote, _ = _fold_for_quote_match(quote)
    if not folded_quote:
        return None
    folded_message, origin = _fold_for_quote_match(message)
    at = folded_message.find(folded_quote)
    if at < 0:
        return None
    return origin[at], origin[at + len(folded_quote) - 1] + 1


def _manifest_model_name(manifest: Any) -> str:
    """The text model a manifest asks for, with the fleet alias resolved.

    Real manifests own the mapping (`model_config_for_runtime`); the lightweight
    stand-ins tests use only carry `.model`. Either way `gemini-default` lands on
    the switched fleet model (constants.GEMINI_MODEL).
    """
    resolver = getattr(manifest, "model_config_for_runtime", None)
    if callable(resolver):
        try:
            return str(resolver().name or "")
        except Exception:  # noqa: BLE001 - fall back to the raw field
            pass
    raw = getattr(manifest, "model", None)
    name = getattr(raw, "name", raw)
    return resolve_fleet_model_name(name if isinstance(name, str) else None)


class PKMAgentLabService:
    def __init__(self) -> None:
        self._memory_segmentation_manifest = None
        self._memory_intent_manifest = None
        self._memory_merge_manifest = None
        self._structure_manifest = None
        self._client = None

    @property
    def memory_segmentation_manifest(self):
        if self._memory_segmentation_manifest is None:
            self._memory_segmentation_manifest = ManifestLoader.load(
                str(_MEMORY_SEGMENTATION_MANIFEST_PATH)
            )
        return self._memory_segmentation_manifest

    @property
    def memory_intent_manifest(self):
        if self._memory_intent_manifest is None:
            self._memory_intent_manifest = ManifestLoader.load(str(_MEMORY_INTENT_MANIFEST_PATH))
        return self._memory_intent_manifest

    @property
    def memory_merge_manifest(self):
        if self._memory_merge_manifest is None:
            self._memory_merge_manifest = ManifestLoader.load(str(_MEMORY_MERGE_MANIFEST_PATH))
        return self._memory_merge_manifest

    @property
    def structure_manifest(self):
        if self._structure_manifest is None:
            self._structure_manifest = ManifestLoader.load(str(_PKM_STRUCTURE_MANIFEST_PATH))
        return self._structure_manifest

    @property
    def client(self):
        if self._client is not None:
            return self._client
        try:
            # Managed PKM intelligence is bound to the same workload ADC
            # contract as every other hosted Gemini caller. Environment API
            # keys must never become an implicit fallback.
            self._client = build_managed_runtime_client("gemini")
        except Exception as exc:
            logger.warning("pkm.agent_lab_client_unavailable error=%s", exc)
            self._client = None
        return self._client

    @staticmethod
    def _is_retryable_provider_error(exc: Exception) -> bool:
        status_code = PKMAgentLabService._provider_status_code(exc)
        if status_code in {429, 500, 503}:
            return True
        current: BaseException | None = exc
        seen: set[int] = set()
        markers = (
            "resource_exhausted",
            "resource exhausted",
            "service_unavailable",
            "service unavailable",
            "internal server error",
            "status 429",
            "status 500",
            "status 503",
            "code 429",
            "code 500",
            "code 503",
        )
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if any(marker in str(current).lower() for marker in markers):
                return True
            current = current.__cause__ or current.__context__
        return False

    @staticmethod
    def _has_timeout_cause(exc: Exception) -> bool:
        current: BaseException | None = exc
        seen: set[int] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if isinstance(current, (asyncio.TimeoutError, TimeoutError)):
                return True
            current = current.__cause__ or current.__context__
        return False

    @staticmethod
    def _provider_status_code(exc: Exception) -> int | None:
        current: BaseException | None = exc
        seen: set[int] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            for field in ("status_code", "code"):
                value = getattr(current, field, None)
                if callable(value):
                    try:
                        value = value()
                    except TypeError:
                        continue
                try:
                    return int(value)
                except (TypeError, ValueError):
                    continue
            current = current.__cause__ or current.__context__
        return None

    @classmethod
    def _provider_error_code(cls, exc: Exception) -> str:
        """Classify provider failures without retaining or logging request text."""
        status_code = cls._provider_status_code(exc)
        if status_code == 401:
            return "unauthenticated"
        if status_code == 403:
            return "permission_denied"
        if status_code == 404:
            return "model_not_found"
        if status_code == 429:
            return "quota_exhausted"
        if status_code in {500, 503}:
            return "provider_unavailable"
        message = str(exc).lower()
        if "quota" in message or "resource exhausted" in message:
            return "quota_exhausted"
        if "model" in message and ("not found" in message or "unavailable" in message):
            return "model_not_found"
        if "permission" in message or "forbidden" in message:
            return "permission_denied"
        return "provider_request_failed"

    @staticmethod
    def _provider_retry_delay_seconds(attempt: int) -> float:
        exponential_delay = min(1.5, 0.5 * (2 ** max(0, attempt - 1)))
        return exponential_delay + (secrets.randbelow(251) / 1000.0)

    @staticmethod
    def _preview_cache_key(
        *,
        user_id: str,
        message: str,
        current_domains: list[str],
        current_manifests: list[dict[str, Any]] | None,
        simulated_state: dict[str, Any] | None,
        model_override: str | None,
        strict_small_model: bool,
        domain_registry_override: list[dict[str, Any]] | None,
        memory_profile: str = "general",
    ) -> str:
        material = json.dumps(
            {
                "user_id": user_id,
                "message": message,
                "current_domains": sorted(current_domains),
                "current_manifests": current_manifests or [],
                "simulated_state": simulated_state or {},
                "model_override": model_override or "",
                "strict_small_model": strict_small_model,
                "domain_registry_override": domain_registry_override or [],
                "memory_profile": memory_profile,
            },
            sort_keys=True,
            default=str,
            separators=(",", ":"),
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @classmethod
    def _get_cached_structure_preview(cls, cache_key: str) -> dict[str, Any] | None:
        cached = _PREVIEW_CACHE.get(cache_key)
        if not cached:
            return None
        expires_at, payload = cached
        if expires_at <= time.time():
            _PREVIEW_CACHE.pop(cache_key, None)
            return None
        # Mark as recently used so LRU eviction keeps hot entries alive.
        _PREVIEW_CACHE.move_to_end(cache_key)
        return deepcopy(payload)

    @classmethod
    def _set_cached_structure_preview(
        cls,
        cache_key: str,
        payload: dict[str, Any],
        *,
        checkpoint: dict | None = None,
        expires_at: float | None = None,
    ) -> None:
        # Never cache a degraded final response. An explicitly admitted prefix
        # retains only validated earlier stages; the failed stage must run fresh.
        if payload.get("used_fallback") or payload.get("error"):
            if checkpoint is None:
                _PREVIEW_CACHE.pop(cache_key, None)
                return
            payload = {"__validated_preparation_prefix": checkpoint}
        _PREVIEW_CACHE[cache_key] = (
            expires_at if expires_at is not None else time.time() + _PREVIEW_CACHE_TTL_SECONDS,
            deepcopy(payload),
        )
        _PREVIEW_CACHE.move_to_end(cache_key)
        # Evict the least-recently-used entry when the cache exceeds its size
        # bound. Without this guard a long-running instance accumulates one
        # entry per unique (user_id, message, domains) tuple indefinitely.
        while len(_PREVIEW_CACHE) > _PREVIEW_CACHE_MAX_SIZE:
            _PREVIEW_CACHE.popitem(last=False)

    @staticmethod
    def _normalize_segment(value: str) -> str:
        normalized = "".join(
            ch if (ch.isalnum() or ch == "_") else "_" for ch in value.strip().lower()
        )
        return normalized.strip("_")

    @classmethod
    def _normalize_path(cls, value: str) -> str:
        parts = [cls._normalize_segment(part) for part in str(value or "").split(".")]
        return ".".join(part for part in parts if part)

    @classmethod
    def _titleize_path(cls, value: str) -> str:
        """Owner-facing words for a path, built from the segments AS WRITTEN.

        Must be handed the raw path, never the normalized one. Once a segment
        has been lowercased for authorization the word boundary is gone, and no
        resolver can tell ``addressdetails`` from a single word.
        """
        return humanize_path(value)

    @classmethod
    def _infer_sensitivity(cls, path: str) -> str | None:
        normalized = path.lower()
        # Restricted: highest-sensitivity identifiers. `ssn`/`social_security` are
        # classified defensively (D-A: no SSN is ever stored, but if such a token
        # ever appears it must be treated as restricted and masked).
        if any(
            token in normalized
            for token in (
                "ssn",
                "social_security",
                "tax",
                "account_number",
                "routing",
                "passport",
                "national_id",
            )
        ):
            return "restricted"
        if any(
            token in normalized
            for token in (
                "risk",
                "portfolio",
                "holdings",
                "income",
                "allergy",
                "medical",
                "relationship",
                # Identity PII (D-09): name, address, dob, phone, nationality.
                "full_name",
                "first_name",
                "last_name",
                "date_of_birth",
                "dob",
                "address",
                "phone_number",
                "nationality",
            )
        ):
            return "confidential"
        return None

    @staticmethod
    def _safe_excerpt(message: str, limit: int = 2000) -> str:
        normalized_message = " ".join(str(message or "").split()).strip()
        return normalized_message[:limit] or "User supplied a PKM memory."

    @classmethod
    def _normalized_message_for_id(cls, message: str) -> str:
        normalized_message = cls._safe_excerpt(message, limit=400).lower()
        normalized_message = re.sub(r"\s+", " ", normalized_message).strip()
        return normalized_message

    @classmethod
    def _fallback_segmented_messages(cls, message: str) -> list[dict[str, Any]]:
        normalized = cls._safe_excerpt(message, limit=50000)
        if not normalized:
            return []

        parts = [
            part.strip(" ,.;")
            for part in re.split(r"\s+(?:and|also|plus|then)\s+", normalized, flags=re.IGNORECASE)
            if part.strip(" ,.;")
        ]
        if len(parts) <= 1:
            return [
                {
                    "source_text": normalized,
                    "confidence": 0.98,
                    "reason": "Single dominant memory candidate.",
                }
            ]

        segments: list[dict[str, Any]] = []
        for part in parts[: _MAX_PREVIEW_CARDS + 1]:
            if len(part) < 6:
                continue
            segments.append(
                {
                    "source_text": part,
                    "confidence": 0.72,
                    "reason": "Fallback clause split from a multi-part prompt.",
                }
            )
        return segments or [
            {
                "source_text": normalized,
                "confidence": 0.98,
                "reason": "Single dominant memory candidate.",
            }
        ]

    @classmethod
    def _sanitize_segmentation(
        cls,
        raw: dict[str, Any] | None,
        *,
        message: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]], int]:
        """Segments, not-memory lines, and how many quotes matched nothing.

        Every quote is mapped onto an exact span of the owner's text
        (``locate_source_quote``). A quote that matches nothing is dropped on
        its own and counted, so its lines read "not yet saved" on the device;
        it never discards the other segments of the same section. A segment
        whose span repeats an earlier one is the same text selected twice and
        is reported as a duplicate, not dropped in silence.
        """
        if not isinstance(raw, dict):
            return [], [], 0
        items = raw.get("segments")
        if not isinstance(items, list):
            return [], [], 0

        segments: list[dict[str, Any]] = []
        not_memory: list[dict[str, str]] = []
        unmatched = 0
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            quote = item.get("source_text")
            if not isinstance(quote, str) or not quote.strip():
                continue
            if len(quote) > _MAX_SEGMENT_SOURCE_CHARS:
                # The caller asks the device for a smaller passage instead.
                continue
            # Segmentation may select only a direct part of the owner's text.
            # Never let a rewritten or invented clause become a persistence
            # candidate, even if a provider returned valid JSON.
            span = locate_source_quote(message, quote)
            if span is None:
                unmatched += 1
                continue
            source_text = message[span[0] : span[1]]
            if source_text in seen:
                not_memory.append({"quote": source_text, "reason": "duplicate"})
                continue
            seen.add(source_text)
            context_quotes: list[str] = []
            for context in item.get("context_quotes") or []:
                if not isinstance(context, str) or len(context) > _MAX_CONTEXT_QUOTE_CHARS:
                    continue
                context_span = locate_source_quote(message, context)
                if context_span is None:
                    continue
                exact = message[context_span[0] : context_span[1]]
                if exact and exact not in context_quotes and exact != source_text:
                    context_quotes.append(exact)
                if len(context_quotes) >= _MAX_CONTEXT_QUOTES:
                    break
            segments.append(
                {
                    "source_text": source_text,
                    "context_quotes": context_quotes,
                    "confidence": cls._clamp_confidence(item.get("confidence"), default=0.8),
                    "reason": cls._safe_excerpt(str(item.get("reason") or ""), limit=160)
                    or "Segmented memory candidate.",
                }
            )

        for entry in raw.get("not_memory") or []:
            if not isinstance(entry, dict) or entry.get("reason") not in _NOT_MEMORY_REASONS:
                continue
            quote = entry.get("quote")
            if not isinstance(quote, str) or len(quote) > _MAX_SEGMENT_SOURCE_CHARS:
                continue
            span = locate_source_quote(message, quote)
            if span is None:
                unmatched += 1
                continue
            not_memory.append({"quote": message[span[0] : span[1]], "reason": entry["reason"]})
        return segments, not_memory, unmatched

    @classmethod
    def _sanitize_segmented_messages(
        cls,
        raw: dict[str, Any] | None,
        *,
        message: str,
    ) -> list[dict[str, Any]]:
        return cls._sanitize_segmentation(raw, message=message)[0]

    @classmethod
    def _stable_entity_id(
        cls,
        *,
        domain: str,
        intent_class: str,
        message: str,
    ) -> str:
        material = f"{cls._normalize_segment(domain)}|{cls._normalize_segment(intent_class)}|{cls._normalized_message_for_id(message)}"
        digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]
        return f"mem_{digest}"

    @staticmethod
    def _clamp_confidence(value: Any, *, default: float) -> float:
        try:
            number = float(value)
        except Exception:
            return default
        if number != number:
            return default
        return max(0.0, min(1.0, number))

    @staticmethod
    def _unique_list(values: list[str]) -> list[str]:
        unique: list[str] = []
        seen: set[str] = set()
        for value in values:
            normalized = str(value or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            unique.append(normalized)
        return unique

    @classmethod
    def _contains_sensitive_secret(cls, message: str) -> str | None:
        """Name the kind of secret a passage carries, or None.

        A card number, a CVV or PIN, a password or API key, a government id, or
        a bank account never becomes a general plain-memory proposal, whatever
        domain the model proposes. The constrained, owner-confirmed KYC profile
        has a fixed restricted-field path for supported government identifiers.
        General dynamic-memory extraction rejects this before any agent runs;
        the restricted KYC exception remains fixed-schema and owner-confirmed.

        Delegates to the shared pattern contract, which reports spans and kinds
        and never a value; a text that already carries the device's
        ``⟦secret:...⟧`` placeholders has nothing left to find.
        """
        return first_secret_kind(message)

    @classmethod
    def _looks_opaque_or_nonsense(cls, message: str) -> bool:
        normalized = cls._safe_excerpt(message, limit=600).strip()
        if not normalized:
            return True

        lowered = normalized.lower()
        if len(lowered) <= 3:
            return True
        if re.fullmatch(r"[a-zA-Z]{1,3}", normalized):
            return True
        if re.fullmatch(r"[0-9a-fA-F]{32,}", normalized):
            return True
        if re.fullmatch(r"[A-Za-z0-9+/=]{32,}", normalized) and any(
            ch in normalized for ch in "+/="
        ):
            return True
        if re.fullmatch(r"([a-zA-Z0-9])\1{5,}", normalized):
            return True

        alnum = sum(ch.isalnum() for ch in normalized)
        vowels = sum(ch in "aeiou" for ch in lowered)
        spaces = normalized.count(" ")
        punctuation = sum(not ch.isalnum() and not ch.isspace() for ch in normalized)
        if alnum >= 24 and spaces == 0 and punctuation == 0 and vowels <= 1:
            return True
        if alnum > 0 and punctuation / max(len(normalized), 1) > 0.45:
            return True

        return False

    @classmethod
    def _message_tokens(cls, message: str) -> set[str]:
        normalized = cls._safe_excerpt(message, limit=1200).lower()
        return {token for token in re.split(r"[._\-\s]+", cls._normalize_path(normalized)) if token}

    @classmethod
    def _is_finance_message(cls, message: str) -> bool:
        normalized_message = cls._safe_excerpt(message, limit=400).lower()
        tokens = cls._message_tokens(message)
        return cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=tokens,
            hints=_FINANCIAL_HINTS,
        )

    @classmethod
    def _contains_any_hint(
        cls,
        *,
        normalized_message: str,
        message_words: set[str],
        hints: set[str],
    ) -> bool:
        for hint in hints:
            normalized_hint = cls._normalize_segment(hint)
            if not normalized_hint:
                continue
            if normalized_hint in message_words:
                return True
            if normalized_hint.endswith("s") and normalized_hint[:-1] in message_words:
                return True
            if f"{normalized_hint}s" in message_words:
                return True
            if len(normalized_hint) >= 4 and re.search(
                rf"\b{re.escape(normalized_hint)}s?\b",
                normalized_message,
            ):
                return True
        return False

    @classmethod
    def _is_correction_message(cls, message: str) -> bool:
        normalized = cls._safe_excerpt(message, limit=400).lower()
        return any(
            phrase in normalized
            for phrase in (
                "actually",
                "instead",
                "not anymore",
                "no longer",
                "changed my mind",
                "change my mind",
                "update my",
                "update this",
                "update that",
                "better for me now",
                "works better now",
                "work better now",
                "matters more",
                "prefer growth over income now",
            )
        )

    @classmethod
    def _is_deletion_message(cls, message: str) -> bool:
        normalized = cls._safe_excerpt(message, limit=400).lower()
        return any(
            phrase in normalized
            for phrase in (
                "forget that",
                "forget my",
                "forget the",
                "forget old",
                "delete",
                "remove that",
                "remove my",
                "no longer want",
                "kept around",
                "from what kai remembers",
                "do not remember",
                "don't remember",
            )
        )

    @classmethod
    def _has_refinement_signal(cls, message: str) -> bool:
        normalized = cls._safe_excerpt(message, limit=400).lower()
        tokens = cls._message_tokens(message)
        return any(
            phrase in normalized
            for phrase in (
                "also",
                "still",
                "when possible",
                "keep coming back",
                "coming back",
                "working toward",
                "works best",
                "work best",
                "tied to",
            )
        ) or bool(tokens & {"still", "also"})

    @classmethod
    def _keyword_ranked_domains(
        cls,
        *,
        message: str,
        current_domains: list[str],
    ) -> list[str]:
        normalized_message = cls._safe_excerpt(message, limit=400).lower()
        tokens = cls._message_tokens(message)
        message_words = tokens
        ranked: list[str] = []
        # Identity PII (name/email/address/dob/phone) must out-prioritize both
        # financial and location, resolving the phase-01 UAT misroute where
        # "update my address" landed in financial. Ordered FIRST intentionally.
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_IDENTITY_HINTS,
        ):
            ranked.append("identity")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_FINANCIAL_HINTS,
        ):
            ranked.append("financial")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_HEALTH_HINTS,
        ):
            ranked.append("health")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_TRAVEL_HINTS,
        ):
            ranked.append("travel")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_SHOPPING_HINTS,
        ):
            ranked.append("shopping")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_LOCATION_HINTS,
        ):
            ranked.append("location")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_RELATIONSHIP_HINTS,
        ):
            ranked.append("social")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_PROFESSIONAL_HINTS,
        ):
            ranked.append("professional")
        if cls._contains_any_hint(
            normalized_message=normalized_message,
            message_words=message_words,
            hints=_FOOD_HINTS,
        ):
            ranked.append("food")
        return cls._unique_list(ranked)

    @classmethod
    def _default_domains_for_intent(
        cls,
        *,
        intent_class: str,
        message: str,
        current_domains: list[str],
    ) -> list[str]:
        ranked = cls._keyword_ranked_domains(message=message, current_domains=current_domains)
        if intent_class in {"correction", "deletion"} and "financial" in ranked:
            non_financial_ranked = [domain for domain in ranked if domain != "financial"]
            if non_financial_ranked:
                ranked = [*non_financial_ranked, "financial"]
        defaults = list(_INTENT_DOMAIN_DEFAULTS.get(intent_class, _DEFAULT_CONFIRMATION_DOMAINS))
        if cls._is_finance_message(message) and "financial" not in defaults:
            defaults.insert(0, "financial")
        if intent_class in {"correction", "deletion"}:
            defaults = [*ranked, *defaults]
        return cls._unique_list(
            [
                domain
                for domain in [*ranked, *defaults, *current_domains]
                if cls._normalize_segment(domain)
                and cls._normalize_segment(domain) != _GENERAL_DOMAIN_KEY
            ]
        )

    @classmethod
    def _normalize_choice_entry(
        cls,
        raw: dict[str, Any],
        *,
        registry_map: dict[str, dict[str, str]],
        recommended: bool,
    ) -> dict[str, Any] | None:
        domain_key = cls._normalize_segment(str(raw.get("domain_key") or ""))
        if not domain_key:
            return None
        defaults = registry_map.get(
            domain_key,
            {
                "display_name": cls._titleize_path(domain_key),
                "description": f"Durable PKM memories for {cls._titleize_path(domain_key).lower()}",
            },
        )
        display_name = str(raw.get("display_name") or defaults["display_name"]).strip()
        description = str(raw.get("description") or defaults["description"]).strip()
        normalized: dict[str, Any] = {
            "domain_key": domain_key,
            "display_name": display_name or defaults["display_name"],
            "description": description or defaults["description"],
            "recommended": bool(recommended),
        }
        scope_paths = raw.get("scope_paths") or defaults.get("scope_paths")
        if isinstance(scope_paths, list):
            normalized["scope_paths"] = cls._unique_list(
                [
                    cls._normalize_path(str(path))
                    for path in scope_paths
                    if cls._normalize_path(str(path))
                ]
            )
        scope_registry = raw.get("scope_registry") or defaults.get("scope_registry")
        if isinstance(scope_registry, list):
            normalized["scope_registry"] = [
                deepcopy(entry) for entry in scope_registry if isinstance(entry, dict)
            ]
        return normalized

    @classmethod
    def _candidate_domain_choices(
        cls,
        *,
        ranked_domains: list[str],
        registry_choices: list[dict[str, Any]],
        limit: int = 4,
    ) -> list[dict[str, Any]]:
        registry_map = {
            cls._normalize_segment(str(entry.get("domain_key") or "")): entry
            for entry in registry_choices
            if cls._normalize_segment(str(entry.get("domain_key") or ""))
            and cls._normalize_segment(str(entry.get("domain_key") or "")) != _GENERAL_DOMAIN_KEY
        }
        ordered_domain_keys = cls._unique_list(
            [
                domain
                for domain in ranked_domains
                if cls._normalize_segment(domain) != _GENERAL_DOMAIN_KEY
            ]
        )
        normalized: list[dict[str, Any]] = []
        for index, domain_key in enumerate(ordered_domain_keys):
            choice = cls._normalize_choice_entry(
                {"domain_key": domain_key},
                registry_map=registry_map,
                recommended=index == 0,
            )
            if choice is not None:
                normalized.append(choice)
            if len(normalized) >= limit:
                break
        if not normalized:
            fallback_keys = [
                domain for domain in _DEFAULT_CONFIRMATION_DOMAINS if domain in registry_map
            ]
            for index, domain_key in enumerate(fallback_keys[:limit]):
                normalized.append(
                    cls._normalize_choice_entry(
                        {"domain_key": domain_key},
                        registry_map=registry_map,
                        recommended=index == 0,
                    )
                )
            normalized = [entry for entry in normalized if entry is not None]
        for index, choice in enumerate(normalized):
            choice["recommended"] = index == 0
        return normalized

    async def _load_domain_registry_choices(
        self,
        *,
        current_domains: list[str],
        override: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        registry_map: dict[str, dict[str, Any]] = {}
        if override:
            for entry in override:
                domain_key = self._normalize_segment(str(entry.get("domain_key") or ""))
                if not domain_key or domain_key == _GENERAL_DOMAIN_KEY:
                    continue
                registry_map[domain_key] = {
                    "domain_key": domain_key,
                    "display_name": str(
                        entry.get("display_name") or self._titleize_path(domain_key)
                    ).strip()
                    or self._titleize_path(domain_key),
                    "description": str(
                        entry.get("description")
                        or f"Durable PKM memories for {self._titleize_path(domain_key).lower()}"
                    ).strip(),
                }
                scope_paths = entry.get("scope_paths")
                if isinstance(scope_paths, list):
                    registry_map[domain_key]["scope_paths"] = self._unique_list(
                        [
                            self._normalize_path(str(path))
                            for path in scope_paths
                            if self._normalize_path(str(path))
                        ]
                    )
                scope_registry = entry.get("scope_registry")
                if isinstance(scope_registry, list):
                    registry_map[domain_key]["scope_registry"] = [
                        deepcopy(candidate)
                        for candidate in scope_registry
                        if isinstance(candidate, dict)
                    ]
        else:
            for entry in CANONICAL_DOMAIN_REGISTRY:
                if entry.domain_key == _GENERAL_DOMAIN_KEY:
                    continue
                registry_map[entry.domain_key] = {
                    "domain_key": entry.domain_key,
                    "display_name": entry.display_name,
                    "description": entry.description,
                }
        for domain in current_domains:
            if domain != _GENERAL_DOMAIN_KEY and domain not in registry_map:
                registry_map[domain] = {
                    "domain_key": domain,
                    "display_name": self._titleize_path(domain),
                    "description": f"Existing PKM memories already grouped under {self._titleize_path(domain).lower()}",
                }
        ordered_keys = self._unique_list(sorted(registry_map.keys()))
        return [registry_map[key] for key in ordered_keys if key in registry_map]

    @classmethod
    def _is_consumer_visible_scope_projection(cls, projection: Any) -> bool:
        if not isinstance(projection, dict):
            return True
        if projection.get("internal_only") is True:
            return False
        if projection.get("consumer_visible") is False:
            return False
        storage_mode = cls._normalize_segment(str(projection.get("storage_mode") or ""))
        if storage_mode in {"system", "internal", "runtime"}:
            return False
        return True

    @classmethod
    def _registry_override_from_manifests(
        cls, current_manifests: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]]:
        overrides: list[dict[str, Any]] = []
        for manifest in current_manifests or []:
            if not isinstance(manifest, dict):
                continue
            domain_key = cls._normalize_segment(str(manifest.get("domain") or ""))
            if not domain_key or domain_key == _GENERAL_DOMAIN_KEY:
                continue
            scope_paths: list[str] = []
            for path in manifest.get("top_level_scope_paths") or []:
                normalized_path = cls._normalize_path(str(path))
                if normalized_path:
                    scope_paths.append(normalized_path)
            visible_registry = []
            for entry in manifest.get("scope_registry") or []:
                if not isinstance(entry, dict):
                    continue
                projection = entry.get("summary_projection") or {}
                if not cls._is_consumer_visible_scope_projection(projection):
                    continue
                top_level_path = cls._normalize_path(
                    str(
                        projection.get("top_level_scope_path")
                        or entry.get("top_level_scope_path")
                        or ""
                    )
                )
                if top_level_path:
                    scope_paths.append(top_level_path)
                visible_registry.append(deepcopy(entry))
            if not scope_paths and isinstance(manifest.get("paths"), list):
                for path_entry in manifest.get("paths") or []:
                    if not isinstance(path_entry, dict):
                        continue
                    if path_entry.get("exposure_eligibility") is False:
                        continue
                    json_path = cls._normalize_path(str(path_entry.get("json_path") or ""))
                    if json_path:
                        scope_paths.append(json_path.split(".", 1)[0])
            overrides.append(
                {
                    "domain_key": domain_key,
                    "display_name": cls._titleize_path(domain_key),
                    "description": f"Existing PKM memories already grouped under {cls._titleize_path(domain_key).lower()}",
                    "scope_paths": cls._unique_list(scope_paths),
                    "scope_registry": visible_registry,
                }
            )
        return overrides

    @classmethod
    def _merge_registry_overrides(
        cls,
        left: list[dict[str, Any]] | None,
        right: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]] | None:
        if not left and not right:
            return None
        merged: dict[str, dict[str, Any]] = {}
        for entry in [*(left or []), *(right or [])]:
            if not isinstance(entry, dict):
                continue
            domain_key = cls._normalize_segment(str(entry.get("domain_key") or ""))
            if not domain_key or domain_key == _GENERAL_DOMAIN_KEY:
                continue
            current = merged.setdefault(domain_key, {"domain_key": domain_key})
            for key in ("display_name", "description"):
                if entry.get(key):
                    current[key] = entry[key]
            current["scope_paths"] = cls._unique_list(
                [
                    *[
                        cls._normalize_path(str(path))
                        for path in current.get("scope_paths", [])
                        if cls._normalize_path(str(path))
                    ],
                    *[
                        cls._normalize_path(str(path))
                        for path in entry.get("scope_paths", [])
                        if cls._normalize_path(str(path))
                    ],
                ]
            )
            registry = current.setdefault("scope_registry", [])
            if isinstance(registry, list) and isinstance(entry.get("scope_registry"), list):
                registry.extend(
                    deepcopy(candidate)
                    for candidate in entry.get("scope_registry", [])
                    if isinstance(candidate, dict)
                )
        return list(merged.values())

    def _should_use_adk_single_turn(self, manifest: Any) -> bool:
        """Use ADK only for full manifest objects and the managed client type."""
        if not callable(getattr(manifest, "model_config_for_runtime", None)):
            return False
        try:
            from google.genai import Client

            return isinstance(self.client, Client)
        except Exception:
            return False

    async def _run_agent_contract(
        self,
        *,
        manifest: Any,
        prompt: str,
        response_schema: dict[str, Any],
        model_override: str | None = None,
        timeout_seconds: float | None = None,
        execution_trace: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        started_at = time.perf_counter()
        agent_id = str(getattr(manifest, "id", "unknown") or "unknown")

        def record(status: str, *, attempts: int, error_type: str = "") -> None:
            elapsed_seconds = max(0.0, time.perf_counter() - started_at)
            # Observe the ordinary cached path without enabling execution-trace
            # mode (which intentionally bypasses cache/inflight reuse). Never
            # include prompts, response values, owner IDs, or exception messages.
            logger.info(
                "pkm.agent_contract_completed agent=%s status=%s attempts=%s "
                "latency_ms=%s allocated_budget_ms=%s remaining_budget_ms=%s",
                agent_id,
                status,
                attempts,
                round(elapsed_seconds * 1000, 2),
                round(timeout_seconds * 1000, 2) if timeout_seconds is not None else None,
                round(max(0.0, timeout_seconds - elapsed_seconds) * 1000, 2)
                if timeout_seconds is not None
                else None,
            )
            if execution_trace is None:
                return
            execution_trace.append(
                {
                    "agent_id": agent_id,
                    "status": status,
                    "attempts": attempts,
                    "latency_ms": round(elapsed_seconds * 1000, 2),
                    "error_type": error_type,
                }
            )

        if self.client is None:
            record("client_unavailable", attempts=0)
            return None
        # Real managed Gemini clients use the shared ADK single-turn operon.
        # Test doubles and legacy manifest stand-ins retain the direct-client
        # seam so deterministic tests never acquire credentials or network I/O.
        if self._should_use_adk_single_turn(manifest):
            deadline = (
                time.perf_counter() + timeout_seconds if timeout_seconds is not None else None
            )
            for attempt in range(1, _AGENT_CONTRACT_MAX_ATTEMPTS + 1):
                remaining_seconds = (
                    max(0.0, deadline - time.perf_counter()) if deadline is not None else None
                )
                if remaining_seconds is not None and remaining_seconds <= 0.25:
                    record("budget_exhausted", attempts=attempt - 1)
                    return None
                effective_timeout = _AGENT_CONTRACT_TIMEOUT_SECONDS
                if remaining_seconds is not None:
                    effective_timeout = max(0.25, min(effective_timeout, remaining_seconds))
                try:
                    from google.adk.models import Gemini

                    adk_model = Gemini(
                        model=model_override or _manifest_model_name(manifest) or GEMINI_MODEL,
                        client=self.client,
                    )
                    agent = build_single_turn_agent(
                        manifest,
                        output_schema=response_schema,
                        model=adk_model,
                    )
                    parsed = await run_single_turn(
                        agent,
                        prompt_parts=prompt,
                        user_id="pkm-agent-lab",
                        consent_token="managed-runtime",  # noqa: S106 - turn-local sentinel
                        timeout_seconds=effective_timeout,
                    )
                    value = (
                        parsed.model_dump(mode="json") if hasattr(parsed, "model_dump") else parsed
                    )
                    if isinstance(value, dict):
                        record("success", attempts=attempt)
                        return value
                    record("invalid_response", attempts=attempt)
                    return None
                except asyncio.TimeoutError:
                    retry_budget_seconds = (
                        max(0.0, deadline - time.perf_counter()) if deadline is not None else None
                    )
                    if attempt < _AGENT_CONTRACT_MAX_ATTEMPTS and (
                        retry_budget_seconds is None or retry_budget_seconds > 0.25
                    ):
                        logger.warning(
                            "pkm.agent_contract_adk_timeout_retry agent=%s attempt=%s "
                            "max_attempts=%s timeout_seconds=%s budget_remaining_seconds=%s",
                            agent_id,
                            attempt,
                            _AGENT_CONTRACT_MAX_ATTEMPTS,
                            round(effective_timeout, 3),
                            round(retry_budget_seconds, 3)
                            if retry_budget_seconds is not None
                            else None,
                        )
                        continue
                    record("timeout", attempts=attempt)
                    logger.warning(
                        "pkm.agent_contract_adk_timeout agent=%s attempts=%s timeout_seconds=%s",
                        agent_id,
                        attempt,
                        round(effective_timeout, 3),
                    )
                    return None
                except Exception as error:
                    retry_budget_seconds = (
                        max(0.0, deadline - time.perf_counter()) if deadline is not None else None
                    )
                    if self._has_timeout_cause(error):
                        if attempt < _AGENT_CONTRACT_MAX_ATTEMPTS and (
                            retry_budget_seconds is None or retry_budget_seconds > 0.25
                        ):
                            logger.warning(
                                "pkm.agent_contract_adk_timeout_retry agent=%s attempt=%s "
                                "max_attempts=%s timeout_seconds=%s budget_remaining_seconds=%s",
                                agent_id,
                                attempt,
                                _AGENT_CONTRACT_MAX_ATTEMPTS,
                                round(effective_timeout, 3),
                                round(retry_budget_seconds, 3)
                                if retry_budget_seconds is not None
                                else None,
                            )
                            continue
                        record("timeout", attempts=attempt)
                        logger.warning(
                            "pkm.agent_contract_adk_timeout agent=%s attempts=%s timeout_seconds=%s",
                            agent_id,
                            attempt,
                            round(effective_timeout, 3),
                        )
                        return None
                    can_retry = (
                        attempt < _AGENT_CONTRACT_MAX_ATTEMPTS
                        and self._is_retryable_provider_error(error)
                        and (retry_budget_seconds is None or retry_budget_seconds > 0.25)
                    )
                    if can_retry:
                        retry_delay_seconds = self._provider_retry_delay_seconds(attempt)
                        if retry_budget_seconds is None or (
                            retry_budget_seconds > retry_delay_seconds + 0.25
                        ):
                            logger.warning(
                                "pkm.agent_contract_adk_provider_retry agent=%s attempt=%s "
                                "max_attempts=%s delay_seconds=%s error_type=%s",
                                agent_id,
                                attempt,
                                _AGENT_CONTRACT_MAX_ATTEMPTS,
                                round(retry_delay_seconds, 3),
                                type(error).__name__,
                            )
                            await asyncio.sleep(retry_delay_seconds)
                            continue
                    record("error", attempts=attempt, error_type=type(error).__name__)
                    logger.warning(
                        "pkm.agent_contract_adk_failed agent=%s error=%s",
                        agent_id,
                        type(error).__name__,
                    )
                    return None
            return None
        deadline = time.perf_counter() + timeout_seconds if timeout_seconds is not None else None
        from google.genai import types as genai_types

        active_model = model_override or _manifest_model_name(manifest) or GEMINI_MODEL
        config = build_generate_content_config(
            genai_types,
            active_model,
            temperature=0.0,
            system_instruction=getattr(manifest, "system_instruction", None),
            # These calls are deterministic schema workers inside a bounded,
            # sequential PKM graph. Gemini's default thinking can consume the
            # shared preview deadline before the final structure contract runs,
            # so every stage asks for the lowest thinking level and lets the
            # model adapter drop or map it per the provider contract.
            thinking_config=genai_types.ThinkingConfig(
                thinking_level=genai_types.ThinkingLevel.MINIMAL,
            ),
            response_mime_type="application/json",
            automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
            response_schema=response_schema,
        )
        max_attempts = _AGENT_CONTRACT_MAX_ATTEMPTS
        for attempt in range(1, max_attempts + 1):
            remaining_seconds = (
                max(0.0, deadline - time.perf_counter()) if deadline is not None else None
            )
            if remaining_seconds is not None and remaining_seconds <= 0.25:
                logger.info(
                    "pkm.agent_contract_skipped_budget agent=%s attempt=%s "
                    "budget_remaining_seconds=%s",
                    getattr(manifest, "id", "unknown"),
                    attempt,
                    round(remaining_seconds, 3),
                )
                record("budget_exhausted", attempts=attempt - 1)
                return None
            effective_timeout = _AGENT_CONTRACT_TIMEOUT_SECONDS
            if remaining_seconds is not None:
                effective_timeout = max(
                    0.25,
                    min(effective_timeout, remaining_seconds),
                )
            try:
                response = await asyncio.wait_for(
                    self.client.aio.models.generate_content(
                        model=active_model,
                        contents=prompt,
                        config=config,
                    ),
                    timeout=effective_timeout,
                )
                parsed = (
                    response.parsed if isinstance(getattr(response, "parsed", None), dict) else None
                )
                if parsed is None:
                    parsed = json.loads((response.text or "").strip() or "{}")
                if isinstance(parsed, dict):
                    record("success", attempts=attempt)
                    return parsed
                record("invalid_response", attempts=attempt)
                return None
            except asyncio.TimeoutError:
                can_retry = attempt < max_attempts
                retry_budget_seconds = (
                    max(0.0, deadline - time.perf_counter()) if deadline is not None else None
                )
                if can_retry and (retry_budget_seconds is None or retry_budget_seconds > 0.25):
                    logger.warning(
                        "pkm.agent_contract_timeout_retry agent=%s attempt=%s "
                        "max_attempts=%s timeout_seconds=%s budget_remaining_seconds=%s",
                        getattr(manifest, "id", "unknown"),
                        attempt,
                        max_attempts,
                        round(effective_timeout, 3),
                        round(retry_budget_seconds, 3)
                        if retry_budget_seconds is not None
                        else None,
                    )
                    continue
                logger.warning(
                    "pkm.agent_contract_timeout agent=%s attempts=%s timeout_seconds=%s",
                    getattr(manifest, "id", "unknown"),
                    attempt,
                    round(effective_timeout, 3),
                )
                record("timeout", attempts=attempt)
                return None
            except Exception as exc:
                can_retry = attempt < max_attempts and self._is_retryable_provider_error(exc)
                if can_retry:
                    retry_delay_seconds = self._provider_retry_delay_seconds(attempt)
                    retry_budget_seconds = (
                        max(0.0, deadline - time.perf_counter()) if deadline is not None else None
                    )
                    if (
                        retry_budget_seconds is None
                        or retry_budget_seconds > retry_delay_seconds + 0.25
                    ):
                        logger.warning(
                            "pkm.agent_contract_provider_retry agent=%s attempt=%s "
                            "max_attempts=%s delay_seconds=%s error_type=%s",
                            getattr(manifest, "id", "unknown"),
                            attempt,
                            max_attempts,
                            round(retry_delay_seconds, 3),
                            type(exc).__name__,
                        )
                        await asyncio.sleep(retry_delay_seconds)
                        continue
                logger.warning(
                    "pkm.agent_contract_failed agent=%s model=%s error_type=%s "
                    "provider_status=%s error_code=%s",
                    getattr(manifest, "id", "unknown"),
                    active_model,
                    type(exc).__name__,
                    self._provider_status_code(exc),
                    self._provider_error_code(exc),
                )
                record("error", attempts=attempt, error_type=type(exc).__name__)
                return None
        return None

    @staticmethod
    def _remaining_preview_budget_seconds(deadline: float | None) -> float | None:
        if deadline is None:
            return None
        return max(0.0, deadline - time.perf_counter())

    @classmethod
    def _build_state_summary(cls, simulated_state: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(simulated_state, dict):
            return {"domains": [], "recent_memories": []}
        recent_memories = []
        for memory in simulated_state.get("memories") or []:
            if not isinstance(memory, dict):
                continue
            recent_memories.append(
                {
                    "domain": cls._normalize_segment(str(memory.get("domain") or "")),
                    "entity_id": cls._normalize_segment(str(memory.get("entity_id") or "")),
                    "entity_scope": cls._normalize_path(str(memory.get("entity_scope") or "")),
                    "intent_class": cls._normalize_segment(str(memory.get("intent_class") or "")),
                    "message": cls._safe_excerpt(str(memory.get("message") or ""), limit=200),
                    "active": bool(memory.get("active", True)),
                }
            )
            if len(recent_memories) >= 10:
                break
        domains = [
            cls._normalize_segment(str(domain))
            for domain in (simulated_state.get("domains") or [])
            if cls._normalize_segment(str(domain))
        ]
        return {
            "domains": cls._unique_list(domains),
            "recent_memories": recent_memories,
        }

    @classmethod
    def _compact_registry_choices(
        cls,
        registry_choices: list[dict[str, Any]],
    ) -> list[str]:
        # Compact metadata, not the vocabulary: truncation makes later domains
        # impossible to select when the prompt requires these exact keys.  The
        # resulting list is still a model-facing allowlist, so reserved,
        # internal, and malformed domain keys must not consume its context or
        # invite a target the generic PKM writer will reject.
        compact: list[str] = []
        for entry in registry_choices:
            if not isinstance(entry, dict):
                continue
            raw_domain_key = cls._normalize_segment(str(entry.get("domain_key") or ""))
            if not raw_domain_key or raw_domain_key == _GENERAL_DOMAIN_KEY:
                continue
            try:
                domain_key = validate_dynamic_top_level_domain(raw_domain_key)
            except ValueError:
                continue
            compact.append(domain_key)
        return cls._unique_list(compact)

    @classmethod
    def _compact_state_summary(cls, simulated_state: dict[str, Any] | None) -> dict[str, Any]:
        summary = cls._build_state_summary(simulated_state)
        recent = []
        for memory in summary.get("recent_memories") or []:
            if not isinstance(memory, dict):
                continue
            recent.append(
                {
                    "domain": cls._normalize_segment(str(memory.get("domain") or "")),
                    "entity_id": cls._normalize_segment(str(memory.get("entity_id") or "")),
                    "entity_scope": cls._normalize_path(str(memory.get("entity_scope") or "")),
                    "intent_class": cls._normalize_segment(str(memory.get("intent_class") or "")),
                    "message_hint": cls._safe_excerpt(str(memory.get("message") or ""), limit=80),
                    "active": bool(memory.get("active", True)),
                }
            )
            if len(recent) >= 4:
                break
        return {
            "domains": summary.get("domains") or [],
            "recent_memories": recent,
        }

    def _build_memory_segmentation_prompt(
        self,
        *,
        message: str,
        strict_small_model: bool,
    ) -> str:
        # The manifest owns semantic instructions in both managed ADK and
        # direct-client paths. The prompt carries the worked examples and the
        # owner's material serialized as input, nothing else.
        return self._agent_request(
            self.memory_segmentation_manifest,
            {"message": message, "strict_small_model": strict_small_model},
        )

    @staticmethod
    @lru_cache(maxsize=1)
    def _few_shot_examples() -> tuple[dict[str, Any], ...]:
        payload = json.loads(_PKM_FEW_SHOT_PATH.read_text(encoding="utf-8"))
        return tuple(payload.get("examples") or ())

    @classmethod
    def _few_shot_block(cls, agent_id: str) -> str:
        """This agent's worked examples from the versioned set, or nothing."""

        rows = [
            f"Input: {cls._compact_json(example['input'])}\n"
            f"Answer: {cls._compact_json(example['answer'])}"
            for example in cls._few_shot_examples()
            if example.get("agent") == agent_id
        ]
        return f"{_FEW_SHOT_HEADER}\n" + "\n".join(rows) + "\n\n" if rows else ""

    @staticmethod
    def _compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def _agent_request(cls, manifest: Any, request: dict[str, Any]) -> str:
        """Worked examples, then the request as JSON. No instruction text.

        Every rule lives once, in the manifest's system instruction, which the
        runtime sends as the system instruction. Restating rules here is how
        the intent instruction came to be sent twice per call.
        """

        agent_id = str(getattr(manifest, "id", "") or "")
        body = {key: value for key, value in request.items() if value not in (None, [], "")}
        return f"{cls._few_shot_block(agent_id)}Request: {cls._compact_json(body)}"

    @classmethod
    def _existing_entities(
        cls, simulated_state: dict[str, Any] | None, *, compact: bool
    ) -> list[dict[str, Any]]:
        """The owner's saved entities sent as context, in the order given.

        Only active entities: an inactive one can be neither extended nor
        corrected. The device already ranks them by relevance.
        """

        summary = (
            cls._compact_state_summary(simulated_state)
            if compact
            else cls._build_state_summary(simulated_state)
        )
        entities = []
        for memory in summary.get("recent_memories") or []:
            if not isinstance(memory, dict) or not memory.get("active", True):
                continue
            entities.append(
                {
                    "domain": memory.get("domain") or "",
                    "entity_id": memory.get("entity_id") or "",
                    "entity_scope": memory.get("entity_scope") or "",
                    "intent_class": memory.get("intent_class") or "",
                    "summary": memory.get("message") or memory.get("message_hint") or "",
                }
            )
        return entities

    @classmethod
    def _fallback_intent_frame(
        cls,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
    ) -> dict[str, Any]:
        normalized = cls._safe_excerpt(message, limit=800).lower()
        tokens = cls._message_tokens(message)
        message_words = tokens
        ranked_domains = cls._keyword_ranked_domains(
            message=message, current_domains=current_domains
        )
        has_refinement_signal = cls._has_refinement_signal(message)
        is_explicitly_unresolved = any(
            phrase in normalized
            for phrase in (
                "not enough for you to store",
                "have not said what that means",
                "have not picked whether",
                "still unsure",
                "still too vague",
            )
        )
        is_pkm_governance_note = (
            "pkm write" in normalized
            or "memory is specific" in normalized
            or normalized.startswith("broad food preferences")
            or normalized.startswith("broad travel memories")
            or normalized.startswith("broad health constraints")
            or "reminders kept separate from durable pkm" in normalized
            or "vague prompts to trigger confirmation" in normalized
            or normalized.startswith("i want the system to ")
        )
        is_vague_capture = any(
            phrase in normalized
            for phrase in (
                "not being specific enough",
                "leaving it vague",
                "cleaner way to describe",
                "something about",
            )
        )
        is_plan_or_goal = any(
            phrase in normalized
            for phrase in (
                "a big goal",
                "i am still working toward",
                "i want my travel plans",
                "i want my work week",
                "my planning still",
                "choices work best",
                "support steady",
                "i want to save",
                "save for",
                "pay off",
                "student loan",
                "student loans",
            )
        )
        is_routine = any(
            phrase in normalized
            for phrase in (
                "every morning",
                "daily ",
                "weekly ",
                "weekends go better",
                "calendar is not overloaded",
                "shopping list is deliberate",
            )
        )

        save_class = "durable"
        intent_class = "note"
        mutation_intent = "create"
        confidence = 0.68
        confirmation_reason = ""

        if cls._looks_opaque_or_nonsense(message):
            save_class = "ephemeral"
            intent_class = "ambiguous"
            mutation_intent = "no_op"
            confidence = 0.98
        elif (
            any(phrase in normalized for phrase in _AMBIGUOUS_PREFIXES)
            or is_vague_capture
            or is_explicitly_unresolved
        ):
            save_class = "ambiguous"
            intent_class = "ambiguous"
            mutation_intent = "no_op"
            confidence = 0.52
            confirmation_reason = "The message is too short or underspecified to safely choose one durable PKM domain."
        elif (
            normalized.startswith("remind me")
            or normalized.startswith("please remind")
            or normalized.startswith("please order")
            or normalized.startswith("order ")
            or "todo" in tokens
            or "to_do" in tokens
            or (
                "reminders" in tokens
                and "durable" in tokens
                and "pkm" in tokens
                and ("one" in tokens or "off" in tokens)
            )
        ):
            save_class = "ephemeral"
            intent_class = "task_or_reminder"
            mutation_intent = "no_op"
            confidence = 0.92
        elif is_pkm_governance_note:
            # Product-governance statements are durable owner preferences about
            # PKM behavior. They are never investment information, even when
            # they mention finance, scopes, or consent.
            save_class = "durable"
            intent_class = "note"
            mutation_intent = "extend"
            confidence = 0.8
        elif cls._is_deletion_message(message):
            save_class = "durable"
            intent_class = "deletion"
            mutation_intent = "delete"
            confidence = 0.9
        elif cls._is_correction_message(message):
            save_class = "durable"
            intent_class = "correction"
            mutation_intent = "correct"
            confidence = 0.88
        elif is_routine:
            save_class = "durable"
            intent_class = "routine"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.8
        elif is_plan_or_goal:
            save_class = "durable"
            intent_class = "plan_or_goal"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.8
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_LOCATION_HINTS,
        ):
            save_class = "durable"
            intent_class = "profile_fact"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.78
        elif (
            any(
                phrase in normalized
                for phrase in (
                    "i like",
                    "i also like",
                    "i love",
                    "i prefer",
                    "i still prefer",
                    "i still lean",
                    "my favorite",
                )
            )
            or normalized.startswith("i want simple repeatable meals")
            or ("prefer" in tokens and not normalized.startswith(("delete", "remove", "forget")))
            or (
                "like" in tokens
                and bool(ranked_domains)
                and not normalized.startswith(("delete", "remove", "forget", "remind me"))
            )
        ):
            save_class = "durable"
            intent_class = "preference"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.78
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_FOOD_HINTS,
        ):
            save_class = "durable"
            intent_class = "preference"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.76
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_HEALTH_HINTS,
        ):
            save_class = "durable"
            intent_class = "health"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.8
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_TRAVEL_HINTS,
        ):
            save_class = "durable"
            intent_class = "preference"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.78
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_SHOPPING_HINTS,
        ):
            save_class = "durable"
            intent_class = (
                "shopping_need"
                if normalized.startswith("i need") or "usually buy" in normalized
                else "preference"
            )
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.76
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_RELATIONSHIP_HINTS,
        ):
            save_class = "durable"
            intent_class = "relationship"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.76
        elif cls._contains_any_hint(
            normalized_message=normalized,
            message_words=message_words,
            hints=_PROFESSIONAL_HINTS,
        ):
            save_class = "durable"
            intent_class = "preference" if "prefer" in tokens else "profile_fact"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.76
        elif len(tokens) <= 2:
            save_class = "ambiguous"
            intent_class = "ambiguous"
            mutation_intent = "no_op"
            confidence = 0.42
            confirmation_reason = "The message is too short or underspecified to safely choose one durable PKM domain."
        elif any(token in normalized for token in ("daily ", "weekly ")):
            save_class = "durable"
            intent_class = "routine"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.74
        elif any(
            token in normalized for token in ("goal", "plan", "want to", "planning", "this year")
        ):
            save_class = "durable"
            intent_class = "plan_or_goal"
            mutation_intent = "extend" if has_refinement_signal else "create"
            confidence = 0.73

        requires_confirmation = save_class == "ambiguous" or confidence < 0.64
        if intent_class in {"correction", "deletion", "financial_event"} and confidence >= 0.8:
            requires_confirmation = False
        if cls._looks_opaque_or_nonsense(message):
            requires_confirmation = False
            confirmation_reason = ""
        if requires_confirmation and not confirmation_reason:
            confirmation_reason = "The message could fit more than one broad domain, so Kai should confirm the user's intent before save."
        candidate_domain_choices = cls._candidate_domain_choices(
            ranked_domains=cls._default_domains_for_intent(
                intent_class=intent_class,
                message=message,
                current_domains=current_domains,
            )
            or ranked_domains,
            registry_choices=registry_choices,
        )
        return {
            "save_class": save_class,
            "intent_class": intent_class,
            "mutation_intent": mutation_intent,
            "requires_confirmation": requires_confirmation,
            "confirmation_reason": confirmation_reason,
            "candidate_domain_choices": candidate_domain_choices,
            "confidence": confidence,
            "source_agent": "memory_intent_agent",
            "contract_version": 1,
        }

    @classmethod
    def _sanitize_intent_frame(
        cls,
        *,
        message: str,
        raw: dict[str, Any] | None,
        fallback: dict[str, Any],
        registry_choices: list[dict[str, Any]],
        current_domains: list[str],
    ) -> dict[str, Any]:
        """Take the intent agent's frame, falling back only where it did not speak.

        The block below this one adopts every field the model returned that is
        valid for its enum, which is the right shape. What followed it was not:
        five separate rules let `_fallback_intent_frame` -- a keyword and regex
        classifier -- overwrite `save_class`, `intent_class` and
        `mutation_intent` outright, and none of them consulted the model's
        confidence, only the fallback's own.

        The widest of them fired whenever the fallback scored >= 0.76 and
        wanted no confirmation, for 11 of the 14 intent classes. Measured
        2026-09-11 over twelve ordinary sentences, it outranked the model on
        four: "I prefer espresso without sugar", "Remind me to renew my Costco
        membership", "I sleep badly when I eat late" and one other. On the
        third of those the rule files a sleep observation as `preference`
        whatever the model concluded, which is how a health signal ends up
        shelved beside a coffee order.

        That is the first shape named in AGENTS.md principle 9: a rule that
        DECIDES INSTEAD OF the model. So each of those rules now applies only
        when the model did not answer -- where the fallback is the only
        judgement that exists and is therefore correct, the exception principle
        9 states explicitly.

        A rule that WOULD have fired against a real answer is logged rather
        than dropped in silence. The disagreement rate is the number that says
        whether the prompt needs work, and it cannot be read off a rule that
        wins invisibly.
        """
        model_answered = isinstance(raw, dict) and bool(raw)
        suppressed: list[str] = []
        frame = deepcopy(fallback)
        if isinstance(raw, dict):
            save_class = str(raw.get("save_class") or frame["save_class"]).strip().lower()
            if save_class in _SAVE_CLASSES:
                frame["save_class"] = save_class

            intent_class = str(raw.get("intent_class") or frame["intent_class"]).strip().lower()
            if intent_class in _INTENT_CLASSES:
                frame["intent_class"] = intent_class

            mutation_intent = (
                str(raw.get("mutation_intent") or frame["mutation_intent"]).strip().lower()
            )
            if mutation_intent in _MUTATION_INTENTS:
                frame["mutation_intent"] = mutation_intent

            frame["requires_confirmation"] = bool(
                raw.get("requires_confirmation", frame["requires_confirmation"])
            )
            frame["confirmation_reason"] = str(
                raw.get("confirmation_reason") or frame["confirmation_reason"] or ""
            ).strip()
            frame["confidence"] = cls._clamp_confidence(
                raw.get("confidence"),
                default=float(frame["confidence"]),
            )
            frame["source_agent"] = (
                cls._normalize_segment(str(raw.get("source_agent") or "")) or "memory_intent_agent"
            )
            try:
                frame["contract_version"] = int(raw.get("contract_version") or 1)
            except Exception:
                frame["contract_version"] = 1

            raw_choices = raw.get("candidate_domain_choices")
            if isinstance(raw_choices, list) and raw_choices:
                ranked_domains = [
                    cls._normalize_segment(str(entry.get("domain_key") or ""))
                    for entry in raw_choices
                    if isinstance(entry, dict)
                ]
            else:
                ranked_domains = [
                    choice["domain_key"] for choice in frame.get("candidate_domain_choices", [])
                ]
            frame["candidate_domain_choices"] = cls._candidate_domain_choices(
                ranked_domains=ranked_domains
                or cls._default_domains_for_intent(
                    intent_class=frame["intent_class"],
                    message=message,
                    current_domains=current_domains,
                ),
                registry_choices=registry_choices,
            )

        if frame["intent_class"] == "command":
            # The intent agent's own answer, made consistent: a live command is
            # never memory, whatever save_class came with it.
            frame["save_class"] = "ephemeral"
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
        if frame["save_class"] == "ambiguous":
            frame["requires_confirmation"] = True
            frame["mutation_intent"] = "no_op"
        if frame["save_class"] == "ephemeral":
            frame["mutation_intent"] = "no_op"
        fallback_confidence = cls._clamp_confidence(fallback.get("confidence"), default=0.0)
        wide_override = (
            fallback_confidence >= 0.76
            and fallback.get("save_class") in _SAVE_CLASSES
            and not fallback.get("requires_confirmation")
        )
        if wide_override and model_answered:
            suppressed.append("fallback_confidence_override")
        if wide_override and not model_answered:
            fallback_choices = fallback.get("candidate_domain_choices") or []
            if fallback_choices:
                frame["candidate_domain_choices"] = deepcopy(fallback_choices)
            if fallback.get("save_class") in {"ephemeral", "ambiguous"} or fallback.get(
                "intent_class"
            ) in {
                "preference",
                "profile_fact",
                "routine",
                "plan_or_goal",
                "relationship",
                "health",
                "financial_event",
                "correction",
                "deletion",
                "task_or_reminder",
                "note",
            }:
                frame["save_class"] = fallback["save_class"]
                frame["intent_class"] = fallback["intent_class"]
                frame["mutation_intent"] = fallback["mutation_intent"]
                frame["requires_confirmation"] = False
                frame["confirmation_reason"] = ""
                frame["confidence"] = max(
                    float(frame.get("confidence") or 0.0), fallback_confidence
                )
        if cls._looks_opaque_or_nonsense(message):
            frame["save_class"] = "ephemeral"
            frame["intent_class"] = "ambiguous"
            frame["mutation_intent"] = "no_op"
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
            frame["confidence"] = max(0.98, float(frame.get("confidence") or 0.0))
        elif fallback.get("save_class") == "ambiguous" and model_answered:
            suppressed.append("fallback_ambiguous_override")
        elif fallback.get("save_class") == "ambiguous":
            frame["save_class"] = "ambiguous"
            frame["intent_class"] = "ambiguous"
            frame["mutation_intent"] = "no_op"
            frame["requires_confirmation"] = True
            frame["confirmation_reason"] = fallback.get("confirmation_reason") or (
                "The message is too short or underspecified to safely choose one durable PKM domain."
            )
            frame["confidence"] = max(
                float(frame.get("confidence") or 0.0),
                float(fallback.get("confidence") or 0.0),
            )
        elif fallback.get("save_class") == "ephemeral" and model_answered:
            suppressed.append("fallback_ephemeral_override")
        elif fallback.get("save_class") == "ephemeral":
            frame["save_class"] = "ephemeral"
            frame["intent_class"] = fallback.get("intent_class") or frame["intent_class"]
            frame["mutation_intent"] = "no_op"
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
            frame["confidence"] = max(
                float(frame.get("confidence") or 0.0),
                float(fallback.get("confidence") or 0.0),
            )
        elif (
            fallback.get("save_class") == "durable"
            and fallback.get("mutation_intent") in {"correct", "delete"}
            and frame.get("mutation_intent") != fallback.get("mutation_intent")
            and (
                not model_answered
                or (
                    "\n" not in message.strip()
                    and message.strip()
                    .lower()
                    .startswith(
                        ("actually i ", "actually, i ", "update my ", "delete my ", "forget my ")
                    )
                )
            )
        ):
            # DELIBERATELY NOT gated on model_answered, unlike the three rules
            # above it. This is the one place the fallback is catching an
            # explicit cue rather than substituting a judgement.
            #
            # `test_obvious_location_correction_recovers_from_model_no_op`
            # holds the case: the model answers `ephemeral` / `ambiguous` /
            # `no_op` to "Actually I live in New York City now." A correction
            # dropped is the person's own record left wrong, and it is silent
            # -- nothing tells them the update did not land. That is a
            # data-integrity guard, which AGENTS.md principle 9 and
            # backend-semantic-boundary.md both place outside this doctrine,
            # the same way a security guard sits outside it.
            #
            # The durable fix is still the prompt: "Actually" and "No, ..."
            # opening a sentence are corrections, and the intent agent should
            # say so without help. When the live disagreement rate for this
            # rule reaches zero, it can go. Until then it stays, because the
            # failure it prevents is one-directional and unrecoverable.
            frame["save_class"] = "durable"
            frame["intent_class"] = fallback["intent_class"]
            frame["mutation_intent"] = fallback["mutation_intent"]
            frame["requires_confirmation"] = True
            frame["confirmation_reason"] = (
                frame.get("confirmation_reason")
                or "Confirm the requested change to your saved information."
            )
            logger.info(
                "pkm_intent_integrity_guard_applied operation=%s", fallback["mutation_intent"]
            )
            frame["confidence"] = max(
                float(frame.get("confidence") or 0.0),
                float(fallback.get("confidence") or 0.0),
            )
            frame["candidate_domain_choices"] = deepcopy(
                fallback.get("candidate_domain_choices") or []
            )
        elif (
            fallback.get("save_class") == "durable"
            and fallback.get("mutation_intent") == "extend"
            and frame.get("mutation_intent") in {"create", "no_op"}
            and not frame.get("requires_confirmation")
            and model_answered
        ):
            suppressed.append("fallback_extend_override")
        elif (
            fallback.get("save_class") == "durable"
            and fallback.get("mutation_intent") == "extend"
            and frame.get("mutation_intent") in {"create", "no_op"}
            and not frame.get("requires_confirmation")
        ):
            frame["save_class"] = "durable"
            frame["intent_class"] = fallback.get("intent_class") or frame["intent_class"]
            frame["mutation_intent"] = "extend"
            frame["candidate_domain_choices"] = deepcopy(
                fallback.get("candidate_domain_choices")
                or frame.get("candidate_domain_choices")
                or []
            )
            frame["confidence"] = max(
                float(frame.get("confidence") or 0.0),
                float(fallback.get("confidence") or 0.0),
            )
        elif (
            fallback.get("save_class") == "durable"
            and not fallback.get("requires_confirmation")
            and cls._clamp_confidence(fallback.get("confidence"), default=0.0) >= 0.73
            and (
                frame.get("intent_class") != fallback.get("intent_class")
                or frame.get("mutation_intent") != fallback.get("mutation_intent")
            )
            and model_answered
        ):
            # The widest rule in the method, and the clearest case of the
            # doctrine's first shape: its trigger condition IS disagreement
            # with the model, and it resolved that disagreement in the rule's
            # favour every time, at a lower bar (0.73) than the confidence
            # rule above it (0.76).
            #
            # Measured: "I sleep badly when I eat late." The intent agent
            # returns `health` at 0.93 confidence; the keyword classifier says
            # `preference` at 0.76; this rule filed it as `preference`. The
            # model's own confidence was never part of the comparison.
            suppressed.append("fallback_disagreement_override")
        elif (
            fallback.get("save_class") == "durable"
            and not fallback.get("requires_confirmation")
            and cls._clamp_confidence(fallback.get("confidence"), default=0.0) >= 0.73
            and (
                frame.get("intent_class") != fallback.get("intent_class")
                or frame.get("mutation_intent") != fallback.get("mutation_intent")
            )
        ):
            frame["save_class"] = "durable"
            frame["intent_class"] = fallback.get("intent_class") or frame["intent_class"]
            frame["mutation_intent"] = fallback.get("mutation_intent") or frame["mutation_intent"]
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
            frame["candidate_domain_choices"] = deepcopy(
                fallback.get("candidate_domain_choices")
                or frame.get("candidate_domain_choices")
                or []
            )
            frame["confidence"] = max(
                float(frame.get("confidence") or 0.0),
                float(fallback.get("confidence") or 0.0),
            )
        if (
            frame["intent_class"] in {"correction", "deletion", "financial_event"}
            and frame["confidence"] >= 0.8
            and not model_answered
        ):
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
        if (
            fallback.get("save_class") == "durable"
            and not fallback.get("requires_confirmation")
            and frame.get("save_class") == "durable"
            and frame.get("requires_confirmation")
            and cls._clamp_confidence(fallback.get("confidence"), default=0.0) >= 0.7
            and not model_answered
        ):
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
        if frame["requires_confirmation"] and not frame["confirmation_reason"]:
            frame["confirmation_reason"] = (
                "Kai needs a quick confirmation before writing this memory into the PKM."
            )
        if suppressed:
            # INFO, not a hint on the frame: the frame is persisted and its
            # shape is a schema. A rate rising here says the prompt and the
            # keyword classifier disagree more often than they used to, which
            # is a prompt to fix, not a rule to restore.
            logger.info(
                "pkm_intent_rule_suppressed rules=%s intent_class=%s save_class=%s",
                ",".join(suppressed),
                frame.get("intent_class"),
                frame.get("save_class"),
            )

        return frame

    @classmethod
    def _root_scope_for_intent(
        cls, intent_class: str, target_domain: str, message: str = ""
    ) -> str:
        domain = cls._normalize_segment(target_domain)
        intent = cls._normalize_segment(intent_class)
        normalized = cls._safe_excerpt(message, limit=240).lower()
        if intent == "preference":
            if domain == "health":
                if any(
                    token in normalized
                    for token in (
                        "swim",
                        "run",
                        "walk",
                        "stretch",
                        "workout",
                        "exercise",
                        "mobility",
                    )
                ):
                    return "activities"
                if any(token in normalized for token in ("sleep", "wake", "bed", "rest")):
                    return "sleep_preferences"
                if any(
                    token in normalized
                    for token in ("allerg", "diet", "avoid", "gluten", "dairy", "peanut")
                ):
                    return "dietary_constraints"
                return "preferences"
            if domain == "travel":
                if any(token in normalized for token in ("seat", "window", "aisle")):
                    return "seat_preferences"
                return "preferences"
            if domain == "food":
                return "preferences"
            if domain == "shopping":
                return "product_preferences"
            if domain == "professional":
                return "work_preferences"
            return "preferences"
        if intent == "profile_fact":
            return "profile"
        if intent == "routine":
            return "routines"
        if intent == "task_or_reminder":
            return "tasks"
        if intent == "plan_or_goal":
            return "goals"
        if intent == "relationship":
            return "relationships"
        if intent == "health":
            if any(
                token in normalized
                for token in ("swim", "run", "walk", "stretch", "workout", "exercise", "fitness")
            ):
                return "activities"
            if any(token in normalized for token in ("allerg", "intoler", "constraint", "avoid")):
                return "dietary_constraints"
            return "records"
        if intent == "travel":
            return "travel_notes"
        if intent == "shopping_need":
            return "shopping"
        if intent == "financial_event":
            return "events"
        if intent in {"correction", "deletion"}:
            if domain == "location" and any(
                token in normalized
                for token in ("based", "base", "live", "lives", "living", "home", "city")
            ):
                return "profile"
            return cls._root_scope_for_intent("preference", domain, message=message)
        return "notes"

    @classmethod
    def _scope_paths_for_domain(
        cls,
        *,
        registry_choices: list[dict[str, Any]],
        domain: str,
    ) -> list[str]:
        normalized_domain = cls._normalize_segment(domain)
        paths: list[str] = []
        for entry in registry_choices:
            if not isinstance(entry, dict):
                continue
            if cls._normalize_segment(str(entry.get("domain_key") or "")) != normalized_domain:
                continue
            for path in entry.get("scope_paths") or []:
                normalized_path = cls._normalize_path(str(path))
                if normalized_path:
                    paths.append(normalized_path)
            for registry_entry in entry.get("scope_registry") or []:
                if not isinstance(registry_entry, dict):
                    continue
                projection = registry_entry.get("summary_projection") or {}
                if not cls._is_consumer_visible_scope_projection(projection):
                    continue
                normalized_path = cls._normalize_path(
                    str(
                        projection.get("top_level_scope_path")
                        or registry_entry.get("top_level_scope_path")
                        or ""
                    )
                )
                if normalized_path:
                    paths.append(normalized_path)
        return cls._unique_list(paths)

    @classmethod
    def _scope_tokens(cls, path: str) -> set[str]:
        tokens: set[str] = set()
        for part in re.split(r"[._\-\s]+", cls._normalize_path(path)):
            if not part or part in _STRUCTURAL_SCOPE_TOKENS:
                continue
            tokens.add(part)
            if part.endswith("s") and len(part) > 3:
                tokens.add(part[:-1])
        return tokens

    @classmethod
    def _contains_changes_branch(cls, value: Any) -> bool:
        if isinstance(value, dict):
            for key, child in value.items():
                if cls._normalize_segment(str(key)) == "changes":
                    return True
                if cls._contains_changes_branch(child):
                    return True
        elif isinstance(value, list):
            return any(cls._contains_changes_branch(item) for item in value)
        return False

    @classmethod
    def _strip_internal_metadata(cls, value: Any) -> tuple[Any, bool]:
        if isinstance(value, dict):
            stripped: dict[str, Any] = {}
            removed = False
            for key, child in value.items():
                normalized_key = cls._normalize_segment(str(key))
                key_tokens = {token for token in re.split(r"[._\-\s]+", normalized_key) if token}
                if normalized_key in _INTERNAL_METADATA_SCOPE_TOKENS or (
                    key_tokens & _INTERNAL_METADATA_SCOPE_TOKENS
                ):
                    removed = True
                    continue
                stripped_child, child_removed = cls._strip_internal_metadata(child)
                stripped[key] = stripped_child
                removed = removed or child_removed
            return stripped, removed
        if isinstance(value, list):
            next_items = []
            removed = False
            for item in value:
                stripped_item, item_removed = cls._strip_internal_metadata(item)
                next_items.append(stripped_item)
                removed = removed or item_removed
            return next_items, removed
        return value, False

    @classmethod
    def _drift_flags_from_preview(
        cls,
        *,
        validation_hints: list[str],
        fallback_used: bool,
        intent_used_fallback: bool = False,
        merge_used_fallback: bool = False,
        structure_used_fallback: bool = False,
        intent_skipped: bool = False,
        merge_skipped: bool = False,
        structure_skipped: bool = False,
    ) -> dict[str, bool]:
        hints = {cls._normalize_segment(str(hint)) for hint in validation_hints if hint}
        return {
            # Deliberately NOT folded into fallback_used. A fallback means the
            # model answered badly or not at all; a skip means it was never
            # consulted. Collapsing them would hide the second behind a metric
            # that looks healthy precisely when the intelligence is absent.
            "stage_skipped": bool(intent_skipped or merge_skipped or structure_skipped),
            "intent_skipped": bool(intent_skipped),
            "merge_skipped": bool(merge_skipped),
            "structure_skipped": bool(structure_skipped),
            "fallback_used": bool(
                fallback_used
                or intent_used_fallback
                or merge_used_fallback
                or structure_used_fallback
            ),
            "scope_defaulted": bool(
                hints
                & {
                    "dynamic_scope_metadata_no_specific_match",
                    "primary_path_defaulted_to_root_scope",
                    "primary_path_missing",
                    "unresolved_domain_choice",
                }
            ),
            "duplicate_candidate": "possible_duplicate_memory" in hints,
            "correction_without_target": bool(
                hints
                & {
                    "correction_without_prior_target_treated_as_update",
                    "correction_without_prior_target_kept_as_new_entity",
                    "mutation_target_missing",
                }
            ),
            "changes_branch_blocked": bool(
                hints
                & {
                    "changes_branch_blocked",
                    "crud_payload_aligned_to_merge_target",
                }
            ),
            "internal_metadata_blocked": "internal_metadata_blocked" in hints,
            # A model target inside an app-owned branch, moved to that branch's
            # agent_memory sibling by the registry. Recorded, never silent.
            "reserved_target_rerouted_to_sibling": "reserved_target_rerouted_to_sibling" in hints,
        }

    @classmethod
    def _preferred_scope_from_metadata(
        cls,
        *,
        intent_class: str,
        target_domain: str,
        message: str,
        fallback_scope: str,
        registry_choices: list[dict[str, Any]],
    ) -> tuple[str, str | None]:
        fallback = cls._normalize_path(fallback_scope) or "notes"
        available_paths = cls._scope_paths_for_domain(
            registry_choices=registry_choices,
            domain=target_domain,
        )
        if not available_paths:
            return fallback, None
        if fallback in available_paths and fallback not in {
            "preferences",
            "notes",
            "records",
            "shopping",
        }:
            return fallback, None

        message_tokens = cls._message_tokens(message)
        intent = cls._normalize_segment(intent_class)
        best_path = ""
        best_score = 0.0
        for path in available_paths:
            path_tokens = cls._scope_tokens(path)
            if not path_tokens:
                continue
            overlap = len(message_tokens & path_tokens)
            score = float(overlap * 3)
            if intent in {"preference", "correction", "deletion"} and (
                "preference" in path_tokens or "preferences" in path_tokens
            ):
                score += 1.5
            if intent == "profile_fact" and {"profile", "identity", "location"} & path_tokens:
                score += 1.0
            if (
                intent == "routine"
                and {"routine", "routines", "activity", "activities"} & path_tokens
            ):
                score += 1.0
            if intent == "plan_or_goal" and {"goal", "goals", "plan", "plans"} & path_tokens:
                score += 1.0
            if intent == "shopping_need":
                if {"product", "products", "preference", "preferences"} & path_tokens:
                    score += 1.5
                if ({"receipt", "receipts", "merchant"} & path_tokens) and (
                    {"receipt", "receipts", "merchant", "purchase", "purchases"} & message_tokens
                ):
                    score += 1.0
            if score > best_score:
                best_score = score
                best_path = path

        if best_path and best_score >= 1.0:
            return best_path, "dynamic_scope_metadata_selected"
        return fallback, "dynamic_scope_metadata_no_specific_match"

    @classmethod
    def _retarget_payload_root_scope(
        cls,
        payload: dict[str, Any],
        *,
        from_scope: str,
        to_scope: str,
    ) -> dict[str, Any]:
        source_scope = cls._normalize_path(from_scope)
        target_scope = cls._normalize_path(to_scope)
        if not source_scope or not target_scope or source_scope == target_scope:
            return payload
        if source_scope not in payload or target_scope in payload:
            return payload
        next_payload = deepcopy(payload)
        next_payload[target_scope] = next_payload.pop(source_scope)
        return next_payload

    @classmethod
    def _entity_scope_from_path(cls, path: str) -> str:
        normalized = cls._normalize_path(path)
        parts = [part for part in normalized.split(".") if part]
        if "entities" not in parts:
            return ""
        entity_index = parts.index("entities")
        return ".".join(parts[:entity_index])

    @classmethod
    def _memory_similarity_score(cls, left: str, right: str) -> float:
        left_tokens = cls._message_tokens(left) - _MEMORY_SIMILARITY_STOPWORDS
        right_tokens = cls._message_tokens(right) - _MEMORY_SIMILARITY_STOPWORDS
        if not left_tokens or not right_tokens:
            return 0.0
        intersection = len(left_tokens & right_tokens)
        union = len(left_tokens | right_tokens)
        return intersection / union if union else 0.0

    @classmethod
    def _fallback_merge_decision(
        cls,
        *,
        message: str,
        current_domains: list[str],
        intent_frame: dict[str, Any],
        simulated_state: dict[str, Any] | None,
    ) -> dict[str, Any]:
        recommended_domain = cls._first_recommended_domain(
            intent_frame,
            fallback=current_domains[0] if current_domains else _DEFAULT_CONFIRMATION_DOMAINS[0],
        )
        intent_class = cls._normalize_segment(str(intent_frame.get("intent_class") or "note"))
        mutation_intent = cls._normalize_segment(
            str(intent_frame.get("mutation_intent") or "create")
        )
        root_scope = cls._root_scope_for_intent(
            intent_class,
            recommended_domain,
            message=message,
        )
        default_entity_id = cls._stable_entity_id(
            domain=recommended_domain,
            intent_class=intent_class,
            message=message,
        )
        if mutation_intent == "no_op":
            return {
                "merge_mode": "no_op",
                "target_domain": recommended_domain,
                "target_entity_id": "",
                "target_entity_path": "",
                "match_confidence": cls._clamp_confidence(
                    intent_frame.get("confidence"), default=0.95
                ),
                "match_reason": "The message is not durable enough to create or modify PKM memory.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            }

        best_match: dict[str, Any] | None = None
        best_score = 0.0
        state_summary = cls._build_state_summary(simulated_state)
        for memory in state_summary.get("recent_memories") or []:
            if not isinstance(memory, dict):
                continue
            if not memory.get("active", True):
                continue
            memory_domain = cls._normalize_segment(str(memory.get("domain") or ""))
            if memory_domain != recommended_domain:
                continue
            score = cls._memory_similarity_score(message, str(memory.get("message") or ""))
            memory_scope = cls._normalize_path(str(memory.get("entity_scope") or ""))
            if mutation_intent in {"correct", "delete"} and memory_scope == "changes":
                continue
            if mutation_intent in {"correct", "delete"} and memory_scope:
                if memory_scope == root_scope:
                    score += 0.75
                elif memory_scope.startswith(f"{root_scope}.") or root_scope.startswith(
                    f"{memory_scope}."
                ):
                    score += 0.4
            if score > best_score:
                best_score = score
                best_match = memory

        target_entity_id = (
            cls._normalize_segment(str((best_match or {}).get("entity_id") or ""))
            or default_entity_id
        )
        target_entity_scope = (
            cls._normalize_path(str((best_match or {}).get("entity_scope") or "")) or root_scope
        )
        target_entity_path = (
            f"{target_entity_scope}.entities.{target_entity_id}"
            if target_entity_id and target_entity_scope
            else ""
        )
        merge_mode = "create_entity"
        match_reason = "Create a new durable entity for this memory."
        confidence = cls._clamp_confidence(intent_frame.get("confidence"), default=0.72)

        if mutation_intent == "correct" and best_match is not None:
            merge_mode = "correct_entity"
            match_reason = "The message corrects an existing active memory in the same domain."
            confidence = max(confidence, best_score)
        elif mutation_intent == "delete" and best_match is not None:
            merge_mode = "delete_entity"
            match_reason = "The message deletes an existing active memory in the same domain."
            confidence = max(confidence, best_score)
        elif (
            mutation_intent == "create"
            and best_match is not None
            and target_entity_scope == root_scope
            and best_score >= 0.12
        ):
            merge_mode = "extend_entity"
            match_reason = (
                "The message maps to an existing canonical memory, so it should refine "
                "that entity instead of creating a duplicate."
            )
            confidence = max(confidence, best_score)
        elif (
            mutation_intent in {"extend", "update"}
            and best_match is not None
            and (best_score >= 0.18 or (best_score > 0 and target_entity_scope == root_scope))
        ):
            merge_mode = "extend_entity"
            match_reason = "The message appears to refine an existing memory instead of creating a new concept."
            confidence = max(confidence, best_score)
        elif mutation_intent in {"correct", "delete"} and best_match is None:
            merge_mode = "no_op"
            target_entity_id = ""
            target_entity_path = ""
            match_reason = "No stable prior target was available for correction or deletion."

        return {
            "merge_mode": merge_mode,
            "target_domain": recommended_domain,
            "target_entity_id": target_entity_id,
            "target_entity_path": target_entity_path,
            "match_confidence": confidence,
            "match_reason": match_reason,
            "source_agent": "memory_merge_agent",
            "contract_version": 1,
        }

    @classmethod
    def _repeats_an_entity_verbatim(
        cls, message: str, existing_entities: list[dict[str, Any]]
    ) -> bool:
        def words(text: str) -> list[str]:
            return re.findall(r"[a-z0-9]+", text.lower())

        said = words(message)
        return bool(said) and any(
            isinstance(entity, dict) and words(str(entity.get("summary") or "")) == said
            for entity in existing_entities
        )

    @classmethod
    def _resolve_mutation_target(
        cls,
        *,
        decision: dict[str, Any],
        fallback: dict[str, Any],
        mutation_intent: str,
        existing_entities: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Validate the target of a correction or deletion; the model decides.

        The model reads the owner's existing entities and matches by meaning;
        the fallback matches by shared words. Until 2026-10-02 a word-match miss
        vetoed the model outright: a target it named was discarded, and a
        correction it kept as a new entity was dropped. Now a target the model
        names is kept when the owner has it, and its create_entity for a
        correction with no prior entity stands. A named target the owner does
        not have is never written to. A model no_op stays no_op unless the word
        match found a target, the recovery this code always made.
        """

        known = {
            f"{cls._normalize_path(str(entity.get('entity_scope') or ''))}.entities."
            f"{cls._normalize_segment(str(entity.get('entity_id') or ''))}"
            for entity in existing_entities
            if isinstance(entity, dict) and entity.get("entity_scope") and entity.get("entity_id")
        }
        mode = decision.get("merge_mode")
        targeted = mode in {"correct_entity", "delete_entity", "extend_entity"}
        if targeted and str(decision.get("target_entity_path") or "") in known:
            return decision
        if mode == "create_entity" and mutation_intent == "correct":
            return decision
        if fallback.get("merge_mode") in {"correct_entity", "delete_entity"}:
            return deepcopy(fallback)
        resolved = deepcopy(decision)
        resolved["target_entity_id"] = ""
        resolved["target_entity_path"] = ""
        if targeted and mutation_intent == "correct":
            # The model meant to write a new value to an entity the owner does
            # not have: keep the value as a new entity rather than invent a path.
            resolved["merge_mode"] = "create_entity"
            resolved["match_reason"] = "Correction with no prior entity; the new value is kept."
        else:
            resolved["merge_mode"] = "no_op"
            resolved["match_reason"] = fallback.get("match_reason") or (
                "No stable prior target was available for this mutation."
            )
        return resolved

    @classmethod
    def _sanitize_merge_decision(
        cls,
        *,
        raw: dict[str, Any] | None,
        fallback: dict[str, Any],
        intent_frame: dict[str, Any],
        current_domains: list[str],
        existing_entities: list[dict[str, Any]] | None = None,
        message: str = "",
    ) -> dict[str, Any]:
        decision = deepcopy(fallback)
        if isinstance(raw, dict):
            merge_mode = cls._normalize_segment(str(raw.get("merge_mode") or ""))
            if merge_mode in _MERGE_MODES:
                decision["merge_mode"] = merge_mode
            target_domain = cls._normalize_segment(str(raw.get("target_domain") or ""))
            if target_domain and target_domain != _GENERAL_DOMAIN_KEY:
                decision["target_domain"] = target_domain
            target_entity_id = cls._normalize_segment(str(raw.get("target_entity_id") or ""))
            if target_entity_id:
                decision["target_entity_id"] = target_entity_id
            target_entity_path = cls._normalize_path(str(raw.get("target_entity_path") or ""))
            if target_entity_path:
                decision["target_entity_path"] = target_entity_path
            decision["match_confidence"] = cls._clamp_confidence(
                raw.get("match_confidence"),
                default=float(decision["match_confidence"]),
            )
            reason = str(raw.get("match_reason") or "").strip()
            if reason:
                decision["match_reason"] = reason
            decision["source_agent"] = (
                cls._normalize_segment(str(raw.get("source_agent") or "")) or "memory_merge_agent"
            )
            try:
                decision["contract_version"] = int(raw.get("contract_version") or 1)
            except Exception:
                decision["contract_version"] = 1

        if cls._looks_opaque_or_nonsense(decision.get("match_reason") or ""):
            decision["match_reason"] = fallback["match_reason"]

        mutation_intent = cls._normalize_segment(str(intent_frame.get("mutation_intent") or ""))
        if mutation_intent in {"correct", "delete"}:
            decision = cls._resolve_mutation_target(
                decision=decision,
                fallback=fallback,
                mutation_intent=mutation_intent,
                existing_entities=existing_entities or [],
            )
        elif (
            mutation_intent in {"extend", "update"}
            and decision.get("merge_mode") == "no_op"
            and fallback.get("merge_mode") == "extend_entity"
            and not cls._repeats_an_entity_verbatim(message, existing_entities or [])
        ):
            # no_op is only for a word-for-word repeat (the shared kernel's
            # rule). A reaffirmation that adds words ("I still plan around
            # this: ...") extends the entity the word match found; the owner
            # reviews it. Measured 2026-10-02: merge dropped one such
            # statement in every release-chain repetition.
            decision = deepcopy(fallback)

        if decision["merge_mode"] in {"correct_entity", "delete_entity"}:
            decision_scope = cls._entity_scope_from_path(
                str(decision.get("target_entity_path") or "")
            )
            fallback_scope = cls._entity_scope_from_path(
                str(fallback.get("target_entity_path") or "")
            )
            if not decision_scope or decision_scope == "changes":
                decision["target_entity_id"] = fallback.get("target_entity_id") or ""
                decision["target_entity_path"] = fallback.get("target_entity_path") or ""
                decision_scope = fallback_scope
            if decision_scope == "changes":
                decision["merge_mode"] = "no_op"
                decision["target_entity_id"] = ""
                decision["target_entity_path"] = ""
                decision["match_reason"] = (
                    "No stable canonical entity target was available for this mutation."
                )

        if mutation_intent == "no_op":
            decision["merge_mode"] = "no_op"
            decision["target_entity_id"] = ""
            decision["target_entity_path"] = ""
        if (
            decision["merge_mode"] in {"correct_entity", "delete_entity"}
            and decision["target_domain"] not in current_domains
        ):
            decision["merge_mode"] = "no_op"
            decision["target_entity_id"] = ""
            decision["target_entity_path"] = ""
            decision["match_reason"] = (
                "The target domain does not exist yet, so mutation cannot safely be applied."
            )
        if decision["target_domain"] == _GENERAL_DOMAIN_KEY:
            decision["target_domain"] = cls._first_recommended_domain(
                intent_frame, fallback=fallback["target_domain"]
            )
        return decision

    @classmethod
    def _build_entity_record(
        cls,
        *,
        message: str,
        intent_frame: dict[str, Any],
        merge_decision: dict[str, Any],
    ) -> dict[str, Any]:
        intent_class = cls._normalize_segment(str(intent_frame.get("intent_class") or "note"))
        entity_id = cls._normalize_segment(str(merge_decision.get("target_entity_id") or ""))
        return {
            "entity_id": entity_id
            or cls._stable_entity_id(
                domain=str(merge_decision.get("target_domain") or "memory"),
                intent_class=intent_class,
                message=message,
            ),
            "kind": intent_class or "note",
            # The whole statement, never a clipped prefix: a segment is at most
            # _MAX_SEGMENT_SOURCE_CHARS. This record used to cut the summary
            # at 240 and the observation at 500 characters, so a long fact
            # that skipped the structure agent was saved incomplete.
            "summary": cls._safe_excerpt(message, limit=_MAX_SEGMENT_SOURCE_CHARS),
            "observations": [cls._safe_excerpt(message, limit=_MAX_SEGMENT_SOURCE_CHARS)],
            "status": _ENTITY_STATUS_ACTIVE,
        }

    @classmethod
    def _fallback_payload_from_intent(
        cls,
        *,
        message: str,
        intent_frame: dict[str, Any],
        merge_decision: dict[str, Any],
        target_domain: str,
    ) -> dict[str, Any]:
        intent_class = str(intent_frame.get("intent_class") or "note")
        root_scope = cls._root_scope_for_intent(
            intent_class,
            target_domain,
            message=message,
        )
        merge_mode = cls._normalize_segment(str(merge_decision.get("merge_mode") or ""))
        target_scope = cls._entity_scope_from_path(
            str(merge_decision.get("target_entity_path") or "")
        )
        if merge_mode in {"correct_entity", "delete_entity"} and target_scope:
            root_scope = target_scope
        entity = cls._build_entity_record(
            message=message,
            intent_frame=intent_frame,
            merge_decision=merge_decision,
        )
        if intent_class == "financial_event":
            entity["kind"] = "financial_memory"
        if intent_class == "deletion":
            entity["status"] = _ENTITY_STATUS_DELETED
        return {
            root_scope: {
                "entities": {
                    entity["entity_id"]: entity,
                }
            }
        }

    @classmethod
    def _strip_pii_from_payload_keys(cls, payload: Any) -> Any:
        """Recursively remove keys that contain PII embedded by the LLM.

        LLMs can encode sensitive data (balances, phone numbers, emails, SSNs)
        into JSON *keys* to bypass value-only scrubbers. This walks the full
        payload tree and drops any key whose name matches a PII pattern.
        """
        if isinstance(payload, dict):
            cleaned: dict[str, Any] = {}
            for key, value in payload.items():
                if _PII_IN_KEY_RE.search(str(key)):
                    continue
                cleaned[key] = cls._strip_pii_from_payload_keys(value)
            return cleaned
        if isinstance(payload, list):
            return [cls._strip_pii_from_payload_keys(item) for item in payload]
        return payload

    @classmethod
    def _sanitize_candidate_payload(
        cls,
        value: Any,
        *,
        message: str,
        intent_frame: dict[str, Any],
        merge_decision: dict[str, Any],
        target_domain: str,
    ) -> dict[str, Any]:
        if isinstance(value, dict) and value:
            return cls._strip_pii_from_payload_keys(value)
        return cls._fallback_payload_from_intent(
            message=message,
            intent_frame=intent_frame,
            merge_decision=merge_decision,
            target_domain=target_domain,
        )

    @classmethod
    def _walk_payload(
        cls,
        value: Any,
        path: list[str],
        paths: dict[str, dict[str, Any]],
        display_path: list[str] | None = None,
    ) -> None:
        """Record every path in a payload, with its owner-facing label.

        ``display_path`` mirrors ``path`` segment for segment, spelled the way
        the owner's data spells it. It is carried rather than derived because
        ``path`` has already been through ``_normalize_segment``: this walk is
        the only point where both forms exist at once, and therefore the only
        place the label can be authored correctly.
        """
        if display_path is None:
            display_path = list(path)
        if value is None:
            return

        current_path = ".".join(path)
        if current_path:
            is_array = isinstance(value, list)
            is_object = isinstance(value, dict)
            path_type = "array" if is_array else "object" if is_object else "leaf"
            paths[current_path] = {
                "json_path": current_path,
                "parent_path": ".".join(path[:-1]) if len(path) > 1 else None,
                "path_type": path_type,
                "exposure_eligibility": path_type == "leaf"
                and not any(
                    part in _BLOCKED_EXTERNAL_PATH_PARTS for part in current_path.split(".")
                ),
                "consent_label": cls._titleize_path(".".join(display_path)),
                "display_segment": (
                    None
                    if not display_path or display_path[-1] in _SYNTHETIC_SEGMENTS
                    else display_path[-1]
                ),
                "sensitivity_label": cls._infer_sensitivity(current_path),
                "segment_id": path[0] if path else "root",
                "source_agent": "pkm_structure_agent",
            }

        if isinstance(value, list):
            sample = next((item for item in value if item is not None), None)
            if sample is not None:
                cls._walk_payload(sample, [*path, "_items"], paths, [*display_path, "_items"])
            return

        if not isinstance(value, dict):
            return

        for raw_key, child_value in value.items():
            normalized_key = cls._normalize_segment(str(raw_key))
            if normalized_key:
                # raw_key, not normalized_key: the spelling still exists here.
                cls._walk_payload(
                    child_value, [*path, normalized_key], paths, [*display_path, str(raw_key)]
                )

    @classmethod
    def _payload_financial_signature(cls, payload: dict[str, Any]) -> bool:
        serialized = json.dumps(payload, sort_keys=True).lower()
        return any(token in serialized for token in _FINANCIAL_PAYLOAD_HINTS)

    @classmethod
    def _reserved_payload_hits(
        cls, *, target_domain: str, payload: dict[str, Any]
    ) -> dict[str, ReservedEntry]:
        """Top-level payload keys whose subtree touches an app-owned branch.

        Every path of the payload is checked against the registry, not only its
        top-level keys, so a reserved prefix below the root is still seen. The
        map is keyed by the top-level key that carries the hit.
        """
        paths: dict[str, dict[str, Any]] = {}
        cls._walk_payload(payload or {}, [], paths)
        hits: dict[str, ReservedEntry] = {}
        for path in [*paths, *(str(key) for key in (payload or {}))]:
            normalized = cls._normalize_path(path)
            entry = reserved_entry_for(target_domain, normalized)
            if entry is None:
                continue
            raw_key = next(
                (
                    key
                    for key in (payload or {})
                    if cls._normalize_path(str(key)) == normalized.split(".", 1)[0]
                ),
                None,
            )
            if raw_key is not None:
                hits.setdefault(str(raw_key), entry)
        return hits

    @classmethod
    def _deep_merge(cls, left: Any, right: Any) -> Any:
        if isinstance(left, dict) and isinstance(right, dict):
            merged = deepcopy(left)
            for key, value in right.items():
                merged[key] = (
                    cls._deep_merge(merged[key], value) if key in merged else deepcopy(value)
                )
            return merged
        return deepcopy(right)

    @classmethod
    def _remap_protocol_domain_name(
        cls,
        *,
        target_domain: str,
        payload: dict[str, Any],
        recommended_domain: str,
    ) -> tuple[str, dict[str, Any], bool]:
        """Keep a fact whose domain name collides with a protocol namespace.

        ``agent``, ``agents``, ``mcp`` and ``system`` are among the
        RESERVED_DYNAMIC_DOMAIN_SLUGS, so they can never be a person's domain. A statement about agent, MCP or system
        architecture is still the owner's work context: rather than refusing
        it, the fact moves into the intent's recommended domain (or
        ``professional``), nested under the name the model chose, so the
        subject survives as a branch. App-owned and internal domains are not
        handled here; they keep their own reserved-branch rules.
        """
        slug = cls._normalize_segment(target_domain)
        if slug not in _REMAPPABLE_PROTOCOL_DOMAIN_NAMES:
            return target_domain, payload, False
        replacement = cls._normalize_segment(recommended_domain or "")
        if (
            not replacement
            or replacement in RESERVED_DYNAMIC_DOMAIN_SLUGS
            or replacement == _GENERAL_DOMAIN_KEY
            or not is_valid_dynamic_top_level_domain(replacement)
        ):
            replacement = "professional"
        nested = {slug: deepcopy(payload)} if payload else {}
        return replacement, nested, True

    @classmethod
    def _reroute_reserved_payload(
        cls,
        *,
        target_domain: str,
        payload: dict[str, Any],
        whole_domain: bool = False,
    ) -> tuple[str, dict[str, Any], ReservedEntry | None, str | None, str | None]:
        """Move a payload aimed at an app-owned branch into its agent_memory sibling.

        ``contracts/pkm/reserved-branches.v1.json`` is the authority: a chat fact
        about saved places, RIA picks or a wallet card belongs to that feature's
        screen, and is kept in the sibling (``location.agent_memory``) until the
        owner commits it there. Returns ``(domain, payload, entry, blocked,
        branch)``. ``entry`` is the reserved entry that triggered a move, and
        ``branch`` the concrete branch it reserves here, both for the offer.
        ``blocked`` is a hint when the branch keeps no chat facts at all (KYC
        internals, runtime credentials, Secrets), or the move would have to
        split one card across two domains.
        """
        if whole_domain:
            hits = {str(key): reserved_entry_for(target_domain, "") for key in payload}
            if not payload:
                entry = reserved_entry_for(target_domain, "")
                hits = {"": entry} if entry else {}
        else:
            hits = cls._reserved_payload_hits(target_domain=target_domain, payload=payload)
        hits = {key: entry for key, entry in hits.items() if entry is not None}
        if not hits:
            return target_domain, payload, None, None, None
        first_key, first_entry = next(iter(hits.items()))
        branch = (
            first_entry.branch_prefix
            if first_entry.branch_prefix != "*"
            else cls._normalize_segment(first_key) or first_entry.domain
        )
        destinations = {
            key: sibling_for(
                entry.domain, entry.branch_prefix if entry.branch_prefix != "*" else ""
            )
            for key, entry in hits.items()
        }
        if any(destination is None for destination in destinations.values()):
            return target_domain, payload, first_entry, "reserved_branch_blocked", branch
        sibling_domains = {destination[1] for destination in destinations.values() if destination}
        if len(sibling_domains) != 1:
            return target_domain, payload, first_entry, "reserved_branch_blocked", branch
        sibling_domain = next(iter(sibling_domains))
        moved_keys = set(hits)
        remaining = {key: value for key, value in payload.items() if key not in moved_keys}
        if sibling_domain != target_domain and remaining:
            # One card writes one domain; never split it silently.
            return target_domain, payload, first_entry, "reserved_branch_blocked", branch
        next_payload = deepcopy(remaining)
        for key in hits:
            destination = destinations[key]
            if destination is None:  # excluded above; keeps the type checker honest
                continue
            sibling_branch = destination[2]
            subtree = payload.get(key, {}) if key else {}
            if not isinstance(subtree, dict):
                subtree = {cls._normalize_segment(key) or "note": subtree}
            next_payload[sibling_branch] = cls._deep_merge(
                next_payload.get(sibling_branch, {}), subtree
            )
        return sibling_domain, next_payload, first_entry, None, branch

    @classmethod
    def _reserved_offer(
        cls,
        *,
        entry: ReservedEntry | None,
        branch: str | None,
        raw_structure: dict[str, Any],
    ) -> dict[str, Any] | None:
        """The card's offer to commit the fact in the owning app's own screen."""
        raw_offer = raw_structure.get("reserved_offer")
        raw_offer = raw_offer if isinstance(raw_offer, dict) else {}
        if entry is None:
            # The model filed the fact in a sibling itself and named the branch.
            named = cls._normalize_path(str(raw_offer.get("branch") or ""))
            domain, _, rest = named.partition(".")
            entry = reserved_entry_for(domain, rest) if rest else None
            branch = rest.split(".", 1)[0] if entry is not None else None
        if entry is None or entry.offer_action is None or not entry.agent_memory_sibling:
            return None
        branch = branch or (entry.branch_prefix if entry.branch_prefix != "*" else entry.domain)
        label = " ".join(str(raw_offer.get("label") or "").split())[:48]
        if not label:
            # Model failure only: it filed a reserved fact without naming it.
            label = humanize_path(branch).lower()
        return {
            "domain": entry.domain,
            "branch": branch,
            # The agent's short noun ("Home"); the owning screen prefills from it.
            "subject": label,
            "owner_feature": entry.owner_feature,
            "agent_memory_sibling": entry.agent_memory_sibling,
            "offer_action": {
                "route_pattern": entry.offer_action.route_pattern,
                "action_id": entry.offer_action.action_id,
                "label": entry.offer_action.label(label),
            },
            "registry_version": reserved_registry_version(),
        }

    @classmethod
    def _first_recommended_domain(
        cls, intent_frame: dict[str, Any], fallback: str = "professional"
    ) -> str:
        for entry in intent_frame.get("candidate_domain_choices") or []:
            if isinstance(entry, dict) and entry.get("recommended"):
                domain_key = cls._normalize_segment(str(entry.get("domain_key") or ""))
                if domain_key and domain_key != _GENERAL_DOMAIN_KEY:
                    return domain_key
        return fallback

    @classmethod
    def _fallback_structure_decision(
        cls,
        *,
        message: str,
        current_domains: list[str],
        intent_frame: dict[str, Any],
        target_domain: str,
        candidate_payload: dict[str, Any],
    ) -> dict[str, Any]:
        path_map: dict[str, dict[str, Any]] = {}
        cls._walk_payload(candidate_payload, [], path_map)
        json_paths = sorted(path_map.keys())
        top_level_scope_paths = sorted({path.split(".", 1)[0] for path in json_paths if path})
        externalizable_paths = [
            path for path in json_paths if path_map[path].get("path_type") == "leaf"
        ]
        sensitivity_labels = {
            path: label
            for path, label in (
                (path, path_map[path].get("sensitivity_label")) for path in json_paths
            )
            if isinstance(label, str) and label
        }
        mutation_intent = str(intent_frame.get("mutation_intent") or "create")
        if target_domain in current_domains:
            action = (
                "match_existing_domain"
                if mutation_intent in {"update", "correct", "delete"}
                else "extend_domain"
            )
        else:
            action = "create_domain"
        return {
            "action": action,
            "target_domain": target_domain,
            "json_paths": json_paths,
            "top_level_scope_paths": top_level_scope_paths,
            "externalizable_paths": externalizable_paths,
            "summary_projection": {
                "intent_class": intent_frame.get("intent_class"),
                "save_class": intent_frame.get("save_class"),
                "path_count": len(json_paths),
            },
            "sensitivity_labels": sensitivity_labels,
            "confidence": cls._clamp_confidence(intent_frame.get("confidence"), default=0.55),
            "source_agent": "pkm_structure_agent",
            "contract_version": DYNAMIC_DOMAIN_CONTRACT_VERSION,
        }

    @classmethod
    def _adopt_model_structure_decision(
        cls,
        *,
        walk_decision: dict[str, Any],
        raw_decision: dict[str, Any],
    ) -> tuple[dict[str, Any], list[str]]:
        """Let the structure agent's own decision stand where it made one.

        Six of the ten fields in `_STRUCTURE_DECISION_SCHEMA["required"]` were
        never read. The model was asked for `action`, `json_paths`,
        `top_level_scope_paths`, `externalizable_paths`, `summary_projection`
        and `sensitivity_labels`, it returned all six under a schema that
        rejects a response missing any of them, and
        `_normalize_structure_preview` then rebuilt every one of them from a
        deterministic walk. That is the second shape named in AGENTS.md
        principle 9: a rule that DISCARDS what the model returned. The prompt
        cost is paid either way; only the answer is thrown out.

        Two of them stay walk-derived on purpose, and this is not a hedge.
        `candidate_payload` is mutated after the model returns -- sanitized,
        CRUD-realigned, financially normalized, root-scope retargeted and
        metadata-stripped -- so `json_paths` and `top_level_scope_paths` from
        the model describe a payload that no longer exists. Adopting those
        would not be trusting the model, it would be recording a shape nothing
        was written in.

        `externalizable_paths` is the model's to choose, intersected with what
        actually survived those mutations. The intersection is not a second
        opinion about sharing: the sharing guard is
        `is_internal_manifest_path`, downstream and independent, and it still
        runs on whatever comes out of here.
        """
        hints: list[str] = []
        decision = dict(walk_decision)
        real_paths = set(decision.get("json_paths") or [])
        walk_leaves = list(decision.get("externalizable_paths") or [])

        action = str(raw_decision.get("action") or "").strip()
        if action in _STRUCTURE_DECISION_ACTIONS:
            decision["action"] = action
        elif action:
            hints.append("structure_action_invalid")

        proposed = [
            cls._normalize_path(str(path))
            for path in (raw_decision.get("externalizable_paths") or [])
            if str(path or "").strip()
        ]
        if proposed:
            survived = [path for path in proposed if path in real_paths]
            if survived:
                decision["externalizable_paths"] = survived
                if len(survived) != len(proposed):
                    # Some of what it chose was written somewhere else by a
                    # later normalization step. Worth seeing: a rising rate
                    # here means the mutations and the prompt disagree about
                    # the shape, which is a prompt problem, not a model one.
                    hints.append("structure_externalizable_paths_partially_stale")
            else:
                decision["externalizable_paths"] = walk_leaves
                hints.append("structure_externalizable_paths_stale")

        labels = raw_decision.get("sensitivity_labels")
        if isinstance(labels, dict) and labels:
            merged = dict(decision.get("sensitivity_labels") or {})
            kept = 0
            for path, label in labels.items():
                normalized = cls._normalize_path(str(path))
                if normalized in real_paths and isinstance(label, str) and label.strip():
                    merged[normalized] = label.strip()
                    kept += 1
            decision["sensitivity_labels"] = merged
            if not kept:
                hints.append("structure_sensitivity_labels_stale")

        projection = raw_decision.get("summary_projection")
        if isinstance(projection, dict) and projection:
            # The model's own projection, except the count, which is a fact
            # about the payload rather than a judgement about it.
            decision["summary_projection"] = {
                **projection,
                "path_count": len(real_paths),
            }

        return decision, hints

    @classmethod
    def _manifest_target_entity_scope(
        cls,
        *,
        requested_scope: str,
        manifest_paths: list[str],
    ) -> str | None:
        normalized_requested = cls._normalize_path(requested_scope)
        if normalized_requested:
            if normalized_requested in manifest_paths:
                return normalized_requested
            for path in manifest_paths:
                if path.startswith(f"{normalized_requested}."):
                    return normalized_requested
        if manifest_paths:
            for path in manifest_paths:
                if "." in path:
                    return path.rsplit(".", 1)[0]
            return manifest_paths[0]
        return None

    @classmethod
    def _primary_json_path_for_preview(
        cls,
        *,
        requested_path: str,
        top_level_scope_paths: list[str],
        manifest_paths: list[str],
        intent_frame: dict[str, Any],
        write_mode: str,
    ) -> str | None:
        if write_mode == "do_not_save":
            return None

        normalized_requested = cls._normalize_path(requested_path)
        normalized_top_levels = [
            cls._normalize_path(path) for path in top_level_scope_paths if cls._normalize_path(path)
        ]
        intent_class = cls._normalize_segment(str(intent_frame.get("intent_class") or ""))
        if (
            normalized_requested
            and normalized_top_levels
            and intent_class
            in {
                "preference",
                "profile_fact",
                "routine",
                "plan_or_goal",
                "relationship",
                "health",
                "travel",
                "shopping_need",
                "note",
                "financial_event",
            }
            and (
                normalized_requested.endswith(".statements")
                or normalized_requested.endswith(".entries")
                or normalized_requested.endswith("._items")
            )
        ):
            return normalized_top_levels[0]

        if normalized_requested:
            if normalized_requested in manifest_paths:
                return normalized_requested
            if any(path.startswith(f"{normalized_requested}.") for path in manifest_paths):
                return normalized_requested

        if (
            intent_class
            in {
                "preference",
                "profile_fact",
                "routine",
                "plan_or_goal",
                "relationship",
                "health",
                "travel",
                "shopping_need",
                "note",
                "financial_event",
            }
            and normalized_top_levels
        ):
            return normalized_top_levels[0]

        for manifest_path in manifest_paths:
            if manifest_path.endswith(".statements") or manifest_path.endswith(".entries"):
                return manifest_path

        if normalized_top_levels:
            return normalized_top_levels[0]
        if manifest_paths:
            return manifest_paths[0]
        return None

    @classmethod
    def _detect_duplicate_memory(
        cls,
        *,
        message: str,
        simulated_state: dict[str, Any] | None,
        target_domain: str,
    ) -> bool:
        if not isinstance(simulated_state, dict):
            return False
        normalized_message = cls._safe_excerpt(message, limit=400).lower()
        for memory in simulated_state.get("memories") or []:
            if not isinstance(memory, dict):
                continue
            if not memory.get("active", True):
                continue
            if cls._normalize_segment(str(memory.get("domain") or "")) != target_domain:
                continue
            existing_message = cls._safe_excerpt(
                str(memory.get("message") or ""), limit=400
            ).lower()
            if existing_message == normalized_message:
                return True
        return False

    @classmethod
    def _normalize_structure_preview(
        cls,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        intent_frame: dict[str, Any],
        merge_decision: dict[str, Any],
        parsed_structure: dict[str, Any] | None,
        fallback_target_domain: str,
        simulated_state: dict[str, Any] | None,
        update_intent: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        secret_kind = cls._contains_sensitive_secret(message)
        if secret_kind:
            # Same terminal shape as the reserved-target rejection: never
            # redirected, never owner-confirmable, and the hint tells the
            # surface to point at the secure form instead.
            return {
                "candidate_payload": {},
                "structure_decision": {
                    "action": "reject_sensitive_secret",
                    "target_domain": "",
                    "json_paths": [],
                    "top_level_scope_paths": [],
                    "externalizable_paths": [],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.0,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": DYNAMIC_DOMAIN_CONTRACT_VERSION,
                },
                "write_mode": "do_not_save",
                "primary_json_path": None,
                "target_entity_scope": None,
                "validation_hints": [f"sensitive_{secret_kind}_rejected"],
            }
        raw_structure = parsed_structure or {}
        raw_decision = raw_structure.get("structure_decision")
        raw_decision = raw_decision if isinstance(raw_decision, dict) else {}

        suggested_target_domain = (
            cls._normalize_segment(str(raw_decision.get("target_domain") or ""))
            or cls._normalize_segment(str(merge_decision.get("target_domain") or ""))
            or fallback_target_domain
        )
        validation_hints: list[str] = []
        candidate_payload = cls._sanitize_candidate_payload(
            raw_structure.get("candidate_payload"),
            message=message,
            intent_frame=intent_frame,
            merge_decision=merge_decision,
            target_domain=suggested_target_domain,
        )
        raw_payload_has_changes = cls._contains_changes_branch(
            raw_structure.get("candidate_payload")
        )
        merge_mode = cls._normalize_segment(str(merge_decision.get("merge_mode") or ""))
        target_scope = cls._entity_scope_from_path(
            str(merge_decision.get("target_entity_path") or "")
        )
        if merge_mode in {"correct_entity", "delete_entity"} and target_scope != "changes":
            aligned_payload = cls._fallback_payload_from_intent(
                message=message,
                intent_frame=intent_frame,
                merge_decision=merge_decision,
                target_domain=suggested_target_domain,
            )
            if candidate_payload != aligned_payload:
                validation_hints.append("crud_payload_aligned_to_merge_target")
            candidate_payload = aligned_payload
            if raw_payload_has_changes:
                validation_hints.append("changes_branch_blocked")

        if not isinstance(raw_structure, dict):
            validation_hints.append("missing_structure_output")

        recommended_domain = cls._first_recommended_domain(
            intent_frame, fallback=suggested_target_domain
        )
        registry_keys = {
            cls._normalize_segment(str(entry.get("domain_key") or ""))
            for entry in registry_choices
            if cls._normalize_segment(str(entry.get("domain_key") or ""))
        }
        target_domain = (
            cls._normalize_segment(str(merge_decision.get("target_domain") or ""))
            or suggested_target_domain
            or recommended_domain
            or _DEFAULT_CONFIRMATION_DOMAINS[0]
        )
        target_domain, candidate_payload, remapped = cls._remap_protocol_domain_name(
            target_domain=target_domain,
            payload=candidate_payload,
            recommended_domain=recommended_domain,
        )
        if remapped:
            validation_hints.append("protocol_domain_name_remapped")
        reserved_entry: ReservedEntry | None = None
        reserved_branch: str | None = None
        try:
            target_domain = validate_dynamic_top_level_domain(target_domain)
        except ValueError:
            rerouted_domain, rerouted_payload, entry, blocked, branch = (
                cls._reroute_reserved_payload(
                    target_domain=cls._normalize_segment(target_domain),
                    payload=candidate_payload,
                    whole_domain=True,
                )
            )
            if entry is not None and blocked is None:
                # An app-owned domain (Wallet) with an agent_memory sibling: the
                # fact is kept there, recorded, and offered to the app's screen.
                # Never a general domain: the sibling is the registry's answer.
                target_domain = rerouted_domain
                candidate_payload = rerouted_payload
                reserved_entry, reserved_branch = entry, branch
                validation_hints.append("reserved_target_rerouted_to_sibling")
        if reserved_entry is None and not is_valid_dynamic_top_level_domain(target_domain):
            # A model-proposed reserved or malformed domain with no sibling must
            # never be silently redirected into a general domain. That would
            # turn a policy rejection into an owner-confirmable write to the
            # wrong place. Return a terminal preview instead; callers already
            # omit do_not_save cards from the save path.
            return {
                "candidate_payload": {},
                "structure_decision": {
                    "action": "reject_reserved_target",
                    "target_domain": "",
                    "json_paths": [],
                    "top_level_scope_paths": [],
                    "externalizable_paths": [],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.0,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": DYNAMIC_DOMAIN_CONTRACT_VERSION,
                },
                "write_mode": "do_not_save",
                "primary_json_path": None,
                "target_entity_scope": None,
                "validation_hints": ["invalid_or_reserved_target_rejected"],
            }
        keyword_ranked_domains = cls._keyword_ranked_domains(
            message=message,
            current_domains=current_domains,
        )
        target_supported = target_domain in registry_keys or target_domain in current_domains
        recommended_supported = (
            recommended_domain in registry_keys or recommended_domain in current_domains
        )
        if (
            recommended_domain
            and recommended_supported
            and target_domain != recommended_domain
            and (
                not target_supported
                or target_domain in {"personal", _GENERAL_DOMAIN_KEY}
                or (
                    recommended_domain in keyword_ranked_domains
                    and target_domain not in keyword_ranked_domains
                )
            )
        ):
            validation_hints.append("target_domain_aligned_to_intent")
            target_domain = recommended_domain

        if target_domain == _GENERAL_DOMAIN_KEY:
            validation_hints.append("unresolved_domain_choice")
            target_domain = recommended_domain or _DEFAULT_CONFIRMATION_DOMAINS[0]

        if target_domain not in registry_keys and target_domain not in current_domains:
            validation_hints.append("new_domain_requires_extra_confidence")
            validation_hints.append("custom_domain_pending_owner_confirmation")

        if (
            intent_frame.get("intent_class") != "financial_event"
            and target_domain != "financial"
            and cls._payload_financial_signature(candidate_payload)
        ):
            validation_hints.append("non_financial_payload_replaced")
            target_domain = (
                recommended_domain
                if recommended_domain != "financial"
                else _DEFAULT_CONFIRMATION_DOMAINS[0]
            )
            candidate_payload = cls._fallback_payload_from_intent(
                message=message,
                intent_frame=intent_frame,
                merge_decision=merge_decision,
                target_domain=target_domain,
            )

        if (
            intent_frame.get("intent_class") not in {"financial_event", "plan_or_goal"}
            and target_domain == "financial"
        ):
            # Recorded, not substituted. This rule used to move the fact to the
            # intent's first non-financial choice, or to `professional`, which
            # filed "I prefer index funds" (intent `preference`) outside Finance.
            # The structure agent named Finance; the reserved registry keeps the
            # fact in financial.agent_memory; the hint only holds auto-save.
            validation_hints.append("financial_domain_requires_confirmation")

        if merge_mode not in {"correct_entity", "delete_entity"}:
            current_root_scope = next(
                (
                    cls._normalize_path(str(key))
                    for key in candidate_payload.keys()
                    if cls._normalize_path(str(key))
                ),
                cls._root_scope_for_intent(
                    str(intent_frame.get("intent_class") or "note"),
                    target_domain,
                    message=message,
                ),
            )
            preferred_scope, scope_hint = cls._preferred_scope_from_metadata(
                intent_class=str(intent_frame.get("intent_class") or "note"),
                target_domain=target_domain,
                message=message,
                fallback_scope=current_root_scope,
                registry_choices=registry_choices,
            )
            if scope_hint:
                validation_hints.append(scope_hint)
            if (
                preferred_scope != current_root_scope
                and scope_hint == "dynamic_scope_metadata_selected"
            ):
                candidate_payload = cls._retarget_payload_root_scope(
                    candidate_payload,
                    from_scope=current_root_scope,
                    to_scope=preferred_scope,
                )

        reserved_blocked: str | None = None
        if merge_mode in {"correct_entity", "delete_entity"}:
            # A correction or deletion of an app-owned record is the app's to
            # make; moving it into the sibling would correct nothing.
            correction_hits = cls._reserved_payload_hits(
                target_domain=target_domain, payload=candidate_payload
            )
            if correction_hits:
                hit_key, reserved_entry = next(iter(correction_hits.items()))
                reserved_branch = (
                    reserved_entry.branch_prefix
                    if reserved_entry.branch_prefix != "*"
                    else cls._normalize_segment(hit_key)
                )
                reserved_blocked = "reserved_target_offered_not_saved"
        else:
            rerouted_domain, rerouted_payload, entry, blocked, branch = (
                cls._reroute_reserved_payload(
                    target_domain=target_domain, payload=candidate_payload
                )
            )
            if entry is not None:
                reserved_entry, reserved_branch = entry, branch
                if blocked is None:
                    target_domain = rerouted_domain
                    candidate_payload = rerouted_payload
                    validation_hints.append("reserved_target_rerouted_to_sibling")
                else:
                    reserved_blocked = blocked

        candidate_payload, metadata_removed = cls._strip_internal_metadata(candidate_payload)
        if metadata_removed:
            validation_hints.append("internal_metadata_blocked")

        if cls._detect_duplicate_memory(
            message=message,
            simulated_state=simulated_state,
            target_domain=target_domain,
        ):
            validation_hints.append("possible_duplicate_memory")

        # The walk over the FINAL payload. Always computed, because it is the
        # only thing that can describe what was actually written after the
        # mutations above, and because it is the whole decision when the model
        # failed or was skipped.
        decision = cls._fallback_structure_decision(
            message=message,
            current_domains=current_domains,
            intent_frame=intent_frame,
            target_domain=target_domain,
            candidate_payload=candidate_payload,
        )
        if raw_decision:
            decision, adoption_hints = cls._adopt_model_structure_decision(
                walk_decision=decision,
                raw_decision=raw_decision,
            )
            validation_hints.extend(adoption_hints)
        decision["confidence"] = cls._clamp_confidence(
            raw_decision.get("confidence"),
            default=cls._clamp_confidence(intent_frame.get("confidence"), default=0.55),
        )
        decision["source_agent"] = (
            cls._normalize_segment(str(raw_decision.get("source_agent") or ""))
            or "pkm_structure_agent"
        )
        try:
            decision["contract_version"] = max(
                int(raw_decision.get("contract_version") or 1),
                DYNAMIC_DOMAIN_CONTRACT_VERSION,
            )
        except Exception:
            decision["contract_version"] = DYNAMIC_DOMAIN_CONTRACT_VERSION

        raw_requested_scope = str(raw_structure.get("target_entity_scope") or "").strip()
        requested_scope = raw_requested_scope
        if target_scope:
            requested_scope = target_scope
        target_entity_scope = cls._manifest_target_entity_scope(
            requested_scope=requested_scope,
            manifest_paths=decision["json_paths"],
        )

        write_mode = str(raw_structure.get("write_mode") or "").strip().lower()
        if write_mode not in _WRITE_MODES:
            # A missing structure decision is not owner approval. Keep the
            # malformed result review-only instead of synthesizing a write.
            write_mode = "confirm_first"
            validation_hints.append("invalid_write_mode_requires_review")
        structure_dropped = write_mode == "do_not_save"

        if intent_frame.get("save_class") == "ephemeral":
            write_mode = "do_not_save"
            validation_hints.append("ephemeral_request_not_saved")
        if cls._looks_opaque_or_nonsense(message):
            write_mode = "do_not_save"
            validation_hints.append("nonsense_or_opaque_input")
        elif (
            intent_frame.get("requires_confirmation")
            or intent_frame.get("save_class") == "ambiguous"
        ):
            write_mode = "confirm_first"
            validation_hints.append("confirmation_required")

        if (
            any(
                hint
                in {
                    "non_financial_payload_replaced",
                    "financial_domain_requires_confirmation",
                    "unresolved_domain_choice",
                }
                for hint in validation_hints
            )
            and write_mode == "can_save"
        ):
            write_mode = "confirm_first"

        if (
            "dynamic_scope_metadata_no_specific_match" in validation_hints
            and write_mode == "can_save"
        ):
            write_mode = "confirm_first"

        mutation_intent = str(intent_frame.get("mutation_intent") or "create")
        if mutation_intent == "correct" and merge_decision.get("merge_mode") == "create_entity":
            validation_hints.append("correction_without_prior_target_kept_as_new_entity")
        if (
            mutation_intent in {"update", "correct", "delete"}
            and target_domain not in current_domains
        ):
            if mutation_intent == "correct":
                validation_hints.append("correction_without_prior_target_treated_as_update")
            else:
                write_mode = "confirm_first"
                validation_hints.append("mutation_target_missing")

        if merge_decision.get("merge_mode") == "no_op":
            write_mode = "do_not_save"
        elif (
            mutation_intent in {"correct", "delete"}
            and merge_decision.get("merge_mode") in {"correct_entity", "delete_entity"}
            and write_mode == "do_not_save"
        ):
            write_mode = "can_save"
            validation_hints.append("crud_write_mode_recovered_from_model_no_op")

        if "possible_duplicate_memory" in validation_hints and write_mode == "can_save":
            write_mode = "confirm_first"

        if mutation_intent == "no_op" and write_mode == "can_save":
            write_mode = "do_not_save"

        effective_confidence = min(
            cls._clamp_confidence(intent_frame.get("confidence"), default=0.0),
            cls._clamp_confidence(decision.get("confidence"), default=0.0),
        )
        requires_review_for_auto_save = (
            mutation_intent not in {"create", "extend"}
            or effective_confidence < _AUTO_SAVE_MIN_CONFIDENCE
            or any(
                hint
                in {
                    "new_domain_requires_extra_confidence",
                    "custom_domain_pending_owner_confirmation",
                    "possible_duplicate_memory",
                    "financial_domain_requires_confirmation",
                    "unresolved_domain_choice",
                    "dynamic_scope_metadata_no_specific_match",
                }
                for hint in validation_hints
            )
        )
        if write_mode == "can_save" and requires_review_for_auto_save:
            write_mode = "confirm_first"
            validation_hints.append("auto_save_requires_review")
        reserved_drop = reserved_blocked or any(
            reserved_entry_for(target_domain, path) is not None
            for path in decision.get("json_paths") or []
        )
        if (
            structure_dropped
            and write_mode == "do_not_save"
            and not reserved_drop
            and intent_frame.get("save_class") == "durable"
            and mutation_intent != "no_op"
            and merge_decision.get("merge_mode") not in {None, "", "no_op"}
            and not cls._looks_opaque_or_nonsense(message)
        ):
            # Whether to save is decided upstream: intent kept this statement
            # and merge attached it, and no rule above dropped it. A structure
            # drop here lost a stated fact silently (measured 2026-10-02: the
            # most common loss on the release chain); keep it for the owner's
            # review instead. Reserved-only input is still dropped below.
            write_mode = "confirm_first"
            validation_hints.append("structure_drop_kept_for_review")
        if reserved_drop:
            # Authority, not meaning: contracts/pkm/reserved-branches.v1.json
            # names the branches an app feature writes through its own screen
            # (Finance sources, Location places, Wallet, KYC...). Whatever is
            # still aimed at one here had no sibling to move to. Last, so no
            # later rule can reopen it. Recorded, never substituted.
            write_mode = "do_not_save"
            validation_hints.append(reserved_blocked or "reserved_branch_blocked")

        if write_mode == "confirm_first":
            intent_frame["requires_confirmation"] = True
            intent_frame["confirmation_reason"] = (
                str(intent_frame.get("confirmation_reason") or "").strip()
                or "Review the domain, scope, and sharing impact before this PKM change is saved."
            )

        parsed_validation_hints = raw_structure.get("validation_hints")
        if isinstance(parsed_validation_hints, list):
            for hint in parsed_validation_hints:
                text = cls._normalize_segment(str(hint))
                if text:
                    validation_hints.append(text)
        validation_hints = cls._unique_list(validation_hints)

        primary_json_path = cls._primary_json_path_for_preview(
            requested_path=str(
                raw_structure.get("primary_json_path") or requested_scope or ""
            ).strip(),
            top_level_scope_paths=decision["top_level_scope_paths"],
            manifest_paths=decision["json_paths"],
            intent_frame=intent_frame,
            write_mode=write_mode,
        )
        if write_mode != "do_not_save" and primary_json_path is None:
            validation_hints.append("primary_path_missing")
        if (
            write_mode != "do_not_save"
            and primary_json_path is not None
            and primary_json_path in decision["top_level_scope_paths"]
            and (raw_requested_scope or requested_scope)
            and cls._normalize_path(raw_requested_scope or requested_scope) != primary_json_path
        ):
            validation_hints.append("primary_path_defaulted_to_root_scope")
        validation_hints = cls._unique_list(validation_hints)

        return {
            "candidate_payload": candidate_payload,
            "structure_decision": decision,
            "write_mode": write_mode,
            "primary_json_path": primary_json_path,
            "target_entity_scope": target_entity_scope,
            "validation_hints": validation_hints,
            "reserved_offer": cls._reserved_offer(
                entry=reserved_entry, branch=reserved_branch, raw_structure=raw_structure
            ),
        }

    @classmethod
    def _build_manifest_from_payload(
        cls,
        *,
        user_id: str,
        domain: str,
        payload: dict[str, Any],
        structure_decision: dict[str, Any],
    ) -> dict[str, Any]:
        path_map: dict[str, dict[str, Any]] = {}
        cls._walk_payload(payload, [], path_map)
        # The walk owns structural facts, not a replacement sensitivity judgment.
        # Adopt only labels for surviving paths before deriving scope tiers.
        sensitivity_labels = structure_decision.get("sensitivity_labels")
        if isinstance(sensitivity_labels, dict):
            for json_path, path in path_map.items():
                label = sensitivity_labels.get(json_path)
                if isinstance(label, str) and label.strip():
                    path["sensitivity_label"] = label.strip()
        paths = [path_map[key] for key in sorted(path_map)]
        top_level_scope_paths = sorted(
            {path["json_path"].split(".", 1)[0] for path in paths if path["json_path"]}
        )
        externalizable_paths = [
            path["json_path"]
            for path in paths
            if path["exposure_eligibility"] and path.get("path_type") == "leaf"
        ]
        segment_ids = sorted({path.get("segment_id") or "root" for path in paths}) or ["root"]
        scope_registry = []
        for scope_path in top_level_scope_paths:
            scope_registry.append(
                {
                    "scope_handle": f"s_{hashlib.sha256(f'{user_id}:{domain}:{scope_path}'.encode('utf-8')).hexdigest()[:12]}",
                    "scope_label": cls._titleize_path(scope_path),
                    "segment_ids": sorted(
                        {
                            path.get("segment_id") or "root"
                            for path in paths
                            if path["json_path"] == scope_path
                            or path["json_path"].startswith(f"{scope_path}.")
                        }
                    ),
                    "sensitivity_tier": "restricted"
                    if any(
                        (path.get("sensitivity_label") or "").lower() == "restricted"
                        for path in paths
                        if path["json_path"] == scope_path
                        or path["json_path"].startswith(f"{scope_path}.")
                    )
                    else "confidential",
                    "scope_kind": "subtree",
                    "exposure_enabled": True,
                    "summary_projection": {
                        "top_level_scope_path": scope_path,
                        "consumer_visible": True,
                        "internal_only": False,
                    },
                }
            )
        for entry in scope_registry:
            for path in paths:
                if path["json_path"] == entry["summary_projection"]["top_level_scope_path"] or path[
                    "json_path"
                ].startswith(f"{entry['summary_projection']['top_level_scope_path']}."):
                    path["scope_handle"] = entry["scope_handle"]
        return {
            "user_id": user_id,
            "domain": domain,
            "manifest_version": 1,
            "structure_decision": structure_decision,
            "summary_projection": structure_decision.get("summary_projection") or {},
            "top_level_scope_paths": top_level_scope_paths,
            "externalizable_paths": externalizable_paths,
            "segment_ids": segment_ids,
            "path_count": len(paths),
            "externalizable_path_count": len(externalizable_paths),
            "paths": paths,
            "scope_registry": scope_registry,
        }

    @classmethod
    def _current_snapshot_for_card(
        cls,
        *,
        simulated_state: dict[str, Any] | None,
        target_domain: str,
        target_entity_id: str,
        target_entity_scope: str | None,
    ) -> dict[str, Any] | None:
        if not isinstance(simulated_state, dict):
            return None
        normalized_domain = cls._normalize_segment(target_domain)
        normalized_entity_id = cls._normalize_segment(target_entity_id)
        normalized_scope = cls._normalize_path(target_entity_scope or "")
        for memory in simulated_state.get("memories") or []:
            if not isinstance(memory, dict):
                continue
            memory_domain = cls._normalize_segment(str(memory.get("domain") or ""))
            memory_entity_id = cls._normalize_segment(str(memory.get("entity_id") or ""))
            memory_scope = cls._normalize_path(str(memory.get("entity_scope") or ""))
            if normalized_domain and memory_domain != normalized_domain:
                continue
            if normalized_entity_id and memory_entity_id == normalized_entity_id:
                return deepcopy(memory)
            if normalized_scope and memory_scope == normalized_scope:
                return deepcopy(memory)
        return None

    @classmethod
    def _extract_patch_value(cls, payload: dict[str, Any], path: str | None) -> Any:
        if not isinstance(payload, dict):
            return None
        normalized_path = cls._normalize_path(path or "")
        if not normalized_path:
            return deepcopy(payload)
        cursor: Any = payload
        for segment in normalized_path.split("."):
            if not isinstance(cursor, dict):
                return None
            cursor = cursor.get(segment)
        return deepcopy(cursor)

    @classmethod
    def _scope_projection_for_card(
        cls,
        *,
        target_domain: str,
        manifest_draft: dict[str, Any] | None,
        primary_json_path: str | None,
    ) -> dict[str, Any]:
        normalized_domain = cls._normalize_segment(target_domain)
        normalized_path = cls._normalize_path(primary_json_path or "")
        scopes: list[str] = []
        if normalized_domain:
            scopes.append(f"attr.{normalized_domain}.*")
            if normalized_path:
                scopes.append(f"attr.{normalized_domain}.{normalized_path}.*")
        scope_registry = (
            manifest_draft.get("scope_registry")
            if isinstance(manifest_draft, dict)
            and isinstance(manifest_draft.get("scope_registry"), list)
            else []
        )
        return {
            "recommended_scope": scopes[-1] if len(scopes) > 1 else (scopes[0] if scopes else ""),
            "available_scopes": scopes,
            "scope_handles": [
                str(entry.get("scope_handle") or "")
                for entry in scope_registry
                if isinstance(entry, dict) and str(entry.get("scope_handle") or "").strip()
            ],
        }

    @classmethod
    def _context_plan_from_cards(cls, preview_cards: list[dict[str, Any]]) -> dict[str, Any]:
        candidate_domains: list[str] = []
        candidate_paths: list[str] = []
        candidate_segment_ids: list[str] = []
        per_domain: dict[str, dict[str, Any]] = {}
        for card in preview_cards:
            domain = cls._normalize_segment(str(card.get("target_domain") or ""))
            path = cls._normalize_path(str(card.get("primary_json_path") or ""))
            segment_ids = [
                cls._normalize_segment(str(segment_id))
                for segment_id in (card.get("candidate_segment_ids") or [])
                if cls._normalize_segment(str(segment_id))
            ]
            if domain and domain not in candidate_domains:
                candidate_domains.append(domain)
            if path and path not in candidate_paths:
                candidate_paths.append(path)
            for segment_id in segment_ids:
                if segment_id not in candidate_segment_ids:
                    candidate_segment_ids.append(segment_id)
            if domain:
                entry = per_domain.setdefault(
                    domain,
                    {"domain": domain, "paths": [], "segment_ids": []},
                )
                if path and path not in entry["paths"]:
                    entry["paths"].append(path)
                for segment_id in segment_ids:
                    if segment_id not in entry["segment_ids"]:
                        entry["segment_ids"].append(segment_id)
        return {
            "candidate_domains": candidate_domains,
            "candidate_paths": candidate_paths,
            "candidate_segment_ids": candidate_segment_ids,
            "domains": list(per_domain.values()),
        }

    @classmethod
    def _aggregate_preview_summary(
        cls,
        *,
        preview_cards: list[dict[str, Any]],
        split_recommended: bool,
        total_segments_detected: int,
    ) -> dict[str, Any]:
        can_save = sum(1 for card in preview_cards if card.get("write_mode") == "can_save")
        confirm_first = sum(
            1 for card in preview_cards if card.get("write_mode") == "confirm_first"
        )
        do_not_save = sum(1 for card in preview_cards if card.get("write_mode") == "do_not_save")
        primary_card = next(
            (card for card in preview_cards if card.get("write_mode") != "do_not_save"),
            preview_cards[0] if preview_cards else None,
        )
        drift_flag_counts = {
            flag: sum(
                1
                for card in preview_cards
                if isinstance(card.get("drift_flags"), dict)
                and bool((card.get("drift_flags") or {}).get(flag))
            )
            for flag in _DRIFT_FLAG_NAMES
        }
        return {
            "card_count": len(preview_cards),
            "can_save_count": can_save,
            "confirm_first_count": confirm_first,
            "do_not_save_count": do_not_save,
            "drift_flag_counts": drift_flag_counts,
            "split_recommended": split_recommended,
            "total_segments_detected": total_segments_detected,
            "primary_target_domain": primary_card.get("target_domain") if primary_card else None,
            "primary_write_mode": primary_card.get("write_mode") if primary_card else None,
            "primary_intent_class": primary_card.get("intent_class") if primary_card else None,
            "notes": [
                note
                for note in [
                    "Prompt was truncated to eight preview cards. Split the message if you want Kai to review each memory separately."
                    if split_recommended
                    else "",
                    "Preview is read-only. Save encrypts only the selected PKM updates with the active vault key.",
                ]
                if note
            ],
        }

    @classmethod
    def _build_preview_card(
        cls,
        *,
        card_id: str,
        source_text: str,
        preview: dict[str, Any],
        simulated_state: dict[str, Any] | None,
    ) -> dict[str, Any]:
        intent_frame = (
            preview.get("intent_frame") if isinstance(preview.get("intent_frame"), dict) else {}
        )
        merge_decision = (
            preview.get("merge_decision") if isinstance(preview.get("merge_decision"), dict) else {}
        )
        structure_decision = (
            preview.get("structure_decision")
            if isinstance(preview.get("structure_decision"), dict)
            else {}
        )
        manifest_draft = (
            preview.get("manifest_draft") if isinstance(preview.get("manifest_draft"), dict) else {}
        )
        target_domain = cls._normalize_segment(
            str(manifest_draft.get("domain") or structure_decision.get("target_domain") or "")
        )
        primary_json_path = cls._normalize_path(str(preview.get("primary_json_path") or ""))
        target_entity_scope = cls._normalize_path(str(preview.get("target_entity_scope") or ""))
        target_entity_id = cls._normalize_segment(str(merge_decision.get("target_entity_id") or ""))
        manifest_segment_ids = [
            cls._normalize_segment(str(segment_id))
            for segment_id in (manifest_draft.get("segment_ids") or [])
            if cls._normalize_segment(str(segment_id))
        ]
        current_snapshot = cls._current_snapshot_for_card(
            simulated_state=simulated_state,
            target_domain=target_domain,
            target_entity_id=target_entity_id,
            target_entity_scope=target_entity_scope,
        )
        candidate_payload = (
            preview.get("candidate_payload")
            if isinstance(preview.get("candidate_payload"), dict)
            else {}
        )
        return {
            "card_id": card_id,
            "source_text": source_text,
            "save_class": intent_frame.get("save_class") or "unknown",
            "intent_class": intent_frame.get("intent_class") or "unknown",
            "mutation_intent": intent_frame.get("mutation_intent") or "unknown",
            "merge_mode": merge_decision.get("merge_mode") or "unknown",
            "target_domain": target_domain or "unresolved",
            "primary_json_path": primary_json_path or None,
            "target_entity_scope": target_entity_scope or None,
            "target_entity_id": target_entity_id or None,
            "write_mode": preview.get("write_mode") or "confirm_first",
            "requires_confirmation": bool(intent_frame.get("requires_confirmation")),
            "confirmation_reason": str(intent_frame.get("confirmation_reason") or ""),
            "candidate_domain_choices": deepcopy(
                intent_frame.get("candidate_domain_choices") or []
            ),
            "current_entity_snapshot": current_snapshot,
            "proposed_entity_patch": cls._extract_patch_value(
                candidate_payload,
                target_entity_scope or primary_json_path,
            ),
            "resulting_domain_patch": {target_domain: deepcopy(candidate_payload)}
            if target_domain
            else deepcopy(candidate_payload),
            "scope_projection": cls._scope_projection_for_card(
                target_domain=target_domain,
                manifest_draft=manifest_draft,
                primary_json_path=primary_json_path or None,
            ),
            "candidate_segment_ids": manifest_segment_ids,
            "validation_hints": deepcopy(preview.get("validation_hints") or []),
            "drift_flags": deepcopy(
                preview.get("drift_flags")
                or cls._drift_flags_from_preview(
                    validation_hints=list(preview.get("validation_hints") or []),
                    fallback_used=bool(preview.get("used_fallback")),
                    intent_used_fallback=bool(preview.get("intent_used_fallback")),
                    merge_used_fallback=bool(preview.get("merge_used_fallback")),
                    structure_used_fallback=bool(preview.get("structure_used_fallback")),
                    intent_skipped=bool(preview.get("intent_skipped")),
                    merge_skipped=bool(preview.get("merge_skipped")),
                    structure_skipped=bool(preview.get("structure_skipped")),
                )
            ),
            "intent_frame": deepcopy(intent_frame),
            "merge_decision": deepcopy(merge_decision),
            "candidate_payload": deepcopy(candidate_payload),
            "structure_decision": deepcopy(structure_decision),
            "manifest_draft": deepcopy(manifest_draft),
            # The owning app's screen, when this fact belongs to a reserved branch.
            "reserved_offer": deepcopy(preview.get("reserved_offer")),
        }

    @staticmethod
    def _kyc_identity_fields() -> dict[str, dict[str, Any]]:
        """Load the shared, value-free KYC alias contract used by web and API."""
        try:
            payload = json.loads(_KYC_IDENTITY_PROFILE_CONTRACT_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.error("pkm.kyc_identity_contract_unavailable error=%s", type(exc).__name__)
            return {}
        fields = payload.get("fields") if isinstance(payload, dict) else []
        return {
            str(field.get("id") or "").strip(): field
            for field in fields
            if isinstance(field, dict)
            and str(field.get("id") or "").strip()
            and str(field.get("domain") or "").strip()
            and str(field.get("path") or "").strip()
        }

    @classmethod
    def _kyc_identity_prompt(cls, *, message: str, fields: dict[str, dict[str, Any]]) -> str:
        allowed = [
            {
                "field_id": field_id,
                "aliases": list(field.get("aliases") or []),
                "sensitivity": str(field.get("sensitivity") or ""),
            }
            for field_id, field in fields.items()
        ]
        return (
            "Extract only explicit, durable KYC identity facts from the user's supplied text. "
            "Return no inference, no summaries, no raw about-me blob, no passwords, tokens, banking "
            "details, or unsupported fields. Fields marked restricted are government identifiers: extract "
            "them only when explicitly supplied, using their exact allowed field_id. Each fact must use exactly "
            "one allowed field_id, preserve a direct source_text excerpt from the user, and use a value "
            "directly stated in that excerpt. If uncertain or conflicting, omit the fact.\n\n"
            "If an explicit durable fact does not fit an allowed KYC field, put it in "
            "general_fallback_facts instead. Each fallback must have one small factual value, a stable "
            "lowercase field label, a direct source_text excerpt, and one of these domains: identity, "
            "professional, location, health, travel, food, shopping, entertainment, social, general. "
            "Fallback facts are review-first. Do not emit prose paragraphs, secrets, identifiers, or "
            "anything ambiguous.\n\n"
            f"Allowed fields: {json.dumps(allowed, ensure_ascii=False)}\n\n"
            f"User supplied text:\n{message}"
        )

    @classmethod
    def _set_nested_value(cls, payload: dict[str, Any], path: str, value: str) -> None:
        cursor = payload
        parts = [part for part in cls._normalize_path(path).split(".") if part]
        for part in parts[:-1]:
            nested = cursor.get(part)
            if not isinstance(nested, dict):
                nested = {}
                cursor[part] = nested
            cursor = nested
        if parts:
            cursor[parts[-1]] = value

    @staticmethod
    def _safe_kyc_general_domain(value: Any) -> str:
        allowed = {
            "identity",
            "professional",
            "location",
            "health",
            "travel",
            "food",
            "shopping",
            "entertainment",
            "social",
            _GENERAL_DOMAIN_KEY,
        }
        domain = PKMAgentLabService._normalize_segment(str(value or ""))
        return domain if domain in allowed else ""

    @classmethod
    def _safe_kyc_general_field(cls, value: Any) -> str:
        field = cls._normalize_segment(str(value or ""))
        if not field or field in _BLOCKED_EXTERNAL_PATH_PARTS or field in _STRUCTURAL_SCOPE_TOKENS:
            return ""
        return field

    async def _generate_kyc_identity_preview(
        self,
        *,
        user_id: str,
        message: str,
        current_domains: list[str],
        model_override: str | None,
        execution_trace: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        """One constrained model pass for explicit KYC facts; no generic fan-out."""
        fields = self._kyc_identity_fields()
        started_at = time.perf_counter()
        secret_kind = self._contains_sensitive_secret(message)
        # Government identifiers are still forbidden from the general dynamic
        # memory path. This constrained KYC profile is the one exception: it
        # only accepts explicitly listed, restricted fields and always makes
        # them owner-confirmed before encrypted persistence.
        blocking_secret_kind = (
            secret_kind if secret_kind and secret_kind != _RESTRICTED_KYC_IDENTIFIER_KIND else None
        )
        raw = (
            None
            if blocking_secret_kind or not fields
            else await self._run_agent_contract(
                manifest=self.structure_manifest,
                prompt=self._kyc_identity_prompt(message=message, fields=fields),
                response_schema=_KYC_IDENTITY_EXTRACTION_SCHEMA,
                model_override=model_override,
                timeout_seconds=_AGENT_CONTRACT_TIMEOUT_SECONDS,
                execution_trace=execution_trace,
            )
        )
        facts = (
            raw.get("facts") if isinstance(raw, dict) and isinstance(raw.get("facts"), list) else []
        )
        general_fallback_facts = (
            raw.get("general_fallback_facts")
            if isinstance(raw, dict) and isinstance(raw.get("general_fallback_facts"), list)
            else []
        )
        message_normalized = self._safe_excerpt(message, limit=50000).casefold()
        cards: list[dict[str, Any]] = []
        seen: set[str] = set()
        for index, fact in enumerate(facts, start=1):
            if not isinstance(fact, dict):
                continue
            field_id = str(fact.get("field_id") or "").strip()
            field = fields.get(field_id)
            value = str(fact.get("value") or "").strip()
            source_text = str(fact.get("source_text") or "").strip()
            if not field or not value or not source_text:
                continue
            # Provider output is only a proposal. It must be anchored in the
            # exact user-entered text before becoming a PKM candidate.
            if (
                source_text.casefold() not in message_normalized
                or value.casefold() not in source_text.casefold()
            ):
                continue
            dedupe_key = f"{field_id}:{value.casefold()}"
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            confidence = self._clamp_confidence(fact.get("confidence"), default=0.0)
            domain = self._normalize_segment(str(field["domain"]))
            path = self._normalize_path(str(field["path"]))
            is_restricted = str(field.get("sensitivity") or "").lower() == "restricted"
            candidate_payload: dict[str, Any] = {}
            self._set_nested_value(candidate_payload, path, value)
            intent_frame = {
                "save_class": "durable",
                "intent_class": "profile_fact",
                "mutation_intent": "extend" if domain in current_domains else "create",
                "requires_confirmation": is_restricted or confidence < _AUTO_SAVE_MIN_CONFIDENCE,
                "confirmation_reason": (
                    "Review this restricted KYC identifier before saving."
                    if is_restricted
                    else "Review this low-confidence KYC extraction before saving."
                    if confidence < _AUTO_SAVE_MIN_CONFIDENCE
                    else ""
                ),
                "candidate_domain_choices": [],
                "confidence": confidence,
            }
            structure_decision = self._fallback_structure_decision(
                message=source_text,
                current_domains=current_domains,
                intent_frame=intent_frame,
                target_domain=domain,
                candidate_payload=candidate_payload,
            )
            structure_decision["confidence"] = confidence
            if is_restricted:
                structure_decision.setdefault("sensitivity_labels", {})[path] = "restricted"
            manifest_draft = self._build_manifest_from_payload(
                user_id=user_id,
                domain=domain,
                payload=candidate_payload,
                structure_decision=structure_decision,
            )
            preview = {
                "intent_frame": intent_frame,
                "merge_decision": {
                    "merge_mode": "extend_entity" if domain in current_domains else "create_entity",
                    "target_domain": domain,
                    "target_entity_id": "identity_profile" if domain == "identity" else "profile",
                },
                "candidate_payload": candidate_payload,
                "structure_decision": structure_decision,
                "manifest_draft": manifest_draft,
                "write_mode": "confirm_first"
                if is_restricted or confidence < _AUTO_SAVE_MIN_CONFIDENCE
                else "can_save",
                "primary_json_path": path,
                "target_entity_scope": path.rsplit(".", 1)[0] if "." in path else path,
                "validation_hints": [
                    "kyc_identity_v1",
                    "explicit_user_statement",
                    *(["restricted_kyc_identifier"] if is_restricted else []),
                ],
            }
            card = self._build_preview_card(
                card_id=f"kyc_identity_{index:02d}",
                source_text=source_text,
                preview=preview,
                simulated_state=None,
            )
            card.update(
                {
                    "canonical_field_id": field_id,
                    "confidence": confidence,
                    "source_disposition": "explicit_user_statement",
                    "retrieval_hints": {
                        "domain": domain,
                        "path": path,
                        "aliases": list(field.get("aliases") or []),
                        "segment_ids": list(card.get("candidate_segment_ids") or []),
                    },
                }
            )
            cards.append(card)
        for index, fact in enumerate(general_fallback_facts, start=1):
            if not isinstance(fact, dict):
                continue
            domain = self._safe_kyc_general_domain(fact.get("domain"))
            field = self._safe_kyc_general_field(fact.get("field"))
            value = str(fact.get("value") or "").strip()
            source_text = str(fact.get("source_text") or "").strip()
            if (
                not domain
                or not field
                or not value
                or len(value) > 240
                or not source_text
                or source_text.casefold() not in message_normalized
                or value.casefold() not in source_text.casefold()
                or self._contains_sensitive_secret(value)
            ):
                continue
            path = f"facts.{field}" if domain == _GENERAL_DOMAIN_KEY else f"profile.{field}"
            dedupe_key = f"{domain}:{path}:{value.casefold()}"
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            confidence = self._clamp_confidence(fact.get("confidence"), default=0.0)
            candidate_payload: dict[str, Any] = {}
            self._set_nested_value(candidate_payload, path, value)
            intent_frame = {
                "save_class": "durable",
                "intent_class": "profile_fact",
                "mutation_intent": "extend" if domain in current_domains else "create",
                "requires_confirmation": True,
                "confirmation_reason": "Review this KYC detail before saving.",
                "candidate_domain_choices": [],
                "confidence": confidence,
            }
            structure_decision = self._fallback_structure_decision(
                message=source_text,
                current_domains=current_domains,
                intent_frame=intent_frame,
                target_domain=domain,
                candidate_payload=candidate_payload,
            )
            structure_decision["confidence"] = confidence
            manifest_draft = self._build_manifest_from_payload(
                user_id=user_id,
                domain=domain,
                payload=candidate_payload,
                structure_decision=structure_decision,
            )
            preview = {
                "intent_frame": intent_frame,
                "merge_decision": {
                    "merge_mode": "extend_entity" if domain in current_domains else "create_entity",
                    "target_domain": domain,
                    "target_entity_id": "profile",
                },
                "candidate_payload": candidate_payload,
                "structure_decision": structure_decision,
                "manifest_draft": manifest_draft,
                "write_mode": "confirm_first",
                "primary_json_path": path,
                "target_entity_scope": path.rsplit(".", 1)[0],
                "validation_hints": [
                    "kyc_identity_v1",
                    "general_pkm_fallback",
                    "explicit_user_statement",
                ],
            }
            card = self._build_preview_card(
                card_id=f"kyc_general_{index:02d}",
                source_text=source_text,
                preview=preview,
                simulated_state=None,
            )
            card.update(
                {
                    "confidence": confidence,
                    "source_disposition": "general_pkm_fallback",
                    "retrieval_hints": {
                        "domain": domain,
                        "path": path,
                        "aliases": [field],
                        "segment_ids": list(card.get("candidate_segment_ids") or []),
                    },
                }
            )
            cards.append(card)
        summary = self._aggregate_preview_summary(
            preview_cards=cards,
            split_recommended=False,
            total_segments_detected=len(cards),
        )
        context_plan = self._context_plan_from_cards(cards)
        used_fallback = raw is None
        empty_manifest = self._build_manifest_from_payload(
            user_id=user_id,
            domain="identity",
            payload={},
            structure_decision={
                "action": "create_domain",
                "target_domain": "identity",
                "json_paths": [],
                "top_level_scope_paths": [],
                "externalizable_paths": [],
                "summary_projection": {},
                "sensitivity_labels": {},
                "confidence": 0.0,
                "source_agent": "pkm_structure_agent",
                "contract_version": DYNAMIC_DOMAIN_CONTRACT_VERSION,
            },
        )
        primary = cards[0] if cards else {}
        elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
        return {
            "agent_id": self.structure_manifest.id,
            "agent_name": self.structure_manifest.name,
            "model": model_override
            or _manifest_model_name(self.structure_manifest)
            or GEMINI_MODEL,
            "used_fallback": used_fallback,
            "intent_used_fallback": False,
            "merge_used_fallback": False,
            "structure_used_fallback": used_fallback,
            "error": "sensitive_input_rejected"
            if blocking_secret_kind
            else ("kyc_identity_extraction_unavailable" if used_fallback else None),
            "intent_frame": primary.get("intent_frame", {}),
            "merge_decision": primary.get("merge_decision", {}),
            "candidate_payload": primary.get("candidate_payload", {}),
            "structure_decision": primary.get(
                "structure_decision", empty_manifest["structure_decision"]
            ),
            "write_mode": primary.get("write_mode", "do_not_save"),
            "primary_json_path": primary.get("primary_json_path"),
            "target_entity_scope": primary.get("target_entity_scope"),
            "validation_hints": [
                "kyc_identity_v1",
                *([f"sensitive_{blocking_secret_kind}_rejected"] if blocking_secret_kind else []),
            ],
            "manifest_draft": primary.get("manifest_draft", empty_manifest),
            "preview_cards": cards,
            "preview_summary": summary,
            "performance": {
                "total_latency_ms": elapsed_ms,
                "stage_latencies_ms": {"kyc_identity_extraction": elapsed_ms},
                "cards_returned": len(cards),
                "extraction_call_count": 0 if blocking_secret_kind or not fields else 1,
                "strategy": "single_constrained_kyc_identity_extraction",
                "context_domains_loaded": context_plan.get("candidate_domains") or [],
                "context_segments_loaded": context_plan.get("candidate_segment_ids") or [],
            },
            "context_plan": context_plan,
        }

    def _build_memory_intent_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
        context_quotes: list[str] | None = None,
    ) -> str:
        return self._agent_request(
            self.memory_intent_manifest,
            {
                "message": message,
                "section_context": self._section_context(context_quotes),
                "current_domains": current_domains,
                "domain_choices": self._compact_registry_choices(registry_choices)
                if strict_small_model
                else registry_choices,
                "existing_entities": self._existing_entities(
                    simulated_state, compact=strict_small_model
                ),
            },
        )

    @staticmethod
    def _section_context(context_quotes: list[str] | None) -> list[str]:
        """The exact headings that attribute and qualify a statement.

        They say whose company, which person or which period; they are not a
        second fact to save.
        """
        return [quote for quote in (context_quotes or []) if isinstance(quote, str) and quote]

    def _build_memory_merge_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        intent_frame: dict[str, Any],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
    ) -> str:
        return self._agent_request(
            self.memory_merge_manifest,
            {
                "message": message,
                "intent_frame": intent_frame,
                "current_domains": current_domains,
                "existing_entities": self._existing_entities(
                    simulated_state, compact=strict_small_model
                ),
            },
        )

    def _build_structure_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        intent_frame: dict[str, Any],
        merge_decision: dict[str, Any],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
        context_quotes: list[str] | None = None,
    ) -> str:
        return self._agent_request(
            self.structure_manifest,
            {
                "message": message,
                "section_context": self._section_context(context_quotes),
                "intent_frame": intent_frame,
                "merge_decision": merge_decision,
                "current_domains": current_domains,
                "domain_choices": self._compact_registry_choices(registry_choices)
                if strict_small_model
                else registry_choices,
                "existing_entities": self._existing_entities(
                    simulated_state, compact=strict_small_model
                ),
                # The structure instruction promises this table with every
                # request; until now only the strict intent prompt carried it.
                "reserved_branches": [
                    [row["reserved_branch"], row["agent_memory_sibling"]]
                    for row in reserved_table_for_prompt()
                ],
            },
        )

    @classmethod
    def _should_skip_structure_agent(cls, *, intent_frame: dict[str, Any]) -> bool:
        """Skip the structure agent only when the intent agent said "nothing to save".

        Two answers qualify: ``no_op`` (the intent agent judged it not memory)
        and ``command`` (a live instruction for One to act, such as "optimize my
        portfolio", which only the live turn can carry). Everything else is
        structured, including a statement that needs the owner's confirmation:
        skipping those used to file them through ``_build_entity_record``, a
        keyword-free fallback that kept a truncated summary of the statement.
        """
        if cls._normalize_segment(str(intent_frame.get("intent_class") or "")) == "command":
            return True
        return cls._normalize_segment(str(intent_frame.get("mutation_intent") or "")) == "no_op"

    async def _generate_single_structure_preview(
        self,
        *,
        user_id: str,
        message: str,
        context_quotes: list[str] | None = None,
        current_domains: list[str] | None = None,
        current_manifests: list[dict[str, Any]] | None = None,
        simulated_state: dict[str, Any] | None = None,
        model_override: str | None = None,
        strict_small_model: bool = False,
        domain_registry_override: list[dict[str, Any]] | None = None,
        update_intent: dict[str, Any] | None = None,
        deadline: float | None = None,
        execution_trace: list[dict[str, Any]] | None = None,
        contract_runner=None,
    ) -> dict[str, Any]:
        run_contract = contract_runner or self._run_agent_contract
        normalized_domains = [
            self._normalize_segment(domain) for domain in (current_domains or []) if domain
        ]
        manifest_overrides = self._registry_override_from_manifests(current_manifests)
        effective_registry_override = self._merge_registry_overrides(
            domain_registry_override,
            manifest_overrides,
        )
        registry_choices = await self._load_domain_registry_choices(
            current_domains=normalized_domains,
            override=effective_registry_override,
        )
        # Whether each stage was ROUTED AROUND, as distinct from whether it ran
        # and fell back. A skip means no model judgement exists for that stage
        # at all, and an unobservable substitution is indistinguishable from a
        # model answer, which is why these are never folded into fallback_used.
        merge_skipped = False
        structure_skipped = False

        # The intent agent alone decides memory versus command. There is no
        # earlier finance stage: a finance preference is memory like any other,
        # and the reserved registry files it under financial.agent_memory.
        fallback_intent = self._fallback_intent_frame(
            message=message,
            current_domains=normalized_domains,
            registry_choices=registry_choices,
        )
        intent_raw = await run_contract(
            manifest=self.memory_intent_manifest,
            prompt=self._build_memory_intent_prompt(
                message=message,
                current_domains=normalized_domains,
                registry_choices=registry_choices,
                simulated_state=simulated_state,
                strict_small_model=strict_small_model,
                context_quotes=context_quotes,
            ),
            response_schema=_INTENT_FRAME_SCHEMA,
            model_override=model_override,
            timeout_seconds=self._remaining_preview_budget_seconds(deadline),
            execution_trace=execution_trace,
        )
        intent_used_fallback = intent_raw is None
        intent_frame = self._sanitize_intent_frame(
            message=message,
            raw=intent_raw,
            fallback=fallback_intent,
            registry_choices=registry_choices,
            current_domains=normalized_domains,
        )

        merge_fallback = self._fallback_merge_decision(
            message=message,
            current_domains=normalized_domains,
            intent_frame=intent_frame,
            simulated_state=simulated_state,
        )
        if intent_frame.get("mutation_intent") == "no_op":
            merge_raw = None
            merge_used_fallback = False
            merge_skipped = True
        else:
            merge_raw = await run_contract(
                manifest=self.memory_merge_manifest,
                prompt=self._build_memory_merge_prompt(
                    message=message,
                    current_domains=normalized_domains,
                    intent_frame=intent_frame,
                    simulated_state=simulated_state,
                    strict_small_model=strict_small_model,
                ),
                response_schema=_MERGE_DECISION_SCHEMA,
                model_override=model_override,
                timeout_seconds=self._remaining_preview_budget_seconds(deadline),
                execution_trace=execution_trace,
            )
            merge_used_fallback = merge_raw is None
        merge_decision = self._sanitize_merge_decision(
            raw=merge_raw,
            fallback=merge_fallback,
            intent_frame=intent_frame,
            current_domains=normalized_domains,
            existing_entities=self._existing_entities(simulated_state, compact=strict_small_model),
            message=message,
        )
        merge_mode = str(merge_decision.get("merge_mode") or "")
        if merge_mode == "extend_entity":
            intent_frame["mutation_intent"] = "extend"
        elif merge_mode == "correct_entity":
            intent_frame["mutation_intent"] = "correct"
        elif merge_mode == "delete_entity":
            intent_frame["mutation_intent"] = "delete"

        fallback_target_domain = self._first_recommended_domain(
            intent_frame, fallback=_DEFAULT_CONFIRMATION_DOMAINS[0]
        )
        if self._should_skip_structure_agent(intent_frame=intent_frame):
            structure_raw = None
            structure_used_fallback = False
            # The model was never asked. That is not the same as the model
            # answering and needing no fallback, and until now both wrote
            # False here, so a skipped stage reported as a successful run.
            structure_skipped = True
        else:
            structure_raw = await run_contract(
                manifest=self.structure_manifest,
                prompt=self._build_structure_prompt(
                    message=message,
                    current_domains=normalized_domains,
                    registry_choices=registry_choices,
                    intent_frame=intent_frame,
                    merge_decision=merge_decision,
                    simulated_state=simulated_state,
                    strict_small_model=strict_small_model,
                    context_quotes=context_quotes,
                ),
                response_schema=_STRUCTURE_PREVIEW_SCHEMA,
                model_override=model_override,
                timeout_seconds=self._remaining_preview_budget_seconds(deadline),
                execution_trace=execution_trace,
            )
            structure_used_fallback = structure_raw is None
        normalized_preview = self._normalize_structure_preview(
            message=message,
            current_domains=normalized_domains,
            registry_choices=registry_choices,
            intent_frame=intent_frame,
            merge_decision=merge_decision,
            parsed_structure=structure_raw,
            fallback_target_domain=fallback_target_domain,
            simulated_state=simulated_state,
        )
        agent_manifest = self.structure_manifest
        manifest = self._build_manifest_from_payload(
            user_id=user_id,
            domain=normalized_preview["structure_decision"]["target_domain"],
            payload=normalized_preview["candidate_payload"],
            structure_decision=normalized_preview["structure_decision"],
        )

        errors = []
        if intent_used_fallback:
            errors.append("memory_intent_agent_fallback")
        if merge_used_fallback:
            errors.append("memory_merge_agent_fallback")
        if structure_used_fallback:
            errors.append("pkm_structure_agent_fallback")
        used_fallback = intent_used_fallback or merge_used_fallback or structure_used_fallback
        drift_flags = self._drift_flags_from_preview(
            validation_hints=normalized_preview["validation_hints"],
            fallback_used=used_fallback,
            intent_used_fallback=intent_used_fallback,
            merge_used_fallback=merge_used_fallback,
            structure_used_fallback=structure_used_fallback,
            intent_skipped=False,
            merge_skipped=merge_skipped,
            structure_skipped=structure_skipped,
        )

        return {
            "agent_id": agent_manifest.id,
            "agent_name": agent_manifest.name,
            "model": model_override or _manifest_model_name(agent_manifest) or GEMINI_MODEL,
            "used_fallback": used_fallback,
            "intent_used_fallback": intent_used_fallback,
            "merge_used_fallback": merge_used_fallback,
            "structure_used_fallback": structure_used_fallback,
            "intent_skipped": False,
            "merge_skipped": merge_skipped,
            "structure_skipped": structure_skipped,
            "drift_flags": drift_flags,
            "error": "; ".join(errors) or None,
            "intent_frame": intent_frame,
            "merge_decision": merge_decision,
            "candidate_payload": normalized_preview["candidate_payload"],
            "structure_decision": normalized_preview["structure_decision"],
            "write_mode": normalized_preview["write_mode"],
            "primary_json_path": normalized_preview["primary_json_path"],
            "target_entity_scope": normalized_preview["target_entity_scope"],
            "validation_hints": normalized_preview["validation_hints"],
            "reserved_offer": normalized_preview.get("reserved_offer"),
            "manifest_draft": manifest,
        }

    @staticmethod
    def _normalize_update_intent(
        update_intent: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Sanitize an explicit field-update intent supplied by the caller.

        Returns a normalized dict ({domain, field_path, current_value,
        proposed_value}) only when BOTH a domain and a field_path are present;
        otherwise None (the request falls back to free-form message handling).
        This is what makes the agent's update_pkm path deterministic: the
        confirm decision is driven by these structured slots, not by an LLM
        re-parse of a synthesized sentence (GAP 1 fix).
        """
        if not isinstance(update_intent, dict):
            return None
        domain = str(update_intent.get("domain") or "").strip()
        field_path = str(update_intent.get("field_path") or "").strip()
        if not domain or not field_path:
            return None
        return {
            "domain": domain,
            "field_path": field_path,
            "current_value": str(update_intent.get("current_value") or ""),
            "proposed_value": str(update_intent.get("proposed_value") or ""),
        }

    async def generate_structure_preview(
        self,
        *,
        user_id: str,
        message: str,
        current_domains: list[str] | None = None,
        current_manifests: list[dict[str, Any]] | None = None,
        simulated_state: dict[str, Any] | None = None,
        model_override: str | None = None,
        strict_small_model: bool = False,
        domain_registry_override: list[dict[str, Any]] | None = None,
        capture_execution_trace: bool = False,
        memory_profile: str = "general",
        continuation_scope: str | None = None,
    ) -> dict[str, Any]:
        total_started_at = time.perf_counter()
        normalized_domains = [
            self._normalize_segment(domain) for domain in (current_domains or []) if domain
        ]
        normalized_update_intent = self._normalize_update_intent(update_intent)
        preview_cache_key = self._preview_cache_key(
            user_id=user_id,
            message=message,
            current_domains=normalized_domains,
            current_manifests=current_manifests,
            simulated_state=simulated_state,
            model_override=model_override,
            strict_small_model=strict_small_model,
            domain_registry_override=domain_registry_override,
            memory_profile=memory_profile,
        )

        def resolve_model(manifest, override):
            return resolve_fleet_model_name(
                override or _manifest_model_name(manifest) or GEMINI_MODEL
            )

        # Bind cache entries to the effective authored contracts and execution
        # policy, not only the owner's submitted context. Source changes invalidate
        # continuation rather than silently replaying a previous interpretation.
        contracts = [
            (self.memory_segmentation_manifest, _SEGMENTATION_SCHEMA),
            (self.memory_intent_manifest, _INTENT_FRAME_SCHEMA),
            (self.memory_merge_manifest, _MERGE_DECISION_SCHEMA),
            (self.structure_manifest, _STRUCTURE_PREVIEW_SCHEMA),
        ]
        runtime_fingerprint = "".join(
            contract_fingerprint(manifest, resolve_model(manifest, model_override), schema)
            for manifest, schema in contracts
        )
        for relative_path in (
            "services/pkm_agent_lab_service.py",
            "services/pkm_preview_continuation.py",
            "services/domain_contracts.py",
            "hushh_adk/single_turn.py",
            "hushh_adk/turn.py",
            "runtime_providers/gemini_config.py",
        ):
            runtime_fingerprint += hashlib.sha256(
                (_REPO_ROOT / "hushh_mcp" / relative_path).read_bytes()
            ).hexdigest()
        runtime_fingerprint += json.dumps(
            [
                continuation_scope,
                _PREVIEW_TOTAL_BUDGET_SECONDS,
                _AGENT_CONTRACT_TIMEOUT_SECONDS,
                _AGENT_CONTRACT_MAX_ATTEMPTS,
            ]
        )
        preview_cache_key = hashlib.sha256(
            (preview_cache_key + runtime_fingerprint).encode()
        ).hexdigest()
        prefix = None
        checkpoint_expiry = time.time() + _PREVIEW_CACHE_TTL_SECONDS
        if not capture_execution_trace:
            cached_preview = self._get_cached_structure_preview(preview_cache_key)
            if cached_preview is not None:
                if "__validated_preparation_prefix" in cached_preview:
                    prefix = cached_preview["__validated_preparation_prefix"]
                    checkpoint_expiry = _PREVIEW_CACHE[preview_cache_key][0]
                else:
                    logger.info("pkm.agent_lab.preview_cache_hit")
                    return cached_preview
            inflight_preview = _PREVIEW_INFLIGHT.get(preview_cache_key)
            if inflight_preview is not None:
                logger.info("pkm.agent_lab.preview_inflight_hit")
                return deepcopy(await inflight_preview)

        async def _build_preview() -> dict[str, Any]:
            errors: list[str] = []
            continuation = PreviewContinuation(
                run=self._run_agent_contract,
                resolve_model=resolve_model,
                records={
                    key: value for key, value in (prefix or {}).items() if key != "__segments"
                },
            )
            # These records contain only stage outcomes/timings, never model
            # values. Keep them on normal responses so failures are diagnosable
            # without trace mode's deliberate cache/inflight bypass.
            execution_trace: list[dict[str, Any]] = []
            if memory_profile == "kyc_identity_v1":
                response_payload = await self._generate_kyc_identity_preview(
                    user_id=user_id,
                    message=message,
                    current_domains=normalized_domains,
                    model_override=model_override,
                    execution_trace=execution_trace,
                )
                if execution_trace is not None:
                    response_payload.setdefault("performance", {})["agent_execution"] = (
                        execution_trace
                    )
                if not capture_execution_trace:
                    self._set_cached_structure_preview(preview_cache_key, response_payload)
                return response_payload
            preview_deadline = time.perf_counter() + _PREVIEW_TOTAL_BUDGET_SECONDS

            segmentation_started_at = time.perf_counter()
            segmentation_raw = await continuation.run(
                manifest=self.memory_segmentation_manifest,
                prompt=self._build_memory_segmentation_prompt(
                    message=message,
                    strict_small_model=strict_small_model,
                ),
                response_schema=_SEGMENTATION_SCHEMA,
                model_override=model_override,
                timeout_seconds=self._remaining_preview_budget_seconds(preview_deadline),
                execution_trace=execution_trace,
            )
            segmentation_latency_ms = round(
                (time.perf_counter() - segmentation_started_at) * 1000, 2
            )
            segmentation_used_fallback = not (
                isinstance(segmentation_raw, dict)
                and type(segmentation_raw.get("has_more_candidates")) is bool
            )
            if isinstance(segmentation_raw, dict):
                raw_segments = segmentation_raw.get("segments")
                # A malformed batch is a schema failure. A quote that does not
                # match the owner's text is not: that one segment is dropped
                # and reported in _sanitize_segmentation, and the rest of the
                # section is kept (it used to discard the whole section).
                if not isinstance(raw_segments, list) or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("source_text"), str)
                    or not item["source_text"].strip()
                    for item in (raw_segments if isinstance(raw_segments, list) else [])
                ):
                    segmentation_used_fallback = True
            if segmentation_used_fallback:
                errors.append("memory_segmentation_agent_fallback")
                # Invalid coverage is a schema failure, not a successful
                # semantic selection. Never auto-save a partially certified batch.
                segmentation_raw = None

            segmented_messages, not_memory, unmatched_quotes = self._sanitize_segmentation(
                segmentation_raw, message=message
            )
            if unmatched_quotes:
                logger.info("pkm.agent_lab.segment_quote_unmatched count=%s", unmatched_quotes)
            total_segments_detected = len(segmented_messages)
            split_recommended = total_segments_detected > _MAX_PREVIEW_CARDS or (
                isinstance(segmentation_raw, dict)
                and segmentation_raw.get("has_more_candidates") is True
            )
            # A selected source span must not lose a trailing qualifier just
            # to fit a limit. Ask the existing client splitter for a smaller
            # passage; no truncated prefix becomes a memory candidate.
            oversized_source = isinstance(segmentation_raw, dict) and any(
                isinstance(item, dict)
                and isinstance(item.get("source_text"), str)
                and len(item["source_text"]) > _MAX_SEGMENT_SOURCE_CHARS
                for item in (segmentation_raw.get("segments") or [])
            )
            split_recommended = split_recommended or oversized_source
            preview_results: list[dict[str, Any]] = []
            preview_cards: list[dict[str, Any]] = []
            preview_latencies_ms: list[float] = []

            async def _build_preview_entry(
                index: int, segment: dict[str, Any]
            ) -> dict[str, Any] | None:
                source_text = segment["source_text"]
                context_quotes = list(segment.get("context_quotes") or [])
                if not source_text:
                    return None
                source_key = hashlib.sha256(source_text.encode()).hexdigest()
                multiple = total_segments_detected > 1
                segment_trace: list[dict[str, Any]] = []
                segment_continuation = continuation
                if multiple:
                    # Never share mutable agent-ID records across concurrent
                    # candidates. Exact prompt fingerprints still gate reuse.
                    segment_continuation = PreviewContinuation(
                        run=self._run_agent_contract,
                        resolve_model=resolve_model,
                        records=(prefix or {}).get("__segments", {}).get(source_key),
                    )
                    segmentation_record = continuation.records.get("agent_memory_segmentation")
                    if segmentation_record is not None:
                        segment_continuation.records["agent_memory_segmentation"] = deepcopy(
                            segmentation_record
                        )
                preview_started_at = time.perf_counter()
                preview = await self._generate_single_structure_preview(
                    user_id=user_id,
                    message=source_text,
                    context_quotes=context_quotes,
                    current_domains=normalized_domains,
                    current_manifests=current_manifests,
                    simulated_state=simulated_state,
                    model_override=model_override,
                    strict_small_model=strict_small_model,
                    domain_registry_override=domain_registry_override,
                    update_intent=normalized_update_intent,
                    deadline=preview_deadline,
                    execution_trace=segment_trace if multiple else execution_trace,
                    contract_runner=segment_continuation.run,
                )
                if multiple:
                    execution_trace.extend(
                        {**row, "candidate_index": index} for row in segment_trace
                    )
                preview_latency_ms = round((time.perf_counter() - preview_started_at) * 1000, 2)
                card_id = f"card_{index:02d}"
                card = self._build_preview_card(
                    card_id=card_id,
                    source_text=source_text,
                    preview=preview,
                    simulated_state=simulated_state,
                )
                card["context_quotes"] = context_quotes
                return {
                    "preview": preview,
                    "latency_ms": preview_latency_ms,
                    "card": card,
                    "source_key": source_key,
                    "checkpoint": segment_continuation.checkpoint(
                        message=message,
                        segment_source=source_text,
                        response={**preview, "preview_cards": [card]},
                        trace=segment_trace,
                    )
                    if multiple and continuation_scope and not segmentation_used_fallback
                    else None,
                }

            preview_entries = await asyncio.gather(
                *[
                    _build_preview_entry(index, segment)
                    for index, segment in enumerate(
                        segmented_messages[:_MAX_PREVIEW_CARDS], start=1
                    )
                ]
            )

            for entry in preview_entries:
                if entry is None:
                    continue
                preview = entry["preview"]
                preview_latencies_ms.append(float(entry["latency_ms"]))
                preview_results.append(preview)
                preview_cards.append(entry["card"])
                if preview.get("error"):
                    errors.append(str(preview.get("error")))

            primary_preview = next(
                (result for result in preview_results if result.get("write_mode") != "do_not_save"),
                preview_results[0] if preview_results else None,
            )
            preview_summary = self._aggregate_preview_summary(
                preview_cards=preview_cards,
                split_recommended=split_recommended,
                total_segments_detected=total_segments_detected,
            )
            # Lines the segmentation agent accounted for without saving, as
            # exact quotes; the device maps them onto its coverage receipt.
            preview_summary["not_memory"] = not_memory
            preview_summary["unmatched_quote_count"] = unmatched_quotes
            context_plan = self._context_plan_from_cards(preview_cards)
            total_latency_ms = round((time.perf_counter() - total_started_at) * 1000, 2)
            performance = {
                "total_latency_ms": total_latency_ms,
                "stage_latencies_ms": {
                    "memory_segmentation": segmentation_latency_ms,
                    "preview_cards_total": round(sum(preview_latencies_ms), 2),
                    "preview_cards_average": round(
                        sum(preview_latencies_ms) / len(preview_latencies_ms), 2
                    )
                    if preview_latencies_ms
                    else 0.0,
                },
                "cards_returned": len(preview_cards),
                "context_domains_considered": normalized_domains,
                "context_domains_loaded": context_plan.get("candidate_domains") or [],
                "context_domains_decrypted": [],
                "context_segments_loaded": context_plan.get("candidate_segment_ids") or [],
                "strategy": "metadata_first_targeted_segments",
                "budget_seconds": _PREVIEW_TOTAL_BUDGET_SECONDS,
                "budget_remaining_seconds": round(
                    self._remaining_preview_budget_seconds(preview_deadline) or 0.0, 3
                ),
            }
            if execution_trace is not None:
                performance["agent_execution"] = execution_trace

            if primary_preview is None:
                # An explicit, valid empty segmentation is the model's no-op
                # decision, not a failed provider call. Malformed output and
                # rejected nonempty source quotes still fail closed.
                # Nothing to save, and every quote the agent returned matched:
                # an empty selection, or a section that is all disclaimer or
                # duplicate lines (reported in not_memory). An unmatched quote
                # keeps this a retryable failure instead.
                empty_selection = (
                    isinstance(segmentation_raw, dict)
                    and isinstance(segmentation_raw.get("segments"), list)
                    and not segmented_messages
                    and unmatched_quotes == 0
                    and segmentation_raw.get("has_more_candidates") is False
                    and type(segmentation_raw.get("contract_version")) is int
                    and segmentation_raw["contract_version"] == 1
                    and isinstance(segmentation_raw.get("source_agent"), str)
                    and bool(segmentation_raw["source_agent"].strip())
                )
                retryable_split = split_recommended and not segmentation_used_fallback
                preparation_valid = empty_selection or retryable_split
                empty_hints = [] if preparation_valid else ["preview_generation_failed"]
                if split_recommended:
                    empty_hints.append("split_recommended")
                if unmatched_quotes:
                    empty_hints.append("segment_quote_unmatched")
                empty_manifest = self._build_manifest_from_payload(
                    user_id=user_id,
                    domain="professional",
                    payload={},
                    structure_decision={
                        "action": "create_domain",
                        "target_domain": "professional",
                        "json_paths": [],
                        "top_level_scope_paths": [],
                        "externalizable_paths": [],
                        "summary_projection": {},
                        "sensitivity_labels": {},
                        "confidence": 0.0,
                        "source_agent": "pkm_structure_agent",
                        "contract_version": 1,
                    },
                )
                response_payload = {
                    "agent_id": self.memory_segmentation_manifest.id,
                    "agent_name": self.memory_segmentation_manifest.name,
                    "model": model_override
                    or _manifest_model_name(self.memory_segmentation_manifest)
                    or GEMINI_MODEL,
                    "used_fallback": not preparation_valid,
                    "intent_used_fallback": False,
                    "merge_used_fallback": False,
                    "structure_used_fallback": False,
                    "drift_flags": self._drift_flags_from_preview(
                        validation_hints=empty_hints,
                        fallback_used=not preparation_valid,
                    ),
                    "error": None
                    if preparation_valid
                    else "; ".join(self._unique_list(errors or ["memory_segmentation_no_output"])),
                    "intent_frame": {},
                    "merge_decision": {},
                    "candidate_payload": {},
                    "structure_decision": empty_manifest["structure_decision"],
                    "write_mode": "do_not_save",
                    "primary_json_path": None,
                    "target_entity_scope": None,
                    "validation_hints": empty_hints,
                    "manifest_draft": empty_manifest,
                    "preview_cards": preview_cards,
                    "preview_summary": preview_summary,
                    "performance": performance,
                    "context_plan": context_plan,
                }
                if not capture_execution_trace:
                    self._set_cached_structure_preview(preview_cache_key, response_payload)
                return response_payload

            validation_hints = list(primary_preview.get("validation_hints") or [])
            if split_recommended and "split_recommended" not in validation_hints:
                validation_hints.append("split_recommended")
            if unmatched_quotes:
                validation_hints.append("segment_quote_unmatched")

            response_payload = {
                **primary_preview,
                # These are batch health signals, not the first card's health.
                # Preserve each card's semantic result while ensuring a later
                # timeout cannot be reported as fully prepared information.
                **{
                    field: any(bool(result.get(field)) for result in preview_results)
                    for field in (
                        "intent_used_fallback",
                        "merge_used_fallback",
                        "structure_used_fallback",
                        "intent_skipped",
                        "merge_skipped",
                        "structure_skipped",
                    )
                },
                "used_fallback": bool(
                    segmentation_used_fallback
                    or any(result.get("used_fallback") for result in preview_results)
                ),
                "error": "; ".join(self._unique_list(errors)) or primary_preview.get("error"),
                "validation_hints": self._unique_list(validation_hints),
                "preview_cards": preview_cards,
                "preview_summary": preview_summary,
                "performance": performance,
                "context_plan": context_plan,
            }
            response_payload["drift_flags"] = self._drift_flags_from_preview(
                validation_hints=response_payload["validation_hints"],
                fallback_used=bool(response_payload.get("used_fallback")),
                intent_used_fallback=bool(response_payload.get("intent_used_fallback")),
                merge_used_fallback=bool(response_payload.get("merge_used_fallback")),
                structure_used_fallback=bool(response_payload.get("structure_used_fallback")),
                intent_skipped=bool(response_payload.get("intent_skipped")),
                merge_skipped=bool(response_payload.get("merge_skipped")),
                structure_skipped=bool(response_payload.get("structure_skipped")),
            )
            if not capture_execution_trace:
                checkpoint = (
                    continuation.checkpoint(
                        message=message, response=response_payload, trace=execution_trace
                    )
                    if continuation_scope
                    else None
                )
                if continuation_scope and total_segments_detected > 1 and not split_recommended:
                    segment_prefixes = {
                        entry["source_key"]: entry["checkpoint"]
                        for entry in preview_entries
                        if entry is not None and entry["checkpoint"] is not None
                    }
                    checkpoint = (
                        {
                            "agent_memory_segmentation": continuation.records[
                                "agent_memory_segmentation"
                            ],
                            "__segments": segment_prefixes,
                        }
                        if segment_prefixes
                        else None
                    )
                self._set_cached_structure_preview(
                    preview_cache_key,
                    response_payload,
                    checkpoint=checkpoint,
                    expires_at=checkpoint_expiry if checkpoint else None,
                )
            return response_payload

        if capture_execution_trace:
            return deepcopy(await _build_preview())
        task = asyncio.create_task(_build_preview())
        _PREVIEW_INFLIGHT[preview_cache_key] = task
        try:
            return deepcopy(await task)
        finally:
            current = _PREVIEW_INFLIGHT.get(preview_cache_key)
            if current is task:
                _PREVIEW_INFLIGHT.pop(preview_cache_key, None)


_pkm_agent_lab_service: PKMAgentLabService | None = None


def get_pkm_agent_lab_service() -> PKMAgentLabService:
    global _pkm_agent_lab_service
    if _pkm_agent_lab_service is None:
        _pkm_agent_lab_service = PKMAgentLabService()
    return _pkm_agent_lab_service
