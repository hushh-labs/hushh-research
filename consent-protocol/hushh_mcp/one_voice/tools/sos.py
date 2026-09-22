"""Save My Soul (SOS) tools: emergency contacts, alert arming, delivery, stop.

Canonical contract (``OneLocationAgentService``): a Save My Soul alert is one
8-hour grant per phone-verified SMS contact, written with ``share_kind="sos"``
(legacy reason marker ``sos_panic``). The server never holds a position: the
location envelope is encrypted on the device, so ``trigger_save_my_soul`` can
only *arm* the alert and hand the client a ``publish_location_envelopes``
step. "Sent" is a fact only ``report_save_my_soul_delivery`` may state, and
only after the server sees a stored envelope on the grant.

Lifecycle guarantees this module owns:

* The trigger card is prepared from the live roster (``prepare_trigger``): it
  names exactly who will be alerted and who is left out, refuses a card when
  the roster cannot be read, and execution refuses to act on an audience that
  changed since the card was shown (``sos_audience_changed``).
* Arming runs under the owner-scoped ``sos_incident_guard`` so two attempts
  that race cannot both create a full set; a lost or refused create for one
  contact never hides the grants already created for the others.
* The delivery report is bound to the armed set recorded on the session
  (``ctx.sos_incident``) or, failing that, to every live SOS grant the sender
  owns; caller-supplied ids can add "unknown" rows but never narrow coverage.
  An unreadable verification is ``sos_unverified``, never "nothing changed".
* Stop counts a share as ended only on positive evidence (a revoked/expired
  status from the revoke, confirmed by a re-read); everything else stays
  ``unresolved`` and is reported as still possibly live.

All services here are the vault-owner plane (``user_id``); the SMS-contact
routes use the vault-owner token, so no tool sets ``firebase_plane``.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.one_voice.tools.base import (
    PersonRef,
    Prepared,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    now_iso,
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
# Same bound as the web client's ONE_LOCATION_SHARE_NOTE_MAX_LENGTH
# (hushh-webapp/lib/one-location/message-limits.ts): the manual surface
# rejects longer notes rather than truncating, and so does this input model.
SOS_NOTE_MAX_LENGTH = 140
# A cold GPS fix (up to 15 s), the fresh state load and one store per contact
# can exceed 25 s; the client caps a step at 60 s, so ask for all of it.
PUBLISH_ENVELOPES_TIMEOUT_S = 60
RECIPIENT_LOOKUP_LIMIT = 100
# Statuses of a revoke response that prove the share is over.
_ENDED_STATUSES = frozenset({"revoked", "expired"})

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
    # Scoped to the roster ids: a contact must never read as "no key" only
    # because they fell off the alphabetical page of every eligible recipient.
    recipients = service.list_verified_recipients(
        owner_user_id=user_id, limit=RECIPIENT_LOOKUP_LIMIT, user_ids=contact_ids
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


def _normalize_note(value: str | None) -> str | None:
    """Whitespace-collapsed note or None. Length is enforced by the input model
    (reject, not truncate), so what the card shows is what is sent."""
    return " ".join(str(value or "").split()) or None


def _offer_roster(ctx: ToolContext, user_ids: list[str]) -> None:
    current = list(ctx.entities.offered_person_ids) if ctx.entities.offer_is_fresh() else []
    merged = current + [uid for uid in user_ids if uid not in current]
    if merged:
        ctx.entities.offer_people(merged)


def _record_incident(ctx: ToolContext, grant_ids: list[str], *, source: str) -> None:
    """Bind this session to the alert's exact grant set. Correlation only: the
    server's grants and envelopes remain the authority for every outcome."""
    ctx.sos_incident = {
        "grant_ids": list(grant_ids),
        "armed_at": now_iso(),
        "source": source,
    }


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
    # The roster's ids are offered so "remove Priya" can be confirmed from the
    # people who are actually on it, not from a directory guess. A fresh offer
    # from a lookup in flight (resolve_person for "add Priya") is kept, not
    # clobbered: the roster is added to it.
    _offer_roster(ctx, [contact.user_id for contact in contacts])
    if grants:
        _record_incident(ctx, [grant.grant_id for grant in grants], source="status")
    else:
        # Nothing live on the server: a record this session still holds is
        # about an alert that has ended.
        ctx.sos_incident = None
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
        description=(
            "Optional short message shown to the contacts with the alert. Leave it out "
            "unless the person gave one; never ask for it before preparing the alert."
        ),
    )


