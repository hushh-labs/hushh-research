"""Rebuildable bidirectional backlink graph and field-weighted BM25 lexical index."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from typing import Any

from .contracts import WikiPageRevision, WikiRefused, validate_page_id

_TOKEN_RE = re.compile(r"[a-z0-9_]{2,64}")
_STOPWORDS = frozenset(
    {
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "has",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "that",
        "the",
        "to",
        "was",
        "were",
        "with",
    }
)

_FIELD_WEIGHTS: dict[str, float] = {
    "title": 3.0,
    "claims": 2.5,
    "tldr": 2.0,
    "body": 1.0,
}


def tokenize_wiki_text(text: str) -> list[str]:
    if not text:
        return []
    return [token for token in _TOKEN_RE.findall(text.lower()) if token not in _STOPWORDS]


class BacklinkGraph:
    """Deterministic bidirectional link index keyed by stable wpg_* and wcl_* IDs."""

    def __init__(self, outbound: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self._outbound: dict[str, list[dict[str, Any]]] = {}
        if outbound:
            for raw_source, edges in sorted(outbound.items()):
                source_id = validate_page_id(raw_source)
                normalized: list[dict[str, Any]] = []
                for edge in edges:
                    target_id = validate_page_id(edge.get("target_page_id"))
                    if target_id == source_id:
                        continue
                    item: dict[str, Any] = {
                        "target_page_id": target_id,
                        "relation": str(edge.get("relation", "related")),
                        "source_revision": int(edge.get("source_revision", 1)),
                    }
                    if edge.get("anchor_claim_id"):
                        item["anchor_claim_id"] = str(edge["anchor_claim_id"])
                    if edge.get("note"):
                        item["note"] = str(edge["note"])
                    normalized.append(item)
                normalized.sort(
                    key=lambda item: (
                        item["target_page_id"],
                        item["relation"],
                        item.get("anchor_claim_id", ""),
                    )
                )
                if normalized:
                    self._outbound[source_id] = normalized

    @classmethod
    def from_pages(cls, pages: list[WikiPageRevision]) -> BacklinkGraph:
        graph = cls()
        for page in sorted(pages, key=lambda item: item.page_id):
            graph.upsert_page(page)
        return graph

    def upsert_page(self, page: WikiPageRevision) -> None:
        edges: list[dict[str, Any]] = []
        for link in page.links:
            if link.target_page_id == page.page_id:
                continue
            item: dict[str, Any] = {
                "target_page_id": link.target_page_id,
                "relation": link.relation,
                "source_revision": page.revision,
            }
            if link.anchor_claim_id is not None:
                item["anchor_claim_id"] = link.anchor_claim_id
            if link.note:
                item["note"] = link.note
            edges.append(item)
        edges.sort(
            key=lambda item: (
                item["target_page_id"],
                item["relation"],
                item.get("anchor_claim_id", ""),
            )
        )
        if edges:
            self._outbound[page.page_id] = edges
        else:
            self._outbound.pop(page.page_id, None)

    def remove_page(self, page_id: str) -> None:
        self._outbound.pop(validate_page_id(page_id), None)

    def outbound_for(self, page_id: str) -> list[dict[str, Any]]:
        return [dict(edge) for edge in self._outbound.get(validate_page_id(page_id), ())]

    def inbound_for(self, target_page_id: str) -> list[dict[str, Any]]:
        validated = validate_page_id(target_page_id)
        inbound: list[dict[str, Any]] = []
        for source_id in sorted(self._outbound):
            for edge in self._outbound[source_id]:
                if edge["target_page_id"] != validated:
                    continue
                record: dict[str, Any] = {
                    "source_page_id": source_id,
                    "relation": edge["relation"],
                    "source_revision": edge["source_revision"],
                }
                if "anchor_claim_id" in edge:
                    record["anchor_claim_id"] = edge["anchor_claim_id"]
                if "note" in edge:
                    record["note"] = edge["note"]
                inbound.append(record)
        inbound.sort(
            key=lambda item: (
                item["source_page_id"],
                item["relation"],
                item.get("anchor_claim_id", ""),
            )
        )
        return inbound

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": 1,
            "outbound": {page_id: self._outbound[page_id] for page_id in sorted(self._outbound)},
        }

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> BacklinkGraph:
        if not isinstance(raw, dict) or raw.get("format") != 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        outbound = raw.get("outbound")
        if not isinstance(outbound, dict):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        return cls(outbound=outbound)


class LexicalSearchIndex:
    """Encrypted-store BM25 + field-weighted lexical search index (no plaintext SQL FTS)."""

    def __init__(self, documents: dict[str, dict[str, Any]] | None = None) -> None:
        self._documents: dict[str, dict[str, Any]] = {}
        if documents:
            for raw_id, doc in sorted(documents.items()):
                page_id = validate_page_id(raw_id)
                if not isinstance(doc, dict):
                    raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
                fields_raw = doc.get("fields", {})
                if not isinstance(fields_raw, dict):
                    raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
                fields: dict[str, dict[str, int]] = {}
                for field_name in sorted(_FIELD_WEIGHTS):
                    counts = fields_raw.get(field_name, {})
                    if not isinstance(counts, dict):
                        raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
                    fields[field_name] = {
                        str(term): int(freq)
                        for term, freq in sorted(counts.items())
                        if int(freq) > 0
                    }
                self._documents[page_id] = {
                    "revision": int(doc.get("revision", 1)),
                    "fields": fields,
                }

    @classmethod
    def from_pages(cls, pages: list[WikiPageRevision]) -> LexicalSearchIndex:
        index = cls()
        for page in sorted(pages, key=lambda item: item.page_id):
            index.upsert_page(page)
        return index

    def upsert_page(self, page: WikiPageRevision) -> None:
        active_claims_text = " ".join(
            f"{claim.claim_id} {claim.statement}"
            for claim in page.claims
            if claim.status in {"active", "uncertain"}
        )
        field_texts = {
            "title": f"{page.page_id} {page.title}",
            "claims": active_claims_text,
            "tldr": page.tldr,
            "body": page.body,
        }
        fields: dict[str, dict[str, int]] = {}
        for field_name in sorted(_FIELD_WEIGHTS):
            counts = Counter(tokenize_wiki_text(field_texts[field_name]))
            fields[field_name] = {term: counts[term] for term in sorted(counts)}
        self._documents[page.page_id] = {
            "revision": page.revision,
            "fields": fields,
        }

    def remove_page(self, page_id: str) -> None:
        self._documents.pop(validate_page_id(page_id), None)

    def query_candidates(self, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
        if type(limit) is not int or not 1 <= limit <= 50:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        terms = list(dict.fromkeys(tokenize_wiki_text(query)))
        if not terms or not self._documents:
            return []

        doc_count = len(self._documents)
        weighted_lengths: dict[str, float] = {}
        doc_freqs: Counter[str] = Counter()

        for page_id, doc in self._documents.items():
            length = 0.0
            present_terms: set[str] = set()
            for field_name, weight in _FIELD_WEIGHTS.items():
                field_counts: dict[str, int] = doc["fields"].get(field_name, {})
                length += weight * sum(field_counts.values())
                present_terms.update(field_counts.keys())
            weighted_lengths[page_id] = max(length, 1.0)
            for term in present_terms:
                doc_freqs[term] += 1

        avg_len = sum(weighted_lengths.values()) / max(doc_count, 1)
        k1 = 1.5
        b = 0.75

        scored: list[dict[str, Any]] = []
        for page_id in sorted(self._documents):
            doc = self._documents[page_id]
            score = 0.0
            matched: list[str] = []
            for term in terms:
                tf = 0.0
                for field_name, weight in _FIELD_WEIGHTS.items():
                    tf += weight * doc["fields"].get(field_name, {}).get(term, 0)
                if tf <= 0.0:
                    continue
                matched.append(term)
                df = doc_freqs[term]
                idf = math.log(1.0 + (doc_count - df + 0.5) / (df + 0.5))
                norm = k1 * (1.0 - b + b * (weighted_lengths[page_id] / max(avg_len, 1.0)))
                score += idf * ((tf * (k1 + 1.0)) / (tf + norm))
            if score > 0.0:
                scored.append(
                    {
                        "page_id": page_id,
                        "indexed_revision": doc["revision"],
                        "score": round(score, 6),
                        "matched_terms": matched,
                    }
                )

        scored.sort(key=lambda item: (-item["score"], item["page_id"]))
        return scored[:limit]

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": 1,
            "documents": {page_id: self._documents[page_id] for page_id in sorted(self._documents)},
        }

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> LexicalSearchIndex:
        if not isinstance(raw, dict) or raw.get("format") != 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        documents = raw.get("documents")
        if not isinstance(documents, dict):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        return cls(documents=documents)
