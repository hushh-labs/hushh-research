"""Semantic retrieval for the generated action capability catalog.

Loads a pinned Sentence Transformers model, projects each wired action into
a 384-dimensional embedding, and answers natural-language queries with
reciprocal-rank-fused candidates.  No action is ever executed from a retrieval
result -- One makes that decision, and execution still flows through the
existing ``run_app_action`` / ``start_app_goal`` path.

Degradation
-----------
If the model cannot be loaded (missing dependency, corrupted cache, OOM),
``is_retrieval_available()`` returns ``False`` and all public functions return
empty results without raising.  The existing lexical path in ``action_tools``
continues to serve One.

Model
-----
``intfloat/multilingual-e5-small`` (revision 614241f622f53c4eeff9890bdc4f31cfecc418b3).
384 float32 dims, MIT licence, query/passage prefix protocol, 512-token limit.
Pinned in ``pyproject.toml``; packaged in the backend image and loaded once per
worker process.
"""

from __future__ import annotations

import dataclasses
import hashlib
import logging
import os
import tempfile
import unicodedata
from functools import lru_cache
from typing import Any

logger = logging.getLogger(__name__)

# ── Model configuration ────────────────────────────────────────────────────

_MODEL_NAME = "intfloat/multilingual-e5-small"
_MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
_EMBED_DIM = 384
# The backend image runs as uid 10001 with --home-dir /app, and /app is copied
# in as root, so a ~/.cache default raises PermissionError -- which _get_model
# swallows as "model load failed", i.e. a silent degradation. The temp dir is
# writable by that uid. Set HUSHH_EMBEDDING_CACHE_DIR to a directory the image
# creates and chowns so the model is not re-downloaded on every cold start.
_MODEL_CACHE_DIR = os.environ.get(
    "HUSHH_EMBEDDING_CACHE_DIR",
    os.path.join(tempfile.gettempdir(), "hushh-embeddings"),
)

# ── Retrieval parameters ────────────────────────────────────────────────────

_MAX_RETRIEVAL_RESULTS = 10  # returned to One per call
_SEMANTIC_CANDIDATES = 20  # retrieved from each branch before fusion
_LEXICAL_CANDIDATES = 20

# ── Runtime flags ───────────────────────────────────────────────────────────

_retrieval_available = True
_retrieval_error: str | None = None


# ── Errors ───────────────────────────────────────────────────────────────────


class RetrievalError(Exception):
    """Base class for retrieval failures."""


class EmbeddingModelUnavailable(RetrievalError):
    """The pinned embedding model could not be loaded."""


class CatalogDigestMismatch(RetrievalError):
    """The cached vectors no longer match the generated catalog."""