class TriggerSaveMySoulResult(ToolResult):
    status: Literal["sos_grants_created", "no_emergency_contacts", "already_active"]
    grant_ids: list[str] = Field(default_factory=list)
    armed: list[SosGrantView] = Field(default_factory=list)
    skipped_no_key: list[EmergencyContactView] = Field(default_factory=list)
    skipped_not_phone_verified: list[EmergencyContactView] = Field(default_factory=list)
    failed: list[dict[str, str]] = Field(default_factory=list)
    note: str | None = None
    duration_hours: int = SOS_DURATION_HOURS
    precision: Literal["precise"] = "precise"
    client_step: dict[str, Any] | None = None


def _already_active(grants: list[SosGrantView]) -> TriggerSaveMySoulResult:
    return TriggerSaveMySoulResult(
        status="already_active",
        reason_code="sos_already_active",
        grant_ids=[grant.grant_id for grant in grants],
        armed=grants,
        spoken_facts=[
            "Save My Soul is already active for "
            f"{_spoken_roster([grant.display_name for grant in grants])}. "
            "I won't start another; you can check delivery or stop it."
        ],
    )


def _no_contacts() -> TriggerSaveMySoulResult:
    return TriggerSaveMySoulResult(
        status="no_emergency_contacts",
        reason_code="no_emergency_contacts",
        needs="setup",
        spoken_facts=["You have no emergency contacts yet, so no alert can be sent."],
    )


def _none_ready(contacts: list[EmergencyContactView]) -> Rejected:
    return Rejected(
        reason_code="no_sos_ready_contacts",
        needs="setup",
        spoken_facts=[
            f"{_spoken_roster([contact.display_name for contact in contacts])} can't receive "
            "your location yet, so no alert could be armed."
        ],
    )


def _roster_unavailable(exc: Exception) -> Rejected:
    return Rejected(
        reason_code="roster_unavailable",
        spoken_facts=[
            "I can't read your emergency contacts right now, so I haven't prepared an "
            "alert. You can open Save My Soul and send it by hand.",
            str(getattr(exc, "message", "") or ""),
        ],
    )


def _trigger_summary(
    ready: list[EmergencyContactView],
    excluded: list[EmergencyContactView],
    note: str | None,
) -> str:
    text = (
        f"send a Save My Soul alert to {_spoken_roster([c.display_name for c in ready])}: "
        f"your precise location for {SOS_DURATION_HOURS} hours"
    )
    if excluded:
        text += (
            f", leaving out {_spoken_roster([c.display_name for c in excluded], noun='contact')} "
            "who can't receive it yet"
        )
    if note:
        text += f', with the note "{note}"'
    return text


async def prepare_trigger(ctx: ToolContext, args: TriggerSaveMySoulInput) -> Prepared | ToolResult:
    """The exact effect the tap will approve, from the live roster.

    No card when the roster cannot be read (unavailable is not empty), when
    it is empty, when nobody on it can receive a location, or when an alert
    is already live; those are answered as typed results so the model
    narrates the real state instead of asking for a tap that would do
    nothing or something else.
    """
    service = _service(ctx)
    try:
        contacts = await _emergency_contacts(service, ctx.user_id)
        active = await _active_sos_grants(service, ctx.user_id)
    except Exception as exc:  # noqa: BLE001 - a DB outage is "unavailable", not "empty"
        return _roster_unavailable(exc)
    names_by_id = {contact.user_id: contact.display_name for contact in contacts}
    if active:
        grants = [_grant_view(grant, names_by_id) for grant in active]
        _record_incident(ctx, [grant.grant_id for grant in grants], source="prepare")
        return _already_active(grants)
    ctx.sos_incident = None
    if not contacts:
        return _no_contacts()
    ready = [contact for contact in contacts if contact.sos_ready]
    excluded = [contact for contact in contacts if not contact.sos_ready]
    if not ready:
        return _none_ready(contacts)
    note = _normalize_note(args.note)
    return Prepared(
        summary=_trigger_summary(ready, excluded, note),
        snapshot={
            "recipient_ids": sorted(contact.user_id for contact in ready),
            "excluded_ids": sorted(contact.user_id for contact in excluded),
            "note": note,
            "duration_hours": SOS_DURATION_HOURS,
            "precision": "precise",
        },
    )


