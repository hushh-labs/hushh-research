"""Typed recipient sources and private snapshots for reviewed Mail composition.

This adapter resolves the model's declared sources; it never infers an address,
confirms a person, edits a profile, or sends. Stored snapshots belong only in the
owning Mail draft's sealed state, never model results or conversation history.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

from hushh_mcp.one_voice.tools.base import PersonRef, Rejected, ToolContext
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, normalize_draft
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service


class AddressPart(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["literal", "spelled"]
    text: str = ""
    characters: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _units(self) -> AddressPart:
        if self.type == "literal":
            if self.characters or len(self.text) > 320:
                raise ValueError("literal address parts contain only text, at most 320 characters")
        elif self.text or not self.characters or len(self.characters) > 320:
            raise ValueError("spelled address parts need character units only")
        elif any(
            len(char) != 1 or not (char.isascii() and (char.isalnum() or char in ".+_-@"))
            for char in self.characters
        ):
            raise ValueError("use single Latin letters, digits, or . + _ - @")
        return self


class RecipientSource(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["connection", "address", "self"]
    role: Literal["to", "cc", "bcc"] = "to"
    person: PersonRef | None = None
    address_parts: list[AddressPart] = Field(default_factory=list, max_length=16, exclude=True)
    address: str = Field(default="", max_length=320, validate_default=True)

    @field_validator("address", mode="before")
    @classmethod
    def _address_units(cls, value: Any, info: ValidationInfo) -> Any:
        parts = info.data.get("address_parts") or []
        if not parts:
            return value
        if value:
            raise ValueError("supply address or address_parts, not both")
        return "".join(
            part.text if part.type == "literal" else "".join(part.characters) for part in parts
        )

    @model_validator(mode="after")
    def _source(self) -> RecipientSource:
        if self.kind == "connection":
            valid = self.person is not None and not self.address
        elif self.kind == "address":
            valid = self.person is None and bool(self.address.strip())
        else:
            valid = self.person is None and not self.address
        if not valid:
            raise ValueError("recipient source fields must match its kind")
        return self


class ResolvedRecipients(BaseModel):
    """Private, immutable reviewed audience; all addresses use the Mail normalizer."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    sources: tuple[RecipientSource, ...]
    bindings: tuple[str, ...]
    to: tuple[str, ...]
    cc: tuple[str, ...]
    bcc: tuple[str, ...]

    @property
    def source_count(self) -> int:
        return len(self.sources)

    @property
    def recipient_count(self) -> int:
        return len(self.to) + len(self.cc) + len(self.bcc)

    @property
    def duplicate_count(self) -> int:
        return self.source_count - self.recipient_count

    def draft_fields(self) -> dict[str, list[str]]:
        return {"to": list(self.to), "cc": list(self.cc), "bcc": list(self.bcc)}


class ConnectionAudience(BaseModel):
    """Read-only complete-audience counts; this grants no batch send authority."""

    source_count: int
    eligible_count: int
    distinct_mailboxes: int
    duplicate_count: int
    missing_count: int
    invalid_count: int
    ambiguous_count: int
    within_send_limit: bool


def _refused(reason: str, fact: str) -> Rejected:
    return Rejected(reason_code=reason, spoken_facts=[fact], retire_open_proposal=True)


def _one_address(raw: Any) -> tuple[str | None, str]:
    if not isinstance(raw, str) or not raw.strip():
        return None, "missing"
    try:
        normalized = normalize_draft({"to": raw, "body": "address validation"})
    except GmailDeliveryError:
        return None, "invalid"
    if len(normalized.to) != 1:
        return None, "ambiguous"
    return normalized.to[0], "ready"


async def _connections(ctx: ToolContext) -> list[dict[str, Any]] | Rejected:
    try:
        service = ctx.service("connections", ConnectionsService)
        rows = await asyncio.to_thread(service.list_connections, ctx.user_id)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("invalid connection snapshot")
        return rows
    except Exception:
        return _refused(
            "recipient_lookup_unavailable",
            "I couldn't check your connections. Your message hasn't been sent. Please try again.",
        )