# ── Retrieval result ─────────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True, slots=True)
class RetrievedAction:
    """One ranked capability returned to One.

    This is a *retrieval* result, not an execution grant.  ``score`` is a fused
    rank signal, never a confidence that licenses execution: One chooses the
    action, and ``run_app_action`` re-validates it against the generated
    manifest and the browser-declared screen.

    ``availability`` is context-sensitive and is recomputed by the caller that
    knows the live screen; the value produced here is the catalog-only view.
    """

    action_id: str
    score: float
    source: str  # "semantic" | "lexical" | "fused"
    meaning: str
    semantic_boundaries: str | None
    required_inputs: dict[str, Any]
    policy: str
    availability: str
    navigation: dict[str, Any] | None
    goal: dict[str, Any] | None
    label: str = ""
    delegate_agent_id: str = ""
    guard_ids: tuple[str, ...] = ()
    use_tool: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe projection for HTTP and tool payloads."""
        payload: dict[str, Any] = {
            "action_id": self.action_id,
            "label": self.label,
            "meaning": self.meaning,
            "policy": self.policy,
            "availability": self.availability,
            "retrieval_score": round(self.score, 6),
            "source": self.source,
        }
        if self.semantic_boundaries:
            payload["semantic_boundaries"] = self.semantic_boundaries
        if self.required_inputs:
            payload["required_inputs"] = self.required_inputs
        if self.navigation:
            payload["navigation"] = self.navigation
        if self.delegate_agent_id:
            payload["delegate_agent_id"] = self.delegate_agent_id
        if self.guard_ids:
            payload["guard_ids"] = list(self.guard_ids)
        if self.use_tool:
            payload["use_tool"] = self.use_tool
        return payload


def _normalize_boundaries(value: Any) -> str | None:
    """Coerce an authored ``semantic_boundaries`` field to a single string.

    The generated contract authors this as a string (PR 2.5), but older
    fixtures carry a list.  ``list()`` on a string would explode it into
    characters, so branch on type explicitly.
    """
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    if isinstance(value, (list, tuple)):
        parts = [str(v).strip() for v in value if str(v).strip()]
        return "; ".join(parts) or None
    return None


# ── Catalog digest ───────────────────────────────────────────────────────────


def _catalog_digest(gateway: dict[str, Any]) -> str:
    """Stable SHA-256 of the normalized wired-action set.

    Binds the vector cache to the actual catalog content so a stale index is
    never searched silently.  The digest covers every field that goes into the
    searchable description so a contract change that does not touch the action
    list still invalidates the cache.
    """
    import json

    canonical = {
        entry.get("action_id", ""): {
            "label": entry.get("label", ""),
            "meaning": entry.get("meaning", ""),
            "aliases": sorted(entry.get("aliases", []) or []),
            "search_keywords": sorted(entry.get("search_keywords", []) or []),
            "semantic_boundaries": sorted(
                (
                    [_normalize_boundaries(entry.get("semantic_boundaries"))]
                    if _normalize_boundaries(entry.get("semantic_boundaries"))
                    else []
                )
            ),
        }
        for entry in gateway.get("actions", [])
        if (entry.get("execution_target") or {}).get("status") == "wired"
    }
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _cache_key(digest: str, model_revision: str) -> str:
    return f"action_retrieval:{digest}:{model_revision}"


# ── Description projection ───────────────────────────────────────────────────


def _project_description(entry: dict[str, Any]) -> str:
    """Build the passage text embedded for semantic retrieval.

    Concatenates the authored ``meaning`` with ``search_keywords`` so the
    vector captures what the action IS, not just its label.  Optional
    ``semantic_boundaries`` are appended as distinguishing clauses rather than
    mixed into the main text -- they describe what the action is NOT, which
    would corrupt the positive embedding if included inline.
    """
    parts: list[str] = [str(entry.get("meaning") or "").strip()]

    keywords = entry.get("search_keywords") or []
    if keywords:
        parts.append("Keywords: " + ", ".join(str(k) for k in keywords if str(k).strip()))

    aliases = entry.get("aliases") or []
    if aliases:
        parts.append("Also known as: " + ", ".join(str(a) for a in aliases if str(a).strip()))

    boundary_text = _normalize_boundaries(entry.get("semantic_boundaries"))
    boundaries = [boundary_text] if boundary_text else []
    if boundaries:
        for b in boundaries:
            b = str(b or "").strip()
            if b:
                parts.append(f"(Distinction: {b})")

    return ". ".join(p for p in parts if p)


# ── Query preprocessing ──────────────────────────────────────────────────────


def _normalize_query(query: str, max_bytes: int = 4096) -> str:
    """Unicode-normalize, strip excessive whitespace, and reject oversized input.

    Returns the cleaned query, or raises ``ValueError`` if the input exceeds
    ``max_bytes`` UTF-8 bytes.  Negation, names, and duration expressions are
    intentionally preserved -- they carry meaning that downstream should not
    lose.
    """
    if not isinstance(query, str):
        raise ValueError("Query must be a string.")

    # NFC normalization (composed form) so diacritics and Hindi/Hinglish
    # sequences have a single canonical representation for embedding.
    normalized = unicodedata.normalize("NFC", query)

    # Collapse whitespace runs to a single space; strip leading/trailing.
    normalized = " ".join(normalized.split())

    byte_len = len(normalized.encode("utf-8"))
    if byte_len > max_bytes:
        raise ValueError(
            f"Query exceeds {max_bytes} UTF-8 bytes ({byte_len} provided). "
            "Submit a shorter request."
        )
    if not normalized:
        raise ValueError("Query must not be empty.")

    return normalized


# ── Lexical fallback ─────────────────────────────────────────────────────────


# Combining marks (Mn/Mc) and joiners belong INSIDE a token: Indic vowel signs
# and conjunct joiners are not word boundaries.
# Mirrors _QUERY_STOPWORDS in action_tools (duplicated, not imported, because
# action_tools imports this module).  Without it, "connect me with ankit" is
# dominated by "me"/"with" and the action the person asked for falls out of the
# result window entirely -- the exact production incident this catalog exists to
# prevent.  Only English function words appear here, so a Hindi or Hinglish
# token is never dropped.
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
        "the",
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

_TOKEN_MARK_CATEGORIES = frozenset({"Mn", "Mc"})
_TOKEN_JOINERS = frozenset({"\u200c", "\u200d"})  # ZWNJ, ZWJ


def _unicode_tokens(text: str) -> list[str]:
    """Split on anything that is not a Unicode letter, digit, or combining mark.

    ``str.isalnum()`` alone is not enough for Indic scripts: a Devanagari
    vowel sign such as U+0947 is category ``Mn`` and U+0940 is ``Mc``, neither
    of which is alphanumeric.  Splitting on them shreds "मेरी" into
    ``['म', 'र']`` and the query scores zero against every action.  Mark
    categories and the zero-width joiners used to build conjuncts are
    therefore part of a token, not separators.
    """
    out: list[str] = []
    buf: list[str] = []
    for ch in text:
        if (
            ch.isalnum()
            or unicodedata.category(ch) in _TOKEN_MARK_CATEGORIES
            or ch in _TOKEN_JOINERS
        ):
            buf.append(ch)
        elif buf:
            out.append("".join(buf))
            buf = []
    if buf:
        out.append("".join(buf))
    return out


def _unicode_lexical_score(entry: dict[str, Any], query: str) -> int:
    """Substring relevance that works on Unicode, not just ASCII ``[a-z0-9]``.

    Returns 0 when nothing matches; positive scores for label / alias /
    keyword / meaning / action_id hits.  This is intentionally different from
    ``_relevance_score`` in ``action_tools.py``: it does not strip non-ASCII
    characters, does not apply stopword removal, and does not cap the token
    list.
    """
    if not query:
        return 0
    q = query.lower()
    q_tokens = _unicode_tokens(q)
    if not q_tokens:
        return 0
    # Content tokens for the overlap signal; fall back to the raw tokens when a
    # query is entirely stopwords so a short query still scores.
    content_tokens = [t for t in q_tokens if t not in _LEXICAL_STOPWORDS] or q_tokens
    score = 0
    label = str(entry.get("label") or "").lower()
    meaning = str(entry.get("meaning") or "").lower()
    action_id = str(entry.get("action_id") or "").lower()

    # Whole-phrase signals: strongest, but only fire for short queries.
    if q in label:
        score += 40
    if q in meaning:
        score += 15
    if q in action_id:
        score += 10
    for alias in entry.get("aliases") or []:
        a = str(alias).lower()
        if q == a:
            score += 90
        elif q in a:
            score += 25
    for kw in entry.get("search_keywords") or []:
        k = str(kw).lower()
        if q == k:
            score += 35
        elif q in k:
            score += 15

    # Token overlap: without this, a natural query like "share my location
    # with mom" scores 0 against a "Share location" action, because no
    # whole-phrase test can match.  A 0 score is excluded by
    # _lexical_candidates, which silently collapsed hybrid retrieval to
    # semantic-only for every multi-word query.
    label_tokens = set(_unicode_tokens(label))
    meaning_tokens = set(_unicode_tokens(meaning))
    id_tokens = set(_unicode_tokens(action_id))
    alias_tokens: set[str] = set()
    for alias in entry.get("aliases") or []:
        alias_tokens |= set(_unicode_tokens(str(alias).lower()))
    keyword_tokens: set[str] = set()
    for kw in entry.get("search_keywords") or []:
        keyword_tokens |= set(_unicode_tokens(str(kw).lower()))

    matched_label = 0
    for token in set(content_tokens):
        if token in alias_tokens:
            score += 8
        if token in label_tokens:
            score += 6
            matched_label += 1
        if token in keyword_tokens:
            score += 4
        if token in id_tokens:
            score += 3
        if token in meaning_tokens:
            score += 2

    # Reward proportional coverage of the action's own label, so "share
    # location" outranks an action that merely shares one common word.
    if label_tokens and matched_label:
        score += int(20 * matched_label / len(label_tokens))

    return score


def _lexical_candidates(
    query: str, gateway: dict[str, Any], limit: int = _LEXICAL_CANDIDATES
) -> list[tuple[int, str]]:
    """Return ``[(score, action_id), ...]`` for actions that lexically match."""
    scored: list[tuple[int, str]] = []
    for entry in gateway.get("actions", []):
        if (entry.get("execution_target") or {}).get("status") != "wired":
            continue
        s = _unicode_lexical_score(entry, query)
        if s > 0:
            scored.append((s, str(entry.get("action_id", ""))))
    scored.sort(key=lambda x: -x[0])
    return scored[:limit]


# ── Reciprocal rank fusion ────────────────────────────────────────────────────


def _reciprocal_rank_fusion(
    semantic: list[str],
    lexical: list[str],
    k: int = 60,
) -> list[tuple[str, float]]:
    """Combine two ranked lists into a single fused ranking.

    ``semantic`` and ``lexical`` are ordered highest-relevance-first.  The RRF
    score for an action at position *i* (0-indexed) in a list of length *n* is
    ``1 / (k + i + 1)``.  Scores across lists are summed; ties are broken by
    semantic position (it carries the meaning signal).
    """
    fused: dict[str, float] = {}
    semantic_pos: dict[str, int] = {}
    for i, aid in enumerate(semantic):
        fused[aid] = fused.get(aid, 0.0) + 1.0 / (k + i + 1)
        semantic_pos.setdefault(aid, i)
    for i, aid in enumerate(lexical):
        fused[aid] = fused.get(aid, 0.0) + 1.0 / (k + i + 1)
    ranked = sorted(fused.items(), key=lambda x: (-x[1], semantic_pos.get(x[0], 10**9)))
    return ranked


# ── Embedding model ──────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _get_model() -> Any:
    """Load (and cache) the Sentence Transformers model.

    Called once per worker.  Falls back to a degraded state on any error so
    the rest of the system continues to work.
    """
    global _retrieval_available, _retrieval_error
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        _retrieval_available = False
        _retrieval_error = "sentence_transformers not installed"
        logger.warning("action_retrieval_degraded reason=%s", _retrieval_error)
        return None

    try:
        os.makedirs(_MODEL_CACHE_DIR, exist_ok=True)
        model = SentenceTransformer(
            _MODEL_NAME,
            revision=_MODEL_REVISION,
            cache_folder=_MODEL_CACHE_DIR,
        )
        logger.info(
            "action_retrieval_model_loaded model=%s revision=%s",
            _MODEL_NAME,
            _MODEL_REVISION,
        )
        return model
    except Exception:
        _retrieval_available = False
        _retrieval_error = "model load failed"
        logger.exception("action_retrieval_degraded reason=model_load_failed")
        return None


# ── Embedding helpers ─────────────────────────────────────────────────────────

# E5 models require a "query: " or "passage: " prefix for best quality.
_QUERY_PREFIX = "query: "
_PASSAGE_PREFIX = "passage: "


def _encode_query(model: Any, query: str) -> list[float]:
    if model is None:
        return []
    try:
        embedding = model.encode(
            _QUERY_PREFIX + query,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return embedding.tolist()
    except Exception:
        logger.exception("action_retrieval_encode_query_failed")
        return []


def _encode_passages(model: Any, texts: list[str]) -> list[list[float]]:
    if model is None or not texts:
        return []
    try:
        prefixed = [_PASSAGE_PREFIX + t for t in texts]
        embeddings = model.encode(
            prefixed,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return embeddings.tolist()
    except Exception:
        logger.exception("action_retrieval_encode_passages_failed")
        return []


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Dot product of L2-normalized vectors == cosine similarity."""
    if len(a) != len(b) or not a:
        return 0.0
    return sum(x * y for x, y in zip(a, b, strict=True))