def summarize_trigger(ctx: ToolContext, args: TriggerSaveMySoulInput) -> str:
    """Fallback card sentence; ``prepare_trigger`` normally supplies the summary."""
    return "send a Save My Soul alert to your emergency contacts"


@dataclass
class _Armed:
    """Outcome of the guarded arming pass (runs in one worker thread)."""

    kind: Literal["armed", "already_active", "audience_changed", "no_contacts", "none_ready"]
    contacts: list[EmergencyContactView] = field(default_factory=list)
    ready: list[EmergencyContactView] = field(default_factory=list)
    active: list[SosGrantView] = field(default_factory=list)
    armed: list[SosGrantView] = field(default_factory=list)
    skipped_no_key: list[EmergencyContactView] = field(default_factory=list)
    skipped_not_verified: list[EmergencyContactView] = field(default_factory=list)
    failed: list[dict[str, str]] = field(default_factory=list)
    first_error: Exception | None = None


def _arm_sync(
    service: Any, user_id: str, prepared: dict[str, Any] | None, note: str | None
) -> _Armed:
    """Re-read, drift-check and create, all under the owner's incident lock.

    Every created grant is recorded in the outcome before the next contact is
    attempted; a refused or crashed create for one contact is recorded as
    failed for that contact and never hides the grants that already exist.
    """
    guard = getattr(service, "sos_incident_guard", None)
    context = guard(owner_user_id=user_id) if callable(guard) else _NullGuard()
    outcome: _Armed | None = None
    try:
        with context:
            outcome = _arm_under_lock(service, user_id, prepared, note)
    except Exception:
        # The lock connection can fail on release after the grants were
        # created on other connections; those grants exist and must be
        # published, not hidden behind "can't confirm whether anything changed".
        if outcome is not None and outcome.kind == "armed" and outcome.armed:
            return outcome
        raise
    return outcome


def _arm_under_lock(
    service: Any, user_id: str, prepared: dict[str, Any] | None, note: str | None
) -> _Armed:
    if True:
        contacts = _emergency_contacts_sync(service, user_id)
        names_by_id = {contact.user_id: contact.display_name for contact in contacts}
        active_rows = [
            grant
            for grant in (service.list_active_owner_grants(owner_user_id=user_id) or [])
            if grant and _is_sos_grant(grant) and _is_live(grant)
        ]
        if active_rows:
            return _Armed(
                kind="already_active",
                contacts=contacts,
                active=[_grant_view(grant, names_by_id) for grant in active_rows],
            )
        if not contacts:
            return _Armed(kind="no_contacts")
        ready = [contact for contact in contacts if contact.sos_ready]
        if not ready:
            return _Armed(kind="none_ready", contacts=contacts)
        expected = (prepared or {}).get("recipient_ids")
        if isinstance(expected, list) and sorted(contact.user_id for contact in ready) != sorted(
            str(uid) for uid in expected
        ):
            # The audience the person approved is not the audience this
            # would alert. No grant is created; a new card must be shown.
            return _Armed(kind="audience_changed", contacts=contacts, ready=ready)
        outcome = _Armed(kind="armed", contacts=contacts, ready=ready)
        for contact in contacts:
            if not contact.has_location_key:
                outcome.skipped_no_key.append(contact)
                continue
            if not contact.phone_verified:
                outcome.skipped_not_verified.append(contact)
                continue
            try:
                grant = service.create_grant(
                    owner_user_id=user_id,
                    recipient_user_id=contact.user_id,
                    recipient_key_id=contact.key_id,
                    duration_hours=SOS_DURATION_HOURS,
                    duration_mode=SOS_DURATION_MODE,
                    reason=note or SOS_LEGACY_REASON,
                    share_kind=SOS_SHARE_KIND,
                    require_recipient_phone_verified=True,
                    enforce_connection=False,
                )
            except Exception as exc:  # noqa: BLE001 - one contact must not sink the others
                outcome.first_error = outcome.first_error or exc
                outcome.failed.append(
                    {
                        "user_id": contact.user_id,
                        "display_name": contact.display_name or "",
                        "reason_code": str(getattr(exc, "code", "") or type(exc).__name__),
                    }
                )
                continue
            outcome.armed.append(_grant_view(grant or {}, names_by_id))
        return outcome


