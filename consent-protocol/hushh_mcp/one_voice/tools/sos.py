"""Save My Soul (SOS) tools: emergency contacts, alert arming, delivery, stop.

Canonical contract (``OneLocationAgentService``): a Save My Soul alert is one
8-hour grant per phone-verified SMS contact, written with ``share_kind="sos"``
(legacy reason marker ``sos_panic``). The server never holds a position: the
location envelope is encrypted on the device, so ``trigger_save_my_soul`` can
only *arm* the alert and hand the client a ``publish_location_envelopes``
step. "Sent" is a fact only ``report_save_my_soul_delivery`` may state, and
only after the server sees a stored envelope on the grant.

All services here are the vault-owner plane (``user_id``); the SMS-contact
routes use the vault-owner token, so no tool sets ``firebase_plane``.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.one_voice.tools.base import (
    PersonRef,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)
from hushh_mcp.services.one_location_circle_service import OneLocationCircleError

SOS_SHARE_KIND = "sos"
SOS_DURATION_HOURS = 8
SOS_DURATION_MODE = "timed"
SOS_LEGACY_REASON = "sos_panic"
SOS_NOTE_MAX_LENGTH = 140
PUBLISH_ENVELOPES_TIMEOUT_S = 25
RECIPIENT_LOOKUP_LIMIT = 100

# Screens (see ``session.OPENABLE_SCREENS``) the client refreshes after a change.
UI_REFRESH_SOS: tuple[str, ...] = ("location_sos", "location_home")
UI_REFRESH_CONTACTS: tuple[str, ...] = ("location_emergency_contacts", "location_sos")

# Service refusals carry ``.code`` / ``.message``; both planes of the Location
# service raise one of these two.
ServiceError = (OneLocationAgentError, OneLocationCircleError)

# Placeholder labels the recipient projection emits when no name is known.
# They are never spoken as a person's name.
_MASKED_PHONE_ONLY = re.compile(r"^\*{3,}\d{1,4}$")
_PLACEHOLDER_NAMES = frozenset({"verified user", "a trusted person", "a contact"})


# -- shared views -------------------------------------------------------------


class EmergencyContactView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    display_name: str | None = None
    phone_verified: bool = False
    has_location_key: bool = False
    # Both conditions the SOS lane requires before a grant can be written.
    sos_ready: bool = False
    key_id: str | None = None


class SosGrantView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    grant_id: str
    user_id: str
    display_name: str | None = None
    key_id: str | None = None
    expires_at: str | None = None
    has_envelope: bool = False


# -- helpers --------------------------------------------------------------------


def _service(ctx: ToolContext) -> Any:
    return ctx.service("location", OneLocationAgentService)


def _speakable_name(value: Any) -> str | None:
    text = " ".join(str(value or "").split())
    if not text or text.lower() in _PLACEHOLDER_NAMES or _MASKED_PHONE_ONLY.match(text):
        return None
    return text


def _join(names: list[str]) -> str:
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return ", ".join(names[:-1]) + f", and {names[-1]}"


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _spoken_roster(names: list[str | None], *, noun: str = "emergency contact") -> str:
    """Names the service returned, with unnamed people counted rather than invented."""
    named = [name for name in names if name]
    unnamed = len(names) - len(named)
    if not named:
        return _plural(len(names), noun)
    if unnamed:
        return _join(named + [_plural(unnamed, "other contact")])
    return _join(named)


def _is_past(value: Any) -> bool:
    if not value:
        return False
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment <= datetime.now(timezone.utc)


def _is_sos_grant(grant: dict[str, Any]) -> bool:
    return str(grant.get("shareKind") or "") == SOS_SHARE_KIND


def _is_live(grant: dict[str, Any]) -> bool:
    return str(grant.get("status") or "") == "active" and not _is_past(grant.get("expiresAt"))


def _rejected(exc: Exception) -> Rejected:
    code = str(getattr(exc, "code", "") or "service_error")
    message = str(getattr(exc, "message", "") or "That didn't go through.")
    return Rejected(reason_code=code, spoken_facts=[message])


def _emergency_contacts_sync(service: Any, user_id: str) -> list[EmergencyContactView]:
    """The SMS roster, joined to the recipient projection for name/phone/key facts.

    Sync on purpose: handlers run it through ``asyncio.to_thread``; the
    trigger card's ``summarize`` (which the executor calls synchronously)
    reads it directly so the card names the people who will be alerted.
    """
    contact_ids: list[str] = list(service.list_sms_contact_ids(owner_user_id=user_id))
    if not contact_ids:
        return []
    recipients = service.list_verified_recipients(
        owner_user_id=user_id, limit=RECIPIENT_LOOKUP_LIMIT
    )
    by_id = {str(row.get("userId") or ""): row for row in recipients or [] if row}
    contacts: list[EmergencyContactView] = []
    for contact_id in contact_ids:
        row = by_id.get(contact_id) or {}
        key_id = str(row.get("keyId") or "") or None
        phone_verified = bool(row.get("phoneVerified"))
        has_key = bool(row.get("canReceiveLocation")) and key_id is not None
        contacts.append(
            EmergencyContactView(
                user_id=contact_id,
                display_name=_speakable_name(row.get("displayName")),
                phone_verified=phone_verified,
                has_location_key=has_key,
                sos_ready=phone_verified and has_key,
                key_id=key_id,
            )
        )
    return contacts


async def _emergency_contacts(service: Any, user_id: str) -> list[EmergencyContactView]:
    return await asyncio.to_thread(_emergency_contacts_sync, service, user_id)


async def _active_sos_grants(service: Any, user_id: str) -> list[dict[str, Any]]:
    grants = await asyncio.to_thread(service.list_active_owner_grants, owner_user_id=user_id)
    return [grant for grant in grants or [] if grant and _is_sos_grant(grant) and _is_live(grant)]


def _grant_view(
    grant: dict[str, Any], names_by_id: dict[str, str | None] | None = None
) -> SosGrantView:
    user_id = str(grant.get("recipientUserId") or "")
    name = _speakable_name(grant.get("recipientDisplayName"))
    if name is None and names_by_id:
        name = names_by_id.get(user_id)
    return SosGrantView(
        grant_id=str(grant.get("id") or ""),
        user_id=user_id,
        display_name=name,
        key_id=str(grant.get("recipientKeyId") or "") or None,
        expires_at=str(grant.get("expiresAt") or "") or None,
        has_envelope=bool(grant.get("latestEnvelopeId")),
    )


def _confirmed_name(ctx: ToolContext, user_id: str) -> str | None:
    person = ctx.entities.person(user_id)
    return person.display_name if person is not None else None


# -- get_save_my_soul_status ---------------------------------------------------


class SaveMySoulStatusInput(ToolInput):
    pass


class SaveMySoulStatusResult(ToolResult):
    status: Literal["ready", "no_emergency_contacts", "active"]
    emergency_contacts: list[EmergencyContactView] = Field(default_factory=list)
    active_sos: bool = False
    active_grant_count: int = 0
    active_grants: list[SosGrantView] = Field(default_factory=list)
    default_action: Literal["open", "trigger"] = "open"


async def get_save_my_soul_status(ctx: ToolContext, args: SaveMySoulStatusInput) -> ToolResult:
    service = _service(ctx)
    try:
        contacts = await _emergency_contacts(service, ctx.user_id)
        active = await _active_sos_grants(service, ctx.user_id)
        preference = await asyncio.to_thread(service.get_sos_voice_preference, user_id=ctx.user_id)
    except ServiceError as exc:
        return _rejected(exc)
    default_action: Literal["open", "trigger"] = (
        "trigger" if str((preference or {}).get("defaultAction") or "") == "trigger" else "open"
    )
    names_by_id = {contact.user_id: contact.display_name for contact in contacts}
    grants = [_grant_view(grant, names_by_id) for grant in active]
    facts: list[str] = []
    if grants:
        status: Literal["ready", "no_emergency_contacts", "active"] = "active"
        facts.append(
            "Save My Soul is active with "
            f"{_plural(len(grants), 'live location share')} to "
            f"{_spoken_roster([grant.display_name for grant in grants])}."
        )
    elif not contacts:
        status = "no_emergency_contacts"
        facts.append("You have no emergency contacts yet, so no alert can be sent.")
    else:
        status = "ready"
        facts.append(
            f"Your {_plural(len(contacts), 'emergency contact')}: "
            f"{_spoken_roster([contact.display_name for contact in contacts])}."
        )
        not_ready = [contact for contact in contacts if not contact.sos_ready]
        if not_ready:
            named = [contact.display_name for contact in not_ready if contact.display_name]
            who = _join(named) if len(named) == len(not_ready) else f"{len(not_ready)} of them"
            facts.append(f"{who} can't receive your location yet.")
    return SaveMySoulStatusResult(
        status=status,
        spoken_facts=facts,
        emergency_contacts=contacts,
        active_sos=bool(grants),
        active_grant_count=len(grants),
        active_grants=grants,
        default_action=default_action,
        needs="setup" if status == "no_emergency_contacts" else None,
    )


# -- trigger_save_my_soul ------------------------------------------------------


class TriggerSaveMySoulInput(ToolInput):
    note: str | None = Field(
        default=None,
        max_length=SOS_NOTE_MAX_LENGTH,
        description="Optional short message shown to the contacts with the alert.",
    )


class TriggerSaveMySoulResult(ToolResult):
    status: Literal["sos_grants_created", "no_emergency_contacts", "already_active"]
    grant_ids: list[str] = Field(default_factory=list)
    armed: list[SosGrantView] = Field(default_factory=list)
    skipped_no_key: list[EmergencyContactView] = Field(default_factory=list)
    skipped_not_phone_verified: list[EmergencyContactView] = Field(default_factory=list)
    failed: list[dict[str, str]] = Field(default_factory=list)
    client_step: dict[str, Any] | None = None


def summarize_trigger(ctx: ToolContext, args: TriggerSaveMySoulInput) -> str:
    """Card sentence naming the real contacts. Best effort: an unreadable roster
    falls back to a generic phrase rather than blocking the card; the handler
    re-reads the roster at execution time either way."""
    try:
        contacts = _emergency_contacts_sync(_service(ctx), ctx.user_id)
    except Exception:  # noqa: BLE001 - the card must render; the handler decides
        contacts = []
    if not contacts:
        return "send a Save My Soul alert to your emergency contacts"
    return f"send a Save My Soul alert to {_spoken_roster([c.display_name for c in contacts])}"


async def trigger_save_my_soul(ctx: ToolContext, args: TriggerSaveMySoulInput) -> ToolResult:
    service = _service(ctx)
    try:
        contacts = await _emergency_contacts(service, ctx.user_id)
        active = await _active_sos_grants(service, ctx.user_id)
    except ServiceError as exc:
        return _rejected(exc)
    if not contacts:
        return TriggerSaveMySoulResult(
            status="no_emergency_contacts",
            reason_code="no_emergency_contacts",
            needs="setup",
            spoken_facts=["You have no emergency contacts yet, so no alert can be sent."],
        )
    names_by_id = {contact.user_id: contact.display_name for contact in contacts}
    if active:
        grants = [_grant_view(grant, names_by_id) for grant in active]
        return TriggerSaveMySoulResult(
            status="already_active",
            reason_code="sos_already_active",
            grant_ids=[grant.grant_id for grant in grants],
            armed=grants,
            spoken_facts=[
                "Save My Soul is already active for "
                f"{_spoken_roster([grant.display_name for grant in grants])}."
            ],
        )
    note = " ".join(str(args.note or "").split()) or None
    armed: list[SosGrantView] = []
    skipped_no_key: list[EmergencyContactView] = []
    skipped_not_verified: list[EmergencyContactView] = []
    failed: list[dict[str, str]] = []
    left_out: list[str | None] = []
    first_error: Exception | None = None
    for contact in contacts:
        if not contact.has_location_key:
            skipped_no_key.append(contact)
            left_out.append(contact.display_name)
            continue
        if not contact.phone_verified:
            skipped_not_verified.append(contact)
            left_out.append(contact.display_name)
            continue
        try:
            grant = await asyncio.to_thread(
                service.create_grant,
                owner_user_id=ctx.user_id,
                recipient_user_id=contact.user_id,
                recipient_key_id=contact.key_id,
                duration_hours=SOS_DURATION_HOURS,
                duration_mode=SOS_DURATION_MODE,
                reason=note or SOS_LEGACY_REASON,
                share_kind=SOS_SHARE_KIND,
                require_recipient_phone_verified=True,
                enforce_connection=False,
            )
        except ServiceError as exc:
            # One refused contact must not stop the alert for the others.
            first_error = first_error or exc
            failed.append(
                {
                    "user_id": contact.user_id,
                    "display_name": contact.display_name or "",
                    "reason_code": str(exc.code),
                }
            )
            left_out.append(contact.display_name)
            continue
        armed.append(_grant_view(grant or {}, names_by_id))
    if not armed:
        if first_error is not None:
            return _rejected(first_error)
        return Rejected(
            reason_code="no_sos_ready_contacts",
            needs="setup",
            spoken_facts=[
                f"{_spoken_roster([contact.display_name for contact in contacts])} can't receive "
                "your location yet, so no alert could be armed."
            ],
        )
    grant_ids = [grant.grant_id for grant in armed]
    facts = [
        f"Alert armed for {_spoken_roster([grant.display_name for grant in armed])}; "
        "sending your position now."
    ]
    if left_out:
        facts.append(f"{_spoken_roster(left_out, noun='contact')} could not be included.")
    return TriggerSaveMySoulResult(
        status="sos_grants_created",
        needs="client_step",
        spoken_facts=facts,
        grant_ids=grant_ids,
        armed=armed,
        skipped_no_key=skipped_no_key,
        skipped_not_phone_verified=skipped_not_verified,
        failed=failed,
        client_step={
            "kind": "publish_location_envelopes",
            "purpose": "sos",
            "grant_ids": grant_ids,
            "grants": [
                {"grant_id": grant.grant_id, "user_id": grant.user_id, "key_id": grant.key_id}
                for grant in armed
            ],
            "sos": True,
            "timeout_s": PUBLISH_ENVELOPES_TIMEOUT_S,
        },
    )


# -- report_save_my_soul_delivery ----------------------------------------------


class ReportSaveMySoulDeliveryInput(ToolInput):
    grant_ids: list[str] = Field(
        min_length=1,
        max_length=50,
        description="Grant ids returned by trigger_save_my_soul.",
    )


class ReportSaveMySoulDeliveryResult(ToolResult):
    status: Literal["sos_sent", "sos_partial", "sos_not_sent"]
    delivered: list[str] = Field(default_factory=list)
    not_alerted: list[str] = Field(default_factory=list)
    delivered_grant_ids: list[str] = Field(default_factory=list)
    not_alerted_grant_ids: list[str] = Field(default_factory=list)
    unknown_grant_ids: list[str] = Field(default_factory=list)


async def report_save_my_soul_delivery(
    ctx: ToolContext, args: ReportSaveMySoulDeliveryInput
) -> ToolResult:
    """Server-side verification: a grant counts as delivered only when the
    client's encrypted position envelope is stored on it."""
    service = _service(ctx)
    wanted = [gid.strip() for gid in args.grant_ids if gid and gid.strip()]
    try:
        grants = await asyncio.to_thread(
            service.list_active_owner_grants, owner_user_id=ctx.user_id
        )
    except ServiceError as exc:
        return _rejected(exc)
    by_id = {
        str(grant.get("id") or ""): grant
        for grant in grants or []
        if grant
        and _is_sos_grant(grant)
        and str(grant.get("ownerUserId") or ctx.user_id) == ctx.user_id
    }
    delivered: list[SosGrantView] = []
    not_alerted: list[SosGrantView] = []
    unknown: list[str] = []
    for grant_id in wanted:
        grant = by_id.get(grant_id)
        if grant is None:
            unknown.append(grant_id)
            continue
        view = _grant_view(grant)
        (delivered if view.has_envelope else not_alerted).append(view)
    if delivered and not not_alerted and not unknown:
        status: Literal["sos_sent", "sos_partial", "sos_not_sent"] = "sos_sent"
    elif delivered:
        status = "sos_partial"
    else:
        status = "sos_not_sent"
    facts: list[str] = []
    if delivered:
        facts.append(
            f"Your position reached {_spoken_roster([g.display_name for g in delivered], noun='contact')}."
        )
    if not_alerted:
        facts.append(
            f"Your position has not reached {_spoken_roster([g.display_name for g in not_alerted], noun='contact')}."
        )
    if unknown:
        facts.append(f"{_plural(len(unknown), 'alert')} could not be verified.")
    if not facts:
        facts.append("Your position was not sent.")
    return ReportSaveMySoulDeliveryResult(
        status=status,
        spoken_facts=facts,
        delivered=[g.display_name or g.user_id for g in delivered],
        not_alerted=[g.display_name or g.user_id for g in not_alerted],
        delivered_grant_ids=[g.grant_id for g in delivered],
        not_alerted_grant_ids=[g.grant_id for g in not_alerted],
        unknown_grant_ids=unknown,
        reason_code=None if status == "sos_sent" else "envelope_missing",
    )


