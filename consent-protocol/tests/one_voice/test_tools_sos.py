"""Save My Soul voice tools: arming, verified delivery, stop, emergency contacts.

Handlers are called directly with a service double injected through
``ToolContext.services``; the registry is not imported so this file does not
depend on the other tool families.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import sos
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    PersonRef,
    Prepared,
    Rejected,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    now_iso,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_circle_service import OneLocationCircleError

OWNER = "owner-user"
AYESHA = "user-ayesha"
RAVI = "user-ravi"
MEERA = "user-meera"


def _future(hours: float = 7.5) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _past(hours: float = 1) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


def _recipient(
    user_id: str, name: str, *, key: bool = True, verified: bool = True
) -> dict[str, Any]:
    return {
        "userId": user_id,
        "displayName": name,
        "phoneVerified": verified,
        "keyId": f"key-{user_id}" if key else None,
        "publicKeyJwk": {"kty": "EC"} if key else None,
        "canReceiveLocation": key,
    }


def _grant(
    grant_id: str,
    recipient: str,
    name: str,
    *,
    kind: str = "sos",
    status: str = "active",
    envelope: bool = False,
    expires_at: str | None = None,
) -> dict[str, Any]:
    return {
        "id": grant_id,
        "ownerUserId": OWNER,
        "recipientUserId": recipient,
        "recipientDisplayName": name,
        "recipientKeyId": f"key-{recipient}",
        "status": status,
        "shareKind": kind,
        "expiresAt": expires_at or _future(),
        "latestEnvelopeId": f"env-{grant_id}" if envelope else None,
    }


class FakeLocationService:
    """Sync double for the parts of OneLocationAgentService the SOS tools call."""

    def __init__(self) -> None:
        self.sms_contact_ids: list[str] = []
        self.recipients: list[dict[str, Any]] = []
        self.owner_grants: list[dict[str, Any]] = []
        self.sos_voice_preference: dict[str, Any] = {"defaultAction": "open", "updatedAt": None}
        self.create_errors: dict[str, Exception] = {}
        self.add_error: Exception | None = None
        self.remove_error: Exception | None = None
        self.revoke_errors: dict[str, Exception] = {}
        self.roster_error: Exception | None = None
        self.created: list[dict[str, Any]] = []
        self.revoked: list[str] = []
        self.calls: list[str] = []
        self.recipient_filters: list[list[str]] = []
        self.guard_depth = 0
        self.guard_entries = 0
        # Per-grant override of what revoke_grant answers (None = malformed/lost).
        self.revoke_responses: dict[str, Any] = {}
        # Raised by the second list_active_owner_grants read of a stop.
        self.reread_error: Exception | None = None
        self._grant_reads = 0
        self._seq = 0

    # reads
    def list_sms_contact_ids(self, *, owner_user_id: str) -> list[str]:
        self.calls.append("list_sms_contact_ids")
        if self.roster_error is not None:
            raise self.roster_error
        assert owner_user_id == OWNER
        return list(self.sms_contact_ids)

    def list_verified_recipients(
        self, *, owner_user_id: str, limit: int = 50, user_ids: list[str] | None = None
    ) -> list[dict[str, Any]]:
        self.calls.append("list_verified_recipients")
        assert owner_user_id == OWNER
        assert limit >= 50
        rows = [dict(row) for row in self.recipients]
        if user_ids is not None:
            # The roster-scoped read: only the ids asked for, in page order.
            self.recipient_filters.append(list(user_ids))
            rows = [row for row in rows if row["userId"] in set(user_ids)]
        return rows

    @contextmanager
    def sos_incident_guard(self, *, owner_user_id: str) -> Iterator[None]:
        assert owner_user_id == OWNER
        self.guard_depth += 1
        self.guard_entries += 1
        try:
            yield
        finally:
            self.guard_depth -= 1

    def list_active_owner_grants(self, *, owner_user_id: str) -> list[dict[str, Any]]:
        self.calls.append("list_active_owner_grants")
        assert owner_user_id == OWNER
        self._grant_reads += 1
        if self.reread_error is not None and self._grant_reads > 1:
            raise self.reread_error
        return [dict(row) for row in self.owner_grants if row["status"] == "active"]

    def get_sos_voice_preference(self, *, user_id: str) -> dict[str, Any]:
        assert user_id == OWNER
        return dict(self.sos_voice_preference)

    # writes
    def create_grant(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append("create_grant")
        # Arming must happen under the owner's incident lock.
        assert self.guard_depth == 1, "create_grant outside sos_incident_guard"
        recipient = kwargs["recipient_user_id"]
        if recipient in self.create_errors:
            raise self.create_errors[recipient]
        self.created.append(kwargs)
        self._seq += 1
        row = next(r for r in self.recipients if r["userId"] == recipient)
        grant = _grant(
            f"grant-{self._seq}", recipient, row["displayName"], kind=kwargs["share_kind"]
        )
        self.owner_grants.append(grant)
        return dict(grant)

    def revoke_grant(self, *, owner_user_id: str, grant_id: str) -> dict[str, Any]:
        self.calls.append("revoke_grant")
        assert owner_user_id == OWNER
        if grant_id in self.revoke_errors:
            raise self.revoke_errors[grant_id]
        if grant_id in self.revoke_responses:
            # The write may or may not have landed; the answer is what's given.
            return self.revoke_responses[grant_id]
        for row in self.owner_grants:
            if row["id"] == grant_id:
                row["status"] = "revoked"
                self.revoked.append(grant_id)
                return dict(row)
        raise OneLocationAgentError("LOCATION_GRANT_NOT_FOUND", "Share not found.", status_code=404)

    def add_sms_contact(
        self, *, owner_user_id: str, contact_user_id: str, operation_id: str | None = None
    ) -> list[str]:
        self.calls.append("add_sms_contact")
        assert owner_user_id == OWNER
        if self.add_error is not None:
            raise self.add_error
        if contact_user_id not in self.sms_contact_ids:
            self.sms_contact_ids.append(contact_user_id)
        return list(self.sms_contact_ids)

    def remove_sms_contact(
        self, *, owner_user_id: str, contact_user_id: str, operation_id: str | None = None
    ) -> list[str]:
        self.calls.append("remove_sms_contact")
        assert owner_user_id == OWNER
        if self.remove_error is not None:
            raise self.remove_error
        self.sms_contact_ids = [uid for uid in self.sms_contact_ids if uid != contact_user_id]
        return list(self.sms_contact_ids)


def _ctx(
    service: FakeLocationService | None = None, *, confirmed: dict[str, str] | None = None
) -> ToolContext:
    entities = EntityContext()
    for user_id, name in (confirmed or {}).items():
        entities.remember_person(
            ConfirmedPerson(
                user_id=user_id,
                display_name=name,
                relationship="connected",
                phone_verified=True,
                has_location_key=True,
                confirmed_at=now_iso(),
            )
        )
    return ToolContext(
        user_id=OWNER,
        conversation_id="conv-1",
        entities=entities,
        screen=ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test fixture, not a secret
        services={"location": service} if service is not None else {},
    )


def _tool(name: str):
    return next(tool for tool in sos.TOOLS if tool.name == name)


def _ready_service() -> FakeLocationService:
    service = FakeLocationService()
    service.sms_contact_ids = [AYESHA, RAVI]
    service.recipients = [
        _recipient(AYESHA, "Ayesha Sharma"),
        _recipient(RAVI, "Ravi Kumar"),
        _recipient(MEERA, "Meera Nair"),  # a connection who is not an emergency contact
    ]
    return service


# -- catalog ------------------------------------------------------------------


def test_catalog_binds_each_tool_to_the_briefed_policy_and_gateway_id():
    expected = {
        "get_save_my_soul_status": (ToolPolicy.read, "location.open_sos"),
        "trigger_save_my_soul": (ToolPolicy.confirm_tap, "location.trigger_sos"),
        "report_save_my_soul_delivery": (ToolPolicy.read, "location.verify_sos_delivery"),
        "stop_save_my_soul": (ToolPolicy.confirm_tap, "location.stop_sos"),
        "add_emergency_contact": (ToolPolicy.confirm_voice, "location.add_emergency_contact"),
        "remove_emergency_contact": (ToolPolicy.confirm_tap, "location.remove_emergency_contact"),
    }
    assert {tool.name for tool in sos.TOOLS} == set(expected)
    for tool in sos.TOOLS:
        policy, action_id = expected[tool.name]
        assert tool.policy is policy, tool.name
        assert tool.gateway_action_id == action_id, tool.name
        assert tool.firebase_plane is False, tool.name
        if tool.policy.needs_confirmation:
            assert tool.summarize is not None, tool.name
        # Every output vocabulary is a Literal the registry can project.
        annotation = tool.output_model.model_fields["status"].annotation
        assert all(isinstance(item, str) for item in annotation.__args__), tool.name
        # Declarations inline PersonRef so the model sees only a user_id slot.
        assert "$defs" not in tool.declaration()["parameters_json_schema"]
    # The two device-consequential cards are prepared from live state, and the
    # trigger can only be confirmed inside a session that can run its step.
    assert _tool("trigger_save_my_soul").prepare is sos.prepare_trigger
    assert _tool("trigger_save_my_soul").device_step is True
    assert _tool("stop_save_my_soul").prepare is sos.prepare_stop
    assert all(not t.device_step for t in sos.TOOLS if t.name != "trigger_save_my_soul")


def test_person_tools_take_only_canonical_ids():
    for name in ("add_emergency_contact", "remove_emergency_contact"):
        tool = _tool(name)
        assert tool.person_args == ("person",)
        schema = tool.declaration()["parameters_json_schema"]
        assert schema["properties"]["person"]["properties"].keys() == {"user_id"}
        assert schema["properties"]["person"]["additionalProperties"] is False
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"person": {"user_id": RAVI, "display_name": "Ravi"}})
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"person": {"name": "Ravi Kumar"}})
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"person_name": "Ravi Kumar"})
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"person": "Ravi Kumar"})


def test_trigger_and_stop_refuse_free_text_recipients():
    with pytest.raises(ValidationError):
        sos.TriggerSaveMySoulInput.model_validate({"contacts": ["Ravi"]})
    with pytest.raises(ValidationError):
        sos.TriggerSaveMySoulInput.model_validate({"note": "x" * 141})
    with pytest.raises(ValidationError):
        sos.StopSaveMySoulInput.model_validate({"person": "Ravi"})
    # The report needs no ids: it always covers the whole armed alert.
    assert sos.ReportSaveMySoulDeliveryInput.model_validate({}).grant_ids == []
    with pytest.raises(ValidationError):
        sos.ReportSaveMySoulDeliveryInput.model_validate({"grant_ids": ["g"] * 51})
    assert sos.TriggerSaveMySoulInput.model_validate({}).note is None
    # 140 is the shared bound (message-limits.ts); 141 is rejected, never truncated.
    assert sos.TriggerSaveMySoulInput.model_validate({"note": "x" * 140}).note == "x" * 140


def test_trigger_description_states_that_sent_needs_client_publish_and_server_verification():
    description = _tool("trigger_save_my_soul").description
    assert "publish" in description and "verif" in description
    assert "ARMED, not sent" in description and "Never say 'sent'" in description
    assert "never ask for a note first" in description
    assert "cannot pick one person" in description


# -- get_save_my_soul_status --------------------------------------------------


async def test_status_with_no_emergency_contacts():
    service = FakeLocationService()
    result = await sos.get_save_my_soul_status(_ctx(service), sos.SaveMySoulStatusInput())
    assert result.status == "no_emergency_contacts"
    assert result.needs == "setup"
    assert result.active_sos is False
    assert result.emergency_contacts == []
    assert result.default_action == "open"
    assert result.spoken_facts == ["You have no emergency contacts yet, so no alert can be sent."]


async def test_status_ready_names_real_contacts_and_flags_the_unready_one():
    service = _ready_service()
    service.recipients[1] = _recipient(RAVI, "Ravi Kumar", key=False)
    service.sos_voice_preference = {"defaultAction": "trigger", "updatedAt": None}
    result = await sos.get_save_my_soul_status(_ctx(service), sos.SaveMySoulStatusInput())
    assert result.status == "ready"
    assert result.default_action == "trigger"
    assert result.active_sos is False and result.active_grant_count == 0
    assert [c.user_id for c in result.emergency_contacts] == [AYESHA, RAVI]
    assert [c.display_name for c in result.emergency_contacts] == ["Ayesha Sharma", "Ravi Kumar"]
    assert [c.sos_ready for c in result.emergency_contacts] == [True, False]
    assert result.emergency_contacts[1].has_location_key is False
    assert result.spoken_facts == [
        "Your 2 emergency contacts: Ayesha Sharma and Ravi Kumar.",
        "Ravi Kumar can't receive your location yet.",
    ]
    assert "Meera" not in " ".join(result.spoken_facts)
    # The read was scoped to the roster, never the whole recipients page.
    assert service.recipient_filters == [[AYESHA, RAVI]]


async def test_status_offers_the_roster_ids_so_a_removal_can_be_confirmed_from_it():
    service = _ready_service()
    ctx = _ctx(service)
    await sos.get_save_my_soul_status(ctx, sos.SaveMySoulStatusInput())
    assert ctx.entities.offered_person_ids == [AYESHA, RAVI]
    # Offered is not confirmed: the remove tool still needs confirm_person.
    assert ctx.entities.person(AYESHA) is None


async def test_status_with_an_active_alert_records_it_for_the_delivery_report():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma", envelope=True)]
    ctx = _ctx(service)
    await sos.get_save_my_soul_status(ctx, sos.SaveMySoulStatusInput())
    assert ctx.sos_incident["grant_ids"] == ["g1"]


async def test_status_active_counts_only_live_sos_grants():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma"),
        _grant("g2", RAVI, "Ravi Kumar", envelope=True),
        _grant("g3", MEERA, "Meera Nair", kind="share"),  # ordinary share, not SOS
        _grant("g4", MEERA, "Meera Nair", expires_at=_past()),  # stale SOS grant
        _grant("g5", MEERA, "Meera Nair", status="revoked"),
    ]
    result = await sos.get_save_my_soul_status(_ctx(service), sos.SaveMySoulStatusInput())
    assert result.status == "active"
    assert result.active_sos is True
    assert result.active_grant_count == 2
    assert [g.grant_id for g in result.active_grants] == ["g1", "g2"]
    assert [g.has_envelope for g in result.active_grants] == [False, True]
    assert result.spoken_facts == [
        "Save My Soul is active with 2 live location shares to Ayesha Sharma and Ravi Kumar."
    ]


async def test_status_placeholder_labels_are_counted_not_spoken():
    service = FakeLocationService()
    service.sms_contact_ids = [AYESHA, RAVI]
    service.recipients = [_recipient(AYESHA, "Ayesha Sharma"), _recipient(RAVI, "*******1234")]
    result = await sos.get_save_my_soul_status(_ctx(service), sos.SaveMySoulStatusInput())
    assert result.emergency_contacts[1].display_name is None
    assert result.spoken_facts[0] == "Your 2 emergency contacts: Ayesha Sharma and 1 other contact."


async def test_status_maps_service_errors_to_rejected():
    service = FakeLocationService()
    service.roster_error = OneLocationAgentError("LOCATION_UNAVAILABLE", "Location is unavailable.")
    result = await sos.get_save_my_soul_status(_ctx(service), sos.SaveMySoulStatusInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_UNAVAILABLE"
    assert result.spoken_facts == ["Location is unavailable."]


# -- trigger_save_my_soul: prepare (the card) ---------------------------------


def _trigger():
    return _tool("trigger_save_my_soul")


async def test_prepare_names_who_gets_it_who_is_left_out_and_the_note():
    service = _ready_service()
    service.sms_contact_ids = [AYESHA, RAVI, MEERA]
    service.recipients[2] = _recipient(MEERA, "Meera Nair", key=False)
    prepared = await sos.prepare_trigger(
        _ctx(service), sos.TriggerSaveMySoulInput(note="  Car   broke down ")
    )
    assert isinstance(prepared, Prepared)
    assert prepared.summary == (
        "send a Save My Soul alert to Ayesha Sharma and Ravi Kumar: your precise location "
        'for 8 hours, leaving out Meera Nair who can\'t receive it yet, with the note "Car broke down"'
    )
    assert prepared.snapshot == {
        "recipient_ids": sorted([AYESHA, RAVI]),
        "excluded_ids": [MEERA],
        "note": "Car broke down",
        "duration_hours": 8,
        "precision": "precise",
    }
    assert service.created == []


async def test_prepare_without_note_does_not_mention_one():
    prepared = await sos.prepare_trigger(_ctx(_ready_service()), sos.TriggerSaveMySoulInput())
    assert isinstance(prepared, Prepared)
    assert "note" not in prepared.summary
    assert prepared.snapshot["note"] is None


async def test_prepare_refuses_a_card_when_the_roster_cannot_be_read():
    service = FakeLocationService()
    service.roster_error = OneLocationAgentError("LOCATION_UNAVAILABLE", "Location is unavailable.")
    result = await sos.prepare_trigger(_ctx(service), sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "roster_unavailable"
    assert "haven't prepared an alert" in result.spoken_facts[0]
    assert result.spoken_facts[1] == "Location is unavailable."


async def test_prepare_answers_empty_roster_and_none_ready_without_a_card():
    empty = await sos.prepare_trigger(_ctx(FakeLocationService()), sos.TriggerSaveMySoulInput())
    assert empty.status == "no_emergency_contacts" and empty.needs == "setup"
    service = _ready_service()
    service.recipients = [
        _recipient(AYESHA, "Ayesha Sharma", key=False),
        _recipient(RAVI, "Ravi Kumar", verified=False),
    ]
    none_ready = await sos.prepare_trigger(_ctx(service), sos.TriggerSaveMySoulInput())
    assert isinstance(none_ready, Rejected)
    assert none_ready.reason_code == "no_sos_ready_contacts"
    assert service.created == []


async def test_prepare_with_an_active_alert_reports_it_instead_of_a_second_card():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma")]
    ctx = _ctx(service)
    result = await sos.prepare_trigger(ctx, sos.TriggerSaveMySoulInput())
    assert result.status == "already_active"
    assert result.grant_ids == ["g1"]
    assert ctx.sos_incident["grant_ids"] == ["g1"]
    assert "I won't start another" in result.spoken_facts[0]


def test_trigger_summary_fallback_never_invents_names():
    assert (
        _trigger().summarize(_ctx(_ready_service()), sos.TriggerSaveMySoulInput())
        == "send a Save My Soul alert to your emergency contacts"
    )


# -- trigger_save_my_soul: execution (after the tap) --------------------------


def _prepared_ctx(service, *, recipient_ids=None, note=None, **kw):
    ctx = _ctx(service, **kw)
    ctx.prepared = {
        "recipient_ids": sorted(recipient_ids if recipient_ids is not None else [AYESHA, RAVI]),
        "excluded_ids": [],
        "note": note,
        "duration_hours": 8,
        "precision": "precise",
    }
    return ctx


async def test_trigger_arms_one_sos_grant_per_ready_contact_and_hands_publish_to_the_client():
    service = _ready_service()
    service.sms_contact_ids = [AYESHA, RAVI, MEERA]
    service.recipients[2] = _recipient(MEERA, "Meera Nair", key=False)
    ctx = _prepared_ctx(service, note="Car broke down")
    result = await sos.trigger_save_my_soul(
        ctx, sos.TriggerSaveMySoulInput(note="  Car broke down  ")
    )

    assert result.status == "sos_grants_created"
    assert result.needs == "client_step"
    assert result.grant_ids == ["grant-1", "grant-2"]
    assert result.note == "Car broke down"
    assert result.duration_hours == 8 and result.precision == "precise"
    assert result.client_step["kind"] == "publish_location_envelopes"
    assert result.client_step["purpose"] == "sos"
    assert result.client_step["grant_ids"] == ["grant-1", "grant-2"]
    assert result.client_step["sos"] is True
    assert result.client_step["timeout_s"] == 60
    assert [g["user_id"] for g in result.client_step["grants"]] == [AYESHA, RAVI]
    assert [c.user_id for c in result.skipped_no_key] == [MEERA]
    assert result.spoken_facts == [
        "Alert armed for Ayesha Sharma and Ravi Kumar; sending your position now.",
        "Meera Nair could not be included.",
    ]
    assert "sent" not in " ".join(result.spoken_facts).lower().replace("sending", "")
    # The session is bound to exactly this grant set for the delivery report.
    assert ctx.sos_incident["grant_ids"] == ["grant-1", "grant-2"]
    assert ctx.sos_incident["source"] == "trigger"
    # The whole pass (re-read, drift check, creates) ran under the owner lock once.
    assert service.guard_entries == 1

    assert len(service.created) == 2
    for call, recipient in zip(service.created, (AYESHA, RAVI), strict=True):
        assert call["owner_user_id"] == OWNER
        assert call["recipient_user_id"] == recipient
        assert call["recipient_key_id"] == f"key-{recipient}"
        assert call["duration_hours"] == 8
        assert call["duration_mode"] == "timed"
        assert call["share_kind"] == "sos"
        assert call["reason"] == "Car broke down"
        assert call["require_recipient_phone_verified"] is True
        assert call["enforce_connection"] is False


async def test_trigger_without_note_uses_the_legacy_sos_reason_marker():
    service = _ready_service()
    await sos.trigger_save_my_soul(_prepared_ctx(service), sos.TriggerSaveMySoulInput())
    assert {call["reason"] for call in service.created} == {"sos_panic"}


async def test_trigger_refuses_when_the_audience_changed_since_the_card():
    service = _ready_service()
    ctx = _prepared_ctx(service, recipient_ids=[AYESHA, RAVI])
    # Meera was added to the roster after the card was shown.
    service.sms_contact_ids = [AYESHA, RAVI, MEERA]
    result = await sos.trigger_save_my_soul(ctx, sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_audience_changed"
    assert result.needs == "confirmation"
    assert "Ayesha Sharma, Ravi Kumar, and Meera Nair" in result.spoken_facts[0]
    assert service.created == []
    assert ctx.sos_incident is None


async def test_trigger_refuses_when_someone_approved_became_unready():
    service = _ready_service()
    ctx = _prepared_ctx(service, recipient_ids=[AYESHA, RAVI])
    service.recipients[1] = _recipient(RAVI, "Ravi Kumar", key=False)
    result = await sos.trigger_save_my_soul(ctx, sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_audience_changed"
    assert service.created == []


async def test_trigger_with_no_contacts_sends_nothing():
    service = FakeLocationService()
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    assert result.status == "no_emergency_contacts"
    assert result.needs == "setup"
    assert service.created == []
    assert result.client_step is None


async def test_trigger_when_already_active_creates_no_new_grants():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma")]
    ctx = _prepared_ctx(service)
    result = await sos.trigger_save_my_soul(ctx, sos.TriggerSaveMySoulInput())
    assert result.status == "already_active"
    assert result.grant_ids == ["g1"]
    assert result.needs is None
    assert result.spoken_facts[0].startswith("Save My Soul is already active for Ayesha Sharma.")
    assert service.created == []
    assert ctx.sos_incident["grant_ids"] == ["g1"]


async def test_trigger_skips_unverified_contacts_and_reports_them():
    service = _ready_service()
    service.recipients[1] = _recipient(RAVI, "Ravi Kumar", verified=False)
    result = await sos.trigger_save_my_soul(
        _prepared_ctx(service, recipient_ids=[AYESHA]), sos.TriggerSaveMySoulInput()
    )
    assert result.status == "sos_grants_created"
    assert [c.user_id for c in result.skipped_not_phone_verified] == [RAVI]
    assert [call["recipient_user_id"] for call in service.created] == [AYESHA]
    assert result.spoken_facts[0] == "Alert armed for Ayesha Sharma; sending your position now."


async def test_trigger_one_refused_contact_does_not_stop_the_others():
    service = _ready_service()
    service.create_errors[AYESHA] = OneLocationAgentError(
        "LOCATION_SMS_CONTACT_REQUIRED", "This person is not in your SMS contacts.", status_code=403
    )
    result = await sos.trigger_save_my_soul(_prepared_ctx(service), sos.TriggerSaveMySoulInput())
    assert result.status == "sos_grants_created"
    assert result.grant_ids == ["grant-1"]
    assert [g.user_id for g in result.armed] == [RAVI]
    assert result.failed == [
        {
            "user_id": AYESHA,
            "display_name": "Ayesha Sharma",
            "reason_code": "LOCATION_SMS_CONTACT_REQUIRED",
        }
    ]
    assert result.spoken_facts == [
        "Alert armed for Ravi Kumar; sending your position now.",
        "Ayesha Sharma could not be included.",
    ]


async def test_trigger_crash_on_a_later_contact_keeps_the_first_grant_armed():
    """A create that dies mid-loop must not hide the grant already created."""
    service = _ready_service()
    service.create_errors[RAVI] = RuntimeError("connection reset")
    ctx = _prepared_ctx(service)
    result = await sos.trigger_save_my_soul(ctx, sos.TriggerSaveMySoulInput())
    assert result.status == "sos_grants_created"
    assert result.grant_ids == ["grant-1"]
    assert result.failed == [
        {"user_id": RAVI, "display_name": "Ravi Kumar", "reason_code": "RuntimeError"}
    ]
    assert result.client_step["grant_ids"] == ["grant-1"]
    assert ctx.sos_incident["grant_ids"] == ["grant-1"]


async def test_trigger_maps_a_total_service_refusal_to_rejected():
    service = _ready_service()
    error = OneLocationAgentError(
        "LOCATION_RECIPIENT_UNAVAILABLE",
        "Ask them to open One Location and unlock once, then try again.",
        status_code=409,
    )
    service.create_errors = {AYESHA: error, RAVI: error}
    result = await sos.trigger_save_my_soul(_prepared_ctx(service), sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_RECIPIENT_UNAVAILABLE"
    assert result.spoken_facts == [error.message]


async def test_trigger_with_no_ready_contact_arms_nothing():
    service = _ready_service()
    service.recipients = [
        _recipient(AYESHA, "Ayesha Sharma", key=False),
        _recipient(RAVI, "Ravi Kumar", key=False),
    ]
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "no_sos_ready_contacts"
    assert result.spoken_facts == [
        "Ayesha Sharma and Ravi Kumar can't receive your location yet, so no alert could be armed."
    ]
    assert service.created == []


async def test_trigger_total_crash_is_a_rejection_with_no_grant():
    service = _ready_service()
    service.create_errors = {AYESHA: RuntimeError("boom"), RAVI: RuntimeError("boom")}
    ctx = _prepared_ctx(service)
    result = await sos.trigger_save_my_soul(ctx, sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_arm_failed"
    assert ctx.sos_incident is None


async def test_trigger_roster_read_failure_is_a_rejection_not_an_empty_roster():
    service = FakeLocationService()
    service.roster_error = OneLocationAgentError("LOCATION_UNAVAILABLE", "Location is unavailable.")
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_UNAVAILABLE"
    assert service.created == []


# -- report_save_my_soul_delivery ---------------------------------------------


def _armed_ctx(service, grant_ids):
    ctx = _ctx(service)
    ctx.sos_incident = {"grant_ids": list(grant_ids), "armed_at": now_iso(), "source": "trigger"}
    return ctx


async def test_delivery_report_sent_only_when_every_grant_has_an_envelope():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=True),
    ]
    result = await sos.report_save_my_soul_delivery(
        _armed_ctx(service, ["g1", "g2"]), sos.ReportSaveMySoulDeliveryInput()
    )
    assert result.status == "sos_sent"
    assert result.delivered == ["Ayesha Sharma", "Ravi Kumar"]
    assert result.not_alerted == []
    assert result.expected_grant_ids == ["g1", "g2"]
    assert result.alert_active is True
    assert result.reason_code is None
    assert result.spoken_facts == ["Your position reached Ayesha Sharma and Ravi Kumar."]


async def test_delivery_report_partial_names_who_was_missed():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=False),
    ]
    result = await sos.report_save_my_soul_delivery(
        _armed_ctx(service, ["g1", "g2"]), sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1", "g2"])
    )
    assert result.status == "sos_partial"
    assert result.delivered == ["Ayesha Sharma"]
    assert result.not_alerted == ["Ravi Kumar"]
    assert result.delivered_grant_ids == ["g1"]
    assert result.not_alerted_grant_ids == ["g2"]
    assert result.spoken_facts == [
        "Your position reached Ayesha Sharma.",
        "Your position has not reached Ravi Kumar; their share is armed but nothing was sent to them.",
    ]


async def test_delivery_report_cannot_be_narrowed_to_the_successful_grants():
    """Asking about only the delivered id must not turn a partial into sent."""
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=False),
    ]
    result = await sos.report_save_my_soul_delivery(
        _armed_ctx(service, ["g1", "g2"]), sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1"])
    )
    assert result.status == "sos_partial"
    assert result.not_alerted == ["Ravi Kumar"]


async def test_delivery_report_foreign_ids_are_unknown_and_never_named():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=False),
        _grant("g3", MEERA, "Meera Nair", kind="share", envelope=True),  # not an SOS grant
    ]
    result = await sos.report_save_my_soul_delivery(
        _armed_ctx(service, ["g1"]),
        sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1", "g3", "missing"]),
    )
    assert result.status == "sos_not_sent"
    assert result.delivered == []
    assert result.not_alerted == ["Ayesha Sharma"]
    assert result.unknown_grant_ids == ["g3", "missing"]
    assert result.reason_code == "envelope_missing"
    assert result.alert_active is True
    assert result.spoken_facts == [
        "Your position has not reached Ayesha Sharma; their share is armed but nothing was sent to them.",
        "2 ids you asked about is not part of this alert.",
        "The alert is still armed; you can try sending again or stop Save My Soul.",
    ]
    assert "Meera" not in " ".join(result.spoken_facts)


async def test_delivery_report_without_a_session_record_covers_every_live_sos_grant():
    """After a reconnect the session holds no record: server state decides."""
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=False),
        _grant("g3", MEERA, "Meera Nair", kind="share", envelope=True),
    ]
    result = await sos.report_save_my_soul_delivery(
        _ctx(service), sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1"])
    )
    assert result.status == "sos_partial"
    assert result.expected_grant_ids == ["g1", "g2"]


async def test_delivery_report_with_nothing_armed_is_an_honest_no_op():
    result = await sos.report_save_my_soul_delivery(
        _ctx(_ready_service()), sos.ReportSaveMySoulDeliveryInput()
    )
    assert result.status == "sos_not_sent"
    assert result.reason_code == "no_active_sos"
    assert result.spoken_facts == ["There's no Save My Soul alert to check."]


async def test_delivery_report_counts_an_ended_grant_as_not_reached():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", status="revoked", envelope=True),
    ]
    result = await sos.report_save_my_soul_delivery(
        _armed_ctx(service, ["g1", "g2"]), sos.ReportSaveMySoulDeliveryInput()
    )
    assert result.status == "sos_partial"
    assert result.ended_grant_ids == ["g2"]
    assert "1 share from this alert already ended." in result.spoken_facts


async def test_delivery_report_is_unverified_when_the_server_cannot_be_read():
    service = _ready_service()
    service.reread_error = RuntimeError("db down")
    service._grant_reads = 1  # the next read is the failing one
    result = await sos.report_save_my_soul_delivery(
        _armed_ctx(service, ["g1"]), sos.ReportSaveMySoulDeliveryInput()
    )
    assert result.status == "sos_unverified"
    assert result.reason_code == "verification_unavailable"
    assert result.alert_active is True
    assert result.expected_grant_ids == ["g1"]
    assert "can't verify delivery" in result.spoken_facts[0]
    assert "nothing" not in result.spoken_facts[0].lower()


# -- stop_save_my_soul --------------------------------------------------------


async def test_prepare_stop_names_the_live_shares_it_will_end():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma"),
        _grant("g2", RAVI, "Ravi Kumar"),
        _grant("g3", MEERA, "Meera Nair", kind="share"),
    ]
    prepared = await sos.prepare_stop(_ctx(service), sos.StopSaveMySoulInput())
    assert isinstance(prepared, Prepared)
    assert prepared.summary == (
        "stop Save My Soul and end 2 live location shares to Ayesha Sharma and Ravi Kumar"
    )
    assert prepared.snapshot == {"grant_ids": ["g1", "g2"]}
    assert service.revoked == []


async def test_prepare_stop_without_a_live_alert_or_state_makes_no_card():
    service = _ready_service()
    assert (await sos.prepare_stop(_ctx(service), sos.StopSaveMySoulInput())).status == "not_active"
    service.roster_error = OneLocationAgentError("LOCATION_UNAVAILABLE", "Location is unavailable.")
    service.list_active_owner_grants = lambda **_: (_ for _ in ()).throw(service.roster_error)
    result = await sos.prepare_stop(_ctx(service), sos.StopSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_state_unavailable"


async def test_stop_revokes_every_live_sos_grant_and_leaves_ordinary_shares_alone():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma"),
        _grant("g2", RAVI, "Ravi Kumar"),
        _grant("g3", MEERA, "Meera Nair", kind="share"),
    ]
    ctx = _armed_ctx(service, ["g1", "g2"])
    result = await sos.stop_save_my_soul(ctx, sos.StopSaveMySoulInput())
    assert result.status == "sos_stopped"
    assert result.stopped_count == 2
    assert result.unresolved == []
    assert service.revoked == ["g1", "g2"]
    assert result.spoken_facts == [
        "Save My Soul stopped; 2 location shares to Ayesha Sharma and Ravi Kumar ended."
    ]
    assert next(g for g in service.owner_grants if g["id"] == "g3")["status"] == "active"
    assert ctx.sos_incident is None


async def test_stop_when_nothing_is_active():
    service = _ready_service()
    service.owner_grants = [_grant("g3", MEERA, "Meera Nair", kind="share")]
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "not_active"
    assert result.stopped_count == 0
    assert service.revoked == []
    assert result.spoken_facts == ["Save My Soul isn't active, so there was nothing to stop."]


async def test_stop_keeps_a_share_it_could_not_end_as_unresolved():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma"), _grant("g2", RAVI, "Ravi Kumar")]
    service.revoke_errors["g2"] = OneLocationAgentError(
        "LOCATION_GRANT_NOT_FOUND", "Share not found.", status_code=404
    )
    ctx = _armed_ctx(service, ["g1", "g2"])
    result = await sos.stop_save_my_soul(ctx, sos.StopSaveMySoulInput())
    assert result.status == "sos_partially_stopped"
    assert result.stopped_count == 1
    assert result.unresolved_grant_ids == ["g2"]
    assert result.failed == [{"grant_id": "g2", "reason_code": "LOCATION_GRANT_NOT_FOUND"}]
    assert result.spoken_facts == [
        "1 location share to Ayesha Sharma ended, but 1 share to Ravi Kumar may still be "
        "live. Check Save My Soul or ask me to stop it again.",
    ]
    # The unresolved share stays bound to the session for the next stop/report.
    assert ctx.sos_incident["grant_ids"] == ["g2"]


async def test_stop_treats_a_lost_or_malformed_revoke_answer_as_unresolved():
    """None, {} and a wrong-id answer are not evidence that anything ended."""
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma"),
        _grant("g2", RAVI, "Ravi Kumar"),
        _grant("g4", MEERA, "Meera Nair"),
    ]
    service.revoke_responses = {"g1": None, "g2": {}, "g4": {"id": "other", "status": "revoked"}}
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_stop_failed"
    assert "3 location shares may still be live" in result.spoken_facts[0]


async def test_stop_needs_the_reread_to_agree_the_share_ended():
    """A revoke that says revoked while the re-read still lists it live is unresolved."""
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma"), _grant("g2", RAVI, "Ravi Kumar")]
    service.revoke_responses["g2"] = {"id": "g2", "status": "revoked"}  # row stays active
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "sos_partially_stopped"
    assert result.unresolved_grant_ids == ["g2"]
    assert {"grant_id": "g2", "reason_code": "still_active"} in result.failed


async def test_stop_counts_only_positive_revoke_answers_when_the_reread_fails():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma"), _grant("g2", RAVI, "Ravi Kumar")]
    service.revoke_responses["g2"] = None
    service.reread_error = RuntimeError("db down")
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "sos_partially_stopped"
    assert [g.grant_id for g in result.stopped] == ["g1"]
    assert result.unresolved_grant_ids == ["g2"]


async def test_stop_maps_a_total_refusal_to_a_stop_failure():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma")]
    service.revoke_errors["g1"] = OneLocationAgentError(
        "LOCATION_GRANT_NOT_FOUND", "Share not found.", status_code=404
    )
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_stop_failed"
    assert result.spoken_facts == [
        "Save My Soul could not be stopped. 1 location share may still be live."
    ]


def test_stop_summary():
    assert (
        _tool("stop_save_my_soul").summarize(_ctx(FakeLocationService()), sos.StopSaveMySoulInput())
        == "stop Save My Soul and end every emergency location share it started"
    )


# -- add_emergency_contact ----------------------------------------------------


def _person_args(user_id: str) -> sos.EmergencyContactInput:
    return sos.EmergencyContactInput(person=PersonRef(user_id=user_id))


async def test_add_contact_uses_the_confirmed_name_and_real_count():
    service = _ready_service()
    ctx = _ctx(service, confirmed={MEERA: "Meera Nair"})
    result = await sos.add_emergency_contact(ctx, _person_args(MEERA))
    assert result.status == "added"
    assert result.person_user_id == MEERA
    assert result.display_name == "Meera Nair"
    assert result.emergency_contact_count == 3
    assert service.sms_contact_ids == [AYESHA, RAVI, MEERA]
    assert result.spoken_facts == [
        "Meera Nair is now an emergency contact.",
        "You have 3 emergency contacts.",
    ]


async def test_add_contact_refuses_an_unconfirmed_person():
    service = _ready_service()
    result = await sos.add_emergency_contact(_ctx(service), _person_args(MEERA))
    assert isinstance(result, Rejected)
    assert result.reason_code == "person_not_confirmed"
    assert result.needs == "disambiguation"
    assert "add_sms_contact" not in service.calls


async def test_add_contact_already_on_the_roster():
    service = _ready_service()
    ctx = _ctx(service, confirmed={RAVI: "Ravi Kumar"})
    result = await sos.add_emergency_contact(ctx, _person_args(RAVI))
    assert result.status == "already_contact"
    assert result.spoken_facts == ["Ravi Kumar is already one of your emergency contacts."]
    assert "add_sms_contact" not in service.calls


async def test_add_contact_not_phone_verified_carries_the_service_message():
    service = _ready_service()
    service.recipients.append(_recipient("user-zara", "Zara Ali", verified=False))
    service.add_error = OneLocationAgentError(
        "LOCATION_RECIPIENT_UNAVAILABLE",
        "Ask this SMS contact to verify their phone before receiving alerts.",
        status_code=409,
    )
    ctx = _ctx(service, confirmed={"user-zara": "Zara Ali"})
    result = await sos.add_emergency_contact(ctx, _person_args("user-zara"))
    assert result.status == "not_phone_verified"
    assert result.reason_code == "LOCATION_RECIPIENT_UNAVAILABLE"
    assert result.spoken_facts == [
        "Zara Ali hasn't verified their phone. Ask this SMS contact to verify their phone before receiving alerts."
    ]
    assert service.sms_contact_ids == [AYESHA, RAVI]


async def test_add_contact_verified_but_without_a_key_is_rejected_with_the_service_code():
    service = _ready_service()
    service.recipients.append(_recipient("user-zara", "Zara Ali", key=False))
    service.add_error = OneLocationAgentError(
        "LOCATION_RECIPIENT_UNAVAILABLE",
        "Ask them to open One Location and unlock once, then try again.",
        status_code=409,
    )
    ctx = _ctx(service, confirmed={"user-zara": "Zara Ali"})
    result = await sos.add_emergency_contact(ctx, _person_args("user-zara"))
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_RECIPIENT_UNAVAILABLE"
    assert result.spoken_facts == ["Ask them to open One Location and unlock once, then try again."]


async def test_add_contact_not_connected():
    service = _ready_service()
    service.add_error = OneLocationCircleError(
        "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
        "Every selected person must still be a connection.",
        status_code=409,
    )
    ctx = _ctx(service, confirmed={"user-zara": "Zara Ali"})
    result = await sos.add_emergency_contact(ctx, _person_args("user-zara"))
    assert result.status == "not_connected"
    assert result.needs == "invite"
    assert result.spoken_facts == [
        "Zara Ali isn't connected with you. Every selected person must still be a connection."
    ]


async def test_add_contact_circle_already_member_maps_to_already_contact():
    service = _ready_service()
    service.add_error = OneLocationCircleError(
        "LOCATION_CIRCLE_ALREADY_MEMBER",
        "One or more selected connections are already in the Circle.",
        status_code=409,
    )
    ctx = _ctx(service, confirmed={MEERA: "Meera Nair"})
    result = await sos.add_emergency_contact(ctx, _person_args(MEERA))
    assert result.status == "already_contact"


async def test_add_contact_other_service_errors_become_rejected():
    service = _ready_service()
    service.add_error = OneLocationAgentError(
        "LOCATION_SMS_CONTACT_SELF",
        "Choose a different connection as an SMS contact.",
        status_code=422,
    )
    ctx = _ctx(service, confirmed={MEERA: "Meera Nair"})
    result = await sos.add_emergency_contact(ctx, _person_args(MEERA))
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_SMS_CONTACT_SELF"
    assert result.spoken_facts == ["Choose a different connection as an SMS contact."]


def test_add_contact_summary_names_the_confirmed_person():
    ctx = _ctx(FakeLocationService(), confirmed={MEERA: "Meera Nair"})
    tool = _tool("add_emergency_contact")
    assert tool.summarize(ctx, _person_args(MEERA)) == "add Meera Nair as an emergency contact"
    assert (
        tool.summarize(_ctx(FakeLocationService()), _person_args(MEERA))
        == "add this person as an emergency contact"
    )


# -- remove_emergency_contact -------------------------------------------------


async def test_remove_contact_uses_the_confirmed_name_and_real_count():
    service = _ready_service()
    ctx = _ctx(service, confirmed={RAVI: "Ravi Kumar"})
    result = await sos.remove_emergency_contact(ctx, _person_args(RAVI))
    assert result.status == "removed"
    assert result.emergency_contact_count == 1
    assert service.sms_contact_ids == [AYESHA]
    assert result.spoken_facts == [
        "Ravi Kumar is no longer an emergency contact.",
        "You have 1 emergency contact left.",
    ]


async def test_remove_last_contact_says_none_left():
    service = _ready_service()
    service.sms_contact_ids = [RAVI]
    ctx = _ctx(service, confirmed={RAVI: "Ravi Kumar"})
    result = await sos.remove_emergency_contact(ctx, _person_args(RAVI))
    assert result.status == "removed"
    assert result.spoken_facts[1] == "You have no emergency contacts left."


async def test_remove_contact_not_on_the_roster():
    service = _ready_service()
    ctx = _ctx(service, confirmed={MEERA: "Meera Nair"})
    result = await sos.remove_emergency_contact(ctx, _person_args(MEERA))
    assert result.status == "not_a_contact"
    assert result.spoken_facts == ["Meera Nair isn't one of your emergency contacts."]
    assert "remove_sms_contact" not in service.calls


async def test_remove_contact_refuses_an_unconfirmed_person():
    service = _ready_service()
    result = await sos.remove_emergency_contact(_ctx(service), _person_args(RAVI))
    assert isinstance(result, Rejected)
    assert result.reason_code == "person_not_confirmed"
    assert service.sms_contact_ids == [AYESHA, RAVI]


async def test_remove_contact_maps_service_errors_to_rejected():
    service = _ready_service()
    service.remove_error = OneLocationCircleError(
        "LOCATION_SMS_CONTACT_UPDATE_FAILED",
        "The emergency contact was not removed.",
        status_code=409,
    )
    ctx = _ctx(service, confirmed={RAVI: "Ravi Kumar"})
    result = await sos.remove_emergency_contact(ctx, _person_args(RAVI))
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_SMS_CONTACT_UPDATE_FAILED"
    assert result.spoken_facts == ["The emergency contact was not removed."]


def test_remove_contact_summary_names_the_confirmed_person():
    ctx = _ctx(FakeLocationService(), confirmed={RAVI: "Ravi Kumar"})
    assert (
        _tool("remove_emergency_contact").summarize(ctx, _person_args(RAVI))
        == "remove Ravi Kumar from your emergency contacts"
    )


# -- results serialize for the pending row / client ---------------------------


async def test_results_are_json_serializable():
    service = _ready_service()
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    public = result.public()
    assert public["status"] == "sos_grants_created"
    assert public["armed"][0]["display_name"] == "Ayesha Sharma"
    assert public["client_step"]["grant_ids"] == ["grant-1", "grant-2"]


# -- review-driven cases -------------------------------------------------------


async def test_status_adds_the_roster_to_a_fresh_offer_instead_of_replacing_it():
    """ "Add Priya": resolve_person offered Priya; a status read must not make
    confirm_person(priya) fail with person_not_offered."""
    service = _ready_service()
    ctx = _ctx(service)
    ctx.entities.offer_people(["user-priya"])
    await sos.get_save_my_soul_status(ctx, sos.SaveMySoulStatusInput())
    assert ctx.entities.offered_person_ids == ["user-priya", AYESHA, RAVI]


async def test_status_without_a_live_alert_clears_a_stale_session_record():
    service = _ready_service()
    ctx = _armed_ctx(service, ["g-old"])
    await sos.get_save_my_soul_status(ctx, sos.SaveMySoulStatusInput())
    assert ctx.sos_incident is None


async def test_delivery_report_follows_the_server_when_the_recorded_alert_was_replaced():
    """Voice armed g1; the app stopped it and re-armed g3 (with an envelope).
    The session record is stale: the report must cover g3, not call it ended."""
    service = _ready_service()
    service.owner_grants = [_grant("g3", AYESHA, "Ayesha Sharma", envelope=True)]
    ctx = _armed_ctx(service, ["g1", "g2"])
    result = await sos.report_save_my_soul_delivery(ctx, sos.ReportSaveMySoulDeliveryInput())
    assert result.status == "sos_sent"
    assert result.expected_grant_ids == ["g3"]
    assert ctx.sos_incident["grant_ids"] == ["g3"]


async def test_delivery_report_for_an_alert_that_ended_is_unverified_not_not_sent():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma", status="revoked", envelope=True)]
    ctx = _armed_ctx(service, ["g1"])
    result = await sos.report_save_my_soul_delivery(ctx, sos.ReportSaveMySoulDeliveryInput())
    assert result.status == "sos_unverified"
    assert result.reason_code == "alert_ended"
    assert result.alert_active is False
    assert result.ended_grant_ids == ["g1"]
    assert ctx.sos_incident is None


async def test_delivery_report_unverified_without_a_record_does_not_claim_inactive():
    service = _ready_service()
    service.reread_error = RuntimeError("db down")
    service._grant_reads = 1
    result = await sos.report_save_my_soul_delivery(
        _ctx(service), sos.ReportSaveMySoulDeliveryInput()
    )
    assert result.status == "sos_unverified"
    assert result.alert_active is None


async def test_stop_refuses_when_a_share_the_card_never_named_went_live():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma"), _grant("g2", RAVI, "Ravi Kumar")]
    ctx = _ctx(service)
    ctx.prepared = {"grant_ids": ["g1"]}  # the card named only g1
    result = await sos.stop_save_my_soul(ctx, sos.StopSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "sos_scope_changed"
    assert service.revoked == []


async def test_stop_proceeds_when_some_named_shares_already_ended():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma")]
    ctx = _ctx(service)
    ctx.prepared = {"grant_ids": ["g1", "g2"]}  # g2 ended on its own since the card
    result = await sos.stop_save_my_soul(ctx, sos.StopSaveMySoulInput())
    assert result.status == "sos_stopped"
    assert service.revoked == ["g1"]


async def test_stop_wrong_id_revoke_answer_is_unresolved_even_when_the_reread_agrees():
    """The answer names another grant: not evidence for this one, even if the
    row happens to be gone on re-read."""
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma"), _grant("g2", RAVI, "Ravi Kumar")]

    def revoke(*, owner_user_id, grant_id):
        service.owner_grants = [g for g in service.owner_grants if g["id"] != grant_id]
        return {"id": "other" if grant_id == "g2" else grant_id, "status": "revoked"}

    service.revoke_grant = revoke
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "sos_partially_stopped"
    assert [g.grant_id for g in result.stopped] == ["g1"]
    assert result.unresolved_grant_ids == ["g2"]


async def test_add_during_a_live_alert_says_the_alert_was_not_sent_to_them():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma", envelope=True)]
    ctx = _ctx(service, confirmed={MEERA: "Meera Nair"})
    result = await sos.add_emergency_contact(ctx, _person_args(MEERA))
    assert result.status == "added"
    assert result.spoken_facts[-1] == (
        "The Save My Soul alert that is active now was not sent to Meera Nair."
    )
    assert service.created == [] and service.revoked == []


async def test_remove_during_a_live_alert_keeps_their_share_running_and_says_so():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma", envelope=True)]
    ctx = _ctx(service, confirmed={AYESHA: "Ayesha Sharma"})
    result = await sos.remove_emergency_contact(ctx, _person_args(AYESHA))
    assert result.status == "removed"
    assert service.sms_contact_ids == [RAVI]
    assert service.revoked == []
    assert next(g for g in service.owner_grants if g["id"] == "g1")["status"] == "active"
    assert result.spoken_facts[-1] == (
        "The live Save My Soul share to Ayesha Sharma is still running; stopping Save My "
        "Soul is a separate step."
    )


async def test_prepare_refuses_a_card_on_a_non_service_read_failure_too():
    service = FakeLocationService()
    service.roster_error = RuntimeError("DatabaseExecutionError: connection refused")
    result = await sos.prepare_trigger(_ctx(service), sos.TriggerSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "roster_unavailable"


async def test_a_guard_release_failure_after_arming_still_reports_the_grants():
    service = _ready_service()

    @contextmanager
    def flaky_guard(*, owner_user_id):
        service.guard_depth += 1
        try:
            yield
        finally:
            service.guard_depth -= 1
        raise RuntimeError("lock connection dropped on commit")

    service.sos_incident_guard = flaky_guard
    ctx = _prepared_ctx(service)
    result = await sos.trigger_save_my_soul(ctx, sos.TriggerSaveMySoulInput())
    assert result.status == "sos_grants_created"
    assert result.grant_ids == ["grant-1", "grant-2"]
    assert ctx.sos_incident["grant_ids"] == ["grant-1", "grant-2"]