class _NullGuard:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_: Any) -> None:
        return None


async def trigger_save_my_soul(ctx: ToolContext, args: TriggerSaveMySoulInput) -> ToolResult:
    service = _service(ctx)
    note = _normalize_note(args.note)
    try:
        result = await asyncio.to_thread(_arm_sync, service, ctx.user_id, ctx.prepared, note)
    except ServiceError as exc:
        return _rejected(exc)
    if result.kind == "already_active":
        _record_incident(ctx, [grant.grant_id for grant in result.active], source="trigger")
        return _already_active(result.active)
    if result.kind == "no_contacts":
        return _no_contacts()
    if result.kind == "none_ready":
        return _none_ready(result.contacts)
    if result.kind == "audience_changed":
        return Rejected(
            reason_code="sos_audience_changed",
            needs="confirmation",
            spoken_facts=[
                "Your emergency contacts changed since that card was shown, so I didn't send "
                f"it. Now it would go to {_spoken_roster([c.display_name for c in result.ready])}. "
                "Ask again and I'll prepare a new card."
            ],
        )
    armed = result.armed
    left_out: list[str | None] = [
        contact.display_name for contact in result.skipped_no_key + result.skipped_not_verified
    ] + [row["display_name"] or None for row in result.failed]
    if not armed:
        if result.first_error is not None and isinstance(result.first_error, ServiceError):
            return _rejected(result.first_error)
        if result.first_error is not None:
            return Rejected(
                reason_code="sos_arm_failed",
                spoken_facts=["The alert could not be armed. No location share was created."],
            )
        return _none_ready(result.contacts)
    grant_ids = [grant.grant_id for grant in armed]
    _record_incident(ctx, grant_ids, source="trigger")
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
        skipped_no_key=result.skipped_no_key,
        skipped_not_phone_verified=result.skipped_not_verified,
        failed=result.failed,
        note=note,
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
        default_factory=list,
        max_length=50,
        description=(
            "Optional. The report always covers the whole armed alert; ids given here "
            "that are not part of it are listed as unknown and never narrow the report."
        ),
    )


class ReportSaveMySoulDeliveryResult(ToolResult):
    status: Literal["sos_sent", "sos_partial", "sos_not_sent", "sos_unverified"]
    delivered: list[str] = Field(default_factory=list)
    not_alerted: list[str] = Field(default_factory=list)
    delivered_grant_ids: list[str] = Field(default_factory=list)
    not_alerted_grant_ids: list[str] = Field(default_factory=list)
    ended_grant_ids: list[str] = Field(default_factory=list)
    unknown_grant_ids: list[str] = Field(default_factory=list)
    expected_grant_ids: list[str] = Field(default_factory=list)
    # None when the server could not be read: unknown is not "no".
    alert_active: bool | None = False


def _unverified(exc: Exception | None, expected: list[str]) -> ReportSaveMySoulDeliveryResult:
    return ReportSaveMySoulDeliveryResult(
        status="sos_unverified",
        reason_code="verification_unavailable",
        spoken_facts=[
            "I can't verify delivery right now. The alert may still be live and your "
            "position may have reached your contacts; check Save My Soul or ask me again.",
        ],
        expected_grant_ids=list(expected),
        alert_active=True if expected else None,
    )


