from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from copy import deepcopy
from pathlib import Path
from typing import Any

from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.services.domain_contracts import CANONICAL_DOMAIN_REGISTRY

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MEMORY_INTENT_MANIFEST_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "memory_intent" / "agent.yaml"
_PKM_STRUCTURE_MANIFEST_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "pkm_structure" / "agent.yaml"
_MEMORY_MERGE_MANIFEST_PATH = _REPO_ROOT / "hushh_mcp" / "agents" / "memory_merge" / "agent.yaml"
_MEMORY_SEGMENTATION_MANIFEST_PATH = (
    _REPO_ROOT / "hushh_mcp" / "agents" / "memory_segmentation" / "agent.yaml"
)
_FINANCIAL_GUARD_MANIFEST_PATH = (
    _REPO_ROOT / "hushh_mcp" / "agents" / "financial_guard" / "agent.yaml"
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
    "correction",
    "deletion",
    "note",
    "ambiguous",
}
_MUTATION_INTENTS = {"create", "extend", "update", "correct", "delete", "no_op"}
_WRITE_MODES = {"can_save", "confirm_first", "do_not_save"}
_FINANCIAL_GUARD_ROUTES = {
    "financial_core",
    "sanctioned_financial_memory",
    "non_financial_or_ephemeral",
}
_MERGE_MODES = {
    "create_entity",
    "extend_entity",
    "correct_entity",
    "delete_entity",
    "no_op",
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
_FINANCIAL_TOP_LEVEL_KEYS = {
    "events",
    "portfolio",
    "holdings",
    "analysis",
    "documents",
    "sources",
    "runtime",
    "goals",
    "profile",
}
_FOOD_HINTS = {
    "food",
    "meal",
    "restaurant",
    "eat",
    "breakfast",
    "lunch",
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
    "hotel",
    "vacation",
    "airport",
    "airline",
    "seat",
}
_HEALTH_HINTS = {
    "allergic",
    "allergy",
    "health",
    "doctor",
    "medical",
    "sleep",
    "workout",
    "fitness",
    "run",
    "running",
}
_SHOPPING_HINTS = {
    "buy",
    "order",
    "wishlist",
    "shopping",
    "brand",
    "purchase",
}
_RELATIONSHIP_HINTS = {
    "mom",
    "dad",
    "wife",
    "husband",
    "partner",
    "friend",
    "family",
    "relationship",
}
_FINANCIAL_HINTS = {
    "stock",
    "portfolio",
    "investment",
    "invest",
    "broker",
    "plaid",
    "retirement",
    "401k",
    "ira",
    "dividend",
}
_FINANCIAL_CORE_HINTS = {
    "optimize",
    "rebalance",
    "analyze",
    "analyse",
    "allocate",
    "buy",
    "sell",
    "review",
    "adjust",
    "lower_volatility",
    "concentration_risk",
}
_FINANCIAL_MEMORY_HINTS = {
    "remember",
    "prefer",
    "preferences",
    "comfortable",
    "risk_tolerance",
    "index_funds",
    "dividend_paying",
    "automatic_monthly_investing",
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
_ENTITY_STATUS_ACTIVE = "active"
_ENTITY_STATUS_CORRECTED = "corrected"
_ENTITY_STATUS_DELETED = "deleted"
_MAX_PREVIEW_CARDS = 4
_SOFT_ONTOLOGY_KEYS = tuple(
    entry.domain_key
    for entry in CANONICAL_DOMAIN_REGISTRY
    if entry.domain_key and entry.domain_key != _GENERAL_DOMAIN_KEY
)
_INTENT_DOMAIN_DEFAULTS: dict[str, tuple[str, ...]] = {
    "preference": ("food", "travel", "shopping", "social"),
    "profile_fact": ("location", "social", "professional"),
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
        "confidence": {"type": "NUMBER"},
        "reason": {"type": "STRING"},
    },
    "required": ["source_text", "confidence", "reason"],
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
    },
    "required": ["segments", "source_agent", "contract_version"],
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

_FINANCIAL_GUARD_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "routing_decision": {
            "type": "STRING",
            "enum": sorted(_FINANCIAL_GUARD_ROUTES),
        },
        "confidence": {"type": "NUMBER"},
        "reason": {"type": "STRING"},
        "source_agent": {"type": "STRING"},
        "contract_version": {"type": "INTEGER"},
    },
    "required": [
        "routing_decision",
        "confidence",
        "reason",
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

_STRUCTURE_DECISION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "action": {
            "type": "STRING",
            "enum": ["match_existing_domain", "create_domain", "extend_domain"],
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


class PKMAgentLabService:
    def __init__(self) -> None:
        self._memory_segmentation_manifest = None
        self._financial_guard_manifest = None
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
    def financial_guard_manifest(self):
        if self._financial_guard_manifest is None:
            self._financial_guard_manifest = ManifestLoader.load(
                str(_FINANCIAL_GUARD_MANIFEST_PATH)
            )
        return self._financial_guard_manifest

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
        api_key = (
            str(os.getenv("GEMINI_API_KEY", "")).strip()
            or str(os.getenv("GOOGLE_API_KEY", "")).strip()
            or str(os.getenv("GOOGLE_GENAI_API_KEY", "")).strip()
        )
        if not api_key:
            return None
        try:
            from google import genai

            self._client = genai.Client(api_key=api_key)
        except Exception as exc:
            logger.warning("pkm.agent_lab_client_unavailable error=%s", exc)
            self._client = None
        return self._client

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
        return " ".join(part.replace("_", " ").title() for part in value.split(".") if part)

    @classmethod
    def _infer_sensitivity(cls, path: str) -> str | None:
        normalized = path.lower()
        if any(token in normalized for token in ("ssn", "tax", "account_number", "routing")):
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
        normalized = cls._safe_excerpt(message, limit=2000)
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
    def _sanitize_segmented_messages(
        cls,
        raw: dict[str, Any] | None,
        *,
        message: str,
    ) -> list[dict[str, Any]]:
        fallback = cls._fallback_segmented_messages(message)
        if not isinstance(raw, dict):
            return fallback

        items = raw.get("segments")
        if not isinstance(items, list):
            return fallback

        sanitized: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            source_text = cls._safe_excerpt(str(item.get("source_text") or ""), limit=280)
            if not source_text:
                continue
            normalized = source_text.casefold()
            if normalized in seen:
                continue
            seen.add(normalized)
            sanitized.append(
                {
                    "source_text": source_text,
                    "confidence": cls._clamp_confidence(item.get("confidence"), default=0.8),
                    "reason": cls._safe_excerpt(str(item.get("reason") or ""), limit=160)
                    or "Segmented memory candidate.",
                }
            )
        return sanitized or fallback

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
        return {token for token in cls._normalize_path(normalized).split(".") if token}

    @classmethod
    def _is_finance_message(cls, message: str) -> bool:
        normalized_message = cls._safe_excerpt(message, limit=400).lower()
        tokens = cls._message_tokens(message)
        return any(token in tokens or token in normalized_message for token in _FINANCIAL_HINTS)

    @classmethod
    def _is_correction_message(cls, message: str) -> bool:
        normalized = cls._safe_excerpt(message, limit=400).lower()
        return any(
            phrase in normalized for phrase in ("actually", "not anymore", "changed my mind")
        )

    @classmethod
    def _is_deletion_message(cls, message: str) -> bool:
        normalized = cls._safe_excerpt(message, limit=400).lower()
        return any(phrase in normalized for phrase in ("forget that", "delete", "remove that"))

    @classmethod
    def _keyword_ranked_domains(
        cls,
        *,
        message: str,
        current_domains: list[str],
    ) -> list[str]:
        normalized_message = cls._safe_excerpt(message, limit=400).lower()
        tokens = cls._message_tokens(message)
        ranked: list[str] = []
        if any(token in tokens or token in normalized_message for token in _FINANCIAL_HINTS):
            ranked.append("financial")
        if any(token in tokens or token in normalized_message for token in _FOOD_HINTS):
            ranked.append("food")
        if any(token in tokens or token in normalized_message for token in _TRAVEL_HINTS):
            ranked.append("travel")
        if any(token in tokens or token in normalized_message for token in _HEALTH_HINTS):
            ranked.append("health")
        if any(token in tokens or token in normalized_message for token in _SHOPPING_HINTS):
            ranked.append("shopping")
        if any(token in tokens or token in normalized_message for token in _RELATIONSHIP_HINTS):
            ranked.append("social")
        for domain in current_domains:
            normalized_domain = cls._normalize_segment(domain)
            if normalized_domain and normalized_domain != _GENERAL_DOMAIN_KEY:
                ranked.append(normalized_domain)
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
        return {
            "domain_key": domain_key,
            "display_name": display_name or defaults["display_name"],
            "description": description or defaults["description"],
            "recommended": bool(recommended),
        }

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

    async def _run_agent_contract(
        self,
        *,
        manifest: Any,
        prompt: str,
        response_schema: dict[str, Any],
        model_override: str | None = None,
    ) -> dict[str, Any] | None:
        if self.client is None:
            return None
        try:
            from google.genai import types as genai_types

            config = genai_types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type="application/json",
                automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
                response_schema=response_schema,
            )
            response = await self.client.aio.models.generate_content(
                model=model_override or manifest.model or GEMINI_MODEL,
                contents=prompt,
                config=config,
            )
            parsed = (
                response.parsed if isinstance(getattr(response, "parsed", None), dict) else None
            )
            if parsed is None:
                parsed = json.loads((response.text or "").strip() or "{}")
            return parsed if isinstance(parsed, dict) else None
        except Exception as exc:
            logger.warning(
                "pkm.agent_contract_failed agent=%s error=%s",
                getattr(manifest, "id", "unknown"),
                exc,
            )
            return None

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
        *,
        limit: int = 8,
    ) -> list[str]:
        compact: list[str] = []
        for entry in registry_choices:
            domain_key = cls._normalize_segment(str(entry.get("domain_key") or ""))
            if domain_key and domain_key != _GENERAL_DOMAIN_KEY:
                compact.append(domain_key)
            if len(compact) >= limit:
                break
        return compact

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
        header = (
            "You are the Memory Segmentation Agent for Hushh Kai.\n"
            "Return JSON only with segments, source_agent, contract_version.\n"
            "Split a single natural-language prompt into 1 to 4 meaningful memory candidates.\n"
        )
        if strict_small_model:
            return (
                f"{header}"
                f"Message: {message}\n"
                "Rules:\n"
                "- Keep each segment self-contained and short.\n"
                "- Split only when the prompt clearly contains multiple durable or semi-durable ideas.\n"
                "- Do not invent facts that were not stated.\n"
                "- If the prompt is one coherent memory, return one segment only.\n"
                "- contract_version must be 1.\n"
                'Examples: {"message":"I like to swim and prefer early breakfasts.","segments":[{"source_text":"I like to swim.","confidence":0.91,"reason":"Exercise preference."},{"source_text":"I prefer early breakfasts.","confidence":0.84,"reason":"Separate food habit."}]} '
                '{"message":"I usually book aisle seats.","segments":[{"source_text":"I usually book aisle seats.","confidence":0.97,"reason":"Single travel preference."}]}'
            )
        return (
            f"{header}"
            f"Natural language message: {message}\n"
            "Rules:\n"
            "- Return 1 segment for a single coherent memory.\n"
            "- Return multiple segments only when the prompt clearly contains multiple distinct memories, routines, preferences, or facts.\n"
            "- Do not split purely stylistic repetition.\n"
            "- Keep source_text close to the user's own wording.\n"
            "- Never emit more than 4 segments.\n"
            "- contract_version must be 1.\n"
        )

    def _build_financial_guard_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
    ) -> str:
        state_summary = (
            self._compact_state_summary(simulated_state)
            if strict_small_model
            else self._build_state_summary(simulated_state)
        )
        registry_payload: list[Any]
        if strict_small_model:
            registry_payload = self._compact_registry_choices(registry_choices)
        else:
            registry_payload = registry_choices
        header = (
            "You are the Financial Guard Agent for Kai.\n"
            "Return JSON only with routing_decision, confidence, reason, source_agent, contract_version.\n"
            "Allowed routing_decision values: financial_core, sanctioned_financial_memory, non_financial_or_ephemeral.\n"
        )
        if strict_small_model:
            # nosec B608 - this is an LLM prompt template, not a SQL query.
            return (
                f"{header}"
                "Rules:\n"
                "- financial_core = governed financial analysis, optimization, trading, allocation, or portfolio action.\n"
                "- sanctioned_financial_memory = durable financial preference or durable financial goal worth remembering.\n"
                "- non_financial_or_ephemeral = reminders, operational asks, or anything not clearly financial memory/core.\n"
                "- Shopping habits, brand loyalty, cuisine choices, and ordinary purchases are not financial unless the message is explicitly about investing, portfolio construction, or a financial product.\n"
                "- Personal life goals like saving for a home or paying off loans are not sanctioned financial memory by default; let downstream intent classification decide the durable domain.\n"
                "- Prefer non_financial_or_ephemeral when uncertain.\n"
                f"Current domains: {json.dumps(current_domains)}\n"
                f"Registry domain keys: {json.dumps(registry_payload)}\n"
                f"State summary: {json.dumps(state_summary)}\n"
                f"Message: {message}\n"
                'Examples: {"message":"Optimize my portfolio for lower volatility.","routing_decision":"financial_core"} '
                '{"message":"Remember that I prefer index funds.","routing_decision":"sanctioned_financial_memory"} '
                '{"message":"I tend to buy basics from Patagonia before I look anywhere else.","routing_decision":"non_financial_or_ephemeral"} '
                '{"message":"One medium-term priority for me is to save for a condo by 2028.","routing_decision":"non_financial_or_ephemeral"} '
                '{"message":"Remind me to review my brokerage statement tomorrow.","routing_decision":"non_financial_or_ephemeral"}'
            )
        return (
            f"{header}"
            f"Current top-level PKM domains: {json.dumps(current_domains)}\n"
            f"Higher-level domain registry choices: {json.dumps(registry_payload)}\n"
            f"Current simulated PKM state summary: {json.dumps(state_summary)}\n"
            f"Natural language message: {message}\n"
            "Rules:\n"
            "- financial_core = governed financial action or analysis request.\n"
            "- sanctioned_financial_memory = stable financial preference worth remembering.\n"
            "- non_financial_or_ephemeral = non-financial, reminder-like, or too operational for durable financial memory.\n"
            '- "I prefer dividend-paying stocks." -> sanctioned_financial_memory\n'
            '- "Optimize my portfolio for lower volatility." -> financial_core\n'
            '- "Remind me to review my brokerage statement tomorrow." -> non_financial_or_ephemeral\n'
        )

    @classmethod
    def _fallback_financial_guard_decision(
        cls,
        *,
        message: str,
        current_domains: list[str],
    ) -> dict[str, Any]:
        normalized = cls._safe_excerpt(message, limit=600).lower()
        tokens = cls._message_tokens(message)
        finance_signaled = cls._is_finance_message(message)

        if not finance_signaled:
            return {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.9,
                "reason": "The message is not clearly about governed financial behavior or durable financial memory.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            }

        if normalized.startswith("remind me") or any(
            phrase in normalized for phrase in ("tomorrow", "next week", "later today")
        ):
            return {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.88,
                "reason": "The message is finance-adjacent but operational or time-bound rather than durable governed financial intent.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            }

        if any(token in tokens or token in normalized for token in _FINANCIAL_MEMORY_HINTS) or any(
            phrase in normalized
            for phrase in (
                "remember that i prefer",
                "i prefer",
                "my risk tolerance",
                "comfortable with",
                "prefer index funds",
                "prefer dividend-paying stocks",
            )
        ):
            return {
                "routing_decision": "sanctioned_financial_memory",
                "confidence": 0.84,
                "reason": "The message describes a stable financial preference or memory that can extend the governed financial domain without triggering a live portfolio action.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            }

        if any(token in tokens or token in normalized for token in _FINANCIAL_CORE_HINTS) or (
            "portfolio" in tokens
            and any(
                phrase in normalized
                for phrase in ("i want", "lower", "reduce", "increase", "optimize", "rebalance")
            )
        ):
            return {
                "routing_decision": "financial_core",
                "confidence": 0.9,
                "reason": "The message asks Kai to reason about or act on the governed financial lane rather than store a new durable PKM preference.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            }

        return {
            "routing_decision": "sanctioned_financial_memory"
            if "financial" in current_domains
            else "financial_core",
            "confidence": 0.72,
            "reason": "The message is clearly financial, but a guarded lane is still safer than general PKM routing.",
            "source_agent": "financial_guard_agent",
            "contract_version": 1,
        }

    @classmethod
    def _sanitize_financial_guard_decision(
        cls,
        *,
        raw: dict[str, Any] | None,
        fallback: dict[str, Any],
    ) -> dict[str, Any]:
        decision = deepcopy(fallback)
        if isinstance(raw, dict):
            routing_decision = str(raw.get("routing_decision") or "").strip().lower()
            if routing_decision in _FINANCIAL_GUARD_ROUTES:
                decision["routing_decision"] = routing_decision
            decision["confidence"] = cls._clamp_confidence(
                raw.get("confidence"),
                default=float(decision["confidence"]),
            )
            decision["reason"] = str(raw.get("reason") or decision["reason"] or "").strip()
            decision["source_agent"] = (
                cls._normalize_segment(str(raw.get("source_agent") or ""))
                or "financial_guard_agent"
            )
            try:
                decision["contract_version"] = int(raw.get("contract_version") or 1)
            except Exception:
                decision["contract_version"] = 1
        if not decision.get("reason"):
            decision["reason"] = "Financial Guard Agent routed the message conservatively."
        return decision

    @classmethod
    def _intent_frame_from_financial_guard(
        cls,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        financial_guard: dict[str, Any],
    ) -> dict[str, Any]:
        routing_decision = str(financial_guard.get("routing_decision") or "").strip().lower()
        mutation_intent = "extend" if "financial" in current_domains else "create"
        requires_confirmation = False
        confirmation_reason = ""
        confidence = cls._clamp_confidence(financial_guard.get("confidence"), default=0.82)
        if routing_decision == "sanctioned_financial_memory" and confidence < 0.7:
            requires_confirmation = True
            confirmation_reason = str(financial_guard.get("reason") or "").strip()
        return {
            "save_class": "durable",
            "intent_class": "financial_event",
            "mutation_intent": mutation_intent,
            "requires_confirmation": requires_confirmation,
            "confirmation_reason": confirmation_reason,
            "candidate_domain_choices": cls._candidate_domain_choices(
                ranked_domains=["financial", *current_domains],
                registry_choices=registry_choices,
            ),
            "confidence": confidence,
            "source_agent": str(financial_guard.get("source_agent") or "financial_guard_agent"),
            "contract_version": int(financial_guard.get("contract_version") or 1),
        }

    @classmethod
    def _fallback_intent_frame(
        cls,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        financial_guard: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized = cls._safe_excerpt(message, limit=800).lower()
        tokens = cls._message_tokens(message)
        ranked_domains = cls._keyword_ranked_domains(
            message=message, current_domains=current_domains
        )
        finance_route = (
            str(financial_guard.get("routing_decision") or "").strip().lower()
            if isinstance(financial_guard, dict)
            else ""
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
        elif normalized.startswith("remind me") or "todo" in tokens or "to_do" in tokens:
            save_class = "ephemeral"
            intent_class = "task_or_reminder"
            mutation_intent = "no_op"
            confidence = 0.92
        elif finance_route == "sanctioned_financial_memory":
            save_class = "durable"
            intent_class = "financial_event"
            mutation_intent = "extend" if "financial" in current_domains else "create"
            confidence = max(
                0.84,
                cls._clamp_confidence(
                    financial_guard.get("confidence")
                    if isinstance(financial_guard, dict)
                    else None,
                    default=0.84,
                ),
            )
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
        elif any(
            phrase in normalized for phrase in ("i like", "i love", "i prefer", "my favorite")
        ):
            save_class = "durable"
            intent_class = "preference"
            mutation_intent = "extend" if current_domains else "create"
            confidence = 0.78
        elif any(token in tokens or token in normalized for token in _HEALTH_HINTS):
            save_class = "durable"
            intent_class = "health"
            mutation_intent = "extend" if "health" in current_domains else "create"
            confidence = 0.8
        elif any(token in tokens or token in normalized for token in _TRAVEL_HINTS):
            save_class = "durable"
            intent_class = "travel"
            mutation_intent = "extend" if "travel" in current_domains else "create"
            confidence = 0.78
        elif any(token in tokens or token in normalized for token in _SHOPPING_HINTS):
            save_class = "durable"
            intent_class = "shopping_need"
            mutation_intent = "extend" if "shopping" in current_domains else "create"
            confidence = 0.76
        elif any(token in tokens or token in normalized for token in _RELATIONSHIP_HINTS):
            save_class = "durable"
            intent_class = "relationship"
            mutation_intent = "extend" if "social" in current_domains else "create"
            confidence = 0.76
        elif any(phrase in normalized for phrase in _AMBIGUOUS_PREFIXES) or len(tokens) <= 2:
            save_class = "ambiguous"
            intent_class = "ambiguous"
            mutation_intent = "no_op"
            confidence = 0.42
            confirmation_reason = "The message is too short or underspecified to safely choose one durable PKM domain."
        elif any(
            token in normalized for token in ("every ", "usually ", "each ", "daily ", "weekly ")
        ):
            save_class = "durable"
            intent_class = "routine"
            mutation_intent = "extend" if current_domains else "create"
            confidence = 0.74
        elif any(
            token in normalized for token in ("goal", "plan", "want to", "planning", "this year")
        ):
            save_class = "durable"
            intent_class = "plan_or_goal"
            mutation_intent = "create"
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

        if frame["save_class"] == "ambiguous":
            frame["requires_confirmation"] = True
            frame["mutation_intent"] = "no_op"
        if frame["save_class"] == "ephemeral":
            frame["mutation_intent"] = "no_op"
        if cls._looks_opaque_or_nonsense(message):
            frame["save_class"] = "ephemeral"
            frame["intent_class"] = "ambiguous"
            frame["mutation_intent"] = "no_op"
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
            frame["confidence"] = max(0.98, float(frame.get("confidence") or 0.0))
        if (
            frame["intent_class"] in {"correction", "deletion", "financial_event"}
            and frame["confidence"] >= 0.8
        ):
            frame["requires_confirmation"] = False
            frame["confirmation_reason"] = ""
        if frame["requires_confirmation"] and not frame["confirmation_reason"]:
            frame["confirmation_reason"] = (
                "Kai needs a quick confirmation before writing this memory into the PKM."
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
            return "changes"
        return "notes"

    @classmethod
    def _memory_similarity_score(cls, left: str, right: str) -> float:
        left_tokens = cls._message_tokens(left)
        right_tokens = cls._message_tokens(right)
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
            mutation_intent in {"extend", "update"}
            and best_match is not None
            and best_score >= 0.18
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
    def _sanitize_merge_decision(
        cls,
        *,
        raw: dict[str, Any] | None,
        fallback: dict[str, Any],
        intent_frame: dict[str, Any],
        current_domains: list[str],
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

        if cls._normalize_segment(str(intent_frame.get("mutation_intent") or "")) == "no_op":
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
            "summary": cls._safe_excerpt(message, limit=240),
            "observations": [cls._safe_excerpt(message, limit=500)],
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
            return value
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
    ) -> None:
        if value is None:
            return

        current_path = ".".join(path)
        if current_path:
            is_array = isinstance(value, list)
            is_object = isinstance(value, dict)
            paths[current_path] = {
                "json_path": current_path,
                "parent_path": ".".join(path[:-1]) if len(path) > 1 else None,
                "path_type": "array" if is_array else "object" if is_object else "leaf",
                "exposure_eligibility": True,
                "consent_label": cls._titleize_path(current_path),
                "sensitivity_label": cls._infer_sensitivity(current_path),
                "segment_id": path[0] if path else "root",
                "source_agent": "pkm_structure_agent",
            }

        if isinstance(value, list):
            sample = next((item for item in value if item is not None), None)
            if sample is not None:
                cls._walk_payload(sample, [*path, "_items"], paths)
            return

        if not isinstance(value, dict):
            return

        for raw_key, child_value in value.items():
            normalized_key = cls._normalize_segment(str(raw_key))
            if normalized_key:
                cls._walk_payload(child_value, [*path, normalized_key], paths)

    @classmethod
    def _payload_financial_signature(cls, payload: dict[str, Any]) -> bool:
        serialized = json.dumps(payload, sort_keys=True).lower()
        return any(token in serialized for token in _FINANCIAL_PAYLOAD_HINTS)

    @classmethod
    def _payload_has_financial_shape(cls, payload: dict[str, Any]) -> bool:
        top_level_keys = {
            cls._normalize_segment(str(key))
            for key in payload.keys()
            if cls._normalize_segment(str(key))
        }
        return bool(top_level_keys & _FINANCIAL_TOP_LEVEL_KEYS)

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
        externalizable_paths = list(json_paths)
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
                "message_excerpt": cls._safe_excerpt(message, limit=120),
                "intent_class": intent_frame.get("intent_class"),
                "save_class": intent_frame.get("save_class"),
                "path_count": len(json_paths),
            },
            "sensitivity_labels": sensitivity_labels,
            "confidence": cls._clamp_confidence(intent_frame.get("confidence"), default=0.55),
            "source_agent": "pkm_structure_agent",
            "contract_version": 1,
        }

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
        if write_mode in {"confirm_first", "do_not_save"}:
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
        financial_guard: dict[str, Any],
        parsed_structure: dict[str, Any] | None,
        fallback_target_domain: str,
        simulated_state: dict[str, Any] | None,
    ) -> dict[str, Any]:
        raw_structure = parsed_structure or {}
        raw_decision = raw_structure.get("structure_decision")
        raw_decision = raw_decision if isinstance(raw_decision, dict) else {}
        finance_route = str(financial_guard.get("routing_decision") or "").strip().lower()

        suggested_target_domain = (
            cls._normalize_segment(str(raw_decision.get("target_domain") or ""))
            or cls._normalize_segment(str(merge_decision.get("target_domain") or ""))
            or fallback_target_domain
        )
        candidate_payload = cls._sanitize_candidate_payload(
            raw_structure.get("candidate_payload"),
            message=message,
            intent_frame=intent_frame,
            merge_decision=merge_decision,
            target_domain=suggested_target_domain,
        )

        validation_hints: list[str] = []
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

        if target_domain == _GENERAL_DOMAIN_KEY:
            validation_hints.append("unresolved_domain_choice")
            target_domain = recommended_domain or _DEFAULT_CONFIRMATION_DOMAINS[0]

        if finance_route == "sanctioned_financial_memory":
            raw_target_domain = cls._normalize_segment(str(raw_decision.get("target_domain") or ""))
            if raw_target_domain and raw_target_domain != "financial":
                validation_hints.append("financial_target_normalized")
            if target_domain != "financial":
                validation_hints.append("financial_target_normalized")
                target_domain = "financial"
            if not cls._payload_has_financial_shape(candidate_payload):
                validation_hints.append("financial_payload_normalized")
                candidate_payload = cls._fallback_payload_from_intent(
                    message=message,
                    intent_frame=intent_frame,
                    merge_decision=merge_decision,
                    target_domain="financial",
                )

        if target_domain not in registry_keys and target_domain not in current_domains:
            validation_hints.append("new_domain_requires_extra_confidence")
            if intent_frame.get("requires_confirmation"):
                target_domain = recommended_domain

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

        if intent_frame.get("intent_class") != "financial_event" and target_domain == "financial":
            validation_hints.append("financial_domain_requires_confirmation")
            target_domain = (
                recommended_domain
                if recommended_domain != "financial"
                else _DEFAULT_CONFIRMATION_DOMAINS[0]
            )

        if cls._detect_duplicate_memory(
            message=message,
            simulated_state=simulated_state,
            target_domain=target_domain,
        ):
            validation_hints.append("possible_duplicate_memory")

        decision = cls._fallback_structure_decision(
            message=message,
            current_domains=current_domains,
            intent_frame=intent_frame,
            target_domain=target_domain,
            candidate_payload=candidate_payload,
        )
        decision["confidence"] = cls._clamp_confidence(
            raw_decision.get("confidence"),
            default=cls._clamp_confidence(intent_frame.get("confidence"), default=0.55),
        )
        decision["source_agent"] = (
            cls._normalize_segment(str(raw_decision.get("source_agent") or ""))
            or "pkm_structure_agent"
        )
        try:
            decision["contract_version"] = int(raw_decision.get("contract_version") or 1)
        except Exception:
            decision["contract_version"] = 1

        requested_scope = str(
            raw_structure.get("target_entity_scope")
            or merge_decision.get("target_entity_path")
            or ""
        ).strip()
        target_entity_scope = cls._manifest_target_entity_scope(
            requested_scope=requested_scope,
            manifest_paths=decision["json_paths"],
        )

        write_mode = str(raw_structure.get("write_mode") or "").strip().lower()
        if write_mode not in _WRITE_MODES:
            write_mode = "can_save"

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

        mutation_intent = str(intent_frame.get("mutation_intent") or "create")
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

        if "possible_duplicate_memory" in validation_hints and write_mode == "can_save":
            write_mode = "confirm_first"

        if mutation_intent == "no_op" and write_mode == "can_save":
            write_mode = "do_not_save"

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
        if write_mode == "can_save" and primary_json_path is None:
            validation_hints.append("primary_path_missing")
        if (
            write_mode == "can_save"
            and primary_json_path is not None
            and primary_json_path in decision["top_level_scope_paths"]
            and requested_scope
            and cls._normalize_path(requested_scope) != primary_json_path
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
        }

    @classmethod
    def _build_financial_core_preview(
        cls,
        *,
        message: str,
        current_domains: list[str],
        intent_frame: dict[str, Any],
    ) -> dict[str, Any]:
        merge_decision = {
            "merge_mode": "no_op",
            "target_domain": "financial",
            "target_entity_id": "",
            "target_entity_path": "",
            "match_confidence": 1.0,
            "match_reason": "Governed financial-core requests are not written into PKM.",
            "source_agent": "memory_merge_agent",
            "contract_version": 1,
        }
        candidate_payload = cls._fallback_payload_from_intent(
            message=message,
            intent_frame=intent_frame,
            merge_decision=merge_decision,
            target_domain="financial",
        )
        structure_decision = cls._fallback_structure_decision(
            message=message,
            current_domains=current_domains,
            intent_frame=intent_frame,
            target_domain="financial",
            candidate_payload=candidate_payload,
        )
        target_entity_scope = cls._manifest_target_entity_scope(
            requested_scope="events.entities",
            manifest_paths=structure_decision["json_paths"],
        )
        return {
            "candidate_payload": candidate_payload,
            "structure_decision": structure_decision,
            "write_mode": "do_not_save",
            "primary_json_path": None,
            "target_entity_scope": target_entity_scope,
            "validation_hints": ["routed_to_financial_core"],
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
        paths = [path_map[key] for key in sorted(path_map)]
        top_level_scope_paths = sorted(
            {path["json_path"].split(".", 1)[0] for path in paths if path["json_path"]}
        )
        externalizable_paths = [path["json_path"] for path in paths if path["exposure_eligibility"]]
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
                    "summary_projection": {"top_level_scope_path": scope_path},
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
        return {
            "card_count": len(preview_cards),
            "can_save_count": can_save,
            "confirm_first_count": confirm_first,
            "do_not_save_count": do_not_save,
            "split_recommended": split_recommended,
            "total_segments_detected": total_segments_detected,
            "primary_target_domain": primary_card.get("target_domain") if primary_card else None,
            "primary_write_mode": primary_card.get("write_mode") if primary_card else None,
            "primary_intent_class": primary_card.get("intent_class") if primary_card else None,
            "notes": [
                note
                for note in [
                    "Prompt was truncated to four preview cards. Split the message if you want Kai to review each memory separately."
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
            "routing_decision": preview.get("routing_decision") or "non_financial_or_ephemeral",
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
            "intent_frame": deepcopy(intent_frame),
            "merge_decision": deepcopy(merge_decision),
            "candidate_payload": deepcopy(candidate_payload),
            "structure_decision": deepcopy(structure_decision),
            "manifest_draft": deepcopy(manifest_draft),
        }

    def _build_memory_intent_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        financial_guard: dict[str, Any],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
    ) -> str:
        rules = []
        state_summary = self._build_state_summary(simulated_state)
        registry_payload: Any = registry_choices
        if strict_small_model:
            rules.append(
                "- Minimal-thinking mode: prefer conservative broad domains, do not invent narrow domains, and only use ontology labels from the contract."
            )
            rules.append("- Candidate domain choices must only use the provided domain keys.")
            state_summary = self._compact_state_summary(simulated_state)
            registry_payload = self._compact_registry_choices(registry_choices)
            return (
                "You are the Memory Intent Agent for Hushh Kai.\n"  # nosec B608 - prompt template, not SQL.
                "Return JSON only with save_class, intent_class, mutation_intent, requires_confirmation, confirmation_reason, candidate_domain_choices, confidence, source_agent, contract_version.\n"
                "Allowed save_class: durable, ephemeral, ambiguous.\n"
                "Allowed intent_class: preference, profile_fact, routine, task_or_reminder, plan_or_goal, relationship, health, travel, shopping_need, financial_event, correction, deletion, note, ambiguous.\n"
                "Allowed mutation_intent: create, extend, update, correct, delete, no_op.\n"
                f"Financial Guard decision: {json.dumps(financial_guard)}\n"
                f"Soft ontology domain keys: {json.dumps(registry_payload)}\n"
                f"Current domains: {json.dumps(current_domains)}\n"
                f"State summary: {json.dumps(state_summary)}\n"
                f"Message: {message}\n"
                "Rules:\n"
                "- durable = lasting personal knowledge.\n"
                "- ephemeral = reminders, errands, one-off requests.\n"
                "- ambiguous = too vague to save safely.\n"
                "- Brand loyalty, cuisine choices, and shopping habits are preference, not financial_event.\n"
                "- Home base, residence, and where the user lives are profile_fact, not preference.\n"
                "- Financial goals like saving for a home or paying off loans are usually plan_or_goal, not financial_event, unless the message is explicitly about portfolio construction, investing behavior, or risk preference.\n"
                "- If state_summary already shows an active memory in the same broad domain and the new message says still, also, again, continue, or otherwise refines the same theme, prefer mutation_intent extend instead of create.\n"
                "- Explicit update / actually / now / changed-my-mind phrasing should prefer intent_class correction with mutation_intent correct.\n"
                "- Delete / remove / forget phrasing about existing PKM should prefer intent_class deletion with mutation_intent delete, not ephemeral.\n"
                "- Repeating a durable policy like reminders staying out of PKM should not become a new durable preference unless the user clearly states a lasting meta-preference.\n"
                "- correction phrases like actually / instead / changed my mind -> correct.\n"
                "- deletion phrases like forget that / remove that -> delete.\n"
                "- If multiple broad domains are plausible, set requires_confirmation=true and return 2-4 broad candidate domains.\n"
                "- If Financial Guard says sanctioned_financial_memory, use intent_class financial_event with financial recommended first.\n"
                "- If Financial Guard says non_financial_or_ephemeral, do not force financial.\n"
                "- Gibberish, ciphertext-like blobs, random hex strings, or semantically empty fragments must become no_op.\n"
                "- Never use general.\n"
                'Examples: {"message":"Window seats work better for me now.","save_class":"durable","intent_class":"correction","mutation_intent":"correct","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"travel","recommended":true}]} '
                '{"message":"Please call my aunt tomorrow.","save_class":"ephemeral","intent_class":"task_or_reminder","mutation_intent":"no_op","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"social","recommended":true}]} '
                '{"message":"My plans still revolve around living out of Seattle.","save_class":"durable","intent_class":"profile_fact","mutation_intent":"create","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"location","recommended":true}]} '
                '{"message":"One medium-term priority for me is to pay off my student loans in three years.","save_class":"durable","intent_class":"plan_or_goal","mutation_intent":"create","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"financial","recommended":true}]} '
                '{"message":"I still gravitate toward aisle seats if I have the choice.","save_class":"durable","intent_class":"preference","mutation_intent":"extend","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"travel","recommended":true}]} '
                '{"message":"Delete the outdated note about seat selection.","save_class":"durable","intent_class":"deletion","mutation_intent":"delete","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"travel","recommended":true}]} '
                '{"message":"4d2fa9aa67f03c119ed8b8d38b9a7e0a","save_class":"ephemeral","intent_class":"ambiguous","mutation_intent":"no_op","requires_confirmation":false,"candidate_domain_choices":[{"domain_key":"professional","recommended":true}]}'
            )
        return (
            f"{self.memory_intent_manifest.system_instruction}\n\n"
            "Return JSON only.\n"
            f"Financial Guard decision: {json.dumps(financial_guard)}\n"
            f"Soft ontology domain choices: {json.dumps(registry_payload)}\n"
            f"Current top-level PKM domains: {json.dumps(current_domains)}\n"
            f"Current simulated PKM state summary: {json.dumps(state_summary)}\n"
            f"Natural language message: {message}\n"
            "Rules:\n"
            "- Durable means stable personal knowledge worth saving.\n"
            "- Ephemeral means reminders, one-off tasks, or operational requests that should not be stored as durable PKM.\n"
            "- If the user is correcting or deleting prior meaning, set mutation_intent to correct or delete.\n"
            "- If multiple broad domains are plausible, require confirmation and provide 2-4 broad candidate domains.\n"
            "- If Financial Guard says sanctioned_financial_memory, classify this as financial_event with financial recommended first.\n"
            "- If Financial Guard says non_financial_or_ephemeral, do not force a financial label.\n"
            "- Gibberish, ciphertext-like blobs, or semantically empty fragments must map to no_op and do_not_save.\n"
            "- Never use general.\n"
            f"{chr(10).join(rules)}\n"
            "Examples:\n"
            'I like Chinese food. -> {"save_class":"durable","intent_class":"preference","mutation_intent":"create","requires_confirmation":false,"confirmation_reason":"","candidate_domain_choices":[{"domain_key":"food","display_name":"Food & Dining","description":"Dietary preferences, favorite cuisines, and restaurant history","recommended":true}],"confidence":0.93,"source_agent":"memory_intent_agent","contract_version":1}\n'
            'Remind me to call mom on Sunday. -> {"save_class":"ephemeral","intent_class":"task_or_reminder","mutation_intent":"no_op","requires_confirmation":false,"confirmation_reason":"","candidate_domain_choices":[{"domain_key":"social","display_name":"Social","description":"Relationships, family context, and social preferences","recommended":true}],"confidence":0.96,"source_agent":"memory_intent_agent","contract_version":1}\n'
            'Actually I prefer window seats now. -> {"save_class":"durable","intent_class":"correction","mutation_intent":"correct","requires_confirmation":false,"confirmation_reason":"","candidate_domain_choices":[{"domain_key":"travel","display_name":"Travel","description":"Travel preferences, loyalty programs, and trip history","recommended":true}],"confidence":0.89,"source_agent":"memory_intent_agent","contract_version":1}\n'
            'Remember that I prefer index funds. -> {"save_class":"durable","intent_class":"financial_event","mutation_intent":"extend","requires_confirmation":false,"confirmation_reason":"","candidate_domain_choices":[{"domain_key":"financial","display_name":"Financial","description":"Investment portfolio, risk profile, and financial preferences","recommended":true}],"confidence":0.92,"source_agent":"memory_intent_agent","contract_version":1}\n'
            'Q2FmZSB3YWtlIHVwIGhhc2ggcGF5bG9hZA== -> {"save_class":"ephemeral","intent_class":"ambiguous","mutation_intent":"no_op","requires_confirmation":false,"confirmation_reason":"","candidate_domain_choices":[{"domain_key":"professional","display_name":"Professional","description":"Career information, skills, and work preferences","recommended":true}],"confidence":0.98,"source_agent":"memory_intent_agent","contract_version":1}'
        )

    def _build_memory_merge_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        intent_frame: dict[str, Any],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
    ) -> str:
        state_summary = (
            self._compact_state_summary(simulated_state)
            if strict_small_model
            else self._build_state_summary(simulated_state)
        )
        header = (
            "You are the Memory Merge Agent for Hushh Kai.\n"
            "Return JSON only with merge_mode, target_domain, target_entity_id, target_entity_path, match_confidence, match_reason, source_agent, contract_version.\n"
            "Allowed merge_mode values: create_entity, extend_entity, correct_entity, delete_entity, no_op.\n"
        )
        if strict_small_model:
            return (
                f"{header}"
                f"Intent frame: {json.dumps(intent_frame)}\n"
                f"Current domains: {json.dumps(current_domains)}\n"
                f"State summary: {json.dumps(state_summary)}\n"
                f"Message: {message}\n"
                "Rules:\n"
                "- create_entity = a new durable concept.\n"
                "- extend_entity = same durable concept, more detail.\n"
                "- correct_entity = old meaning is superseded by the new statement.\n"
                "- delete_entity = an existing memory should be tombstoned.\n"
                "- no_op = not durable, too vague, or no stable target exists.\n"
                "- Never use general.\n"
                'Examples: {"message":"I still prefer aisle seats.","merge_mode":"extend_entity","target_domain":"travel"} '
                '{"message":"Actually window seats work better now.","merge_mode":"correct_entity","target_domain":"travel"} '
                '{"message":"Forget the old seat note.","merge_mode":"delete_entity","target_domain":"travel"} '
                '{"message":"7b9a662f0c63a4d8f65f5b9d4cb4e2aa","merge_mode":"no_op","target_domain":"professional"}'
            )
        return (
            f"{self.memory_merge_manifest.system_instruction}\n\n"
            "Return JSON only.\n"
            f"Intent frame: {json.dumps(intent_frame)}\n"
            f"Current top-level PKM domains: {json.dumps(current_domains)}\n"
            f"Current simulated PKM state summary: {json.dumps(state_summary)}\n"
            f"Natural language message: {message}\n"
            "Rules:\n"
            "- Choose create_entity when this is a new durable memory.\n"
            "- Choose extend_entity when it clearly refines an existing active memory.\n"
            "- Choose correct_entity when the user is replacing prior meaning.\n"
            "- Choose delete_entity when the user is removing prior meaning.\n"
            "- Choose no_op for noise, ephemeral requests, or missing correction targets.\n"
            "- Never invent a new top-level domain when an existing user domain clearly fits.\n"
            "- Never use general.\n"
        )

    def _build_structure_prompt(
        self,
        *,
        message: str,
        current_domains: list[str],
        registry_choices: list[dict[str, Any]],
        intent_frame: dict[str, Any],
        merge_decision: dict[str, Any],
        financial_guard: dict[str, Any],
        simulated_state: dict[str, Any] | None,
        strict_small_model: bool,
    ) -> str:
        state_summary = self._build_state_summary(simulated_state)
        small_model_rules = ""
        if strict_small_model:
            state_summary = self._compact_state_summary(simulated_state)
            compact_registry_choices = self._compact_registry_choices(registry_choices)
            return (
                "You are the PKM Structure Agent for Hushh Kai.\n"
                "Return JSON only with candidate_payload, structure_decision, write_mode, primary_json_path, target_entity_scope, validation_hints.\n"
                "Allowed actions: match_existing_domain, create_domain, extend_domain.\n"
                "Allowed write_mode: can_save, confirm_first, do_not_save.\n"
                f"Financial Guard decision: {json.dumps(financial_guard)}\n"
                f"Intent frame: {json.dumps(intent_frame)}\n"
                f"Merge decision: {json.dumps(merge_decision)}\n"
                f"Soft ontology domain keys: {json.dumps(compact_registry_choices)}\n"
                f"Current domains: {json.dumps(current_domains)}\n"
                f"State summary: {json.dumps(state_summary)}\n"
                f"Message: {message}\n"
                "Rules:\n"
                "- candidate_payload must align with target_domain and intent_frame.\n"
                "- Keep payload shallow, durable, and entity-based when possible.\n"
                "- Use merge_decision.target_domain unless there is a clear validation error.\n"
                "- primary_json_path may be a top-level root path when broad structure is enough.\n"
                "- Use a deeper nested path only when the subtree is clearly stable.\n"
                "- If requires_confirmation is true, return write_mode=confirm_first and primary_json_path=null or empty.\n"
                "- If save_class is ephemeral, return write_mode=do_not_save.\n"
                "- If Financial Guard says sanctioned_financial_memory, target_domain must be financial.\n"
                "- candidate_payload should favor entities keyed by stable ids over anonymous statement arrays.\n"
                "- Never use general.\n"
                'Examples: {"message":"I usually choose Thai takeout first.","target_domain":"food","primary_json_path":"preferences"} '
                '{"message":"Window seats are easier for me.","target_domain":"travel","primary_json_path":"seat_preferences"}'
            )
        small_model_rules = (
            "- Minimal-thinking mode: prefer shallow payloads with entities{} maps under one stable subtree.\n"
            "- Reuse one of the candidate_domain_choices unless a clearly better broad domain is obvious.\n"
        )
        return (
            f"{self.structure_manifest.system_instruction}\n\n"
            "Return JSON only.\n"
            f"Financial Guard decision: {json.dumps(financial_guard)}\n"
            f"Intent frame: {json.dumps(intent_frame)}\n"
            f"Merge decision: {json.dumps(merge_decision)}\n"
            f"Soft ontology domain choices: {json.dumps(registry_choices)}\n"
            f"Current top-level PKM domains: {json.dumps(current_domains)}\n"
            f"Current simulated PKM state summary: {json.dumps(state_summary)}\n"
            f"Natural language message: {message}\n"
            "Rules:\n"
            "- candidate_payload must align with target_domain and the intent frame.\n"
            "- Keep payloads shallow, durable, and conservative.\n"
            "- Use stable snake_case keys.\n"
            "- Prefer entity maps with stable ids over anonymous append-only statements.\n"
            "- Use merge_decision.target_domain unless validation requires a different broad domain.\n"
            "- For reminders or ephemeral requests, use write_mode=do_not_save.\n"
            "- If intent_frame.requires_confirmation is true, return write_mode=confirm_first.\n"
            "- primary_json_path must identify the main path inside the domain payload. Use a top-level path when a broad root-domain write is enough; use a deeper nested path only when the subtree is clearly stable.\n"
            "- target_entity_scope should point to the stable subtree being written or changed.\n"
            "- If Financial Guard says sanctioned_financial_memory, the only valid target_domain is financial.\n"
            "- For sanctioned financial memory, use an existing guarded financial subtree such as events, profile, goals, or runtime rather than inventing a new financial schema.\n"
            "- Gibberish or opaque input must return write_mode=do_not_save.\n"
            "- Never use the domain key general.\n"
            f"{small_model_rules}"
            "Examples:\n"
            'I gravitate toward Cantonese menus when I go out. -> {"candidate_payload":{"preferences":{"entities":{"mem_food_pref":{"entity_id":"mem_food_pref","kind":"preference","summary":"I gravitate toward Cantonese menus when I go out.","observations":["I gravitate toward Cantonese menus when I go out."],"status":"active"}}}},"structure_decision":{"action":"create_domain","target_domain":"food","json_paths":["preferences","preferences.entities","preferences.entities.mem_food_pref","preferences.entities.mem_food_pref.summary"],"top_level_scope_paths":["preferences"],"externalizable_paths":["preferences","preferences.entities","preferences.entities.mem_food_pref","preferences.entities.mem_food_pref.summary"],"summary_projection":{"intent_class":"preference","top_level_scope":"preferences"},"sensitivity_labels":{},"confidence":0.91,"source_agent":"pkm_structure_agent","contract_version":1},"write_mode":"can_save","primary_json_path":"preferences","target_entity_scope":"preferences","validation_hints":[]}\n'
            'Circle back with my aunt this weekend. -> {"candidate_payload":{"tasks":{"entities":{"mem_social_task":{"entity_id":"mem_social_task","kind":"task_or_reminder","summary":"Circle back with my aunt this weekend.","observations":["Circle back with my aunt this weekend."],"status":"active"}}}},"structure_decision":{"action":"create_domain","target_domain":"social","json_paths":["tasks","tasks.entities","tasks.entities.mem_social_task","tasks.entities.mem_social_task.summary"],"top_level_scope_paths":["tasks"],"externalizable_paths":["tasks","tasks.entities","tasks.entities.mem_social_task","tasks.entities.mem_social_task.summary"],"summary_projection":{"intent_class":"task_or_reminder","top_level_scope":"tasks"},"sensitivity_labels":{},"confidence":0.87,"source_agent":"pkm_structure_agent","contract_version":1},"write_mode":"do_not_save","primary_json_path":"","target_entity_scope":"tasks","validation_hints":[]}\n'
            "Remember that I prefer index funds. -> target_domain must be financial, write_mode can_save or confirm_first, and candidate_payload must use a guarded financial subtree."
        )

    @classmethod
    def _should_skip_structure_agent(
        cls,
        *,
        intent_frame: dict[str, Any],
        financial_guard: dict[str, Any],
    ) -> bool:
        routing_decision = cls._normalize_segment(
            str(financial_guard.get("routing_decision") or "")
        )
        if routing_decision == "financial_core":
            return True
        if bool(intent_frame.get("requires_confirmation")):
            return True
        save_class = cls._normalize_segment(str(intent_frame.get("save_class") or ""))
        return save_class in {"ephemeral", "ambiguous"}

    async def _generate_single_structure_preview(
        self,
        *,
        user_id: str,
        message: str,
        current_domains: list[str] | None = None,
        simulated_state: dict[str, Any] | None = None,
        model_override: str | None = None,
        strict_small_model: bool = False,
        domain_registry_override: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        normalized_domains = [
            self._normalize_segment(domain) for domain in (current_domains or []) if domain
        ]
        registry_choices = await self._load_domain_registry_choices(
            current_domains=normalized_domains,
            override=domain_registry_override,
        )
        financial_guard_fallback = self._fallback_financial_guard_decision(
            message=message,
            current_domains=normalized_domains,
        )
        financial_guard_raw = await self._run_agent_contract(
            manifest=self.financial_guard_manifest,
            prompt=self._build_financial_guard_prompt(
                message=message,
                current_domains=normalized_domains,
                registry_choices=registry_choices,
                simulated_state=simulated_state,
                strict_small_model=strict_small_model,
            ),
            response_schema=_FINANCIAL_GUARD_SCHEMA,
            model_override=model_override,
        )
        financial_guard_used_fallback = financial_guard_raw is None
        financial_guard = self._sanitize_financial_guard_decision(
            raw=financial_guard_raw,
            fallback=financial_guard_fallback,
        )

        fallback_intent = self._fallback_intent_frame(
            message=message,
            current_domains=normalized_domains,
            registry_choices=registry_choices,
            financial_guard=financial_guard,
        )
        if financial_guard["routing_decision"] == "financial_core":
            intent_frame = self._intent_frame_from_financial_guard(
                message=message,
                current_domains=normalized_domains,
                registry_choices=registry_choices,
                financial_guard=financial_guard,
            )
            merge_decision = {
                "merge_mode": "no_op",
                "target_domain": "financial",
                "target_entity_id": "",
                "target_entity_path": "",
                "match_confidence": 1.0,
                "match_reason": "Governed financial-core requests stay outside PKM writes.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            }
            intent_used_fallback = False
            merge_used_fallback = False
            structure_used_fallback = False
            normalized_preview = self._build_financial_core_preview(
                message=message,
                current_domains=normalized_domains,
                intent_frame=intent_frame,
            )
            agent_manifest = self.financial_guard_manifest
        else:
            if financial_guard["routing_decision"] == "sanctioned_financial_memory":
                intent_frame = self._intent_frame_from_financial_guard(
                    message=message,
                    current_domains=normalized_domains,
                    registry_choices=registry_choices,
                    financial_guard=financial_guard,
                )
                intent_used_fallback = False
            else:
                intent_raw = await self._run_agent_contract(
                    manifest=self.memory_intent_manifest,
                    prompt=self._build_memory_intent_prompt(
                        message=message,
                        current_domains=normalized_domains,
                        registry_choices=registry_choices,
                        financial_guard=financial_guard,
                        simulated_state=simulated_state,
                        strict_small_model=strict_small_model,
                    ),
                    response_schema=_INTENT_FRAME_SCHEMA,
                    model_override=model_override,
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
            else:
                merge_raw = await self._run_agent_contract(
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
                )
                merge_used_fallback = merge_raw is None
            merge_decision = self._sanitize_merge_decision(
                raw=merge_raw,
                fallback=merge_fallback,
                intent_frame=intent_frame,
                current_domains=normalized_domains,
            )

            fallback_target_domain = self._first_recommended_domain(
                intent_frame, fallback=_DEFAULT_CONFIRMATION_DOMAINS[0]
            )
            if self._should_skip_structure_agent(
                intent_frame=intent_frame,
                financial_guard=financial_guard,
            ):
                structure_raw = None
                structure_used_fallback = False
            else:
                structure_raw = await self._run_agent_contract(
                    manifest=self.structure_manifest,
                    prompt=self._build_structure_prompt(
                        message=message,
                        current_domains=normalized_domains,
                        registry_choices=registry_choices,
                        intent_frame=intent_frame,
                        merge_decision=merge_decision,
                        financial_guard=financial_guard,
                        simulated_state=simulated_state,
                        strict_small_model=strict_small_model,
                    ),
                    response_schema=_STRUCTURE_PREVIEW_SCHEMA,
                    model_override=model_override,
                )
                structure_used_fallback = structure_raw is None
            normalized_preview = self._normalize_structure_preview(
                message=message,
                current_domains=normalized_domains,
                registry_choices=registry_choices,
                intent_frame=intent_frame,
                merge_decision=merge_decision,
                financial_guard=financial_guard,
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
        if financial_guard_used_fallback:
            errors.append("financial_guard_agent_fallback")
        if intent_used_fallback:
            errors.append("memory_intent_agent_fallback")
        if merge_used_fallback:
            errors.append("memory_merge_agent_fallback")
        if structure_used_fallback:
            errors.append("pkm_structure_agent_fallback")

        return {
            "agent_id": agent_manifest.id,
            "agent_name": agent_manifest.name,
            "model": model_override or agent_manifest.model or GEMINI_MODEL,
            "used_fallback": financial_guard_used_fallback
            or intent_used_fallback
            or merge_used_fallback
            or structure_used_fallback,
            "intent_used_fallback": intent_used_fallback,
            "structure_used_fallback": structure_used_fallback,
            "error": "; ".join(errors) or None,
            "routing_decision": financial_guard["routing_decision"],
            "intent_frame": intent_frame,
            "merge_decision": merge_decision,
            "candidate_payload": normalized_preview["candidate_payload"],
            "structure_decision": normalized_preview["structure_decision"],
            "write_mode": normalized_preview["write_mode"],
            "primary_json_path": normalized_preview["primary_json_path"],
            "target_entity_scope": normalized_preview["target_entity_scope"],
            "validation_hints": normalized_preview["validation_hints"],
            "manifest_draft": manifest,
        }

    async def generate_structure_preview(
        self,
        *,
        user_id: str,
        message: str,
        current_domains: list[str] | None = None,
        simulated_state: dict[str, Any] | None = None,
        model_override: str | None = None,
        strict_small_model: bool = False,
        domain_registry_override: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        total_started_at = time.perf_counter()
        normalized_domains = [
            self._normalize_segment(domain) for domain in (current_domains or []) if domain
        ]
        errors: list[str] = []

        segmentation_started_at = time.perf_counter()
        segmentation_raw = await self._run_agent_contract(
            manifest=self.memory_segmentation_manifest,
            prompt=self._build_memory_segmentation_prompt(
                message=message,
                strict_small_model=strict_small_model,
            ),
            response_schema=_SEGMENTATION_SCHEMA,
            model_override=model_override,
        )
        segmentation_latency_ms = round((time.perf_counter() - segmentation_started_at) * 1000, 2)
        segmentation_used_fallback = segmentation_raw is None
        if segmentation_used_fallback:
            errors.append("memory_segmentation_agent_fallback")

        segmented_messages = self._sanitize_segmented_messages(segmentation_raw, message=message)
        total_segments_detected = len(segmented_messages)
        split_recommended = total_segments_detected > _MAX_PREVIEW_CARDS
        preview_results: list[dict[str, Any]] = []
        preview_cards: list[dict[str, Any]] = []
        preview_latencies_ms: list[float] = []

        for index, segment in enumerate(segmented_messages[:_MAX_PREVIEW_CARDS], start=1):
            source_text = self._safe_excerpt(str(segment.get("source_text") or ""), limit=400)
            if not source_text:
                continue
            preview_started_at = time.perf_counter()
            preview = await self._generate_single_structure_preview(
                user_id=user_id,
                message=source_text,
                current_domains=normalized_domains,
                simulated_state=simulated_state,
                model_override=model_override,
                strict_small_model=strict_small_model,
                domain_registry_override=domain_registry_override,
            )
            preview_latency_ms = round((time.perf_counter() - preview_started_at) * 1000, 2)
            preview_latencies_ms.append(preview_latency_ms)
            preview_results.append(preview)
            card_id = f"card_{index:02d}"
            preview_cards.append(
                self._build_preview_card(
                    card_id=card_id,
                    source_text=source_text,
                    preview=preview,
                    simulated_state=simulated_state,
                )
            )
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
        }

        if primary_preview is None:
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
            return {
                "agent_id": self.memory_segmentation_manifest.id,
                "agent_name": self.memory_segmentation_manifest.name,
                "model": model_override or self.memory_segmentation_manifest.model or GEMINI_MODEL,
                "used_fallback": True,
                "intent_used_fallback": False,
                "structure_used_fallback": False,
                "error": "; ".join(self._unique_list(errors or ["memory_segmentation_no_output"])),
                "routing_decision": "non_financial_or_ephemeral",
                "intent_frame": {},
                "merge_decision": {},
                "candidate_payload": {},
                "structure_decision": empty_manifest["structure_decision"],
                "write_mode": "do_not_save",
                "primary_json_path": None,
                "target_entity_scope": None,
                "validation_hints": [
                    "preview_generation_failed",
                    *(["split_recommended"] if split_recommended else []),
                ],
                "manifest_draft": empty_manifest,
                "preview_cards": preview_cards,
                "preview_summary": preview_summary,
                "performance": performance,
                "context_plan": context_plan,
            }

        validation_hints = list(primary_preview.get("validation_hints") or [])
        if split_recommended and "split_recommended" not in validation_hints:
            validation_hints.append("split_recommended")

        return {
            **primary_preview,
            "used_fallback": bool(
                primary_preview.get("used_fallback") or segmentation_used_fallback
            ),
            "error": "; ".join(self._unique_list(errors)) or primary_preview.get("error"),
            "validation_hints": self._unique_list(validation_hints),
            "preview_cards": preview_cards,
            "preview_summary": preview_summary,
            "performance": performance,
            "context_plan": context_plan,
        }


_pkm_agent_lab_service: PKMAgentLabService | None = None


def get_pkm_agent_lab_service() -> PKMAgentLabService:
    global _pkm_agent_lab_service
    if _pkm_agent_lab_service is None:
        _pkm_agent_lab_service = PKMAgentLabService()
    return _pkm_agent_lab_service
