"""Save My Soul voice tools: arming, verified delivery, stop, emergency contacts.

Handlers are called directly with a service double injected through
``ToolContext.services``; the registry is not imported so this file does not
depend on the other tool families.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import sos
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    PersonRef,
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
        self._seq = 0

    # reads
    def list_sms_contact_ids(self, *, owner_user_id: str) -> list[str]:
        self.calls.append("list_sms_contact_ids")
        if self.roster_error is not None:
            raise self.roster_error
        assert owner_user_id == OWNER
        return list(self.sms_contact_ids)

    def list_verified_recipients(
        self, *, owner_user_id: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        self.calls.append("list_verified_recipients")
        assert owner_user_id == OWNER
        assert limit >= 50
        return [dict(row) for row in self.recipients]

    def list_active_owner_grants(self, *, owner_user_id: str) -> list[dict[str, Any]]:
        self.calls.append("list_active_owner_grants")
        assert owner_user_id == OWNER
        return [dict(row) for row in self.owner_grants if row["status"] == "active"]

    def get_sos_voice_preference(self, *, user_id: str) -> dict[str, Any]:
        assert user_id == OWNER
        return dict(self.sos_voice_preference)

    # writes
    def create_grant(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append("create_grant")
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
        "report_save_my_soul_delivery": (ToolPolicy.read, "location.trigger_sos"),
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
    with pytest.raises(ValidationError):
        sos.ReportSaveMySoulDeliveryInput.model_validate({"grant_ids": []})
    assert sos.TriggerSaveMySoulInput.model_validate({}).note is None


def test_trigger_description_states_that_sent_needs_client_publish_and_server_verification():
    description = _tool("trigger_save_my_soul").description
    assert "publish" in description and "verif" in description
    assert "Never say the alert was 'sent'" in description


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


# -- trigger_save_my_soul -----------------------------------------------------


async def test_trigger_arms_one_sos_grant_per_ready_contact_and_hands_publish_to_the_client():
    service = _ready_service()
    service.sms_contact_ids = [AYESHA, RAVI, MEERA]
    service.recipients[2] = _recipient(MEERA, "Meera Nair", key=False)
    result = await sos.trigger_save_my_soul(
        _ctx(service), sos.TriggerSaveMySoulInput(note="  Car broke down  ")
    )

    assert result.status == "sos_grants_created"
    assert result.needs == "client_step"
    assert result.grant_ids == ["grant-1", "grant-2"]
    assert result.client_step["kind"] == "publish_location_envelopes"
    assert result.client_step["purpose"] == "sos"
    assert result.client_step["grant_ids"] == ["grant-1", "grant-2"]
    assert result.client_step["sos"] is True
    assert result.client_step["timeout_s"] == 25
    assert [g["user_id"] for g in result.client_step["grants"]] == [AYESHA, RAVI]
    assert [c.user_id for c in result.skipped_no_key] == [MEERA]
    assert result.spoken_facts == [
        "Alert armed for Ayesha Sharma and Ravi Kumar; sending your position now.",
        "Meera Nair could not be included.",
    ]
    assert "sent" not in " ".join(result.spoken_facts).lower().replace("sending", "")

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
    await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    assert {call["reason"] for call in service.created} == {"sos_panic"}


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
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    assert result.status == "already_active"
    assert result.grant_ids == ["g1"]
    assert result.needs is None
    assert result.spoken_facts == ["Save My Soul is already active for Ayesha Sharma."]
    assert service.created == []


async def test_trigger_skips_unverified_contacts_and_reports_them():
    service = _ready_service()
    service.recipients[1] = _recipient(RAVI, "Ravi Kumar", verified=False)
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
    assert result.status == "sos_grants_created"
    assert [c.user_id for c in result.skipped_not_phone_verified] == [RAVI]
    assert [call["recipient_user_id"] for call in service.created] == [AYESHA]
    assert result.spoken_facts[0] == "Alert armed for Ayesha Sharma; sending your position now."


async def test_trigger_one_refused_contact_does_not_stop_the_others():
    service = _ready_service()
    service.create_errors[AYESHA] = OneLocationAgentError(
        "LOCATION_SMS_CONTACT_REQUIRED", "This person is not in your SMS contacts.", status_code=403
    )
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
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


async def test_trigger_maps_a_total_service_refusal_to_rejected():
    service = _ready_service()
    error = OneLocationAgentError(
        "LOCATION_RECIPIENT_UNAVAILABLE",
        "Ask them to open One Location and unlock once, then try again.",
        status_code=409,
    )
    service.create_errors = {AYESHA: error, RAVI: error}
    result = await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())
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


async def test_trigger_unknown_exceptions_propagate_to_the_executor():
    service = _ready_service()
    service.create_errors = {AYESHA: RuntimeError("boom"), RAVI: RuntimeError("boom")}
    with pytest.raises(RuntimeError):
        await sos.trigger_save_my_soul(_ctx(service), sos.TriggerSaveMySoulInput())


def test_trigger_summary_names_the_real_contacts():
    service = _ready_service()
    summary = _tool("trigger_save_my_soul").summarize(_ctx(service), sos.TriggerSaveMySoulInput())
    assert summary == "send a Save My Soul alert to Ayesha Sharma and Ravi Kumar"


def test_trigger_summary_falls_back_when_the_roster_is_unreadable():
    service = FakeLocationService()
    service.roster_error = RuntimeError("db down")
    summary = _tool("trigger_save_my_soul").summarize(_ctx(service), sos.TriggerSaveMySoulInput())
    assert summary == "send a Save My Soul alert to your emergency contacts"


# -- report_save_my_soul_delivery ---------------------------------------------


async def test_delivery_report_sent_only_when_every_grant_has_an_envelope():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=True),
    ]
    result = await sos.report_save_my_soul_delivery(
        _ctx(service), sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1", "g2"])
    )
    assert result.status == "sos_sent"
    assert result.delivered == ["Ayesha Sharma", "Ravi Kumar"]
    assert result.not_alerted == []
    assert result.reason_code is None
    assert result.spoken_facts == ["Your position reached Ayesha Sharma and Ravi Kumar."]


async def test_delivery_report_partial_names_who_was_missed():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=True),
        _grant("g2", RAVI, "Ravi Kumar", envelope=False),
    ]
    result = await sos.report_save_my_soul_delivery(
        _ctx(service), sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1", "g2"])
    )
    assert result.status == "sos_partial"
    assert result.delivered == ["Ayesha Sharma"]
    assert result.not_alerted == ["Ravi Kumar"]
    assert result.delivered_grant_ids == ["g1"]
    assert result.not_alerted_grant_ids == ["g2"]
    assert result.spoken_facts == [
        "Your position reached Ayesha Sharma.",
        "Your position has not reached Ravi Kumar.",
    ]


async def test_delivery_report_not_sent_when_no_envelope_and_unknown_ids_are_not_named():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma", envelope=False),
        _grant("g3", MEERA, "Meera Nair", kind="share", envelope=True),  # not an SOS grant
    ]
    result = await sos.report_save_my_soul_delivery(
        _ctx(service), sos.ReportSaveMySoulDeliveryInput(grant_ids=["g1", "g3", "missing"])
    )
    assert result.status == "sos_not_sent"
    assert result.delivered == []
    assert result.not_alerted == ["Ayesha Sharma"]
    assert result.unknown_grant_ids == ["g3", "missing"]
    assert result.reason_code == "envelope_missing"
    assert result.spoken_facts == [
        "Your position has not reached Ayesha Sharma.",
        "2 alerts could not be verified.",
    ]
    assert "Meera" not in " ".join(result.spoken_facts)


# -- stop_save_my_soul --------------------------------------------------------


async def test_stop_revokes_every_live_sos_grant_and_leaves_ordinary_shares_alone():
    service = _ready_service()
    service.owner_grants = [
        _grant("g1", AYESHA, "Ayesha Sharma"),
        _grant("g2", RAVI, "Ravi Kumar"),
        _grant("g3", MEERA, "Meera Nair", kind="share"),
    ]
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "sos_stopped"
    assert result.stopped_count == 2
    assert service.revoked == ["g1", "g2"]
    assert result.spoken_facts == [
        "Save My Soul stopped; 2 location shares to Ayesha Sharma and Ravi Kumar ended."
    ]
    assert next(g for g in service.owner_grants if g["id"] == "g3")["status"] == "active"


async def test_stop_when_nothing_is_active():
    service = _ready_service()
    service.owner_grants = [_grant("g3", MEERA, "Meera Nair", kind="share")]
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "not_active"
    assert result.stopped_count == 0
    assert service.revoked == []
    assert result.spoken_facts == ["Save My Soul isn't active, so there was nothing to stop."]


async def test_stop_reports_a_share_it_could_not_end():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma"), _grant("g2", RAVI, "Ravi Kumar")]
    service.revoke_errors["g2"] = OneLocationAgentError(
        "LOCATION_GRANT_NOT_FOUND", "Share not found.", status_code=404
    )
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert result.status == "sos_stopped"
    assert result.stopped_count == 1
    assert result.failed == [{"grant_id": "g2", "reason_code": "LOCATION_GRANT_NOT_FOUND"}]
    assert result.spoken_facts == [
        "Save My Soul stopped; 1 location share to Ayesha Sharma ended.",
        "1 share could not be ended and is still live.",
    ]


async def test_stop_maps_a_total_refusal_to_rejected():
    service = _ready_service()
    service.owner_grants = [_grant("g1", AYESHA, "Ayesha Sharma")]
    service.revoke_errors["g1"] = OneLocationAgentError(
        "LOCATION_GRANT_NOT_FOUND", "Share not found.", status_code=404
    )
    result = await sos.stop_save_my_soul(_ctx(service), sos.StopSaveMySoulInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "LOCATION_GRANT_NOT_FOUND"
    assert result.spoken_facts == ["Share not found."]


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