async def report_save_my_soul_delivery(
    ctx: ToolContext, args: ReportSaveMySoulDeliveryInput
) -> ToolResult:
    """Server-side verification: a grant counts as delivered only when the
    client's encrypted position envelope is stored on it.

    Coverage is the alert this session armed (or every live SOS grant the
    sender owns when the session holds no record, e.g. after a reconnect).
    Ids the caller supplies can only add "unknown" rows.
    """
    service = _service(ctx)
    recorded = [str(gid) for gid in ((ctx.sos_incident or {}).get("grant_ids") or []) if gid]
    try:
        grants = await asyncio.to_thread(
            service.list_active_owner_grants, owner_user_id=ctx.user_id
        )
    except Exception as exc:  # noqa: BLE001 - unverifiable is a state, not "nothing changed"
        return _unverified(exc, recorded)
    live = {
        str(grant.get("id") or ""): grant
        for grant in grants or []
        if grant
        and _is_sos_grant(grant)
        and str(grant.get("ownerUserId") or ctx.user_id) == ctx.user_id
        and _is_live(grant)
    }
    live_ids = sorted(live)
    # The session record binds the report to the alert this session armed,
    # but the server decides whether that alert still exists: a record with
    # no live grant left is about an alert that ended (stopped from the app,
    # expired, replaced), so the report covers what is live now instead.
    recorded_live = [gid for gid in recorded if gid in live]
    if recorded and not recorded_live and not live_ids:
        ctx.sos_incident = None
        return ReportSaveMySoulDeliveryResult(
            status="sos_unverified",
            reason_code="alert_ended",
            spoken_facts=[
                "That Save My Soul alert has ended, so its delivery can't be verified now."
            ],
            ended_grant_ids=list(recorded),
            alert_active=False,
        )
    if recorded and not recorded_live:
        _record_incident(ctx, live_ids, source="report")
        recorded = live_ids
    expected = recorded or live_ids
    supplied = [gid.strip() for gid in args.grant_ids if gid and gid.strip()]
    unknown = sorted({gid for gid in supplied if gid not in expected})
    if not expected:
        return ReportSaveMySoulDeliveryResult(
            status="sos_not_sent",
            reason_code="no_active_sos",
            spoken_facts=["There's no Save My Soul alert to check."],
            unknown_grant_ids=unknown,
        )
    delivered: list[SosGrantView] = []
    not_alerted: list[SosGrantView] = []
    ended: list[str] = []
    for grant_id in expected:
        grant = live.get(grant_id)
        if grant is None:
            ended.append(grant_id)
            continue
        view = _grant_view(grant)
        (delivered if view.has_envelope else not_alerted).append(view)
    if delivered and not not_alerted and not ended:
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
            f"Your position has not reached {_spoken_roster([g.display_name for g in not_alerted], noun='contact')}; "
            "their share is armed but nothing was sent to them."
        )
    if ended:
        facts.append(f"{_plural(len(ended), 'share')} from this alert already ended.")
    if unknown:
        facts.append(f"{_plural(len(unknown), 'id')} you asked about is not part of this alert.")
    if status == "sos_not_sent":
        facts.append(
            "The alert is still armed; you can try sending again or stop Save My Soul."
            if not_alerted
            else "Nothing from this alert is live any more."
        )
    return ReportSaveMySoulDeliveryResult(
        status=status,
        spoken_facts=facts,
        delivered=[g.display_name or g.user_id for g in delivered],
        not_alerted=[g.display_name or g.user_id for g in not_alerted],
        delivered_grant_ids=[g.grant_id for g in delivered],
        not_alerted_grant_ids=[g.grant_id for g in not_alerted],
        ended_grant_ids=ended,
        unknown_grant_ids=unknown,
        expected_grant_ids=list(expected),
        alert_active=bool(delivered or not_alerted),
        reason_code=None if status == "sos_sent" else "envelope_missing",
    )


# -- stop_save_my_soul ---------------------------------------------------------


class StopSaveMySoulInput(ToolInput):
    pass


class StopSaveMySoulResult(ToolResult):
    status: Literal["sos_stopped", "sos_partially_stopped", "not_active"]
    stopped_count: int = 0
    stopped: list[SosGrantView] = Field(default_factory=list)
    unresolved: list[SosGrantView] = Field(default_factory=list)
    unresolved_grant_ids: list[str] = Field(default_factory=list)
    failed: list[dict[str, str]] = Field(default_factory=list)


def _not_active() -> StopSaveMySoulResult:
    return StopSaveMySoulResult(
        status="not_active",
        reason_code="sos_not_active",
        spoken_facts=["Save My Soul isn't active, so there was nothing to stop."],
    )


