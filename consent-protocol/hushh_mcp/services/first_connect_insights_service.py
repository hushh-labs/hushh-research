"""The "Here's what I picked up" card after a person's first connection.

After someone connects Gmail, Calendar or Drive, One offers a short card of
things it noticed there. Each item has Keep and Forget. Nothing is saved here:
the items go back to the person's screen, and Keep saves one through the
client's encrypted PKM writer with the person's own confirmation.

Boundaries this module holds:

* **Authority.** The caller is the vault owner holding their chat key, the same
  gate a chat turn passes. The first-party owner token is revalidated before
  and after every provider read and before the result is released, so a
  revoked session cannot receive an answer prepared under it.
* **Data use.** Only the source just connected is read, only through its
  existing metadata reader, and only metadata (senders, subjects and dates;
  event titles, times and attendee counts; file names, types and dates).
* **Meaning.** The manifest-owned gene ``one_first_connect_insights`` decides
  what was picked up. The validator here only rejects output that breaks the
  contract (unknown kind, missing or over-long text); it never rewrites a field.
* **Once per source.** ``one_attention_ledger`` records that the card was
  offered, with no content. A source is offered only within a week of its
  first connection, so people who connected long before this shipped are not
  surprised by it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Protocol

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

logger = logging.getLogger(__name__)

Source = Literal["gmail", "calendar", "drive"]
SOURCES: tuple[Source, ...] = ("gmail", "calendar", "drive")
SOURCE_LABELS: dict[str, str] = {"gmail": "Gmail", "calendar": "Calendar", "drive": "Drive"}
LEDGER_KIND = "first_connect_insights"
GENE_ID = "one_first_connect_insights"
INSIGHT_KINDS = frozenset(
    {
        "recurring_meeting",
        "newsletter_heavy",
        "subscription_or_bill",
        "frequent_contact",
        "work_hours",
        "working_pattern",
    }
)
MAX_ITEMS = 5
MAX_LABEL_CHARS = 200
MAX_MEMORY_CHARS = 240
MAX_EVIDENCE_CHARS = 160
GENE_TIMEOUT_SECONDS = 25.0

FIRST_CONNECT_INSIGHTS_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "items": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "kind": {"type": "STRING", "enum": sorted(INSIGHT_KINDS)},
                    "label": {"type": "STRING"},
                    "memory_text": {"type": "STRING"},
                    "evidence": {"type": "STRING"},
                },
                "required": ["kind", "label", "memory_text", "evidence"],
            },
        }
    },
    "required": ["items"],
}

RequireAccess = Callable[[], Awaitable[None]]
Collector = Callable[[str, str, RequireAccess], Awaitable[dict[str, Any]]]
GeneRunner = Callable[..., Awaitable[dict[str, Any]]]
OwnerCheck = Callable[[str, str], Awaitable[object]]


class FirstConnectLedger(Protocol):
    async def eligible_sources(self, user_id: str) -> list[str]: ...

    async def claim(self, user_id: str, source: str) -> bool: ...

    async def settle(self, user_id: str, source: str, outcome: str) -> None: ...


class SourceUnreadable(Exception):
    """The source cannot be read for this card (scope, profile or connection)."""


# A source is eligible within a week of its FIRST connection and until the card
# was offered (or found nothing). A failed model call may be retried after an
# hour; a claim abandoned mid-flight is reclaimable after five minutes.
_ELIGIBLE_SQL = """
WITH connected AS (
  SELECT 'gmail'::TEXT AS source, connected_at AS first_connected_at
  FROM kai_gmail_connections
  WHERE user_id = $1 AND status = 'connected' AND revoked IS NOT TRUE
  UNION ALL
  SELECT 'calendar'::TEXT, created_at
  FROM google_service_grants
  WHERE user_id = $1 AND provider = 'google' AND service = 'calendar'
    AND status = 'connected'
  UNION ALL
  SELECT 'drive'::TEXT, connected_at
  FROM user_external_connector_connections
  WHERE user_id = $1 AND connector_id = 'google_drive' AND status = 'connected'
)
SELECT c.source
FROM connected AS c
WHERE c.first_connected_at > NOW() - INTERVAL '7 days'
  AND NOT EXISTS (
    SELECT 1 FROM one_attention_ledger AS l
    WHERE l.user_id = $1 AND l.kind = 'first_connect_insights' AND l.subject_ref = c.source
      AND (
        l.outcome IN ('offered', 'empty')
        OR (l.outcome = 'failed' AND l.updated_at > NOW() - INTERVAL '1 hour')
        OR (l.outcome = 'pending' AND l.updated_at > NOW() - INTERVAL '5 minutes')
      )
  )