# ── Vector cache ──────────────────────────────────────────────────────────────


class _VectorCache:
    """Digest-bound embedding cache for the wired action catalog.

    Rebuilt when the catalog digest, model revision, or description format
    changes.  The cache lives for the process lifetime; it is never stale
    because the digest gate prevents use of mismatched vectors.
    """

    def __init__(self) -> None:
        self._digest: str | None = None
        self._model_revision: str = _MODEL_REVISION
        self._descriptions: dict[str, str] = {}
        self._vectors: dict[str, list[float]] = {}

    def invalidate(self) -> None:
        self._digest = None
        self._descriptions.clear()
        self._vectors.clear()

    def ensure_built(self, gateway: dict[str, Any]) -> bool:
        """Rebuild if the digest changed; return True if vectors are ready."""
        digest = _catalog_digest(gateway)
        if self._digest == digest and self._model_revision == _MODEL_REVISION and self._vectors:
            return True

        self.invalidate()
        self._digest = digest
        self._model_revision = _MODEL_REVISION

        entries = [
            entry
            for entry in gateway.get("actions", [])
            if (entry.get("execution_target") or {}).get("status") == "wired"
        ]
        descriptions = [_project_description(e) for e in entries]
        action_ids = [str(e.get("action_id", "")) for e in entries]

        model = _get_model()
        if model is None:
            logger.warning("action_retrieval_cache_skip reason=model_unavailable")
            return False

        vectors = _encode_passages(model, descriptions)
        if len(vectors) != len(entries):
            logger.warning(
                "action_retrieval_cache_skip reason=encode_mismatch expected=%d got=%d",
                len(entries),
                len(vectors),
            )
            return False

        # strict=True: a length mismatch here would silently pair an action
        # with another action's vector, which is unfindable at runtime.
        self._descriptions = dict(zip(action_ids, descriptions, strict=True))
        self._vectors = dict(zip(action_ids, vectors, strict=True))
        logger.info("action_retrieval_cache_built actions=%d digest=%s", len(action_ids), digest)
        return True

    def get(self, action_id: str) -> list[float] | None:
        return self._vectors.get(action_id)

    def description(self, action_id: str) -> str | None:
        return self._descriptions.get(action_id)

    def all_action_ids(self) -> list[str]:
        return list(self._vectors.keys())