async def prepare_stop(ctx: ToolContext, args: StopSaveMySoulInput) -> Prepared | ToolResult:
    """The stop card names the live shares it will end; no card when there is
    nothing live or the state cannot be read."""
    service = _service(ctx)
    try:
        active = await _active_sos_grants(service, ctx.user_id)
    except Exception as exc:  # noqa: BLE001 - unreadable state never becomes a card
        return Rejected(
            reason_code="sos_state_unavailable",
            spoken_facts=[
                "I can't read your Save My Soul shares right now, so I haven't prepared a "
                "stop. Nothing was changed.",
                str(getattr(exc, "message", "") or ""),
            ],
        )
    if not active:
        ctx.sos_incident = None
        return _not_active()
    views = [_grant_view(grant) for grant in active]
    return Prepared(
        summary=(
            f"stop Save My Soul and end {_plural(len(views), 'live location share')} to "
            f"{_spoken_roster([v.display_name for v in views], noun='contact')}"
        ),
        snapshot={"grant_ids": sorted(v.grant_id for v in views)},
    )


def summarize_stop(ctx: ToolContext, args: StopSaveMySoulInput) -> str:
    return "stop Save My Soul and end every emergency location share it started"


class _StopScopeChanged(Exception):
    def __init__(self, views: list[SosGrantView]) -> None:
        super().__init__("sos_scope_changed")
        self.views = views


def _stop_sync(
    service: Any, user_id: str, prepared: dict[str, Any] | None
) -> tuple[list[SosGrantView], list[SosGrantView], list[dict[str, str]]]:
    """Revoke every live SOS share; classify by positive evidence only.

    Returns (stopped, unresolved, reasons). A share is stopped when the revoke
    answered revoked/expired AND a re-read no longer lists it live; a lost,
    malformed or refused revoke, or a re-read that still shows it, leaves it
    unresolved. If the re-read itself fails, only revokes with a positive
    answer count. A live share the card never named (a re-arm elsewhere
    after the card was shown) is not revoked on that card's tap.
    """
    active = [
        grant
        for grant in (service.list_active_owner_grants(owner_user_id=user_id) or [])
        if grant and _is_sos_grant(grant) and _is_live(grant)
    ]
    views = [_grant_view(grant) for grant in active]
    named = (prepared or {}).get("grant_ids")
    if isinstance(named, list) and any(v.grant_id not in set(map(str, named)) for v in views):
        raise _StopScopeChanged(views)
    evidence: dict[str, bool] = {}
    reasons: list[dict[str, str]] = []
    for view in views:
        try:
            result = service.revoke_grant(owner_user_id=user_id, grant_id=view.grant_id)
        except Exception as exc:  # noqa: BLE001 - a lost revoke is unresolved, not stopped
            evidence[view.grant_id] = False
            reasons.append(
                {
                    "grant_id": view.grant_id,
                    "reason_code": str(getattr(exc, "code", "") or type(exc).__name__),
                }
            )
            continue
        status = str((result or {}).get("status") or "") if isinstance(result, dict) else ""
        matches = isinstance(result, dict) and str(result.get("id") or "") == view.grant_id
        ok = bool(matches and status in _ENDED_STATUSES)
        evidence[view.grant_id] = ok
        if not ok:
            reasons.append({"grant_id": view.grant_id, "reason_code": status or "no_confirmation"})
    still_live: set[str] | None
    try:
        still_live = {
            str(grant.get("id") or "")
            for grant in (service.list_active_owner_grants(owner_user_id=user_id) or [])
            if grant and _is_sos_grant(grant) and _is_live(grant)
        }
    except Exception:  # noqa: BLE001 - the re-read is confirmation, not the only evidence
        still_live = None
    stopped: list[SosGrantView] = []
    unresolved: list[SosGrantView] = []
    for view in views:
        proven = evidence.get(view.grant_id, False)
        if still_live is not None and view.grant_id in still_live:
            proven = False
            if not any(row["grant_id"] == view.grant_id for row in reasons):
                reasons.append({"grant_id": view.grant_id, "reason_code": "still_active"})
        (stopped if proven else unresolved).append(view)
    return stopped, unresolved, reasons