def _binding(ctx: ToolContext, payload: dict[str, Any]) -> str:
    secret = get_core_security_settings().app_signing_key
    material = json.dumps(
        ["voice-mail-recipient-v1", ctx.user_id, ctx.conversation_id, payload],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hmac.new(secret.encode(), material.encode(), hashlib.sha256).hexdigest()


async def resolve_recipient_sources(
    ctx: ToolContext, sources: list[RecipientSource] | tuple[RecipientSource, ...]
) -> ResolvedRecipients | Rejected:
    """Resolve explicitly selected recipients, reading active connections once."""
    if not sources or len(sources) > 50:
        return _refused("recipient_limit", "Choose between one and 50 recipients for this email.")
    rows = await _connections(ctx) if any(item.kind == "connection" for item in sources) else []
    if isinstance(rows, Rejected):
        return rows
    by_id = {str(row.get("userId") or ""): row for row in rows}
    destinations: dict[str, list[str]] = {"to": [], "cc": [], "bcc": []}
    bindings: list[str] = []
    sender: dict[str, Any] | None = None
    for source in sources:
        bound: dict[str, Any] = {"kind": source.kind, "role": source.role}
        raw: Any = source.address
        if source.kind == "connection":
            user_id = source.person.user_id if source.person is not None else ""
            person = ctx.entities.person(user_id)
            if person is None:
                return _refused(
                    "person_not_confirmed",
                    "Confirm which person you mean before reviewing the email.",
                )
            row = by_id.get(user_id)
            if person.relationship != "connected" or row is None:
                return _refused(
                    "recipient_not_connected", "That person is no longer an active connection."
                )
            raw = row.get("email")
            bound.update(user_id=user_id, connection_id=str(row.get("connectionId") or ""))
        elif source.kind == "self":
            if sender is None:
                gmail = ctx.services.get("gmail") or get_gmail_receipts_service()
                try:
                    sender = await gmail.send_grant_identity(user_id=ctx.user_id)
                except GmailApiError as exc:
                    reason, fact = {
                        "GMAIL_SEND_DISABLED": (
                            "mail_send_disabled",
                            "Turn on Gmail sending in Mail settings.",
                        ),
                        "GMAIL_SEND_PERMISSION_REQUIRED": (
                            "mail_send_permission_required",
                            "Reconnect Gmail and allow sending.",
                        ),
                        "GMAIL_NOT_CONNECTED": (
                            "mail_connect_required",
                            "Connect Gmail before sending to yourself.",
                        ),
                    }.get(
                        str(exc.code),
                        ("sender_unavailable", "I couldn't check your sending account. Try again."),
                    )
                    return _refused(reason, fact)
                except Exception:
                    return _refused(
                        "sender_unavailable", "I couldn't check your sending account. Try again."
                    )
            raw = sender.get("account_label")
            bound.update(
                sender_sub=sender.get("google_sub"),
                grant_generation=sender.get("grant_generation"),
            )
            if not bound["sender_sub"] or not isinstance(bound["grant_generation"], int):
                return _refused(
                    "sender_unavailable", "I couldn't verify your sending account. Try again."
                )
        address, state = _one_address(raw)
        if address is None:
            reason, fact = {
                "missing": (
                    "recipient_address_missing",
                    "An email address is missing. Give an address for this draft.",
                ),
                "invalid": (
                    "recipient_address_invalid",
                    "That email address isn't valid. Correct just the address.",
                ),
                "ambiguous": (
                    "recipient_address_ambiguous",
                    "There is more than one address. Choose the destination to review.",
                ),
            }[state]
            return _refused(reason, fact)
        destinations[source.role].append(address)
        bindings.append(_binding(ctx, {**bound, "address": address}))
    normalized = normalize_draft({**destinations, "body": "address validation"})
    return ResolvedRecipients(
        # Retain only rendered input in the private snapshot; character parts
        # have already served their purpose and cannot become a competing value.
        sources=tuple(
            RecipientSource.model_validate(source.model_dump(mode="json")) for source in sources
        ),
        bindings=tuple(bindings),
        to=normalized.to,
        cc=normalized.cc,
        bcc=normalized.bcc,
    )


async def revalidate_recipient_sources(
    ctx: ToolContext, prepared: ResolvedRecipients
) -> ResolvedRecipients | Rejected:
    current = await resolve_recipient_sources(ctx, prepared.sources)
    if isinstance(current, Rejected):
        return current
    if (
        current.draft_fields() != prepared.draft_fields()
        or len(current.bindings) != len(prepared.bindings)
        or any(
            not hmac.compare_digest(old, new)
            for old, new in zip(prepared.bindings, current.bindings, strict=True)
        )
    ):
        return _refused(
            "recipient_changed",
            "A recipient, email address, or account changed. Review this email again.",
        )
    return current


async def inspect_connection_audience(ctx: ToolContext) -> ConnectionAudience | Rejected:
    """Count the complete active set, never the model's paged people list."""
    rows = await _connections(ctx)
    if isinstance(rows, Rejected):
        return rows
    counts = {"ready": 0, "missing": 0, "invalid": 0, "ambiguous": 0}
    addresses: set[str] = set()
    for row in rows:
        address, state = _one_address(row.get("email"))
        counts[state] += 1
        if address is not None:
            addresses.add(address)
    return ConnectionAudience(
        source_count=len(rows),
        eligible_count=counts["ready"],
        distinct_mailboxes=len(addresses),
        duplicate_count=counts["ready"] - len(addresses),
        missing_count=counts["missing"],
        invalid_count=counts["invalid"],
        ambiguous_count=counts["ambiguous"],
        within_send_limit=0 < len(addresses) <= 50,
    )