_vector_cache = _VectorCache()


# ── Public API ───────────────────────────────────────────────────────────────


def lexical_score(entry: dict[str, Any], query: str) -> int:
    """Public Unicode-aware lexical relevance for one catalog entry.

    Used by ``action_tools`` when the embedding model is unavailable, so the
    degraded path still ranks by the query instead of returning a query-blind
    list.  This is a RANKING signal only -- it never authorizes execution, and
    ``run_app_action`` re-validates every action regardless of score.
    """
    return _unicode_lexical_score(entry, query)


def is_retrieval_available() -> bool:
    """True when the embedding model loaded successfully."""
    return _retrieval_available


def retrieval_error() -> str | None:
    """Human-readable reason if the model is unavailable, else None."""
    return _retrieval_error


def search_actions(
    query: str,
    gateway: dict[str, Any],
    *,
    limit: int = _MAX_RETRIEVAL_RESULTS,
) -> list[RetrievedAction]:
    """Return ranked action entries matching ``query``.

    Combines semantic similarity (embedding dot-product) with Unicode-aware
    lexical matching via reciprocal rank fusion.  Every action in the gateway
    is a candidate; no positive lexical score is required for a semantic result.

    Returns up to ``limit`` entries, each carrying:
    - ``action_id``, ``label``, ``meaning``
    - ``semantic_boundaries`` (may be empty list)
    - ``policy`` (execution_policy)
    - ``availability``: ``"on_screen"`` | ``"journey"`` | ``"navigate_first"``
      (catalog-only view -- callers holding live screen context recompute it)
    - ``navigation`` (when a navigation action opens the destination first)
    - ``score``: fused RRF rank signal, NOT a calibrated confidence and never
      sufficient on its own to execute
    - ``delegate_agent_id`` (when a specialist owns this action)

    Raises ``ValueError`` on bad input; returns an empty list when the model
    is unavailable or no actions match.
    """
    # Input validation
    try:
        cleaned = _normalize_query(query)
    except ValueError:
        raise

    # Ensure the vector cache reflects the current catalog.
    if not _vector_cache.ensure_built(gateway):
        return []

    model = _get_model()
    if model is None:
        return []

    # Encode query.
    query_vec = _encode_query(model, cleaned)
    if not query_vec:
        return []

    # Score every wired action by semantic similarity.
    semantic_ranked: list[tuple[float, str]] = []
    for action_id in _vector_cache.all_action_ids():
        vec = _vector_cache.get(action_id)
        if vec:
            sim = _cosine_similarity(query_vec, vec)
            if sim > 0.0:
                semantic_ranked.append((sim, action_id))
    semantic_ranked.sort(key=lambda x: -x[0])
    semantic_ids = [aid for _, aid in semantic_ranked[:_SEMANTIC_CANDIDATES]]

    # Lexical branch (Unicode-aware).
    lexical_ids = [aid for _, aid in _lexical_candidates(cleaned, gateway, _LEXICAL_CANDIDATES)]

    # Fuse and truncate.
    fused = _reciprocal_rank_fusion(semantic_ids, lexical_ids)
    top_ids = [aid for aid, _ in fused[:limit]]

    # Build lookup from gateway.
    action_map: dict[str, dict[str, Any]] = {
        str(e.get("action_id", "")): e
        for e in gateway.get("actions", [])
        if (e.get("execution_target") or {}).get("status") == "wired"
    }

    # ``fused`` is already ordered by RRF score with a semantic-position
    # tie-break, so preserve that order.  Re-sorting here by (-score, action_id)
    # would break ties ALPHABETICALLY and promote a lexical-only hit above a
    # semantic-only hit of equal score -- the exact thing the plan forbids.
    fused_score: dict[str, float] = dict(fused)
    ordered = [(fused_score.get(aid, 0.0), aid) for aid in top_ids if aid in action_map]

    semantic_id_set = set(semantic_ids)
    lexical_id_set = set(lexical_ids)

    results: list[RetrievedAction] = []
    for score, action_id in ordered:
        entry = action_map[action_id]
        availability, open_first = _reachability(entry)
        if action_id in semantic_id_set and action_id in lexical_id_set:
            source = "fused"
        elif action_id in semantic_id_set:
            source = "semantic"
        else:
            source = "lexical"
        goal = entry.get("goal") if isinstance(entry.get("goal"), dict) else None
        required_inputs = {
            str(spec.get("slot") or ""): spec
            for spec in ((goal or {}).get("required_inputs") or [])
            if isinstance(spec, dict) and spec.get("slot")
        }
        results.append(
            RetrievedAction(
                action_id=action_id,
                score=float(score),
                source=source,
                meaning=str(entry.get("meaning") or ""),
                semantic_boundaries=_normalize_boundaries(entry.get("semantic_boundaries")),
                required_inputs=required_inputs,
                policy=str(entry.get("execution_policy") or "allow_direct"),
                availability=availability,
                navigation=({"open_first_action_id": open_first} if open_first else None),
                goal=goal,
                label=str(entry.get("label") or ""),
                delegate_agent_id=str(entry.get("delegate_agent_id") or ""),
                guard_ids=tuple(str(g) for g in (entry.get("guard_ids") or []) if str(g)),
                use_tool=_tool_name(entry),
            )
        )

    return results


