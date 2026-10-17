"""Durable, owner-scoped public-profile discovery and one-way PKM handoff."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import ipaddress
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4, uuid5

import asyncpg
import httpx

from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logger = logging.getLogger(__name__)

CONSENT_VERSION = "public_profile_discovery_v2"
MAX_FINDINGS = 80
MAX_PROFILE_TEXT = 1200
SCAN_TIMEOUT_SECONDS = 45 * 60
POLL_INTERVAL_SECONDS = 10
DEFAULT_DAILY_SCAN_START_LIMIT = 1000
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_VALID_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d ().-]{7,}\d)(?!\w)")
_PUBLIC_STATUSES = frozenset(
    {"queued", "scanning", "needs_details", "ready", "failed", "claimed", "cancelled"}
)


class ProfileDiscoveryError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def profile_discovery_enabled() -> bool:
    return os.getenv("ONE_PUBLIC_PROFILE_DISCOVERY_ENABLED", "false").strip().lower() == "true"


def profile_discovery_user_enabled(user_id: str) -> bool:
    if not profile_discovery_enabled():
        return False
    allowed = {
        item.strip()
        for item in os.getenv("ONE_PUBLIC_PROFILE_DISCOVERY_ALLOWED_USER_IDS", "").split(",")
        if item.strip()
    }
    environment = os.getenv("ENVIRONMENT", "").strip().lower()
    return user_id in allowed or (not allowed and environment in {"local", "development", "test"})


def _daily_scan_start_limit() -> int:
    try:
        value = int(
            os.getenv(
                "ONE_PUBLIC_PROFILE_DISCOVERY_DAILY_LIMIT", str(DEFAULT_DAILY_SCAN_START_LIMIT)
            )
        )
    except ValueError:
        return 0
    return max(0, min(value, 100_000))


def _clean_text(value: object, *, limit: int = MAX_PROFILE_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _assessment_protocol() -> str:
    protocol = os.getenv("ONE_PUBLIC_PROFILE_PROTOCOL", "a2a").strip()
    if protocol not in {"a2a", "scan"}:
        raise ProfileDiscoveryError(
            "unsupported_profile_protocol", "Public profile assessment is unavailable."
        )
    return protocol


def _public_url(value: object) -> str:
    raw = _clean_text(value, limit=500)
    if not raw:
        return ""
    try:
        from hushh_mcp.services.public_profile_assessment_client import reject_public_contact

        reject_public_contact(raw)
        parsed = urlsplit(raw)
        host = (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
        if parsed.scheme.lower() != "https" or not host or parsed.username or parsed.password:
            raise ValueError
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError
        return urlunsplit(("https", host, parsed.path[:400], "", ""))
    except (UnicodeError, ValueError):
        raise ProfileDiscoveryError(
            "invalid_profile_url", "Enter a public HTTPS profile URL."
        ) from None


def _anchor_hash(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _safe_public_text(value: object, *, limit: int = MAX_PROFILE_TEXT) -> str:
    text = _clean_text(value, limit=limit)
    preserved_dates: list[str] = []

    def preserve_date(match: re.Match[str]) -> str:
        preserved_dates.append(match.group(0))
        return f"__PUBLIC_DATE_{len(preserved_dates) - 1}__"

    text = re.sub(r"\b(?:19|20)\d{2}-\d{2}-\d{2}\b", preserve_date, text)
    text = _EMAIL_RE.sub("[contact removed]", text)
    text = _PHONE_RE.sub("[contact removed]", text)
    for index, date in enumerate(preserved_dates):
        text = text.replace(f"__PUBLIC_DATE_{index}__", date)
    return text


def _source_url(value: object) -> str:
    raw = _clean_text(value, limit=2048)
    try:
        from hushh_mcp.services.public_profile_assessment_client import reject_public_contact

        reject_public_contact(raw)
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
        if scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            return ""
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
            return ""
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            return ""
        port = parsed.port
        default_port = 80 if scheme == "http" else 443
        if port is not None and port != default_port:
            return ""
        return urlunsplit((scheme, host, parsed.path[:1000], "", ""))
    except (UnicodeError, ValueError):
        return ""


def _citation_url(value: object) -> str:
    candidates: list[object] = []
    if isinstance(value, str):
        candidates.append(value)
    elif isinstance(value, dict):
        candidates.extend(value.get(key) for key in ("url", "uri", "source_url", "sourceUrl"))
    for candidate in candidates:
        match = re.search(r"https?://[^\s|<>]+", str(candidate or ""), re.IGNORECASE)
        source = _source_url(match.group(0).rstrip(".,;)]}")) if match else ""
        if source:
            return source
    return ""


def _evidence_ledger_rows(report: object, citations: object) -> list[dict[str, Any]]:
    if not isinstance(report, str):
        return []
    citation_urls = (
        [_citation_url(item) for item in citations] if isinstance(citations, list) else []
    )
    citation_urls = [url for url in citation_urls if url]
    header: list[str] | None = None
    facts: list[dict[str, Any]] = []
    for line in report.splitlines():
        if "|" not in line:
            continue
        cells = [
            cell.replace("\\|", "|").strip()
            for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))
        ]
        normalized = [re.sub(r"[^a-z]+", " ", cell.lower()).strip() for cell in cells]
        if any("claim" in cell for cell in normalized) and any(
            "source" in cell for cell in normalized
        ):
            header = normalized
            continue
        if (
            header is None
            or len(cells) < 2
            or all(re.fullmatch(r":?-{2,}:?", cell.replace(" ", "")) for cell in cells)
        ):
            continue
        claim_index = next((i for i, cell in enumerate(header) if "claim" in cell), 0)
        if claim_index >= len(cells):
            continue
        claim = _safe_public_text(cells[claim_index])
        if not claim:
            continue
        source_index = next((i for i, cell in enumerate(header) if "source" in cell), None)
        url_index = next(
            (i for i, cell in enumerate(header) if "url" in cell or "link" in cell), None
        )
        confidence_index = next((i for i, cell in enumerate(header) if "confidence" in cell), None)
        date_index = next(
            (i for i, cell in enumerate(header) if "date" in cell or "accessed" in cell), None
        )
        note_index = next(
            (
                i
                for i, cell in enumerate(header)
                if "contradiction" in cell or "verification" in cell
            ),
            None,
        )
        source_label = (
            cells[source_index]
            if source_index is not None and source_index < len(cells)
            else "Public evidence"
        )
        source_cell = cells[url_index] if url_index is not None and url_index < len(cells) else ""
        sources = [
            source
            for match in re.findall(r"https?://[^\s|<>]+", source_cell, re.IGNORECASE)
            if (source := _source_url(match.rstrip(".,;)]}")))
        ]
        reference_text = " ".join(
            cells[index]
            for index in (url_index, source_index, note_index)
            if index is not None and index < len(cells)
        )
        for marker in re.findall(r"\[(\d{1,3})\]", reference_text):
            index = int(marker) - 1
            if 0 <= index < len(citation_urls):
                sources.append(citation_urls[index])
        sources = list(dict.fromkeys(sources))[:8]
        confidence_raw = (
            cells[confidence_index].lower()
            if confidence_index is not None and confidence_index < len(cells)
            else ""
        )
        confidence = next(
            (
                level
                for level in ("high", "medium", "low")
                if re.search(rf"\b{level}\b", confidence_raw)
            ),
            None,
        )
        support_parts = ["Source label: " + _safe_public_text(source_label, limit=100)]
        if date_index is not None and date_index < len(cells) and cells[date_index]:
            support_parts.append(
                "Source date/context: " + _safe_public_text(cells[date_index], limit=180)
            )
        if note_index is not None and note_index < len(cells) and cells[note_index]:
            support_parts.append(
                "Verification note: " + _safe_public_text(cells[note_index], limit=220)
            )
        facts.append(
            {
                "category": "Public information",
                "claim": claim,
                "confidence": confidence,
                "support": "; ".join(support_parts)[:500],
                "source_urls": sources,
                "observed_at": None,
                "collected_at": None,
            }
        )
        if len(facts) >= MAX_FINDINGS:
            break
    if facts:
        return facts

    heading = "Public information"
    for line in report.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = _safe_public_text(stripped.lstrip("# "), limit=80) or heading
            continue
        bullet = re.match(r"^(?:[-*•]\s+|\d+[.)]\s+)(.+)$", stripped)
        if not bullet or "|" in stripped:
            continue
        raw_claim = bullet.group(1)
        sources = [
            source
            for match in re.findall(r"https?://[^\s|<>]+", raw_claim, re.IGNORECASE)
            if (source := _source_url(match.rstrip(".,;)]}")))
        ]
        for marker in re.findall(r"\[(\d{1,3})\]", raw_claim):
            index = int(marker) - 1
            if 0 <= index < len(citation_urls):
                sources.append(citation_urls[index])
        sources = list(dict.fromkeys(sources))[:8]
        if not sources:
            continue
        claim = re.sub(r"\[([^\]]+)\]\(https?://[^)\s]+\)", r"\1", raw_claim)
        claim = re.sub(r"https?://[^\s|<>]+", "", claim)
        claim = re.sub(r"\[\d{1,3}\]", "", claim)
        claim = re.sub(r"\s+([,.;:!?])", r"\1", claim)
        claim = _safe_public_text(claim, limit=MAX_PROFILE_TEXT).strip(" -*•\t")
        if not claim:
            continue
        confidence = next(
            (
                level
                for level in ("high", "medium", "low")
                if re.search(rf"\b{level}\s+confidence\b", claim, re.IGNORECASE)
            ),
            None,
        )
        facts.append(
            {
                "category": heading,
                "claim": claim,
                "confidence": confidence,
                "support": "Source-linked dossier entry",
                "source_urls": sources,
                "observed_at": None,
                "collected_at": None,
            }
        )
        if len(facts) >= MAX_FINDINGS:
            break
    return facts


def _profile_from_scan(result: object, *, display_name: str, collected_at: str) -> dict[str, Any]:
    root = result if isinstance(result, dict) else {}
    rich = root.get("rich") if isinstance(root.get("rich"), dict) else {}
    facts: list[dict[str, Any]] = []
    seen: set[str] = set()
    raw_evidence = rich.get("evidence") if isinstance(rich, dict) else None
    if not isinstance(raw_evidence, list) or not raw_evidence:
        raw_evidence = _evidence_ledger_rows(root.get("report"), root.get("citations"))
    if isinstance(raw_evidence, list):
        for item in raw_evidence:
            if not isinstance(item, dict):
                continue
            claim = _safe_public_text(item.get("claim"))
            if not claim or claim in seen:
                continue
            seen.add(claim)
            raw_sources = item.get("sources", item.get("source_urls"))
            sources = (
                list(dict.fromkeys(_source_url(url) for url in raw_sources if _source_url(url)))
                if isinstance(raw_sources, list)
                else []
            )
            confidence = str(item.get("confidence") or "").lower()
            facts.append(
                {
                    "category": _safe_public_text(item.get("category"), limit=80)
                    or "Public information",
                    "claim": claim,
                    "confidence": confidence if confidence in {"low", "medium", "high"} else None,
                    "support": _safe_public_text(item.get("support"), limit=500) or None,
                    "source_urls": sources[:8],
                    # The scanner does not provide source publication dates. Keep
                    # collection time explicit instead of inventing an observation date.
                    "observed_at": None,
                    "collected_at": collected_at,
                }
            )
            if len(facts) >= MAX_FINDINGS:
                break
    raw_conflicts = rich.get("conflicts") if isinstance(rich, dict) else None
    conflicts = (
        [
            _safe_public_text(item, limit=500)
            for item in raw_conflicts
            if _safe_public_text(item, limit=500)
        ][:20]
        if isinstance(raw_conflicts, list)
        else []
    )
    sources = list(dict.fromkeys(url for fact in facts for url in fact["source_urls"]))
    return {
        "schema_version": "public_profile_review.v1",
        "display_name": _safe_public_text(display_name, limit=160),
        "summary": _safe_public_text(root.get("summary"), limit=1800),
        "collected_at": collected_at,
        "revision": 1,
        "facts": facts,
        "sources": sources[:200],
        "conflicts": conflicts,
        "warnings": [
            _safe_public_text(item, limit=300)
            for item in root.get("warnings", [])
            if _safe_public_text(item, limit=300)
        ][:20]
        if isinstance(root.get("warnings"), list)
        else [],
    }


def _job_payload(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
    profile = row.get("profile_payload")
    if isinstance(profile, str):
        try:
            profile = json.loads(profile)
        except (TypeError, ValueError):
            profile = None
    return {
        "job_id": str(row["job_id"]),
        "status": str(row["status"]),
        "profile_revision": row.get("profile_revision"),
        "profile": profile if str(row["status"]) in {"ready", "claimed"} else None,
        "encrypted_draft": (
            {
                "ciphertext": row.get("encrypted_draft_ciphertext"),
                "iv": row.get("encrypted_draft_iv"),
                "tag": row.get("encrypted_draft_tag"),
                "algorithm": row.get("encrypted_draft_algorithm"),
                "profile_revision": row.get("encrypted_draft_profile_revision"),
            }
            if row.get("encrypted_draft_ciphertext")
            else None
        ),
        "last_error_code": row.get("last_error_code"),
        "claimed_at": row.get("claimed_at").isoformat() if row.get("claimed_at") else None,
        "claim_decision": row.get("claim_decision"),
        "updated_at": row.get("updated_at").isoformat() if row.get("updated_at") else None,
    }


class PublicProfileDiscoveryService:
    """PostgreSQL is the job authority; HusshOne owns public-source acquisition."""

    def __init__(
        self,
        *,
        identity_service: ActorIdentityService | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._identity_service = identity_service or ActorIdentityService()
        self._transport = transport

    @staticmethod
    def _require_enabled(user_id: str | None = None) -> None:
        enabled = (
            profile_discovery_enabled()
            if user_id is None
            else profile_discovery_user_enabled(user_id)
        )
        if not enabled:
            raise ProfileDiscoveryError(
                "feature_unavailable", "Profile discovery is not available yet.", 404
            )

    async def start(
        self,
        *,
        user_id: str,
        consent: bool,
        consent_version: str,
        name: str | None = None,
        email: str | None = None,
        profile_url: str | None = None,
        employer: str | None = None,
        city: str | None = None,
        external_phone_consent: bool = False,
    ) -> dict[str, Any]:
        self._require_enabled(user_id)
        if consent is not True or consent_version != CONSENT_VERSION:
            raise ProfileDiscoveryError(
                "consent_required", "Public-web discovery requires your explicit consent.", 422
            )
        identity = (await self._identity_service.ensure_many([user_id])).get(user_id) or {}
        if identity.get("phone_verified") is not True:
            raise ProfileDiscoveryError(
                "verified_phone_required",
                "Verify your phone before starting profile discovery.",
                409,
            )
        if external_phone_consent and not _clean_text(identity.get("phone_number"), limit=40):
            raise ProfileDiscoveryError(
                "phone_unavailable",
                "A verified phone number is required for that optional search.",
                422,
            )
        normalized_url = _public_url(profile_url)
        name_hint = _clean_text(name, limit=160) or None
        email_hint = _clean_text(email, limit=254).lower() or None
        if email_hint and not _VALID_EMAIL_RE.fullmatch(email_hint):
            raise ProfileDiscoveryError(
                "invalid_email", "Enter a valid email address for public discovery.", 422
            )
        employer_hint = _clean_text(employer, limit=120) or None
        city_hint = _clean_text(city, limit=120) or None
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                existing = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1 FOR UPDATE",
                    user_id,
                )
                if existing is not None:
                    return _job_payload(existing)

                cached_entity = None
                if normalized_url:
                    cached_entity = await conn.fetchrow(
                        """SELECT entity_id FROM one_public_profile_identity_anchors
                           WHERE anchor_type='profile_url' AND anchor_hash=$1""",
                        _anchor_hash(normalized_url),
                    )
                profile = (
                    await self._load_pool_profile(conn, UUID(str(cached_entity["entity_id"])))
                    if cached_entity
                    else None
                )
                if _assessment_protocol() == "a2a":
                    profile = None  # A reusable URL is evidence, not owner identity authority.
                row = await conn.fetchrow(
                    """INSERT INTO one_profile_discovery_jobs
                       (user_id, entity_id, status, consent_version, consented_at,
                        external_phone_consent, name_hint, email_hint,
                        public_profile_url, employer_hint, city_hint, profile_revision, profile_payload)
                       VALUES ($1,$2,'queued',$3,now(),$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                       ON CONFLICT (user_id) DO NOTHING
                       RETURNING *""",
                    user_id,
                    UUID(str(cached_entity["entity_id"])) if cached_entity else None,
                    consent_version,
                    external_phone_consent,
                    name_hint,
                    email_hint,
                    normalized_url or None,
                    employer_hint,
                    city_hint,
                    profile.get("revision") if profile else None,
                    json.dumps(profile) if profile else None,
                )
                if row is None:
                    raced = await conn.fetchrow(
                        "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1",
                        user_id,
                    )
                    return _job_payload(raced)
                row = await self._transition(
                    conn,
                    row=row,
                    status="ready" if profile else "queued",
                    profile_revision=profile.get("revision") if profile else None,
                    profile_payload=json.dumps(profile) if profile else None,
                    entity_id=UUID(str(cached_entity["entity_id"])) if cached_entity else None,
                    **(
                        {
                            "name_hint": None,
                            "email_hint": None,
                            "public_profile_url": None,
                            "employer_hint": None,
                            "city_hint": None,
                        }
                        if profile
                        else {}
                    ),
                )
                return _job_payload(row)

    async def status(self, *, user_id: str) -> dict[str, Any] | None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1",
                user_id,
            )
        if row is None and not profile_discovery_user_enabled(user_id):
            self._require_enabled(user_id)
        return _job_payload(row) if row else None

    async def submit_anchors(
        self,
        *,
        user_id: str,
        name: str | None,
        email: str | None,
        profile_url: str | None,
        employer: str | None,
        city: str | None,
    ) -> dict[str, Any]:
        self._require_enabled(user_id)
        normalized_url = _public_url(profile_url)
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1 FOR UPDATE",
                    user_id,
                )
                if row is None:
                    raise ProfileDiscoveryError(
                        "job_not_found", "No profile discovery job exists.", 404
                    )
                if row["status"] not in {"needs_details", "failed"}:
                    return _job_payload(row)
                if (
                    int(row["attempt_count"]) >= 3
                    and row.get("last_error_code") == "scan_retry_limit"
                ):
                    raise ProfileDiscoveryError(
                        "scan_retry_limit", "The one-time search retry limit has been reached.", 409
                    )
                name_hint = _clean_text(name, limit=160) or None
                email_hint = _clean_text(email, limit=254).lower() or None
                if email_hint and not _VALID_EMAIL_RE.fullmatch(email_hint):
                    raise ProfileDiscoveryError(
                        "invalid_email", "Enter a valid email address for public discovery.", 422
                    )
                hints = {
                    "public_profile_url": normalized_url or None,
                    "employer_hint": _clean_text(employer, limit=120) or None,
                    "city_hint": _clean_text(city, limit=120) or None,
                    "name_hint": name_hint or row.get("name_hint"),
                    "email_hint": email_hint or row.get("email_hint"),
                    "last_error_code": None,
                    "assessment_request": None,
                    "scan_id": None,
                    "scan_request_key": None,
                    "scan_deadline_at": None,
                    "lease_id": None,
                    "lease_expires_at": None,
                    "next_attempt_at": datetime.now(timezone.utc),
                }
                cached_entity = None
                if normalized_url:
                    cached_entity = await conn.fetchrow(
                        "SELECT entity_id FROM one_public_profile_identity_anchors WHERE anchor_type='profile_url' AND anchor_hash=$1",
                        _anchor_hash(normalized_url),
                    )
                profile = (
                    await self._load_pool_profile(conn, UUID(str(cached_entity["entity_id"])))
                    if cached_entity
                    else None
                )
                if _assessment_protocol() == "a2a":
                    profile = None
                if profile:
                    hints.update(
                        {
                            "name_hint": None,
                            "email_hint": None,
                            "public_profile_url": None,
                            "employer_hint": None,
                            "city_hint": None,
                        }
                    )
                if _assessment_protocol() == "a2a":
                    profile = None
                updated = await self._transition(
                    conn,
                    row=row,
                    status="ready" if profile else "queued",
                    entity_id=UUID(str(cached_entity["entity_id"])) if cached_entity else None,
                    profile_revision=profile.get("revision") if profile else None,
                    profile_payload=json.dumps(profile) if profile else None,
                    **hints,
                )
                return _job_payload(updated)

    async def cancel(self, *, user_id: str) -> dict[str, Any] | None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1 FOR UPDATE",
                    user_id,
                )
                if row is None:
                    return None
                if row["status"] in {"claimed", "cancelled"}:
                    return _job_payload(row)
                updated = await self._transition(
                    conn,
                    row=row,
                    status="cancelled",
                    lease_id=None,
                    lease_expires_at=None,
                    name_hint=None,
                    email_hint=None,
                    public_profile_url=None,
                    employer_hint=None,
                    city_hint=None,
                )
                return _job_payload(updated)

    async def prepare_claim(
        self, *, user_id: str, revision: int, operation_key: UUID, cards: list[dict[str, str]]
    ) -> dict[str, Any]:
        from hushh_mcp.services.profile_claim_receipts import claim_operations, committed_cards

        try:
            operations = claim_operations(user_id, operation_key, cards)
        except ValueError as exc:
            raise ProfileDiscoveryError(
                "invalid_claim_batch", "Invalid claim selection.", 422
            ) from exc
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1 FOR UPDATE", user_id
                )
                if (
                    row is None
                    or row["status"] not in {"ready", "claimed"}
                    or row["profile_revision"] != revision
                ):
                    raise ProfileDiscoveryError(
                        "profile_revision_changed", "Reload this review.", 409
                    )
                batch = row.get("claim_batch")
                if isinstance(batch, str):
                    batch = json.loads(batch)
                if batch and (batch != operations or row["claim_batch_key"] != operation_key):
                    raise ProfileDiscoveryError(
                        "claim_batch_frozen",
                        "Finish the pending selection before changing it.",
                        409,
                    )
                if not batch:
                    if row["status"] == "claimed":
                        raise ProfileDiscoveryError(
                            "already_claimed", "This review is complete.", 409
                        )
                    await conn.execute(
                        "UPDATE one_profile_discovery_jobs SET claim_batch=$2,claim_batch_key=$3 WHERE user_id=$1",
                        user_id,
                        json.dumps(operations),
                        operation_key,
                    )
                return {"committed_card_ids": await committed_cards(conn, user_id, operations)}

    async def complete_claim(
        self,
        *,
        user_id: str,
        revision: int,
        idempotency_key: UUID,
        reject_all: bool,
        accepted_count: int,
    ) -> dict[str, Any]:
        if reject_all is not True and accepted_count < 1:
            raise ProfileDiscoveryError(
                "accepted_facts_required", "Select at least one fact or reject the profile.", 422
            )
        if reject_all and accepted_count != 0:
            raise ProfileDiscoveryError(
                "invalid_reject_all", "Reject-all cannot include accepted facts.", 422
            )
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE user_id=$1 FOR UPDATE",
                    user_id,
                )
                if row is None:
                    raise ProfileDiscoveryError(
                        "job_not_found", "No profile discovery job exists.", 404
                    )
                if row["status"] == "claimed":
                    if row["claim_idempotency_key"] == idempotency_key:
                        return _job_payload(row)
                    raise ProfileDiscoveryError(
                        "already_claimed", "This profile handoff is already complete.", 409
                    )
                if row["status"] != "ready" or row["profile_revision"] != revision:
                    raise ProfileDiscoveryError(
                        "profile_revision_changed",
                        "The reviewed profile changed. Reload it before claiming.",
                        409,
                    )
                from hushh_mcp.services.profile_claim_receipts import committed_cards

                batch = row.get("claim_batch") or []
                if isinstance(batch, str):
                    batch = json.loads(batch)
                committed = await committed_cards(conn, user_id, batch) if batch else []
                if reject_all and committed:
                    raise ProfileDiscoveryError(
                        "claim_in_progress",
                        "Some details are already saved. Finish this claim.",
                        409,
                    )
                if not reject_all and (
                    not batch
                    or row.get("claim_batch_key") != idempotency_key
                    or len(batch) != accepted_count
                    or len(committed) != len(batch)
                ):
                    raise ProfileDiscoveryError(
                        "claim_writes_pending",
                        "The selected PKM writes are not all committed yet.",
                        409,
                    )
                decision = "rejected_all" if reject_all else "accepted"
                updated = await self._transition(
                    conn,
                    row=row,
                    status="claimed",
                    claim_decision=decision,
                    claim_idempotency_key=idempotency_key,
                    claimed_at=datetime.now(timezone.utc),
                    last_error_code=None,
                )
                return _job_payload(updated)

    async def save_encrypted_draft(
        self,
        *,
        user_id: str,
        revision: int,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
    ) -> dict[str, Any]:
        if algorithm != "aes-256-gcm" or len(ciphertext) > 262144:
            raise ProfileDiscoveryError(
                "invalid_encrypted_draft", "The encrypted draft is invalid.", 422
            )
        try:
            decoded_iv = base64.b64decode(iv, validate=True)
            decoded_tag = base64.b64decode(tag, validate=True)
            base64.b64decode(ciphertext, validate=True)
        except Exception:
            raise ProfileDiscoveryError(
                "invalid_encrypted_draft", "The encrypted draft is invalid.", 422
            ) from None
        if len(decoded_iv) != 12 or len(decoded_tag) != 16:
            raise ProfileDiscoveryError(
                "invalid_encrypted_draft", "The encrypted draft is invalid.", 422
            )
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """UPDATE one_profile_discovery_jobs
                   SET encrypted_draft_ciphertext=$3, encrypted_draft_iv=$4,
                       encrypted_draft_tag=$5, encrypted_draft_algorithm=$6,
                       encrypted_draft_profile_revision=$2, updated_at=now()
                   WHERE user_id=$1 AND status='ready' AND profile_revision=$2 AND claim_batch IS NULL
                   RETURNING *""",
                user_id,
                revision,
                ciphertext,
                iv,
                tag,
                algorithm,
            )
        if row is None:
            raise ProfileDiscoveryError(
                "profile_revision_changed",
                "The reviewed profile changed. Reload it before saving your draft.",
                409,
            )
        return _job_payload(row)

    async def drain(self, *, max_jobs: int = 4) -> dict[str, int]:
        if not 1 <= max_jobs <= 20:
            raise ValueError("max_jobs must be between 1 and 20")
        if not profile_discovery_enabled():
            return {"disabled": 1}
        await self._expire_deadlines()
        claimed = await self._claim_due(max_jobs=max_jobs)
        outcomes: dict[str, int] = {}
        settled = await asyncio.gather(*(self._process(job) for job in claimed))
        for outcome in settled:
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
        return outcomes

    async def drain_feed_outbox(self, *, max_rows: int = 50) -> int:
        if not 1 <= max_rows <= 100:
            raise ValueError("max_rows must be between 1 and 100")
        pool = await get_pool()
        delivered = 0
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(
                    """SELECT outbox_id, job_id, user_id, revision, status
                       FROM one_profile_discovery_feed_outbox
                       WHERE settled_at IS NULL AND available_at <= now()
                         AND (lease_expires_at IS NULL OR lease_expires_at < now())
                       ORDER BY outbox_id
                       FOR UPDATE SKIP LOCKED LIMIT $1""",
                    max_rows,
                )
                for row in rows:
                    source_row_id = str(row["job_id"])
                    event_type = f"profile_discovery_{row['status']}"
                    await conn.execute(
                        """INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
                           VALUES ($1, 'profile_discovery', $2, $3::jsonb, $4)
                           ON CONFLICT (user_id, source_row_id) WHERE source_domain='profile_discovery'
                           DO UPDATE SET event_type=EXCLUDED.event_type,metadata=EXCLUDED.metadata,
                             read_at=NULL,created_at=now()
                           WHERE coalesce((feed_events.metadata->>'progress_revision')::integer,0)
                             < (EXCLUDED.metadata->>'progress_revision')::integer""",
                        row["user_id"],
                        event_type,
                        json.dumps(
                            {
                                "user_facing_status": row["status"],
                                "progress_revision": row["revision"],
                            }
                        ),
                        source_row_id,
                    )
                    await conn.execute(
                        "UPDATE one_profile_discovery_feed_outbox SET settled_at=now(), lease_id=NULL, lease_expires_at=NULL WHERE outbox_id=$1",
                        row["outbox_id"],
                    )
                    delivered += 1
        return delivered

    async def _claim_due(self, *, max_jobs: int) -> list[asyncpg.Record]:
        pool = await get_pool()
        lease_id = uuid4()
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(
                    """WITH due AS (
                         SELECT job_id FROM one_profile_discovery_jobs
                         WHERE status IN ('queued','scanning','failed')
                           AND (status <> 'failed' OR last_error_code='daily_budget_exhausted')
                           AND next_attempt_at <= now()
                           AND (lease_expires_at IS NULL OR lease_expires_at < now())
                           AND (scan_deadline_at IS NULL OR scan_deadline_at > now())
                           AND (scan_id IS NOT NULL OR attempt_count < 3)
                         ORDER BY next_attempt_at, created_at, job_id
                         FOR UPDATE SKIP LOCKED LIMIT $1
                       )
                       UPDATE one_profile_discovery_jobs job
                       SET lease_id=$2, lease_expires_at=now()+interval '90 seconds', updated_at=now()
                       FROM due WHERE job.job_id=due.job_id
                       RETURNING job.*""",
                    max_jobs,
                    lease_id,
                )
        return list(rows)

    async def _expire_deadlines(self) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(
                    """SELECT * FROM one_profile_discovery_jobs
                       WHERE status='scanning' AND scan_deadline_at <= now()
                         AND (lease_expires_at IS NULL OR lease_expires_at < now())
                       FOR UPDATE SKIP LOCKED"""
                )
                for row in rows:
                    await self._transition(
                        conn,
                        row=row,
                        status="failed",
                        scan_id=None,
                        scan_request_key=None,
                        scan_deadline_at=None,
                        last_error_code="scan_timeout",
                        lease_id=None,
                        lease_expires_at=None,
                        next_attempt_at=datetime.now(timezone.utc),
                    )

    async def _process(self, job: asyncpg.Record) -> str:
        job_id = UUID(str(job["job_id"]))
        lease_id = UUID(str(job["lease_id"]))
        try:
            # Keep the identity lookup explicit; no phone value is persisted in the job.
            identities = await self._identity_service.ensure_many([str(job["user_id"])])
            identity = identities.get(str(job["user_id"])) or {}
            if identity.get("phone_verified") is not True:
                await self._set_state(
                    job_id, lease_id, "needs_details", error="verified_phone_required"
                )
                return "needs_details"
            name = _clean_text(job.get("name_hint"), limit=160) or _clean_text(
                identity.get("display_name"), limit=160
            )
            email = (
                _clean_text(job.get("email_hint"), limit=254).lower()
                or _clean_text(identity.get("email"), limit=254).lower()
            )
            if not name or not email:
                await self._set_state(
                    job_id, lease_id, "needs_details", error="identity_details_required"
                )
                return "needs_details"

            scan_id = _clean_text(job.get("scan_id"), limit=100)
            base_url = _clean_text(os.getenv("INTELLIGENCE_API_BASE_URL"), limit=500).rstrip("/")
            api_key = _clean_text(os.getenv("INTELLIGENCE_API_KEY"), limit=2048)
            if not base_url or not api_key:
                await self._set_state(job_id, lease_id, "failed", error="scan_service_unavailable")
                return "failed"
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            async with httpx.AsyncClient(timeout=40.0, transport=self._transport) as client:
                if _assessment_protocol() == "a2a":
                    return await self._process_assessment(
                        job, lease_id, client, base_url, api_key, identity, name, email
                    )
                if not scan_id:
                    request_key, reserve_error = await self._reserve_scan_request(job_id, lease_id)
                    if request_key is None:
                        next_attempt_at = None
                        if reserve_error == "daily_budget_exhausted":
                            now = datetime.now(timezone.utc)
                            next_attempt_at = now.replace(
                                hour=0, minute=0, second=0, microsecond=0
                            ) + timedelta(days=1)
                        await self._set_state(
                            job_id,
                            lease_id,
                            "failed",
                            error=reserve_error or "scan_retry_limit",
                            next_attempt_at=next_attempt_at,
                        )
                        return "failed"
                    body: dict[str, Any] = {
                        "name": name,
                        "email": email,
                        "purpose": "self_audit",
                        "consentAttestation": True,
                        "consentVersion": _clean_text(job.get("consent_version"), limit=80),
                        "socialPreferenceConsent": False,
                        "employer": job.get("employer_hint"),
                        "city": job.get("city_hint"),
                    }
                    profile_url = _clean_text(job.get("public_profile_url"), limit=500)
                    if profile_url:
                        body["confirmedProfiles"] = [
                            {
                                "platform": "Public profile",
                                "url": profile_url,
                                "category": "Professional",
                            }
                        ]
                    if job["external_phone_consent"]:
                        body["phone"] = _clean_text(identity.get("phone_number"), limit=40)
                    response = await client.post(
                        f"{base_url}/api/v1/scan",
                        headers={**headers, "Idempotency-Key": str(request_key)},
                        json=body,
                    )
                    if response.status_code not in {200, 202}:
                        if response.status_code < 500 and response.status_code != 429:
                            await self._set_state(
                                job_id,
                                lease_id,
                                "failed",
                                error="scan_start_failed",
                                scan_request_key=None,
                            )
                        else:
                            await self._schedule_start_retry(
                                job_id, lease_id, error="scan_start_unavailable"
                            )
                        return "failed"
                    payload = response.json()
                    scan_id = _clean_text(payload.get("scanId"), limit=100)
                    if not scan_id:
                        await self._schedule_start_retry(
                            job_id, lease_id, error="scan_start_unavailable"
                        )
                        return "failed"
                    await self._set_scan_id(job_id, lease_id, scan_id)
                    return "started"

                response = await client.get(f"{base_url}/api/v1/scan/{scan_id}", headers=headers)
                await self._record_daily_usage("scan_poll_requests")
                if response.status_code >= 500 or response.status_code == 429:
                    await self._schedule_poll(job_id, lease_id, error="scan_poll_unavailable")
                    return "retrying"
                if response.status_code != 200:
                    await self._set_state(
                        job_id,
                        lease_id,
                        "failed",
                        error="scan_poll_failed",
                        scan_id=None,
                        scan_request_key=None,
                        scan_deadline_at=None,
                    )
                    return "failed"
                payload = response.json()
                scan_status = str(payload.get("status") or "").lower()
                if scan_status in {"running", "queued", "pending"}:
                    await self._schedule_poll(job_id, lease_id)
                    return "running"
                if scan_status != "completed" or not isinstance(payload.get("result"), dict):
                    await self._set_state(
                        job_id,
                        lease_id,
                        "failed",
                        error="scan_failed",
                        scan_id=None,
                        scan_request_key=None,
                        scan_deadline_at=None,
                    )
                    return "failed"
                await self._save_public_profile(job, lease_id, payload["result"], name=name)
                return "ready"
        except (httpx.TimeoutException, httpx.NetworkError):
            if not _clean_text(job.get("scan_id"), limit=100):
                await self._schedule_start_retry(job_id, lease_id, error="scan_transport_error")
            else:
                await self._schedule_poll(job_id, lease_id, error="scan_transport_error")
            return "retrying"
        except Exception:  # noqa: BLE001
            logger.warning("profile_discovery.worker_error", exc_info=True)
            await self._set_state(job_id, lease_id, "failed", error="worker_error")
            return "failed"

    async def _process_assessment(
        self, job, lease_id, client, base_url, api_key, identity, name, email
    ):
        from hushh_mcp.services.public_profile_assessment_client import (
            PublicAssessmentClient,
            validate_prepared_profile,
        )

        adapter = PublicAssessmentClient(client, base_url, api_key)
        job_id = UUID(str(job["job_id"]))
        deadline = job.get("scan_deadline_at")
        if deadline and deadline < datetime.now(timezone.utc):
            await self._set_state(job_id, lease_id, "failed", error="scan_timeout")
            return "failed"
        try:
            if not job.get("scan_id"):
                key, error = await self._reserve_scan_request(job_id, lease_id)
                if key is None:
                    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).replace(
                        hour=0, minute=0, second=0, microsecond=0
                    )
                    await self._set_state(
                        job_id,
                        lease_id,
                        "failed",
                        error=error,
                        next_attempt_at=tomorrow if error == "daily_budget_exhausted" else None,
                    )
                    return "failed"
                candidates = await self._assessment_candidates(job, name)
                payload = {
                    "operationId": str(key),
                    "name": name,
                    "email": email,
                    "consentVersion": job["consent_version"],
                    "externalPhoneConsent": job["external_phone_consent"],
                    "candidates": candidates,
                }
                for source, target in (
                    ("public_profile_url", "profileUrl"),
                    ("employer_hint", "employer"),
                    ("city_hint", "city"),
                ):
                    if job.get(source):
                        payload[target] = job[source]
                if job["external_phone_consent"]:
                    payload["phone"] = identity["phone_number"]
                pool = await get_pool()
                async with pool.acquire() as conn:
                    saved = await conn.fetchval(
                        "UPDATE one_profile_discovery_jobs SET assessment_request=coalesce(assessment_request,$3::jsonb) WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() RETURNING assessment_request",
                        job_id,
                        lease_id,
                        json.dumps(payload),
                    )
                if saved is None:
                    return "lease_lost"
                payload = json.loads(saved) if isinstance(saved, str) else saved
                task = await adapter.submit(payload)
                await self._set_scan_id(job_id, lease_id, task["id"])
                return "started"
            task = await adapter.get(job["scan_id"])
            state = task.get("status", {}).get("state")
            if state in {"submitted", "working"}:
                await self._schedule_poll(job_id, lease_id)
                return "running"
            if state != "completed":
                await self._set_state(
                    job_id, lease_id, "needs_details", error="assessment_incomplete"
                )
                return "needs_details"
            profile = validate_prepared_profile(task["artifacts"][0]["parts"][0]["data"])
            if profile["identity"]["verdict"] != "matched":
                await self._set_state(job_id, lease_id, "needs_details", error="identity_ambiguous")
                return "needs_details"
            await self._save_public_profile(job, lease_id, {"preparedProfile": profile}, name=name)
            return "ready"
        except (KeyError, ValueError):
            await self._set_state(job_id, lease_id, "failed", error="assessment_contract_invalid")
            return "failed"

    async def _assessment_candidates(self, job, name):
        from hushh_mcp.services.public_profile_retrieval import (
            FIXTURE_EMBEDDING_MODEL,
            fixture_embedding,
            retrieve_candidates,
        )

        pool = await get_pool()
        async with pool.acquire() as conn:
            vector_enabled = (
                os.getenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE") == "true"
                and os.getenv("ONE_PUBLIC_PROFILE_VECTOR_ENABLED") == "true"
            )
            if vector_enabled and not str(
                await conn.fetchval("SELECT current_database()")
            ).startswith("hushh_profile_fixture_"):
                raise ValueError("Fixture vectors require isolated storage")
            return await retrieve_candidates(
                conn,
                name=name,
                profile_url=job.get("public_profile_url"),
                embedding=fixture_embedding(name) if vector_enabled else None,
                embedding_model=FIXTURE_EMBEDDING_MODEL if vector_enabled else None,
            )

    async def _set_scan_id(self, job_id: UUID, lease_id: UUID, scan_id: str) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() FOR UPDATE",
                    job_id,
                    lease_id,
                )
                if row is None or row["status"] in {"claimed", "cancelled"}:
                    return
                await self._transition(
                    conn,
                    row=row,
                    status="scanning",
                    scan_id=scan_id,
                    scan_request_key=row["scan_request_key"],
                    scan_deadline_at=datetime.now(timezone.utc)
                    + timedelta(seconds=SCAN_TIMEOUT_SECONDS),
                    next_attempt_at=datetime.now(timezone.utc),
                    lease_id=None,
                    lease_expires_at=None,
                    last_error_code=None,
                )

    async def _reserve_scan_request(
        self, job_id: UUID, lease_id: UUID
    ) -> tuple[UUID | None, str | None]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() FOR UPDATE",
                    job_id,
                    lease_id,
                )
                if row is None:
                    return None, "scan_retry_limit"
                if row["scan_request_key"]:
                    return UUID(str(row["scan_request_key"])), None
                attempt = int(row["attempt_count"]) + 1
                if attempt > 3:
                    return None, "scan_retry_limit"
                limit = _daily_scan_start_limit()
                usage = await conn.fetchrow(
                    "INSERT INTO one_profile_discovery_daily_usage(usage_date) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(usage_date) DO UPDATE SET updated_at=now() RETURNING scan_start_requests"
                )
                if limit == 0 or int(usage["scan_start_requests"]) >= limit:
                    return None, "daily_budget_exhausted"
                await conn.execute(
                    "UPDATE one_profile_discovery_daily_usage SET scan_start_requests=scan_start_requests+1,updated_at=now() WHERE usage_date=(now() AT TIME ZONE 'UTC')::date"
                )
                request_key = uuid5(job_id, f"public-profile-discovery-scan-v1:{attempt}")
                await conn.execute(
                    "UPDATE one_profile_discovery_jobs SET attempt_count=$3,scan_request_key=$4,updated_at=now() WHERE job_id=$1 AND lease_id=$2",
                    job_id,
                    lease_id,
                    attempt,
                    request_key,
                )
                return request_key, None

    async def _record_daily_usage(self, column: str) -> None:
        if column != "scan_poll_requests":
            raise ValueError("invalid public discovery usage counter")
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO one_profile_discovery_daily_usage(usage_date,scan_poll_requests) VALUES((now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(usage_date) DO UPDATE SET scan_poll_requests=one_profile_discovery_daily_usage.scan_poll_requests+1,updated_at=now()"
            )

    async def _schedule_start_retry(self, job_id: UUID, lease_id: UUID, *, error: str) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE one_profile_discovery_jobs
                   SET next_attempt_at=now()+($3 * interval '1 second'),
                       lease_id=NULL, lease_expires_at=NULL,
                       last_error_code=$4, updated_at=now()
                   WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() AND status IN ('queued','failed')""",
                job_id,
                lease_id,
                POLL_INTERVAL_SECONDS,
                error,
            )

    async def _schedule_poll(
        self, job_id: UUID, lease_id: UUID, *, error: str | None = None
    ) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE one_profile_discovery_jobs
                   SET next_attempt_at=now()+($3 * interval '1 second'),
                       lease_id=NULL, lease_expires_at=NULL,
                       last_error_code=$4, updated_at=now()
                   WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() AND status='scanning'""",
                job_id,
                lease_id,
                POLL_INTERVAL_SECONDS,
                error,
            )

    async def _set_state(
        self,
        job_id: UUID,
        lease_id: UUID,
        status: str,
        *,
        error: str | None = None,
        attempt: bool = False,
        next_attempt_at: datetime | None = None,
        **transition_fields: Any,
    ) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() FOR UPDATE",
                    job_id,
                    lease_id,
                )
                if row is None or row["status"] in {"claimed", "cancelled"}:
                    return
                fields: dict[str, Any] = {
                    "last_error_code": error,
                    "attempt_count": min(3, int(row["attempt_count"]) + (1 if attempt else 0)),
                    "lease_id": None,
                    "lease_expires_at": None,
                    "next_attempt_at": next_attempt_at or datetime.now(timezone.utc),
                }
                fields.update(transition_fields)
                if status == "failed" and error == "scan_retry_limit":
                    fields.update(
                        {
                            "name_hint": None,
                            "email_hint": None,
                            "public_profile_url": None,
                            "employer_hint": None,
                            "city_hint": None,
                        }
                    )
                await self._transition(
                    conn,
                    row=row,
                    status=status,
                    **fields,
                )

    async def _save_prepared_profile(self, job, lease_id, profile):
        from hushh_mcp.services.public_profile_projection import bind_anchor, store_prepared

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() FOR UPDATE",
                    job["job_id"],
                    lease_id,
                )
                if row is None or row["status"] in {"claimed", "cancelled"}:
                    return
                request = row.get("assessment_request") or {}
                if isinstance(request, str):
                    request = json.loads(request)
                candidates = request.get("candidates", [])
                candidate_entity_ids = [UUID(candidate["entity_id"]) for candidate in candidates]
                entity_id = await store_prepared(
                    conn, profile, candidate_entity_ids=candidate_entity_ids
                )
                if (
                    os.getenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE") == "true"
                    and os.getenv("ONE_PUBLIC_PROFILE_VECTOR_ENABLED") == "true"
                ):
                    from hushh_mcp.services.public_profile_retrieval import (
                        refresh_fixture_embedding,
                    )

                    if not str(await conn.fetchval("SELECT current_database()")).startswith(
                        "hushh_profile_fixture_"
                    ):
                        raise ValueError("Fixture embeddings require isolated storage")
                    await refresh_fixture_embedding(conn, profile)
                if job.get("public_profile_url"):
                    await bind_anchor(conn, entity_id, job["public_profile_url"])
                await self._transition(
                    conn,
                    row=row,
                    status="ready",
                    entity_id=entity_id,
                    profile_revision=profile["revision"],
                    profile_payload=json.dumps(profile),
                    name_hint=None,
                    email_hint=None,
                    public_profile_url=None,
                    employer_hint=None,
                    city_hint=None,
                    assessment_request=None,
                    lease_id=None,
                    lease_expires_at=None,
                    last_error_code=None,
                )

    async def _save_public_profile(
        self, job: asyncpg.Record, lease_id: UUID, result: dict[str, Any], *, name: str
    ) -> None:
        if "preparedProfile" in result:
            await self._save_prepared_profile(job, lease_id, result["preparedProfile"])
            return
        job_id = UUID(str(job["job_id"]))
        profile_url = _clean_text(job.get("public_profile_url"), limit=500)
        collected_at = datetime.now(timezone.utc).isoformat()
        if "preparedProfile" in result:
            from hushh_mcp.services.public_profile_assessment_client import (
                validate_prepared_profile,
            )

            profile = validate_prepared_profile(result["preparedProfile"])
        else:
            profile = _profile_from_scan(result, display_name=name, collected_at=collected_at)
        if not profile["facts"]:
            await self._set_state(
                job_id,
                lease_id,
                "needs_details",
                error="no_reviewable_findings",
                scan_id=None,
                scan_request_key=None,
                scan_deadline_at=None,
                name_hint=None,
                email_hint=None,
                public_profile_url=None,
                employer_hint=None,
                city_hint=None,
            )
            return
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                current = await conn.fetchrow(
                    "SELECT * FROM one_profile_discovery_jobs WHERE job_id=$1 AND lease_id=$2 AND lease_expires_at>now() FOR UPDATE",
                    job_id,
                    lease_id,
                )
                if current is None or current["status"] in {"claimed", "cancelled"}:
                    return
                entity_id: UUID | None = None
                revision = 1
                if profile_url:
                    anchor = await conn.fetchrow(
                        "SELECT entity_id FROM one_public_profile_identity_anchors WHERE anchor_type='profile_url' AND anchor_hash=$1 FOR UPDATE",
                        _anchor_hash(profile_url),
                    )
                    if anchor:
                        entity_id = UUID(str(anchor["entity_id"]))
                        entity = await conn.fetchrow(
                            "UPDATE one_public_profile_entities SET revision=revision+1,display_name=$2,employer_hint=NULL,city_hint=NULL,updated_at=now() WHERE entity_id=$1 RETURNING revision",
                            entity_id,
                            profile["display_name"],
                        )
                        revision = int(entity["revision"])
                    else:
                        entity_id = await conn.fetchval(
                            "INSERT INTO one_public_profile_entities(display_name,employer_hint,city_hint) VALUES($1,NULL,NULL) RETURNING entity_id",
                            profile["display_name"],
                        )
                        try:
                            await conn.execute(
                                "INSERT INTO one_public_profile_identity_anchors(entity_id,anchor_type,anchor_hash,canonical_url) VALUES($1,'profile_url',$2,$3)",
                                entity_id,
                                _anchor_hash(profile_url),
                                profile_url,
                            )
                        except asyncpg.UniqueViolationError:
                            winner = await conn.fetchval(
                                "SELECT entity_id FROM one_public_profile_identity_anchors WHERE anchor_type='profile_url' AND anchor_hash=$1",
                                _anchor_hash(profile_url),
                            )
                            await conn.execute(
                                "DELETE FROM one_public_profile_entities WHERE entity_id=$1",
                                entity_id,
                            )
                            entity_id = UUID(str(winner)) if winner else None
                            if entity_id:
                                entity = await conn.fetchrow(
                                    "UPDATE one_public_profile_entities SET revision=revision+1,display_name=$2,employer_hint=NULL,city_hint=NULL,updated_at=now() WHERE entity_id=$1 RETURNING revision",
                                    entity_id,
                                    profile["display_name"],
                                )
                                revision = int(entity["revision"])
                if entity_id is None:
                    entity_id = await conn.fetchval(
                        "INSERT INTO one_public_profile_entities(display_name,employer_hint,city_hint) VALUES($1,NULL,NULL) RETURNING entity_id",
                        profile["display_name"],
                    )
                profile["revision"] = revision
                if "preparedProfile" in result:
                    await conn.execute(
                        "UPDATE one_public_profile_entities SET prepared_payload=$2 WHERE entity_id=$1",
                        entity_id,
                        json.dumps(result["preparedProfile"]),
                    )
                for source_url in profile["sources"]:
                    domain = urlsplit(source_url).hostname or "unknown"
                    await conn.execute(
                        """INSERT INTO one_public_profile_sources(entity_id,source_url,source_domain,source_fingerprint,acquired_at)
                           VALUES($1,$2,$3,$4,now()) ON CONFLICT(entity_id,source_url)
                           DO UPDATE SET source_fingerprint=EXCLUDED.source_fingerprint, acquired_at=EXCLUDED.acquired_at""",
                        entity_id,
                        source_url,
                        domain[:255],
                        hashlib.sha256(source_url.encode()).hexdigest(),
                    )
                for fact in profile["facts"]:
                    await conn.execute(
                        """INSERT INTO one_public_profile_findings
                           (entity_id,revision,category,claim,confidence,support,source_urls,observed_at,model_name,model_version)
                           VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'husshone',$8)
                           ON CONFLICT(entity_id,revision,claim) DO NOTHING""",
                        entity_id,
                        revision,
                        fact["category"],
                        fact["claim"],
                        fact["confidence"],
                        fact["support"],
                        fact["source_urls"],
                        _clean_text(result.get("intelligenceVersion"), limit=80) or None,
                    )
                await self._transition(
                    conn,
                    row=current,
                    status="ready",
                    entity_id=entity_id,
                    profile_revision=revision,
                    profile_payload=json.dumps(profile),
                    last_error_code=None,
                    lease_id=None,
                    lease_expires_at=None,
                    scan_deadline_at=None,
                    name_hint=None,
                    email_hint=None,
                    public_profile_url=None,
                    employer_hint=None,
                    city_hint=None,
                )

    async def _load_pool_profile(
        self, conn: asyncpg.Connection, entity_id: UUID
    ) -> dict[str, Any] | None:
        entity = await conn.fetchrow(
            "SELECT entity_id,display_name,revision FROM one_public_profile_entities WHERE entity_id=$1 AND status='active'",
            entity_id,
        )
        if not entity:
            return None
        rows = await conn.fetch(
            """SELECT category,claim,confidence,support,source_urls,observed_at,created_at
               FROM one_public_profile_findings WHERE entity_id=$1 AND revision=$2
               ORDER BY created_at LIMIT $3""",
            entity_id,
            entity["revision"],
            MAX_FINDINGS,
        )
        if not rows:
            return None
        facts = [
            {
                "category": row["category"],
                "claim": row["claim"],
                "confidence": row["confidence"],
                "support": row["support"],
                "source_urls": list(row["source_urls"] or []),
                "observed_at": row["observed_at"].isoformat() if row["observed_at"] else None,
                "collected_at": row["created_at"].isoformat(),
            }
            for row in rows
        ]
        return {
            "schema_version": "public_profile_review.v1",
            "display_name": entity["display_name"],
            "summary": "",
            "collected_at": max(fact["collected_at"] for fact in facts),
            "revision": int(entity["revision"]),
            "facts": facts,
            "sources": list(dict.fromkeys(url for fact in facts for url in fact["source_urls"])),
            "conflicts": [],
            "warnings": [],
        }

    async def _transition(
        self,
        conn: asyncpg.Connection,
        *,
        row: asyncpg.Record,
        status: str,
        **fields: Any,
    ) -> asyncpg.Record:
        if status not in _PUBLIC_STATUSES:
            raise ValueError("invalid profile discovery status")
        if status in {"ready", "claimed", "cancelled", "needs_details"}:
            fields["assessment_request"] = None
        assignments = ["status=$2", "event_revision=event_revision+1", "updated_at=now()"]
        values: list[Any] = [row["job_id"], status]
        allowed = {
            "entity_id",
            "profile_revision",
            "profile_payload",
            "assessment_request",
            "claim_decision",
            "claim_idempotency_key",
            "claimed_at",
            "last_error_code",
            "scan_id",
            "scan_request_key",
            "scan_deadline_at",
            "next_attempt_at",
            "lease_id",
            "lease_expires_at",
            "attempt_count",
            "public_profile_url",
            "employer_hint",
            "city_hint",
            "name_hint",
            "email_hint",
        }
        for key, value in fields.items():
            if key not in allowed:
                raise ValueError(f"invalid profile discovery field: {key}")
            values.append(value)
            assignments.append(f"{key}=${len(values)}")
        # Column names pass the fixed allowlist above; all values are bound.
        updated = await conn.fetchrow(
            f"UPDATE one_profile_discovery_jobs SET {', '.join(assignments)} WHERE job_id=$1 RETURNING *",  # nosec B608
            *values,
        )
        revision = int(updated["event_revision"])
        await conn.execute(
            "INSERT INTO one_profile_discovery_events(job_id,user_id,revision,status) VALUES($1,$2,$3,$4)",
            updated["job_id"],
            updated["user_id"],
            revision,
            status,
        )
        await conn.execute(
            "INSERT INTO one_profile_discovery_feed_outbox(job_id,user_id,revision,status) VALUES($1,$2,$3,$4) ON CONFLICT(job_id,revision) DO NOTHING",
            updated["job_id"],
            updated["user_id"],
            revision,
            status,
        )
        return updated