async def stop_save_my_soul(ctx: ToolContext, args: StopSaveMySoulInput) -> ToolResult:
    service = _service(ctx)
    try:
        stopped, unresolved, reasons = await asyncio.to_thread(
            _stop_sync, service, ctx.user_id, ctx.prepared
        )
    except _StopScopeChanged as changed:
        return Rejected(
            reason_code="sos_scope_changed",
            needs="confirmation",
            spoken_facts=[
                "The live Save My Soul shares changed since that card was shown, so I "
                f"didn't stop anything. Live now: {_plural(len(changed.views), 'share')} to "
                f"{_spoken_roster([v.display_name for v in changed.views], noun='contact')}. "
                "Ask again and I'll prepare a new card."
            ],
        )
    except ServiceError as exc:
        return _rejected(exc)
    if not stopped and not unresolved:
        ctx.sos_incident = None
        return _not_active()
    if not stopped:
        return Rejected(
            reason_code="sos_stop_failed",
            spoken_facts=[
                "Save My Soul could not be stopped. "
                f"{_plural(len(unresolved), 'location share')} may still be live."
            ],
        )
    if unresolved:
        _record_incident(ctx, [v.grant_id for v in unresolved], source="stop")
        return StopSaveMySoulResult(
            status="sos_partially_stopped",
            reason_code="sos_partially_stopped",
            spoken_facts=[
                f"{_plural(len(stopped), 'location share')} to "
                f"{_spoken_roster([g.display_name for g in stopped], noun='contact')} ended, "
                f"but {_plural(len(unresolved), 'share')} to "
                f"{_spoken_roster([g.display_name for g in unresolved], noun='contact')} "
                "may still be live. Check Save My Soul or ask me to stop it again.",
            ],
            stopped_count=len(stopped),
            stopped=stopped,
            unresolved=unresolved,
            unresolved_grant_ids=[v.grant_id for v in unresolved],
            failed=reasons,
        )
    ctx.sos_incident = None
    return StopSaveMySoulResult(
        status="sos_stopped",
        spoken_facts=[
            f"Save My Soul stopped; {_plural(len(stopped), 'location share')} to "
            f"{_spoken_roster([g.display_name for g in stopped], noun='contact')} ended."
        ],
        stopped_count=len(stopped),
        stopped=stopped,
        failed=reasons,
    )


# -- add_emergency_contact -----------------------------------------------------


class EmergencyContactInput(ToolInput):
    person: PersonRef