def search_actions_for_command_palette(
    query: str,
    gateway: dict[str, Any],
    *,
    app_runtime_state: dict[str, Any] | None = None,
    limit: int = _MAX_RETRIEVAL_RESULTS,
) -> list[dict[str, Any]]:
    """Same as ``search_actions`` but aware of the current app screen.

    When ``app_runtime_state`` names a current screen, results include an
    ``on_screen`` flag and actions are ordered by reachability from that
    screen (on-screen first, then journey, then navigate-first).
    """
    base = search_actions(query, gateway, limit=limit * 2)
    current_screen = ""
    if isinstance(app_runtime_state, dict):
        current_screen = str(app_runtime_state.get("screen") or "").strip()

    if not current_screen:
        return [item.to_dict() for item in base[:limit]]

    # Tag and re-sort: on-screen first, preserving semantic order within each tier.
    tiers: dict[str, list[RetrievedAction]] = {
        "on_screen": [],
        "journey": [],
        "navigate_first": [],
        "other": [],
    }
    for item in base:
        tiers.setdefault(item.availability, []).append(item)

    ordered: list[RetrievedAction] = []
    for tier_name in ("on_screen", "journey", "navigate_first", "other"):
        ordered.extend(tiers.get(tier_name, []))

    payload: list[dict[str, Any]] = []
    for item in ordered[:limit]:
        row = item.to_dict()
        row["on_screen"] = item.availability == "on_screen"
        payload.append(row)
    return payload