ORDER BY c.first_connected_at ASC
"""

_CLAIM_SQL = """
INSERT INTO one_attention_ledger (user_id, kind, subject_ref, outcome)
SELECT $1, 'first_connect_insights', $2, 'pending'
WHERE EXISTS (SELECT 1 FROM actor_profiles WHERE user_id = $1)
ON CONFLICT (user_id, kind, subject_ref) DO UPDATE
  SET outcome = 'pending', updated_at = NOW()
  WHERE (one_attention_ledger.outcome = 'failed'
         AND one_attention_ledger.updated_at <= NOW() - INTERVAL '1 hour')
     OR (one_attention_ledger.outcome = 'pending'
         AND one_attention_ledger.updated_at <= NOW() - INTERVAL '5 minutes')
RETURNING subject_ref
"""

_SETTLE_SQL = """
UPDATE one_attention_ledger
SET outcome = $3, updated_at = NOW()
WHERE user_id = $1 AND kind = 'first_connect_insights' AND subject_ref = $2
  AND outcome = 'pending'
"""


class PostgresFirstConnectLedger:
    async def eligible_sources(self, user_id: str) -> list[str]:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(_ELIGIBLE_SQL, user_id)
        return [str(row["source"]) for row in rows if row["source"] in SOURCES]

    async def claim(self, user_id: str, source: str) -> bool:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            return await conn.fetchval(_CLAIM_SQL, user_id, source) is not None

    async def settle(self, user_id: str, source: str, outcome: str) -> None:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(_SETTLE_SQL, user_id, source, outcome)


def _text(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _when(value: object) -> str:
    if isinstance(value, Mapping):
        return _text(value.get("dateTime") or value.get("date"), 40)
    return _text(value, 40)


async def collect_gmail(
    user_id: str,
    require_access: RequireAccess,
    *,
    gmail: Any | None = None,
    reader_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Recent inbox and sent headers only: sender or recipient, subject, date."""
    from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
    from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
    from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

    if not connector_feature_enabled("gmail_chat_reads", user_id):
        raise SourceUnreadable("gmail_reads_unavailable")
    service = gmail if gmail is not None else get_gmail_receipts_service()
    factory = reader_factory or GmailMetadataReader
    collected: dict[str, Any] = {}
    for key in ("inbox", "sent"):
        # The reader allows one bounded read per instance.
        reader = factory(gmail=service, user_id=user_id, require_access=require_access)
        try:
            result = await reader.read("list_recent", {"mailbox": key, "limit": 25})
            await reader.require_current()
        except GmailMetadataError as error:
            if error.code == "retryable":
                raise  # transient: the caller records a failure and retries later
            raise SourceUnreadable(error.code) from None
        collected[key] = [
            {
                "sender": _text(item.get("sender"), 160),
                "recipient": _text(item.get("recipient"), 160),
                "subject": _text(item.get("subject"), 160),
                "received_at": _text(item.get("received_at"), 40),
            }
            for item in result.get("untrusted_external_content") or []
            if isinstance(item, Mapping)
        ]
    return collected