# -- stop_save_my_soul ---------------------------------------------------------


class StopSaveMySoulInput(ToolInput):
    pass


class StopSaveMySoulResult(ToolResult):
    status: Literal["sos_stopped", "not_active"]
    stopped_count: int = 0
    stopped: list[SosGrantView] = Field(default_factory=list)
    failed: list[dict[str, str]] = Field(default_factory=list)


def summarize_stop(ctx: ToolContext, args: StopSaveMySoulInput) -> str:
    return "stop Save My Soul and end every emergency location share it started"


async def stop_save_my_soul(ctx: ToolContext, args: StopSaveMySoulInput) -> ToolResult:
    service = _service(ctx)
    try:
        active = await _active_sos_grants(service, ctx.user_id)
    except ServiceError as exc:
        return _rejected(exc)
    if not active:
        return StopSaveMySoulResult(
            status="not_active",
            reason_code="sos_not_active",
            spoken_facts=["Save My Soul isn't active, so there was nothing to stop."],
        )
    stopped: list[SosGrantView] = []
    failed: list[dict[str, str]] = []
    first_error: Exception | None = None
    for grant in active:
        view = _grant_view(grant)
        try:
            result = await asyncio.to_thread(
                service.revoke_grant, owner_user_id=ctx.user_id, grant_id=view.grant_id
            )
        except ServiceError as exc:
            first_error = first_error or exc
            failed.append({"grant_id": view.grant_id, "reason_code": str(exc.code)})
            continue
        if str((result or {}).get("status") or "") == "active":
            failed.append({"grant_id": view.grant_id, "reason_code": "still_active"})
            continue
        stopped.append(view)
    if not stopped:
        if first_error is not None:
            return _rejected(first_error)
        return Rejected(
            reason_code="sos_stop_failed",
            spoken_facts=["Save My Soul could not be stopped. Its location shares are still live."],
        )
    facts = [
        f"Save My Soul stopped; {_plural(len(stopped), 'location share')} to "
        f"{_spoken_roster([g.display_name for g in stopped], noun='contact')} ended."
    ]
    if failed:
        facts.append(f"{_plural(len(failed), 'share')} could not be ended and is still live.")
    return StopSaveMySoulResult(
        status="sos_stopped",
        spoken_facts=facts,
        stopped_count=len(stopped),
        stopped=stopped,
        failed=failed,
    )


