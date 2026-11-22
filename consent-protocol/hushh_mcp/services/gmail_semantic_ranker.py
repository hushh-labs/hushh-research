"""Import-safe hybrid lexical + ephemeral semantic ranker for Gmail REST results.

A pure bacterial gene: no network calls, no database access, no persistence,
and no secrets. Candidate vectors live only inside local stack variables for a
single call and are discarded before return so zero inbox text or embeddings
are ever stored.
"""

from __future__ import annotations

import html
import re
from collections.abc import Mapping, Sequence
from typing import Any

_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "can",
        "did",
        "do",
        "does",
        "for",
        "from",
        "get",
        "hai",
        "have",
        "how",
        "i",
        "in",
        "is",
        "it",
        "ka",
        "ke",
        "ki",
        "ko",
        "kya",
        "mail",
        "mails",
        "me",
        "mera",
        "mere",
        "meri",
        "my",
        "ne",
        "of",
        "on",
        "or",
        "please",
        "se",
        "show",
        "that",
        "the",
        "this",
        "to",
        "was",
        "what",
        "with",
        "you",
        "your",
        "email",
        "emails",
        "inbox",
    }
)


def clean_snippet(value: Any, *, max_bytes: int = 280) -> str:
    """Unescape Gmail HTML entities, collapse control/whitespace, and cap UTF-8 bytes."""
    if not isinstance(value, str) or not value:
        return ""
    unescaped = html.unescape(value)
    cleaned = " ".join(ch for ch in unescaped.split() if ch)
    cleaned = "".join(ch for ch in cleaned if ord(ch) >= 32 or ch == " ")
    encoded = cleaned.encode("utf-8")
    if len(encoded) <= max_bytes:
        return cleaned
    return encoded[:max_bytes].decode("utf-8", errors="ignore").rstrip()


def fuse_query_candidates(
    ranked_lists: Sequence[Sequence[Mapping[str, Any]]],
    *,
    max_candidates: int = 30,
    k: float = 60.0,
) -> list[dict[str, Any]]:
    """Fuse 1..N Gmail REST ``messages.list`` pages via Reciprocal Rank Fusion.

    Deduplicates by ``threadId`` when present (falling back to ``id``) so a
    single noisy conversation does not crowd out distinct matching threads,
    while keeping the highest-scoring / newest representative message ID per
    thread and preserving ``thread_hits`` for ranking context.
    """
    if max_candidates <= 0:
        return []
    thread_best: dict[str, dict[str, Any]] = {}
    thread_scores: dict[str, float] = {}
    thread_hits: dict[str, int] = {}
    seen_message_ids: set[str] = set()

    for list_index, entries in enumerate(ranked_lists):
        weight = 1.25 if list_index == 0 else (1.0 if list_index == 1 else 0.75)
        seen_in_list: set[str] = set()
        for rank, entry in enumerate(entries):
            if not isinstance(entry, Mapping):
                continue
            msg_id = str(entry.get("id") or "").strip()
            if not msg_id:
                continue
            thread_id = str(entry.get("threadId") or "").strip() or msg_id
            if msg_id not in seen_message_ids:
                seen_message_ids.add(msg_id)
                thread_hits[thread_id] = thread_hits.get(thread_id, 0) + 1
            if thread_id in seen_in_list:
                continue
            seen_in_list.add(thread_id)
            contribution = weight * (k / (rank + k))
            thread_scores[thread_id] = thread_scores.get(thread_id, 0.0) + contribution
            if thread_id not in thread_best:
                thread_best[thread_id] = {
                    "id": msg_id,
                    "threadId": thread_id,
                    "first_list": list_index,
                    "first_rank": rank,
                }

    ordered = sorted(
        thread_best.keys(),
        key=lambda tid: (
            -thread_scores[tid],
            thread_best[tid]["first_list"],
            thread_best[tid]["first_rank"],
        ),
    )
    return [
        {
            "id": thread_best[tid]["id"],
            "threadId": tid,
            "rrf_score": thread_scores[tid],
            "thread_hits": thread_hits.get(tid, 1),
        }
        for tid in ordered[:max_candidates]
    ]