async def collect_calendar(
    user_id: str,
    require_access: RequireAccess,
    *,
    calendar: Any | None = None,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> dict[str, Any]:
    """Four weeks back and two ahead: titles, times and attendee counts only."""
    from hushh_mcp.services.google_calendar_service import get_google_calendar_service
    from hushh_mcp.services.google_connection_service import GoogleConnectionError

    service = calendar if calendar is not None else get_google_calendar_service()
    now = clock()
    await require_access()
    try:
        result = await service.list_events(
            user_id=user_id,
            start_at=(now - timedelta(days=28)).isoformat(),
            end_at=(now + timedelta(days=14)).isoformat(),
            max_results=250,
        )
    except GoogleConnectionError as error:
        raise SourceUnreadable(f"calendar_{getattr(error, 'status_code', 'unreadable')}") from None
    await require_access()
    events = []
    for event in result.get("events") or []:
        if not isinstance(event, Mapping) or event.get("status") == "cancelled":
            continue
        attendees = [a for a in event.get("attendees") or [] if isinstance(a, Mapping)]
        events.append(
            {
                "title": _text(event.get("title"), 120),
                "start": _when(event.get("start")),
                "end": _when(event.get("end")),
                "attendee_count": len(attendees),
                # Addresses help name a frequent contact; the gene may never echo one.
                "attendees": [_text(a.get("email"), 120) for a in attendees[:4] if a.get("email")],
            }
        )
    return {"time_zone": _text(result.get("time_zone"), 64), "events": events}


async def collect_drive(
    user_id: str,
    require_access: RequireAccess,
    *,
    reader_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """The most recently changed files: name, type and date. No file is opened."""
    from hushh_mcp.services.drive_live_reader import DriveLiveReader

    factory = reader_factory or DriveLiveReader
    reader = factory(user_id=user_id, require_access=require_access)
    try:
        result = await reader.find(query=[], recent=True, max_results=25, title_only=True)
    except Exception as error:  # noqa: BLE001 - any Drive refusal means "not readable here"
        raise SourceUnreadable(type(error).__name__) from None
    await require_access()
    return {
        "files": [
            {
                "name": _text(item.get("name"), 160),
                "mime_type": _text(item.get("mime_type"), 80),
                "modified_time": _text(item.get("modified_time"), 40),
            }
            for item in result.get("matches") or []
            if isinstance(item, Mapping)
        ]
    }


_COLLECTORS: dict[str, Callable[..., Awaitable[dict[str, Any]]]] = {
    "gmail": collect_gmail,
    "calendar": collect_calendar,
    "drive": collect_drive,
}


async def collect_source_metadata(
    source: str, user_id: str, require_access: RequireAccess
) -> dict[str, Any]:
    collector = _COLLECTORS.get(source)
    if collector is None:
        raise SourceUnreadable("unknown_source")
    return await collector(user_id, require_access)


async def run_first_connect_gene(
    *, prompt: str, user_id: str, consent_token: str
) -> dict[str, Any]:
    """Run the manifest-owned gene once, schema-constrained, with no tools."""
    from pathlib import Path

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents" / "one" / "agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == GENE_ID)
    if gene.runtime.adk_mode != "single_turn" or gene.privacy.plaintext_telemetry:
        raise RuntimeError("first-connect gene has an invalid runtime boundary")
    agent = build_single_turn_agent(gene, output_schema=FIRST_CONNECT_INSIGHTS_SCHEMA)
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token=consent_token,
        timeout_seconds=GENE_TIMEOUT_SECONDS,
    )
    if not isinstance(result, dict):
        raise ValueError("first-connect gene returned a non-object payload")
    return result