# -- add_emergency_contact -----------------------------------------------------


class EmergencyContactInput(ToolInput):
    person: PersonRef


class AddEmergencyContactResult(ToolResult):
    status: Literal["added", "already_contact", "not_phone_verified", "not_connected"]
    person_user_id: str | None = None
    display_name: str | None = None
    emergency_contact_count: int | None = None


def summarize_add_contact(ctx: ToolContext, args: EmergencyContactInput) -> str:
    name = _confirmed_name(ctx, args.person.user_id) or "this person"
    return f"add {name} as an emergency contact"


def summarize_remove_contact(ctx: ToolContext, args: EmergencyContactInput) -> str:
    name = _confirmed_name(ctx, args.person.user_id) or "this person"
    return f"remove {name} from your emergency contacts"


def _unconfirmed() -> Rejected:
    return Rejected(
        reason_code="person_not_confirmed",
        needs="disambiguation",
        spoken_facts=["I need to confirm who you mean first."],
    )


async def _recipient_row(service: Any, owner_user_id: str, user_id: str) -> dict[str, Any] | None:
    recipients: list[dict[str, Any]] = await asyncio.to_thread(
        service.list_verified_recipients, owner_user_id=owner_user_id, limit=RECIPIENT_LOOKUP_LIMIT
    )
    for row in recipients or []:
        if row and str(row.get("userId") or "") == user_id:
            return row
    return None