class AddEmergencyContactResult(ToolResult):
    status: Literal[
        "added", "already_contact", "not_phone_verified", "not_connected", "roster_full"
    ]
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
        if code == "LOCATION_CIRCLE_INVITE_CAPACITY_REACHED":
            return AddEmergencyContactResult(
                status="roster_full",
                reason_code=code,
                person_user_id=person.user_id,
                display_name=person.display_name,
                emergency_contact_count=len(before),
                spoken_facts=[
                    f"Your emergency contacts list is full, so {person.display_name} was not "
                    "added. Remove someone first."
                ],
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
    facts = [
        f"{person.display_name} is now an emergency contact.",
        f"You have {_plural(len(after), 'emergency contact')}.",
    ]
    if await _sos_is_live(service, ctx.user_id):
        # A roster change is about future alerts; the live one keeps its set.
        facts.append(
            f"The Save My Soul alert that is active now was not sent to {person.display_name}."
        )
    return AddEmergencyContactResult(
        status="added",
        person_user_id=person.user_id,
        display_name=person.display_name,
        emergency_contact_count=len(after),
        spoken_facts=facts,
    )


async def _sos_is_live(service: Any, user_id: str) -> bool:
    try:
        return bool(await _active_sos_grants(service, user_id))
    except Exception:  # noqa: BLE001 - a disclosure, never a blocker for the roster change
        return False


async def _live_share_for(service: Any, user_id: str, recipient_id: str) -> bool:
    try:
        grants = await _active_sos_grants(service, user_id)
    except Exception:  # noqa: BLE001 - same: disclosure only
        return False
    return any(str(grant.get("recipientUserId") or "") == recipient_id for grant in grants)


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
    facts = [
        f"{person.display_name} is no longer an emergency contact.",
        (
            f"You have {_plural(len(after), 'emergency contact')} left."
            if after
            else "You have no emergency contacts left."
        ),
    ]
    if await _live_share_for(service, ctx.user_id, person.user_id):
        # Removing from the roster never revokes a share that is already live.
        facts.append(
            f"The live Save My Soul share to {person.display_name} is still running; "
            "stopping Save My Soul is a separate step."
        )
    return RemoveEmergencyContactResult(
        status="removed",
        person_user_id=person.user_id,
        display_name=person.display_name,
        emergency_contact_count=len(after),
        spoken_facts=facts,
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
            "Read Save My Soul (SMS) status: the emergency contacts by name, whether each is "
            "phone-verified and can receive an encrypted location, whether an alert is active "
            "now and how many live shares it holds, and the person's default for a bare "
            "emergency phrase. Use it for 'who will get my alert', 'is it active', or before "
            "editing emergency contacts (it offers the roster's ids for confirm_person). Reads "
            "only; it never sends an alert. To just open the screen, use open_screen."
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
            "Prepare a Save My Soul alert to the person's emergency contacts. Call it as soon as "
            "the person clearly asks to alert their emergency contacts (with or without a note; "
            "never ask for a note first; a politely phrased ask, 'could you send it?', is still a request). Not for "
            "a single bare word like 'help', 'emergency' or 'SMS' with nothing else: ask one short "
            "question or open the screen instead. It shows a card naming exactly who will get "
            "their precise location for 8 hours; only the person's tap on that card arms it, and "
            "a spoken or typed yes cannot. After the tap it returns sos_grants_created, which "
            "means ARMED, not sent: the app then publishes the encrypted position and the server "
            "verifies delivery (report_save_my_soul_delivery). Never say 'sent' from this result. "
            "It always sends the precise location to the whole emergency roster for 8 hours; it "
            "cannot pick one person, shorten the time, send an approximate or rough location, or "
            "add someone who is not an emergency contact — for those, call nothing, explain, and "
            "ask. It does not call emergency services."
        ),
        handler=trigger_save_my_soul,
        ui_refresh=UI_REFRESH_SOS,
        summarize=summarize_trigger,
        prepare=prepare_trigger,
        device_step=True,
    ),
    ToolSpec(
        name="report_save_my_soul_delivery",
        gateway_action_id="location.verify_sos_delivery",
        policy=ToolPolicy.read,
        input_model=ReportSaveMySoulDeliveryInput,
        output_model=ReportSaveMySoulDeliveryResult,
        description=(
            "Verify on the server whether the Save My Soul position actually reached each "
            "emergency contact: a contact counts as reached only when an encrypted position "
            "envelope is stored on their SOS share. It always checks the whole armed alert. Use "
            "it for 'did it go through' after an alert; it never sends or resends anything. "
            "Returns sos_sent, sos_partial, sos_not_sent, or sos_unverified (the check itself "
            "could not run) with the real names reached and not reached."
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
            "Stop the active Save My Soul: shows a card naming the live SOS location shares it "
            "will end; only the person's tap revokes them. Reports the shares that verifiably "
            "ended and any that may still be live (sos_partially_stopped). It does not tell "
            "anyone the person is safe and does not touch ordinary location sharing. Only for an "
            "explicit ask to stop or end the alert: not for 'I'm safe now' or 'everything's fine' "
            "on its own (say stopping tells nobody and ask), not for 'stop listening' (that is "
            "the voice session), and not for cancelling a card that was never confirmed."
        ),
        handler=stop_save_my_soul,
        ui_refresh=UI_REFRESH_SOS,
        summarize=summarize_stop,
        prepare=prepare_stop,
    ),
    ToolSpec(
        name="add_emergency_contact",
        gateway_action_id="location.add_emergency_contact",
        policy=ToolPolicy.confirm_voice,
        input_model=EmergencyContactInput,
        output_model=AddEmergencyContactResult,
        description=(
            "Add a confirmed person to the emergency contacts who receive future Save My Soul "
            "alerts. Takes a canonical person id only (resolve and confirm the person first). "
            "The person must be a connection with a verified phone who has finished Location "
            "setup; otherwise the result says which of those is missing. Adding never sends an "
            "alert, and never adds a whole circle."
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
            "Remove a confirmed person from the emergency contacts, so they no longer receive "
            "future Save My Soul alerts. Takes a canonical person id only, and only after "
            "confirm_person: read get_save_my_soul_status, call confirm_person with that "
            "contact's user_id, then call this; an id straight from the status read is refused. "
            "Does not end an SOS share that is already live; stop_save_my_soul does that."
        ),
        handler=remove_emergency_contact,
        person_args=("person",),
        ui_refresh=UI_REFRESH_CONTACTS,
        summarize=summarize_remove_contact,
    ),
)