def validate_insights(payload: object) -> list[dict[str, str]]:
    """Keep the items that honour the contract, in the gene's order. Never rewrite one."""
    items = payload.get("items") if isinstance(payload, Mapping) else None
    if not isinstance(items, list):
        raise ValueError("first-connect gene returned no item list")
    accepted: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in items:
        if not isinstance(raw, Mapping):
            continue
        kind = raw.get("kind")
        label = raw.get("label")
        memory_text = raw.get("memory_text")
        evidence = raw.get("evidence")
        if (
            kind not in INSIGHT_KINDS
            or not isinstance(label, str)
            or not isinstance(memory_text, str)
            or not isinstance(evidence, str)
            or not 1 <= len(label.strip()) <= MAX_LABEL_CHARS
            or not 1 <= len(memory_text.strip()) <= MAX_MEMORY_CHARS
            or len(evidence.strip()) > MAX_EVIDENCE_CHARS
            or "@" in label
            or "@" in memory_text
        ):
            # Out of contract: rejected whole, not repaired.
            continue
        key = memory_text.strip().casefold()
        if key in seen:
            continue
        seen.add(key)
        accepted.append(
            {
                "id": f"insight-{len(accepted) + 1}",
                "kind": str(kind),
                "label": label.strip(),
                "memory_text": memory_text.strip(),
                "evidence": evidence.strip(),
            }
        )
        if len(accepted) == MAX_ITEMS:
            break
    return accepted


async def offer_first_connect_insights(
    *,
    user_id: str,
    consent_token: str,
    ledger: FirstConnectLedger | None = None,
    collector: Collector = collect_source_metadata,
    gene_runner: GeneRunner = run_first_connect_gene,
    owner_check: OwnerCheck = validate_first_party_owner_token,
) -> dict[str, Any]:
    """Offer the card for one eligible source, or report that there is none.

    Returns ``{"status": "none"}``, ``{"status": "empty", "source": ...}`` or
    ``{"status": "offered", "source": ..., "sourceLabel": ..., "items": [...]}``.
    The items are returned to the caller only; nothing about them is stored.
    """
    store = ledger or PostgresFirstConnectLedger()

    async def require_access() -> None:
        if await owner_check(user_id, consent_token) is None:
            raise PermissionError("owner authority is unavailable")

    await require_access()
    source = ""
    for candidate in await store.eligible_sources(user_id):
        if candidate in SOURCES and await store.claim(user_id, candidate):
            source = candidate
            break
    if not source:
        return {"status": "none"}

    try:
        metadata = await collector(source, user_id, require_access)
    except SourceUnreadable as error:
        logger.info("one.first_connect_insights_unreadable source=%s code=%s", source, error)
        await store.settle(user_id, source, "empty")
        return {"status": "empty", "source": source}
    except PermissionError:
        await store.settle(user_id, source, "failed")
        raise
    except Exception as error:  # noqa: BLE001 - provider detail never leaves the server
        logger.warning(
            "one.first_connect_insights_read_failed source=%s error=%s",
            source,
            type(error).__name__,
        )
        await store.settle(user_id, source, "failed")
        return {"status": "unavailable", "source": source}

    if not any(isinstance(value, list) and value for value in metadata.values()):
        await store.settle(user_id, source, "empty")
        return {"status": "empty", "source": source}

    try:
        result = await gene_runner(
            prompt=json.dumps({"source": source, "metadata": metadata}, ensure_ascii=False),
            user_id=user_id,
            consent_token=consent_token,
        )
        items = validate_insights(result)
        # A session revoked while the model ran does not receive its answer.
        await require_access()
    except PermissionError:
        await store.settle(user_id, source, "failed")
        raise
    except Exception as error:  # noqa: BLE001 - model FAILURE: retry after the window
        logger.warning(
            "one.first_connect_insights_gene_failed source=%s error=%s",
            source,
            type(error).__name__,
        )
        await store.settle(user_id, source, "failed")
        return {"status": "unavailable", "source": source}

    await store.settle(user_id, source, "offered" if items else "empty")
    if not items:
        return {"status": "empty", "source": source}
    return {
        "status": "offered",
        "source": source,
        "sourceLabel": SOURCE_LABELS[source],
        "items": items,
    }


__all__ = [
    "FIRST_CONNECT_INSIGHTS_SCHEMA",
    "GENE_ID",
    "INSIGHT_KINDS",
    "LEDGER_KIND",
    "SOURCES",
    "FirstConnectLedger",
    "PostgresFirstConnectLedger",
    "SourceUnreadable",
    "collect_calendar",
    "collect_drive",
    "collect_gmail",
    "collect_source_metadata",
    "offer_first_connect_insights",
    "run_first_connect_gene",
    "validate_insights",
]