async def add_emergency_contact(ctx: ToolContext, args: EmergencyContactInput) -> ToolResult:
    person = ctx.entities.person(args.person.user_id)
    if person is None:
        return _unconfirmed()
    service = _service(ctx)
    try:
        before = list(
            await asyncio.to_thread(service.list_sms_contact_ids, owner_user_id=ctx.user_id)
        )
    except ServiceError as exc:
        return _rejected(exc)
    if person.user_id in before:
        return AddEmergencyContactResult(
            status="already_contact",
            reason_code="already_contact",
            person_user_id=person.user_id,
            display_name=person.display_name,
            emergency_contact_count=len(before),
            spoken_facts=[f"{person.display_name} is already one of your emergency contacts."],
        )
    try:
        after = list(
            await asyncio.to_thread(
                service.add_sms_contact, owner_user_id=ctx.user_id, contact_user_id=person.user_id
            )
        )
    except ServiceError as exc:
        code = str(exc.code)
        if code == "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED":
            return AddEmergencyContactResult(
                status="not_connected",
                reason_code=code,
                needs="invite",
                person_user_id=person.user_id,
                display_name=person.display_name,
                spoken_facts=[f"{person.display_name} isn't connected with you. {exc.message}"],
            )
        if code == "LOCATION_CIRCLE_ALREADY_MEMBER":
            return AddEmergencyContactResult(
                status="already_contact",
                reason_code=code,
                person_user_id=person.user_id,
                display_name=person.display_name,
                spoken_facts=[f"{person.display_name} is already one of your emergency contacts."],
            )
        if code == "LOCATION_RECIPIENT_UNAVAILABLE":
            try:
                row = await _recipient_row(service, ctx.user_id, person.user_id)
            except ServiceError:
                row = None
            phone_verified = bool(row.get("phoneVerified")) if row else person.phone_verified
            if not phone_verified:
                return AddEmergencyContactResult(
                    status="not_phone_verified",
                    reason_code=code,
                    needs="setup",
                    person_user_id=person.user_id,
                    display_name=person.display_name,
                    spoken_facts=[
                        f"{person.display_name} hasn't verified their phone. {exc.message}"
                    ],
                )
        return _rejected(exc)
    if person.user_id not in after:
        return Rejected(
            reason_code="emergency_contact_not_added",
            spoken_facts=[f"{person.display_name} was not added. Nothing changed."],
        )
    return AddEmergencyContactResult(
        status="added",
        person_user_id=person.user_id,
        display_name=person.display_name,
        emergency_contact_count=len(after),
        spoken_facts=[
            f"{person.display_name} is now an emergency contact.",
            f"You have {_plural(len(after), 'emergency contact')}.",
        ],
    )


