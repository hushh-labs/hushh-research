"""Closed identifiers, refusal vocabulary, and canonical Markdown contracts for wiki/v1."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

MAX_PAGE_BODY_CHARS = 64_000
MAX_TLDR_CHARS = 600
MAX_CLAIM_CHARS = 1_000
MAX_CLAIMS_PER_PAGE = 256
MAX_LINKS_PER_PAGE = 256
MAX_SOURCES_PER_PAGE = 256
MAX_BATCH_PAGES = 32
MAX_NOTE_CHARS = 280

CLAIM_STATUSES = frozenset({"active", "superseded", "uncertain", "retracted"})
LINK_RELATIONS = frozenset({"related", "supports", "contradicts", "supersedes", "part_of"})
SOURCE_KINDS = frozenset(
    {"chat_turn", "file_object", "pkm_record", "live_activity", "owner_direct"}
)
RESERVED_GENERATED_HEADINGS = frozenset({"tl;dr", "claims", "relations", "sources"})

_PAGE_ID_RE = re.compile(r"^wpg_[0-9a-f]{16}$")
_CLAIM_ID_RE = re.compile(r"^wcl_[0-9a-f]{16}$")
_SOURCE_ID_RE = re.compile(r"^wsr_[0-9a-f]{16}$")
_BATCH_ID_RE = re.compile(r"^wbt_[0-9a-f]{16}$")
_TOMBSTONE_ID_RE = re.compile(r"^wtb_[0-9a-f]{16}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ][^\r\n]{1,40})?$")
_INLINE_LINK_RE = re.compile(
    r"\[\[(wpg_[0-9a-f]{16})(?:#(wcl_[0-9a-f]{16}))?(?:\|([^\]\r\n]{1,160}))?\]\]"
)
_HEADING_RE = re.compile(r"^(#{2,6})\s+(.+?)\s*$", re.MULTILINE)


class WikiRefused(Exception):
    """Typed closed refusal raised across encrypted wiki operations."""

    def __init__(self, code: str, status: int = 409) -> None:
        self.code = code
        self.status = status
        super().__init__(code)


def _validate_prefixed_id(value: Any, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise WikiRefused("WIKI_INVALID_ID", 400)
    return value


def validate_page_id(value: Any) -> str:
    return _validate_prefixed_id(value, _PAGE_ID_RE)


def validate_claim_id(value: Any) -> str:
    return _validate_prefixed_id(value, _CLAIM_ID_RE)


def validate_source_id(value: Any) -> str:
    return _validate_prefixed_id(value, _SOURCE_ID_RE)


def validate_batch_id(value: Any) -> str:
    return _validate_prefixed_id(value, _BATCH_ID_RE)


def validate_tombstone_id(value: Any) -> str:
    return _validate_prefixed_id(value, _TOMBSTONE_ID_RE)


def validate_idempotency_key(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not 4 <= len(value) <= 128
        or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
    ):
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
    return value


def validate_title(value: Any) -> str:
    if not isinstance(value, str):
        raise WikiRefused("WIKI_INVALID_TITLE", 400)
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 200 or any(ord(ch) < 32 for ch in cleaned):
        raise WikiRefused("WIKI_INVALID_TITLE", 400)
    return cleaned


def validate_folder(value: Any) -> str:
    if not isinstance(value, str):
        raise WikiRefused("WIKI_INVALID_FOLDER", 400)
    cleaned = value.strip().strip("/") or "root"
    if cleaned == "root":
        return "root"
    if len(cleaned) > 128 or "\\" in cleaned or any(ord(ch) < 32 for ch in cleaned):
        raise WikiRefused("WIKI_INVALID_FOLDER", 400)
    segments = cleaned.split("/")
    if len(segments) > 8:
        raise WikiRefused("WIKI_INVALID_FOLDER", 400)
    for segment in segments:
        if (
            not segment
            or segment in {".", "..", "root"}
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", segment)
        ):
            raise WikiRefused("WIKI_INVALID_FOLDER", 400)
    return cleaned


def validate_iso_date(value: Any, *, field_name: str = "date") -> str:
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value.strip()):
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
    return value.strip()


@dataclass(frozen=True)
class WikiSourceRef:
    source_id: str
    kind: str
    locator: str
    content_sha256: str
    observed_at: str
    consent_derived: bool = False

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> WikiSourceRef:
        if not isinstance(raw, dict):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        consent_derived = raw.get("consent_derived", False)
        if type(consent_derived) is not bool:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        if consent_derived:
            raise WikiRefused("WIKI_SOURCE_INELIGIBLE", 403)
        kind = raw.get("kind")
        if kind not in SOURCE_KINDS:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        locator = raw.get("locator")
        if (
            not isinstance(locator, str)
            or not 1 <= len(locator.strip()) <= 256
            or any(ord(ch) < 32 for ch in locator)
        ):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        digest = raw.get("content_sha256")
        if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest.lower()):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        return cls(
            source_id=validate_source_id(raw.get("source_id")),
            kind=kind,
            locator=locator.strip(),
            content_sha256=digest.lower(),
            observed_at=validate_iso_date(raw.get("observed_at")),
            consent_derived=False,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "kind": self.kind,
            "locator": self.locator,
            "content_sha256": self.content_sha256,
            "observed_at": self.observed_at,
            "consent_derived": self.consent_derived,
        }


@dataclass(frozen=True)
class WikiClaim:
    claim_id: str
    statement: str
    status: str
    confidence: float
    source_ids: tuple[str, ...]
    observed_at: str
    valid_until: str | None = None
    superseded_by: str | None = None

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> WikiClaim:
        if not isinstance(raw, dict):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        statement = raw.get("statement")
        if (
            not isinstance(statement, str)
            or not 1 <= len(statement.strip()) <= MAX_CLAIM_CHARS
            or any(ord(ch) < 32 and ch not in "\t" for ch in statement)
        ):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        status = raw.get("status", "active")
        if status not in CLAIM_STATUSES:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        confidence_raw = raw.get("confidence", 1.0)
        if type(confidence_raw) not in (int, float) or not 0.0 <= float(confidence_raw) <= 1.0:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        raw_sources = raw.get("source_ids", ())
        if not isinstance(raw_sources, (list, tuple)) or len(raw_sources) > MAX_SOURCES_PER_PAGE:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        source_ids = tuple(dict.fromkeys(validate_source_id(item) for item in raw_sources))
        valid_until = raw.get("valid_until")
        if valid_until is not None:
            valid_until = validate_iso_date(valid_until)
        superseded_by = raw.get("superseded_by")
        if superseded_by is not None:
            superseded_by = validate_claim_id(superseded_by)
        if status == "superseded" and superseded_by is None:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        return cls(
            claim_id=validate_claim_id(raw.get("claim_id")),
            statement=statement.strip(),
            status=status,
            confidence=round(float(confidence_raw), 4),
            source_ids=source_ids,
            observed_at=validate_iso_date(raw.get("observed_at", "2026-01-01")),
            valid_until=valid_until,
            superseded_by=superseded_by,
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "claim_id": self.claim_id,
            "statement": self.statement,
            "status": self.status,
            "confidence": self.confidence,
            "source_ids": list(self.source_ids),
            "observed_at": self.observed_at,
        }
        if self.valid_until is not None:
            payload["valid_until"] = self.valid_until
        if self.superseded_by is not None:
            payload["superseded_by"] = self.superseded_by
        return payload


@dataclass(frozen=True)
class WikiLinkEdge:
    target_page_id: str
    relation: str = "related"
    anchor_claim_id: str | None = None
    note: str = ""

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> WikiLinkEdge:
        if not isinstance(raw, dict):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        relation = raw.get("relation", "related")
        if relation not in LINK_RELATIONS:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        anchor = raw.get("anchor_claim_id")
        if anchor is not None:
            anchor = validate_claim_id(anchor)
        note = raw.get("note", "")
        if (
            not isinstance(note, str)
            or len(note.strip()) > MAX_NOTE_CHARS
            or any(ord(ch) < 32 for ch in note)
        ):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        return cls(
            target_page_id=validate_page_id(raw.get("target_page_id")),
            relation=relation,
            anchor_claim_id=anchor,
            note=note.strip(),
        )

    def key(self) -> tuple[str, str, str]:
        return (self.target_page_id, self.relation, self.anchor_claim_id or "")

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "target_page_id": self.target_page_id,
            "relation": self.relation,
        }
        if self.anchor_claim_id is not None:
            payload["anchor_claim_id"] = self.anchor_claim_id
        if self.note:
            payload["note"] = self.note
        return payload


def extract_inline_links(body: str, *, self_page_id: str = "") -> tuple[WikiLinkEdge, ...]:
    """Extract deterministic inline [[wpg_*]] and [[wpg_*#wcl_*|Label]] links from Markdown."""
    seen: dict[tuple[str, str, str], WikiLinkEdge] = {}
    for match in _INLINE_LINK_RE.finditer(body):
        target_id, claim_id, label = match.group(1), match.group(2), match.group(3)
        if target_id == self_page_id:
            continue
        edge = WikiLinkEdge(
            target_page_id=target_id,
            relation="related",
            anchor_claim_id=claim_id or None,
            note=(label or "").strip()[:MAX_NOTE_CHARS],
        )
        seen.setdefault(edge.key(), edge)
    return tuple(seen.values())


def merge_links(
    explicit_links: tuple[WikiLinkEdge, ...],
    body: str,
    *,
    self_page_id: str,
) -> tuple[WikiLinkEdge, ...]:
    merged: dict[tuple[str, str, str], WikiLinkEdge] = {}
    for edge in explicit_links:
        if edge.target_page_id == self_page_id:
            continue
        merged[edge.key()] = edge
    for inline_edge in extract_inline_links(body, self_page_id=self_page_id):
        merged.setdefault(inline_edge.key(), inline_edge)
    if len(merged) > MAX_LINKS_PER_PAGE:
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
    return tuple(sorted(merged.values(), key=lambda item: item.key()))


@dataclass(frozen=True)
class WikiPageRevision:
    page_id: str
    revision: int
    title: str
    folder: str
    tldr: str
    status_as_of: str
    body: str
    claims: tuple[WikiClaim, ...]
    links: tuple[WikiLinkEdge, ...]
    source_ids: tuple[str, ...]
    updated_at: int

    @classmethod
    def build(
        cls,
        *,
        page_id: str,
        revision: int,
        title: str,
        folder: str = "root",
        tldr: str = "",
        status_as_of: str = "2026-01-01",
        body: str = "",
        claims: list[dict[str, Any] | WikiClaim] | tuple[WikiClaim, ...] = (),
        links: list[dict[str, Any] | WikiLinkEdge] | tuple[WikiLinkEdge, ...] = (),
        source_ids: list[str] | tuple[str, ...] = (),
        updated_at: int,
    ) -> WikiPageRevision:
        validated_id = validate_page_id(page_id)
        if type(revision) is not int or revision < 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        if type(updated_at) is not int or updated_at < 0:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        if not isinstance(tldr, str) or len(tldr.strip()) > MAX_TLDR_CHARS:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        if not isinstance(body, str) or len(body) > MAX_PAGE_BODY_CHARS or "\x00" in body:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        if len(claims) > MAX_CLAIMS_PER_PAGE:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        parsed_claims: list[WikiClaim] = []
        seen_claims: set[str] = set()
        for raw_claim in claims:
            claim = (
                raw_claim if isinstance(raw_claim, WikiClaim) else WikiClaim.from_mapping(raw_claim)
            )
            if claim.claim_id in seen_claims:
                raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
            seen_claims.add(claim.claim_id)
            parsed_claims.append(claim)

        parsed_links = tuple(
            raw_link if isinstance(raw_link, WikiLinkEdge) else WikiLinkEdge.from_mapping(raw_link)
            for raw_link in links
        )
        normalized_body = body.replace("\r\n", "\n").strip()
        merged_links = merge_links(parsed_links, normalized_body, self_page_id=validated_id)

        collected_sources = [validate_source_id(src) for src in source_ids]
        for claim in parsed_claims:
            collected_sources.extend(claim.source_ids)
        deduped_sources = tuple(dict.fromkeys(collected_sources))
        if len(deduped_sources) > MAX_SOURCES_PER_PAGE:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        return cls(
            page_id=validated_id,
            revision=revision,
            title=validate_title(title),
            folder=validate_folder(folder),
            tldr=tldr.strip(),
            status_as_of=validate_iso_date(status_as_of),
            body=normalized_body,
            claims=tuple(parsed_claims),
            links=merged_links,
            source_ids=deduped_sources,
            updated_at=updated_at,
        )

    def markdown(self) -> str:
        return render_wiki_markdown(self)

    def content_sha256(self) -> str:
        canonical = json.dumps(self.to_storage_dict(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def to_storage_dict(self) -> dict[str, Any]:
        return {
            "format": 1,
            "page_id": self.page_id,
            "revision": self.revision,
            "title": self.title,
            "folder": self.folder,
            "tldr": self.tldr,
            "status_as_of": self.status_as_of,
            "body": self.body,
            "claims": [claim.to_dict() for claim in self.claims],
            "links": [edge.to_dict() for edge in self.links],
            "source_ids": list(self.source_ids),
            "updated_at": self.updated_at,
        }

    def to_public_dict(self, *, pending_batch_id: str | None = None) -> dict[str, Any]:
        payload = {
            "page_id": self.page_id,
            "revision": self.revision,
            "title": self.title,
            "folder": self.folder,
            "tldr": self.tldr,
            "status_as_of": self.status_as_of,
            "body": self.body,
            "claims": [claim.to_dict() for claim in self.claims],
            "links": [edge.to_dict() for edge in self.links],
            "source_ids": list(self.source_ids),
            "updated_at": self.updated_at,
            "content_sha256": self.content_sha256(),
            "markdown": self.markdown(),
        }
        if pending_batch_id is not None:
            payload["pending_batch_id"] = pending_batch_id
        return payload

    @classmethod
    def from_storage_bytes(cls, data: bytes) -> WikiPageRevision:
        try:
            decoded = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409) from exc
        if not isinstance(decoded, dict) or decoded.get("format") != 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        return cls.build(
            page_id=decoded.get("page_id", ""),
            revision=decoded.get("revision", 0),
            title=decoded.get("title", ""),
            folder=decoded.get("folder", "root"),
            tldr=decoded.get("tldr", ""),
            status_as_of=decoded.get("status_as_of", "2026-01-01"),
            body=decoded.get("body", ""),
            claims=decoded.get("claims", []),
            links=decoded.get("links", []),
            source_ids=decoded.get("source_ids", []),
            updated_at=decoded.get("updated_at", 0),
        )


def render_wiki_markdown(page: WikiPageRevision) -> str:
    """Render deterministic Markdown with frontmatter, TL;DR, body, claims, links, and sources."""
    lines = [
        "---",
        f"page_id: {page.page_id}",
        f"revision: {page.revision}",
        f"title: {json.dumps(page.title, ensure_ascii=False)}",
        f"folder: {page.folder}",
        f"status_as_of: {page.status_as_of}",
        f"updated_at: {page.updated_at}",
        "---",
        "",
        f"# {page.title}",
        "",
        f"Status as of {page.status_as_of}",
    ]
    if page.tldr:
        lines.extend(["", "## TL;DR", "", page.tldr])
    if page.body:
        lines.extend(["", page.body])
    if page.claims:
        lines.extend(["", "## Claims", ""])
        for claim in page.claims:
            cite = f" (sources: {', '.join(claim.source_ids)})" if claim.source_ids else ""
            superseded = f" [superseded_by: {claim.superseded_by}]" if claim.superseded_by else ""
            lines.append(
                f"- [{claim.claim_id}] ({claim.status}, confidence={claim.confidence:.2f}) "
                f"{claim.statement}{superseded}{cite}"
            )
    if page.links:
        lines.extend(["", "## Relations", ""])
        for edge in page.links:
            anchor = f"#{edge.anchor_claim_id}" if edge.anchor_claim_id else ""
            note = f" — {edge.note}" if edge.note else ""
            lines.append(f"- {edge.relation}: [[{edge.target_page_id}{anchor}]]{note}")
    if page.source_ids:
        lines.extend(["", "## Sources", ""])
        for source_id in page.source_ids:
            lines.append(f"- {source_id}")
    return "\n".join(lines) + "\n"


def replace_markdown_section(
    body: str,
    *,
    heading: str,
    content: str | None,
    level: int = 2,
    create_if_missing: bool = True,
) -> str:
    """Replace, append, or remove a named Markdown heading section deterministically."""
    if not isinstance(heading, str) or not heading.strip() or "\n" in heading:
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
    normalized_heading = heading.strip().lstrip("#").strip()
    if not normalized_heading or len(normalized_heading) > 120:
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
    if normalized_heading.lower() in RESERVED_GENERATED_HEADINGS:
        raise WikiRefused("WIKI_SECTION_RESERVED", 400)
    if type(level) is not int or not 2 <= level <= 6:
        raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

    normalized_body = body.replace("\r\n", "\n")
    matches = list(_HEADING_RE.finditer(normalized_body))
    target_idx = next(
        (
            idx
            for idx, match in enumerate(matches)
            if match.group(2).strip().lower() == normalized_heading.lower()
        ),
        None,
    )

    clean_content = None if content is None else content.replace("\r\n", "\n").strip()
    if target_idx is None:
        if clean_content is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        if not create_if_missing:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        section_block = f"{'#' * level} {normalized_heading}\n\n{clean_content}".strip()
        if not normalized_body.strip():
            return section_block
        return f"{normalized_body.strip()}\n\n{section_block}"

    target_match = matches[target_idx]
    target_level = len(target_match.group(1))
    section_start = target_match.start()
    section_end = len(normalized_body)
    for later_match in matches[target_idx + 1 :]:
        if len(later_match.group(1)) <= target_level:
            section_end = later_match.start()
            break

    prefix = normalized_body[:section_start].rstrip()
    suffix = normalized_body[section_end:].lstrip("\n")
    if clean_content is None:
        combined = "\n\n".join(part for part in (prefix, suffix.strip()) if part)
        return combined.strip()

    replacement = f"{'#' * target_level} {target_match.group(2).strip()}"
    if clean_content:
        replacement = f"{replacement}\n\n{clean_content}"
    parts = [part for part in (prefix, replacement, suffix.strip()) if part]
    return "\n\n".join(parts).strip()


def canonical_request_fingerprint(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
