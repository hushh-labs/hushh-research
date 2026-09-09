"""Hybrid semantic + lexical retrieval for generated action catalog.

Searches ``.voice-action-contract.json`` actions using reciprocal rank fusion
of embedding similarity and Unicode-aware keyword matching.  Used by
``list_app_actions`` and the new proposal endpoints.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import unicodedata
from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, TypeVar, cast

logger = logging.getLogger(__name__)

# Fusion is keyed by whatever identity the caller ranks by: `id(entry)` ints in
# the live path, action-id strings in the tests. The function never inspects the
# key, so it is generic rather than pinned to one of them -- it was annotated
# dict[str, float] while being called with dict[int, float].
_RankKey = TypeVar("_RankKey", bound=Hashable)

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

MAX_RETRIEVAL_RESULTS = 20
_retrieval_available: bool = True
_retrieval_error: str | None = None

# ---------------------------------------------------------------------------
# Availability / error helpers (tested by test_action_retrieval.py)
# ---------------------------------------------------------------------------


def is_retrieval_available() -> bool:
    """True when the embedding model is reachable and loadable.

    Probes the dependency rather than trusting the module flag, which starts
    True and only flips on a load attempt. Without this it reported "available"
    on a host where sentence-transformers is not installed, so the degraded
    ranking looked exactly like a working one -- the failure mode this whole
    module is meant to make visible.
    """
    global _retrieval_available, _retrieval_error
    if not _retrieval_available:
        return False
    try:
        import importlib.util

        if importlib.util.find_spec("sentence_transformers") is None:
            _retrieval_available = False
            _retrieval_error = "sentence_transformers not installed"
            return False
    except Exception:  # noqa: BLE001 - a probe must never raise into a turn
        return False
    return True


def _get_model() -> Any | None:
    """Return the loaded model instance, or None on failure."""
    try:
        return get_embedding_client()._load()
    except Exception:
        return None


def retrieval_error() -> str | None:
    """Return a string describing the last retrieval failure, or None."""
    return _retrieval_error


# ---------------------------------------------------------------------------
# Public normalizer (called from action_tools.py)
# ---------------------------------------------------------------------------


def _normalize_query(text: str) -> str:
    """Unicode-normalize for token extraction.

    ``action_tools`` calls ``action_retrieval._normalize_query``.
    Rejects oversized input instead of silently truncating.
    """
    if len(text) > 50_000:
        raise ValueError(f"Query too large ({len(text)} chars); maximum is 50,000.")
    try:
        return _normalize_query_impl(text)
    except Exception:  # noqa: BLE001
        return str(text or "")


def _normalize_query_impl(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


# ---------------------------------------------------------------------------
# Unicode-aware tokenizer (tested by test_action_retrieval.py)
# ---------------------------------------------------------------------------


def _unicode_tokens(text: str) -> list[str]:
    """Return Unicode-aware tokens (Devanagari-safe).

    Splits on whitespace after NFKC normalization so combining-mark
    sequences (Devanagari syllables, accented Latin, etc.) stay intact.
    ``re.findall`` with ``\\w`` strips spacing-combining marks (Mc),
    which breaks these scripts into single-character fragments.
    """
    normalized = unicodedata.normalize("NFKC", text)
    # Split on whitespace and ASCII hyphens so combining-mark sequences
    # (Devanagari syllables, accented Latin) stay intact while hyphenated
    # English compounds resolve to individual words.
    return re.split(r"[ \t\n\r\f\v-]+", normalized)[:128]


# ---------------------------------------------------------------------------
# RRF helper (tested by test_action_retrieval.py)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Catalog digest
# ---------------------------------------------------------------------------


# Passage vectors for the whole wired catalog, keyed by catalog digest.
#
# Without this, the semantic branch embedded `supported[:20]` -- an arbitrary
# 20 actions in generated-file order, out of 175 wired. Similarity was never
# computed for the rest, so location.share_selected could not win "let Ankit see
# where I am" no matter how well it matched: it was never scored at all.
_PASSAGE_CACHE: dict[str, Any] = {"digest": None, "vectors": []}


def _ensure_passage_vectors(
    supported: list[dict[str, Any]], gateway: dict[str, Any]
) -> list[list[float]]:
    """Embed every wired action once per catalog revision.

    Vectors are positionally aligned to ``supported``; the digest covers the
    generated content, so identical digest implies identical order.
    """
    digest = _catalog_digest(gateway)
    cached = _PASSAGE_CACHE
    if cached["digest"] == digest and len(cached["vectors"]) == len(supported):
        return cast(list[list[float]], cached["vectors"])
    vectors = get_embedding_client().embed_passages([_build_passage(entry) for entry in supported])
    if len(vectors) == len(supported):
        _PASSAGE_CACHE["digest"] = digest
        _PASSAGE_CACHE["vectors"] = vectors
    return vectors


def _catalog_digest(gateway: dict[str, Any]) -> str:
    """Compute a deterministic digest of the canonical gateway content."""
    raw = json.dumps(
        gateway,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Embedding client
# ---------------------------------------------------------------------------


class EmbeddingClient:
    """Sentence-Transformers embedding interface backed by ``intfloat/multilingual-e5-small``."""

    def __init__(
        self,
        *,
        model_revision: str = "614241f622f53c4eeff9890bdc4f31cfecc418b3",
    ) -> None:
        self.model_revision = model_revision
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(
                "intfloat/multilingual-e5-small",
                revision=self.model_revision,
            )
        return self._model

    def embed_query(self, text: str) -> list[float]:
        model = self._load()
        prefixed = f"query: {text}"
        result = model.encode(prefixed, normalize_embeddings=True)
        return cast(list[float], result.tolist())

    def embed_passages(self, passages: list[str]) -> list[list[float]]:
        if not passages:
            return []
        model = self._load()
        prefixed = [f"passage: {p}" for p in passages]
        result = model.encode(prefixed, normalize_embeddings=True)
        return cast(list[list[float]], result.tolist())

    def similarity(
        self,
        query_vec: list[float],
        passage_vecs: list[list[float]],
    ) -> list[float]:
        if not passage_vecs:
            return []
        from numpy import array, dot

        q = array(query_vec)
        ps = array(passage_vecs)
        return cast(list[float], dot(ps, q).tolist())


_embedding_client: EmbeddingClient | None = None


def get_embedding_client() -> EmbeddingClient:
    global _embedding_client
    if _embedding_client is None:
        _embedding_client = EmbeddingClient()
    return _embedding_client


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class RetrievedAction:
    """A single ranked action with retrieval metadata."""

    action_id: str
    label: str = ""
    meaning: str = ""
    description: str = ""
    score: float = 0.0
    retrieval_branch: str = "fused"  # "semantic" | "lexical" | "fused"
    rank: int = 0
    availability: str = "on_screen"
    aliases: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    semantic_boundaries: str | None = None
    required_inputs: Any = field(default_factory=list)
    execution_policy: str = "allow_direct"
    policy: str = "allow_direct"
    use_tool: str | None = None
    navigation: dict[str, Any] | None = None
    delegate_agent_id: str = ""
    goal: dict[str, Any] | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    source: str = "semantic"

    def to_dict(self) -> dict[str, Any]:
        base = {
            "action_id": self.action_id,
            "label": self.label,
            "meaning": self.meaning,
            "description": self.description,
            "score": self.score,
            "retrieval_branch": self.retrieval_branch,
            "rank": self.rank,
            "availability": self.availability,
            "aliases": self.aliases,
            "keywords": self.keywords,
            "semantic_boundaries": self.semantic_boundaries,
            "required_inputs": self.required_inputs,
            "execution_policy": self.execution_policy,
            "use_tool": self.use_tool,
            "navigation": self.navigation,
            "delegate_agent_id": self.delegate_agent_id,
            "goal": self.goal,
        }
        return base


# ---------------------------------------------------------------------------
# Text normalization and passage building
# ---------------------------------------------------------------------------


def _build_passage(entry: dict[str, Any]) -> str:
    """Build a searchable description from an action contract entry."""
    parts: list[str] = []
    label = str(entry.get("label") or "").strip()
    meaning = str(entry.get("meaning") or "").strip()
    action_id = str(entry.get("action_id") or "").strip()
    parts.append(label or action_id)
    if meaning:
        parts.append(meaning)
    aliases = entry.get("aliases") or []
    if aliases:
        parts.append("Aliases: " + ", ".join(str(a) for a in aliases))
    # AgentManifestV2 generates `search_keywords`; retain the legacy fallback
    # only for older fixtures. Missing this field silently removes the
    # authored vocabulary from semantic passage construction.
    keywords = entry.get("search_keywords") or entry.get("keywords") or []
    if keywords:
        parts.append("Keywords: " + ", ".join(str(k) for k in keywords))
    goal = entry.get("goal") or {}
    goal_desc = str(goal.get("goal_description") or "").strip()
    if goal_desc:
        parts.append(goal_desc)
    boundaries = entry.get("semantic_boundaries") or ""
    boundaries = str(boundaries).strip()
    if boundaries:
        parts.append("Boundaries: " + boundaries)
    return ". ".join(parts)


def _build_query_tokens(text: str) -> list[str]:
    """Unicode-aware token extraction (preserves non-Latin scripts)."""
    normalized = _normalize_query(text)
    tokens = normalized.split()
    return [t.lower() for t in tokens if t][:128]


# ---------------------------------------------------------------------------
# Lexical scoring
# ---------------------------------------------------------------------------


def _text_matches(text: str, query_tokens: list[str]) -> bool:
    """Return True if any query token appears in text (Unicode-aware, lowered)."""
    if not query_tokens:
        return True
    lowered = text.lower()
    return any(t in lowered for t in query_tokens)


_LEXICAL_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "at",
        "can",
        "could",
        "do",
        "does",
        "for",
        "get",
        "how",
        "i",
        "in",
        "is",
        "it",
        "let",
        "me",
        "my",
        "need",
        "of",
        "on",
        "one",
        "or",
        "please",
        "show",
        "that",
        "this",
        "to",
        "us",
        "want",
        "we",
        "what",
        "with",
        "would",
        "you",
    }
)


def _lexical_score(entry: dict[str, Any], query: Any) -> float:
    """Literal overlap score for one catalog entry.

    Accepts either the raw query string or a pre-tokenized list. Callers pass
    both: action_tools passes a string, the retrieval loop passes tokens.
    Iterating a string as if it were tokens scores single CHARACTERS against
    every label, which is how "start the analysis" came back ranked by
    route.analysis_history and connect.cancel_request.

    A retrieval signal only. It never decides execution on its own.
    """
    if isinstance(query, str):
        raw = query.lower()
        tokens = _unicode_tokens(raw)
    else:
        tokens = [str(t).lower() for t in (query or [])]
        raw = " ".join(tokens)
    if not tokens:
        return 0.0

    # A query of only function words carries no discriminating signal. Scoring
    # it ranks whichever unrelated action contains "show" or "me" above the
    # actions actually on the person's screen, so return nothing and let the
    # caller fall back to its availability-ordered context list.
    content = [t for t in tokens if t not in _LEXICAL_STOPWORDS]
    if not content:
        return 0.0

    score = 0.0
    label = str(entry.get("label") or "").lower()
    meaning = str(entry.get("meaning") or "").lower()
    action_id = str(entry.get("action_id") or "").lower()
    aliases = [str(a).lower() for a in (entry.get("aliases") or [])]
    # The generated contract authors this as search_keywords; "keywords" never
    # matched anything.
    keywords = [
        str(k).lower() for k in (entry.get("search_keywords") or entry.get("keywords") or [])
    ]

    # Whole-phrase signals: strongest, and only fire for short queries.
    if raw and raw in label:
        score += 40.0
    if raw and raw in meaning:
        score += 15.0
    for alias in aliases:
        if raw == alias:
            score += 90.0
        elif raw and raw in alias:
            score += 25.0
    for keyword in keywords:
        if raw == keyword:
            score += 35.0

    label_tokens = set(_unicode_tokens(label))
    meaning_tokens = set(_unicode_tokens(meaning))
    id_tokens = set(_unicode_tokens(action_id))
    alias_tokens: set[str] = set()
    for alias in aliases:
        alias_tokens |= set(_unicode_tokens(alias))
    keyword_tokens: set[str] = set()
    for keyword in keywords:
        keyword_tokens |= set(_unicode_tokens(keyword))

    matched_label = 0
    for token in set(content):
        if token in alias_tokens:
            score += 8.0
        if token in label_tokens:
            score += 6.0
            matched_label += 1
        if token in keyword_tokens:
            score += 4.0
        if token in id_tokens:
            score += 3.0
        if token in meaning_tokens:
            score += 2.0

    # Absolute coverage, deliberately NOT divided by label length: normalizing
    # turns this into a short-label bonus, which pushed
    # location.select_share_recipient out of the window for
    # "share my location with mom" in favour of location.refresh.
    if matched_label > 1:
        score += 4.0 * matched_label

    return score


# Public alias used by action_tools.py and tests.
lexical_score = _lexical_score


# ---------------------------------------------------------------------------
# Reachability helpers
# ---------------------------------------------------------------------------


def _reachability(entry: dict[str, Any]) -> str:
    """Return the reachability label for an action."""
    if _is_journey_startable(entry):
        return "journey"
    # The generated gateway already declares route execution targets. Use that
    # authority instead of maintaining a second legacy route-to-action map.
    if (entry.get("execution_target") or {}).get("path") == "route":
        return "navigate_first"
    routes = (entry.get("reachability") or {}).get("routes") or []
    for route in routes:
        nav = _navigation_action_for_route(str(route))
        if nav:
            return "navigate_first"
    return "on_screen"


def _context_allows_entry(entry: dict[str, Any], app_runtime_state: dict[str, Any] | None) -> bool:
    """Filter retrieval candidates using redacted runtime authority only.

    Retrieval may narrow candidates, but it never makes an action executable.
    An explicit executable/available inventory wins; otherwise a screen match
    or an authored hidden-navigation action is required when a screen is
    supplied. This prevents a semantic hit from becoming an off-screen
    `action_unavailable` proposal.
    """
    if not app_runtime_state:
        return True
    action_id = str(entry.get("action_id") or "").strip()
    if not action_id:
        return False
    inventory = app_runtime_state.get("executable_action_ids")
    if not isinstance(inventory, list):
        inventory = app_runtime_state.get("available_action_ids")
    if isinstance(inventory, list):
        allowed = {str(value).strip() for value in inventory if str(value).strip()}
        if action_id not in allowed and not action_id.startswith("route."):
            return False
    screen = str(app_runtime_state.get("screen") or "").strip()
    if not screen:
        return True
    reachability = entry.get("reachability") or {}
    screens = reachability.get("screens") or []
    if screen in screens:
        return True
    return bool(reachability.get("hidden_navigable")) or action_id.startswith("route.")


def _is_journey_startable(entry: dict[str, Any]) -> bool:
    """Return True when this action starts a Connections-style journey."""
    action_id = str(entry.get("action_id", ""))
    if not action_id:
        return False
    goal = entry.get("goal")
    if not isinstance(goal, dict):
        return False
    goal_id = str(goal.get("goal_id") or "").strip()
    steps = goal.get("workflow_steps")
    if not goal_id or not isinstance(steps, list) or len(steps) < 2:
        return False
    initial = steps[0] if isinstance(steps[0], dict) else {}
    choice = steps[1] if isinstance(steps[1], dict) else {}
    settlement_target = initial.get("settlement_target")
    choice_action_ids = choice.get("action_ids")
    return bool(
        initial.get("type") == "action"
        and str(initial.get("action_id") or "") == action_id
        and isinstance(settlement_target, dict)
        and str(settlement_target.get("route") or "").strip()
        and str(settlement_target.get("screen") or "").strip()
        and choice.get("type") == "choice"
        and isinstance(choice_action_ids, list)
        and choice_action_ids
    )


def _navigation_action_for_route(route: str) -> str | None:
    nav_map = {
        "/location-map": "location.map",
        "/active-shares": "location.active_shares",
        "/shared-with-me": "location.shared_with_me",
        "/location-requests": "location.requests_to_review",
        "/location-settings": "location.settings",
        "/temporary-link": "location.temporary_link",
        "/check-in": "location.check_in",
        "/emergency-sos": "location.emergency_sos",
        "/emergency-sms-contacts": "location.emergency_sms_contacts",
    }
    return nav_map.get(route)


def _normalize_boundaries(value: str | list[str] | None) -> str | None:
    """Normalize the authored semantic_boundaries field.

    Returns a semicolon-joined string, or None if absent/empty.
    Never shreds a string into individual characters.
    """
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        return s if s else None
    if isinstance(value, list) and value:
        parts = [str(p).strip() for p in value if str(p).strip()]
        return "; ".join(parts) if parts else None
    return None


def _delegate_tool_name(delegate_id: str) -> str | None:
    mapping = {
        "agent_email": "ask_email_agent",
        "agent_location": "ask_location_agent",
        "agent_connections": "ask_consent_agent",
        "agent_connected_systems": "ask_connected_systems_agent",
        "agent_nav": "ask_consent_agent",
    }
    return mapping.get(delegate_id)


def _default_exec_tool(entry: dict[str, Any]) -> str:
    goal = entry.get("goal") or {}
    if (
        goal.get("goal_id")
        and isinstance(goal.get("workflow_steps"), list)
        and len(goal.get("workflow_steps", [])) >= 2
    ):
        return "start_app_goal"
    return "run_app_action"


def _navigation(entry: dict[str, Any]) -> dict[str, Any] | None:
    exec_target = entry.get("execution_target") or {}
    if exec_target.get("path") == "route":
        return {"route": str(exec_target.get("target") or ""), "path": "route"}
    return None


# ---------------------------------------------------------------------------
# Hybrid retrieval
# ---------------------------------------------------------------------------


def _reciprocal_rank_fusion(
    semantic_ranks: Mapping[_RankKey, float] | Sequence[_RankKey],
    lexical_ranks: Mapping[_RankKey, float] | Sequence[_RankKey] | None = None,
    k: float = 60.0,
) -> list[tuple[_RankKey, float]]:
    """Fuse ranked lists or rank maps into (action_id, fused_score) pairs.

    Backward-compatible: accepts the original list-of-strings form
    (``_reciprocal_rank_fusion(list_a, list_b)``) used in tests, as well as
    the dict rank-map form used by ``search_actions``
    (``_reciprocal_rank_fusion(semantic_map, lexical_map)``).
    """

    def _to_map(arg: Any) -> dict[_RankKey, float]:
        if isinstance(arg, dict):
            return dict(arg)
        if isinstance(arg, list):
            return {action_id: i for i, action_id in enumerate(arg) if action_id}
        raise TypeError(f"Expected list or dict, got {type(arg).__name__}")

    # If only one positional argument is a dict and lexical_ranks is None,
    # treat as (semantic_map, lexical_map) and require both to be dicts.
    if lexical_ranks is None and isinstance(semantic_ranks, dict):
        return []  # caller mistake; not a test scenario
    sem = _to_map(semantic_ranks)
    lex = _to_map(lexical_ranks) if lexical_ranks is not None else {}
    fused: dict[_RankKey, float] = {}
    for key, rank in sem.items():
        fused[key] = fused.get(key, 0.0) + k / (rank + k)
    for key, rank in lex.items():
        fused[key] = fused.get(key, 0.0) + k / (rank + k)
    return sorted(fused.items(), key=lambda x: x[1], reverse=True)


def search_actions(
    query: str,
    gateway: dict[str, Any],
    *,
    limit: int = MAX_RETRIEVAL_RESULTS,
    semantic_branch_k: int = 20,
    lexical_branch_k: int = 20,
    semantic_score_floor: float | None = None,
    app_runtime_state: dict[str, Any] | None = None,
) -> list[RetrievedAction]:
    """Hybrid retrieval: semantic similarity + lexical matching via RRF.

    Never returns an empty result set as an automatic execution fallback.
    A semantic match must not require positive lexical score.
    """
    entries = gateway.get("actions") or []
    if not entries:
        return []

    # Gate to wired actions. `voice_enabled` is not a field the generator emits
    # -- it appears on zero of the catalog's entries -- so filtering on it
    # returned [] for every query while reporting retrieval as available. The
    # rest of the codebase gates on execution_target.status, and so does this.
    supported = [
        e
        for e in entries
        if (e.get("execution_target") or {}).get("status") == "wired"
        and _context_allows_entry(e, app_runtime_state)
    ]
    if not supported:
        return []

    query_tokens = _build_query_tokens(query)
    if not query_tokens and not query.strip():
        return []

    client = get_embedding_client()

    # --- Lexical branch ---
    lexical_candidates: list[tuple[dict[str, Any], float]] = []
    for entry in supported:
        score = _lexical_score(entry, query_tokens)
        if score > 0:
            lexical_candidates.append((entry, score))
    lexical_candidates.sort(key=lambda x: x[1], reverse=True)
    lexical_candidates = lexical_candidates[:lexical_branch_k]
    lexical_ranks = {id(entry): float(i) for i, (entry, _) in enumerate(lexical_candidates)}

    # --- Semantic branch ---
    semantic_scores: dict[int, float] = {}
    try:
        query_vec = client.embed_query(query)
        passage_vecs = _ensure_passage_vectors(supported, gateway)
        if passage_vecs:
            sims = client.similarity(query_vec, passage_vecs)
            # strict=True: a length mismatch would pair an action with another
            # action's similarity, which is unfindable at runtime.
            for entry, score in zip(supported, sims, strict=True):
                semantic_scores[id(entry)] = float(score)
    except Exception:
        logger.warning("semantic_search_failed", exc_info=True)

    # Every wired action is scored above; this bounds how many reach fusion.
    semantic_rank_map = {
        eid: float(i)
        for i, (eid, _) in enumerate(
            sorted(semantic_scores.items(), key=lambda x: x[1], reverse=True)[:semantic_branch_k]
        )
    }

    # Already sorted best-first, as a list of (entry_id, score) pairs.
    fused = _reciprocal_rank_fusion(semantic_rank_map, lexical_ranks)

    # Score floor on the semantic branch only (an RRF score is not calibrated).
    # semantic_scores is keyed by id(entry) already, so do not take id() again.
    if semantic_score_floor is not None:
        filtered_ids = {eid for eid, s in semantic_scores.items() if s >= semantic_score_floor}
        fused = [(eid, s) for eid, s in fused if eid in filtered_ids]

    id_to_entry = {id(e): e for e in supported}
    results: list[RetrievedAction] = []

    for rank_i, (eid, score) in enumerate(fused[:limit]):
        entry = id_to_entry.get(eid)
        if not entry:
            continue
        entry_id = str(entry.get("action_id", ""))
        availability = _reachability(entry)
        delegate_id = str(entry.get("delegate_agent_id") or "").strip()
        use_tool = _delegate_tool_name(delegate_id) or _default_exec_tool(entry)
        nav = _navigation(entry)

        results.append(
            RetrievedAction(
                action_id=entry_id,
                label=str(entry.get("label", "")),
                meaning=str(entry.get("meaning", "")),
                description=_build_passage(entry),
                score=score,
                retrieval_branch="fused",
                rank=rank_i + 1,
                availability=availability,
                aliases=[str(a) for a in (entry.get("aliases") or [])],
                keywords=[
                    str(k) for k in (entry.get("search_keywords") or entry.get("keywords") or [])
                ],
                semantic_boundaries=str(entry.get("semantic_boundaries") or "").strip() or None,
                required_inputs=[
                    spec
                    for spec in (entry.get("goal") or {}).get("required_inputs", [])
                    if isinstance(spec, dict)
                ],
                execution_policy=str(entry.get("execution_policy") or "allow_direct"),
                # `policy` is what action_tools reads. Setting only
                # execution_policy left this at its "allow_direct" default, so a
                # confirm_required action reached One reported as directly
                # executable -- the one field where a wrong default is unsafe.
                policy=str(entry.get("execution_policy") or "allow_direct"),
                use_tool=use_tool,
                navigation=nav,
                delegate_agent_id=delegate_id,
                goal=entry.get("goal"),
                raw=entry,
            )
        )

    return results


# ---------------------------------------------------------------------------
# Command palette search
# ---------------------------------------------------------------------------


def search_actions_for_command_palette(
    query: str,
    gateway: dict[str, Any],
    *,
    app_runtime_state: dict[str, Any] | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Same as ``search_actions`` but aware of the current app screen."""
    if not query or not query.strip():
        return []
    base = search_actions(query, gateway, app_runtime_state=app_runtime_state)
    if not base:
        return []
    ordered = sorted(base, key=lambda r: r.score, reverse=True)
    return [r.to_dict() for r in ordered[:limit]]


# ---------------------------------------------------------------------------
# Convenience: load and search in one call
# ---------------------------------------------------------------------------


def load_and_search(
    query: str,
    *,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Load actions from gateway and return top-N semantic search results."""
    from hushh_mcp.one_adk.action_tools import (  # deferred to break circular import
        list_action_gateway_actions,
    )

    entries = list_action_gateway_actions()
    gateway = {"actions": entries}
    return search_actions_for_command_palette(query, gateway, limit=limit)