# -- remove_emergency_contact --------------------------------------------------


class RemoveEmergencyContactResult(ToolResult):
    status: Literal["removed", "not_a_contact"]
    person_user_id: str | None = None
    display_name: str | None = None
    emergency_contact_count: int | None = None


async def remove_emergency_contact(ctx: ToolContext, args: EmergencyContactInput) -> ToolResult:
    person = ctx.entities.person(args.person.user_id)
    if person is None:
        return _unconfirmed()
    service = _service(ctx)
    try:
        before = list(
            await asyncio.to_thread(service.list_sms_contact_ids, owner_user_id=ctx.user_id)
        )
    except ServiceError as exc:
        return _rejected(exc)
    if person.user_id not in before:
        return RemoveEmergencyContactResult(
            status="not_a_contact",
            reason_code="not_a_contact",
            person_user_id=person.user_id,
            display_name=person.display_name,
            emergency_contact_count=len(before),
            spoken_facts=[f"{person.display_name} isn't one of your emergency contacts."],
        )
    try:
        after = list(
            await asyncio.to_thread(
                service.remove_sms_contact,
                owner_user_id=ctx.user_id,
                contact_user_id=person.user_id,
            )
        )
    except ServiceError as exc:
        return _rejected(exc)
    if person.user_id in after:
        return Rejected(
            reason_code="emergency_contact_not_removed",
            spoken_facts=[f"{person.display_name} is still an emergency contact. Nothing changed."],
        )
    return RemoveEmergencyContactResult(
        status="removed",
        person_user_id=person.user_id,
        display_name=person.display_name,
        emergency_contact_count=len(after),
        spoken_facts=[
            f"{person.display_name} is no longer an emergency contact.",
            (
                f"You have {_plural(len(after), 'emergency contact')} left."
                if after
                else "You have no emergency contacts left."
            ),
        ],
    )