# ── Reachability helpers (mirrored from action_tools to avoid import cycle) ───


def _reachability(
    entry: dict[str, Any],
) -> tuple[str, str | None]:
    """Classify how One could reach this action from the current app state.

    Returns ``(availability, open_first_action_id)``.
    """
    # For the retrieval path we do not know the live screen; treat every
    # reachable wired action as discoverable.  The app-side execution guard
    # still validates the actual current screen at dispatch time.
    if _is_journey_startable(entry):
        return "journey", None
    for route in (entry.get("reachability") or {}).get("routes") or []:
        nav_id = _navigation_action_for_route(str(route))
        if nav_id:
            return "navigate_first", nav_id
    return "on_screen", None


def _is_journey_startable(entry: dict[str, Any]) -> bool:
    """True when start_app_goal can begin this action from any screen."""
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
    """Find the wired action that opens ``route``."""
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    clean_route = str(route or "").strip()
    if not clean_route:
        return None
    candidates: list[str] = []
    for candidate in list_action_gateway_actions():
        target = candidate.get("execution_target") or {}
        if target.get("path") != "route" or target.get("status") != "wired":
            continue
        if str(target.get("target") or "").strip() == clean_route:
            candidates.append(str(candidate.get("action_id", "")))
    if not candidates:
        return None
    return sorted(candidates, key=lambda a: (not a.startswith("route."), a))[0]


def _tool_name(entry: dict[str, Any]) -> str | None:
    """Map an entry to the tool One should call."""
    from hushh_mcp.one_adk.action_tools import _DELEGATE_TOOL_BY_AGENT_ID

    delegate_id = str(entry.get("delegate_agent_id") or "").strip()
    delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(delegate_id)
    if delegate_tool:
        return delegate_tool
    if _is_journey_startable(entry):
        return "start_app_goal"
    return "run_app_action"


def invalidate_cache() -> None:
    """Force rebuild on next ``search_actions`` call.

    Used in tests and when the gateway is known to have changed.
    """
    _vector_cache.invalidate()