def _content_tokens(text: str) -> list[str]:
    tokens = [tok.casefold() for tok in _TOKEN_RE.findall(text or "")]
    filtered = [tok for tok in tokens if len(tok) >= 2 and tok not in _STOPWORDS]
    return filtered or [tok for tok in tokens if len(tok) >= 2]


def _lexical_scores(intent: str, candidates: Sequence[Mapping[str, Any]]) -> list[float]:
    query_tokens = _content_tokens(intent)
    if not query_tokens:
        return [0.0] * len(candidates)
    scores: list[float] = []
    for item in candidates:
        sender = str(item.get("sender") or "").casefold()
        subject = str(item.get("subject") or "").casefold()
        snippet = str(item.get("snippet") or "").casefold()
        recipient = str(item.get("recipient") or "").casefold()
        score = 0.0
        for tok in query_tokens:
            if tok in subject:
                score += 3.0
            if tok in sender or tok in recipient:
                score += 2.5
            if tok in snippet:
                score += 1.5
        scores.append(score)
    return scores


def _build_passage(item: Mapping[str, Any]) -> str:
    parts: list[str] = []
    sender = str(item.get("sender") or "").strip()
    recipient = str(item.get("recipient") or "").strip()
    subject = str(item.get("subject") or "").strip()
    snippet = str(item.get("snippet") or "").strip()
    if sender:
        parts.append(f"From: {sender}")
    if recipient:
        parts.append(f"To: {recipient}")
    if subject:
        parts.append(f"Subject: {subject}")
    if snippet:
        parts.append(snippet)
    return " | ".join(parts) or "(empty message)"


def _ranks_from_scores(scores: Sequence[float], *, positive_only: bool = False) -> dict[int, int]:
    indexed = [(idx, score) for idx, score in enumerate(scores) if not positive_only or score > 0.0]
    indexed.sort(key=lambda pair: (-pair[1], pair[0]))
    return {idx: rank for rank, (idx, _) in enumerate(indexed)}


def rerank_mail_candidates(
    intent: str,
    candidates: Sequence[Mapping[str, Any]],
    *,
    embedding_client: Any | None = None,
    k: float = 60.0,
) -> tuple[list[int], bool]:
    """Re-rank hydrated Gmail candidates in RAM using RRF + optional E5 embeddings.

    Returns ``(ordered_indices, used_semantic)``.

    Safety & latency invariants:
    - Only invokes ``embedding_client`` when ``getattr(embedding_client, "is_loaded", False)``
      is True (or explicitly provided ready client), so an unwarmed local worker
      never blocks a chat turn loading a model over the network.
    - All vectors stay strictly local to this function and are never persisted.
    """
    count = len(candidates)
    if count <= 1:
        return list(range(count)), False

    cleaned_intent = " ".join(str(intent or "").split()).strip()
    if not cleaned_intent:
        return list(range(count)), False

    rest_ranks = {idx: idx for idx in range(count)}

    lex_scores = _lexical_scores(cleaned_intent, candidates)
    lex_ranks = _ranks_from_scores(lex_scores, positive_only=True)

    sem_ranks: dict[int, int] = {}
    used_semantic = False
    if embedding_client is not None and getattr(embedding_client, "is_loaded", False):
        try:
            passages = [_build_passage(item) for item in candidates]
            query_vec = embedding_client.embed_query(cleaned_intent)
            passage_vecs = embedding_client.embed_passages(passages)
            if passage_vecs and len(passage_vecs) == count:
                sims = embedding_client.similarity(query_vec, passage_vecs)
                if len(sims) == count:
                    sem_ranks = _ranks_from_scores([float(s) for s in sims])
                    used_semantic = True
        except Exception:  # noqa: BLE001 - ranking degrades cleanly to REST + lexical
            sem_ranks = {}
            used_semantic = False

    fused: dict[int, float] = {}
    for idx in range(count):
        score = 1.0 * (k / (rest_ranks[idx] + k))
        if idx in lex_ranks:
            score += 1.2 * (k / (lex_ranks[idx] + k))
        if idx in sem_ranks:
            score += 1.6 * (k / (sem_ranks[idx] + k))
        fused[idx] = score

    ordered = sorted(range(count), key=lambda idx: (-fused[idx], idx))
    return ordered, used_semantic