# -- catalog --------------------------------------------------------------------


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="get_save_my_soul_status",
        gateway_action_id="location.open_sos",
        policy=ToolPolicy.read,
        input_model=SaveMySoulStatusInput,
        output_model=SaveMySoulStatusResult,
        description=(
            "Read Save My Soul (SOS) status: the emergency contacts by name, whether each is "
            "phone-verified and can receive an encrypted location, whether an SOS is active "
            "now and how many live shares it holds, and the person's default for a bare "
            "emergency phrase (open the SOS screen, or go straight to the trigger card). "
            "Reads only; it never sends an alert."
        ),
        handler=get_save_my_soul_status,
    ),
    ToolSpec(
        name="trigger_save_my_soul",
        gateway_action_id="location.trigger_sos",
        policy=ToolPolicy.confirm_tap,
        input_model=TriggerSaveMySoulInput,
        output_model=TriggerSaveMySoulResult,
        description=(
            "Arm a Save My Soul alert: after the person taps Confirm, one 8-hour SOS location "
            "share is created for every emergency contact who can receive it. The server holds no "
            "position, so this only ARMS the alert and returns a client_step "
            "(publish_location_envelopes) that the app runs to send the encrypted position. "
            "Never say the alert was 'sent' from this result: 'sent' may only be reported after "
            "the client publishes and report_save_my_soul_delivery verifies it on the server. "
            "It does not call emergency services. Optional note: a short message for the contacts."
        ),
        handler=trigger_save_my_soul,
        ui_refresh=UI_REFRESH_SOS,
        summarize=summarize_trigger,
    ),
    ToolSpec(
        name="report_save_my_soul_delivery",
        gateway_action_id="location.trigger_sos",
        policy=ToolPolicy.read,
        input_model=ReportSaveMySoulDeliveryInput,
        output_model=ReportSaveMySoulDeliveryResult,
        description=(
            "Verify on the server whether a Save My Soul position actually reached each contact: "
            "for the grant ids from trigger_save_my_soul, a contact counts as reached only when an "
            "encrypted position envelope is stored on their grant. Call it after the "
            "publish_location_envelopes client step finishes. Returns sos_sent, sos_partial, or "
            "sos_not_sent with the real names reached and not reached."
        ),
        handler=report_save_my_soul_delivery,
    ),
    ToolSpec(
        name="stop_save_my_soul",
        gateway_action_id="location.stop_sos",
        policy=ToolPolicy.confirm_tap,
        input_model=StopSaveMySoulInput,
        output_model=StopSaveMySoulResult,
        description=(
            "Stop the active Save My Soul: after the person taps Confirm, every live SOS location "
            "share is revoked. Reports the real number of shares ended. It does not tell anyone "
            "the person is safe."
        ),
        handler=stop_save_my_soul,
        ui_refresh=UI_REFRESH_SOS,
        summarize=summarize_stop,
    ),
    ToolSpec(
        name="add_emergency_contact",
        gateway_action_id="location.add_emergency_contact",
        policy=ToolPolicy.confirm_voice,
        input_model=EmergencyContactInput,
        output_model=AddEmergencyContactResult,
        description=(
            "Add a confirmed person to the emergency contacts who receive a Save My Soul alert. "
            "Takes a canonical person id only (resolve and confirm the person first). The person "
            "must be a connection with a verified phone who has finished Location setup; "
            "otherwise the result says which of those is missing."
        ),
        handler=add_emergency_contact,
        person_args=("person",),
        ui_refresh=UI_REFRESH_CONTACTS,
        summarize=summarize_add_contact,
    ),
    ToolSpec(
        name="remove_emergency_contact",
        gateway_action_id="location.remove_emergency_contact",
        policy=ToolPolicy.confirm_tap,
        input_model=EmergencyContactInput,
        output_model=RemoveEmergencyContactResult,
        description=(
            "Remove a confirmed person from the emergency contacts, so they no longer receive a "
            "Save My Soul alert. Takes a canonical person id only (resolve and confirm the person "
            "first). Does not end an SOS share that is already live."
        ),
        handler=remove_emergency_contact,
        person_args=("person",),
        ui_refresh=UI_REFRESH_CONTACTS,
        summarize=summarize_remove_contact,
    ),
)
