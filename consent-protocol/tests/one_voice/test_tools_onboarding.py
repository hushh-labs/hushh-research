"""Location setup (onboarding) tool family over an in-memory double that
mirrors the real ``OneLocationSetupService`` state machine and error codes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import onboarding
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    now_iso,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_setup_service import STEPS, SetupProgress

USER = "user-owner"
FRIEND = "user-friend"
CONSENT_VERSION = "location_sharing_v1"


def _fixture_credential(kind: str) -> str:
    """Non-production fixture credential without an inline secret-like literal."""
    return f"{kind}-fixture"


# -- doubles -----------------------------------------------------------------


class SetupDouble:
    """Same transitions and error codes as the real service, in memory."""

    def __init__(self, *, has_recipient_key: bool = True) -> None:
        self.progress = SetupProgress(user_id=USER)
        self.has_recipient_key = has_recipient_key
        self.sharing_state = "unset"
        self.calls: list[str] = []

    def _set(self, **changes: Any) -> SetupProgress:
        self.progress = SetupProgress(**{**self.progress.__dict__, **changes})
        return self.progress

    def _require_started(self) -> SetupProgress:
        if not self.progress.started:
            raise OneLocationAgentError(
                "LOCATION_SETUP_NOT_STARTED", "Start Location setup first.", status_code=409
            )
        return self.progress

    def get(self, *, user_id: str) -> SetupProgress:
        assert user_id == USER
        self.calls.append("get")
        return self.progress

    def start(self, *, user_id: str) -> SetupProgress:
        self.calls.append("start")
        if self.progress.started:
            return self.progress
        return self._set(step="intro", started_at="2026-09-15T10:00:00+00:00")

    def accept_consent(self, *, user_id: str, consent_version: str) -> SetupProgress:
        self.calls.append("accept_consent")
        if not consent_version.strip():
            raise OneLocationAgentError(
                "LOCATION_SETUP_CONSENT_INVALID", "Consent version is invalid.", status_code=422
            )
        progress = self._require_started()
        if progress.step not in {"intro", "consent"}:
            return progress
        return self._set(
            step="consent",
            consent_version=consent_version,
            consent_accepted_at="2026-09-15T10:01:00+00:00",
        )

    def record_os_permission(self, *, user_id: str, state: str) -> SetupProgress:
        self.calls.append(f"record_os_permission:{state}")
        progress = self._require_started()
        if progress.consent_accepted_at is None:
            raise OneLocationAgentError(
                "LOCATION_SETUP_CONSENT_REQUIRED",
                "Accept the Location consent before the device permission prompt.",
                status_code=409,
            )
        step = (
            "os_permission"
            if STEPS.index(progress.step) <= STEPS.index("os_permission")
            else progress.step
        )
        return self._set(step=step, os_permission_state=state)

    def set_precision(self, *, user_id: str, precision: str) -> SetupProgress:
        self.calls.append(f"set_precision:{precision}")
        progress = self._require_started()
        if STEPS.index(progress.step) < STEPS.index("os_permission"):
            raise OneLocationAgentError(
                "LOCATION_SETUP_STEP_ORDER",
                "Finish the device permission step before choosing precision.",
                status_code=409,
            )
        step = (
            "precision" if STEPS.index(progress.step) <= STEPS.index("precision") else progress.step
        )
        return self._set(step=step, precision=precision)

    def confirm_recipient_key(self, *, user_id: str) -> SetupProgress:
        self.calls.append("confirm_recipient_key")
        progress = self._require_started()
        if STEPS.index(progress.step) < STEPS.index("precision"):
            raise OneLocationAgentError(
                "LOCATION_SETUP_STEP_ORDER",
                "Choose precision before registering a key.",
                status_code=409,
            )
        if not self.has_recipient_key:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_KEY_MISSING",
                "This device has not registered a location key yet.",
                status_code=409,
            )
        return self._set(
            step="recipient_key", recipient_key_registered_at="2026-09-15T10:05:00+00:00"
        )

    def complete(self, *, user_id: str) -> SetupProgress:
        self.calls.append("complete")
        progress = self._require_started()
        if progress.step == "done":
            return progress
        if progress.step != "recipient_key":
            raise OneLocationAgentError(
                "LOCATION_SETUP_STEP_ORDER", "Finish every setup step first.", status_code=409
            )
        if progress.consent_version is None:
            raise OneLocationAgentError(
                "LOCATION_SHARING_CONSENT_REQUIRED",
                "Accept location sharing consent before turning sharing on.",
                status_code=409,
            )
        self.sharing_state = "on"
        return self._set(step="done", completed_at="2026-09-15T10:06:00+00:00")


@dataclass(frozen=True)
class AccountSettingsDouble:
    sharing_state: str


class LocationSettingsDouble:
    def __init__(self, setup: SetupDouble) -> None:
        self._setup = setup

    def get(self, *, user_id: str) -> AccountSettingsDouble:
        assert user_id == USER
        return AccountSettingsDouble(sharing_state=self._setup.sharing_state)


def _ctx(setup: SetupDouble | None = None, *, os_permission: str = "unknown") -> ToolContext:
    setup = setup or SetupDouble()
    entities = EntityContext()
    entities.remember_person(
        ConfirmedPerson(
            user_id=FRIEND,
            display_name="Rahul Verma",
            relationship="connected",
            confirmed_at=now_iso(),
        )
    )
    return ToolContext(
        user_id=USER,
        conversation_id="conv-1",
        entities=entities,
        screen=ScreenContext(os_location_permission=os_permission),
        vault_owner_token=_fixture_credential("vault"),
        services={
            onboarding.SETUP_SERVICE: setup,
            onboarding.LOCATION_SETTINGS_SERVICE: LocationSettingsDouble(setup),
        },
    )


def _spec(name: str):
    return next(tool for tool in onboarding.TOOLS if tool.name == name)


def _advance(**kwargs: Any) -> onboarding.AdvanceSetupInput:
    return onboarding.AdvanceSetupInput(**kwargs)


async def _walk_to(setup: SetupDouble, step: str) -> None:
    """Drive the double to ``step`` through the real service verbs."""
    setup.start(user_id=USER)
    if step == "intro":
        return
    setup.accept_consent(user_id=USER, consent_version=CONSENT_VERSION)
    if step == "consent":
        return
    setup.record_os_permission(user_id=USER, state="granted")
    if step == "os_permission":
        return
    setup.set_precision(user_id=USER, precision="precise")
    if step == "precision":
        return
    setup.confirm_recipient_key(user_id=USER)
    if step == "recipient_key":
        return
    setup.complete(user_id=USER)


# -- catalog shape -----------------------------------------------------------


def test_catalog_policies_and_gateway_ids():
    by_name = {tool.name: tool for tool in onboarding.TOOLS}
    assert set(by_name) == {
        "get_location_setup_state",
        "start_location_setup",
        "accept_location_setup_consent",
        "advance_location_setup",
    }
    assert by_name["get_location_setup_state"].policy is ToolPolicy.read
    assert by_name["get_location_setup_state"].gateway_action_id == "location.setup.status"
    assert by_name["start_location_setup"].policy is ToolPolicy.direct
    assert by_name["start_location_setup"].gateway_action_id == "location.setup.start"
    assert by_name["accept_location_setup_consent"].policy is ToolPolicy.confirm_tap
    assert (
        by_name["accept_location_setup_consent"].gateway_action_id
        == "location.setup.accept_consent"
    )
    assert by_name["accept_location_setup_consent"].summarize is not None
    assert by_name["advance_location_setup"].policy is ToolPolicy.direct
    assert by_name["advance_location_setup"].gateway_action_id == "location.setup.advance"


def test_no_tool_accepts_a_free_text_person_or_circle_name():
    for tool in onboarding.TOOLS:
        assert tool.person_args == ()
        assert tool.circle_args == ()
        fields = set(tool.input_model.model_fields)
        assert not fields & {"person", "person_name", "circle", "circle_name", "name", "user_id"}
        for smuggled in ({"person_name": "Rahul"}, {"name": "Rahul"}, {"user_id": FRIEND}):
            with pytest.raises(ValidationError):
                tool.input_model.model_validate(
                    {**smuggled, "step": "complete", "consent_version": "v"}
                )


def test_declarations_are_self_contained():
    for tool in onboarding.TOOLS:
        declaration = tool.declaration()
        assert declaration["name"] == tool.name
        assert "$defs" not in declaration["parameters_json_schema"]


def test_advance_input_only_accepts_known_steps_and_states():
    with pytest.raises(ValidationError):
        _advance(step="consent")
    with pytest.raises(ValidationError):
        _advance(step="os_permission", os_permission_state="maybe")
    with pytest.raises(ValidationError):
        _advance(step="precision", precision="exact")


# -- get_location_setup_state -----------------------------------------------


async def test_state_not_started():
    setup = SetupDouble()
    result = await onboarding.get_location_setup_state(_ctx(setup), onboarding.GetSetupStateInput())
    assert result.status == "not_started"
    assert result.current_step is None
    assert result.progress["started"] is False
    assert result.spoken_facts == ["You haven't started Location setup yet."]


async def test_state_in_progress_names_the_step_in_plain_words():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.get_location_setup_state(_ctx(setup), onboarding.GetSetupStateInput())
    assert result.status == "in_progress"
    assert result.current_step == "os_permission"
    assert result.progress["step"] == "consent"
    assert result.progress["consent_version"] == CONSENT_VERSION
    assert result.spoken_facts == ["You're on the device permission step."]


async def test_state_in_progress_after_denied_permission_says_so():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    setup.record_os_permission(user_id=USER, state="denied")
    result = await onboarding.get_location_setup_state(_ctx(setup), onboarding.GetSetupStateInput())
    assert result.status == "in_progress"
    assert result.spoken_facts == [
        "You're on the precision step.",
        "Your device denied location access. You can change it in Settings.",
    ]


async def test_state_on_last_step():
    setup = SetupDouble()
    await _walk_to(setup, "recipient_key")
    result = await onboarding.get_location_setup_state(_ctx(setup), onboarding.GetSetupStateInput())
    assert result.status == "in_progress"
    assert result.current_step == "done"
    assert result.spoken_facts == ["You're on the last step: finish setup to turn sharing on."]


async def test_state_done():
    setup = SetupDouble()
    await _walk_to(setup, "done")
    result = await onboarding.get_location_setup_state(_ctx(setup), onboarding.GetSetupStateInput())
    assert result.status == "done"
    assert result.progress["completed"] is True
    assert result.spoken_facts == ["Location setup is complete."]


# -- start_location_setup ----------------------------------------------------


async def test_start_opens_the_flow():
    setup = SetupDouble()
    result = await onboarding.start_location_setup(_ctx(setup), onboarding.StartSetupInput())
    assert result.status == "started"
    assert result.current_step == "consent"
    assert result.client_step == {"kind": "open_screen", "screen": "location_setup"}
    assert result.progress["started"] is True
    assert result.spoken_facts == ["Location setup started. First is the consent step."]
    assert "start" in setup.calls


async def test_start_is_idempotent_and_resumes():
    setup = SetupDouble()
    await _walk_to(setup, "os_permission")
    result = await onboarding.start_location_setup(_ctx(setup), onboarding.StartSetupInput())
    assert result.status == "resumed"
    assert result.current_step == "precision"
    assert result.client_step == {"kind": "open_screen", "screen": "location_setup"}
    assert result.spoken_facts == ["Picking up Location setup at the precision step."]
    assert setup.progress.step == "os_permission"


async def test_start_when_done_does_not_reopen_the_flow():
    setup = SetupDouble()
    await _walk_to(setup, "done")
    setup.calls.clear()
    result = await onboarding.start_location_setup(_ctx(setup), onboarding.StartSetupInput())
    assert result.status == "done"
    assert result.client_step is None
    assert result.spoken_facts == ["Location setup is already complete."]
    assert setup.calls == ["get"]


# -- accept_location_setup_consent ------------------------------------------


async def test_accept_consent_records_and_names_the_next_step():
    setup = SetupDouble()
    await _walk_to(setup, "intro")
    result = await onboarding.accept_location_setup_consent(
        _ctx(setup), onboarding.AcceptConsentInput(consent_version=CONSENT_VERSION)
    )
    assert result.status == "accepted"
    assert result.current_step == "os_permission"
    assert result.consent_version == CONSENT_VERSION
    assert result.spoken_facts == ["Consent recorded. Next is your device's location permission."]
    assert setup.progress.consent_accepted_at is not None


async def test_accept_consent_before_start_is_rejected_with_setup_need():
    setup = SetupDouble()
    result = await onboarding.accept_location_setup_consent(
        _ctx(setup), onboarding.AcceptConsentInput(consent_version=CONSENT_VERSION)
    )
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_SETUP_NOT_STARTED"
    assert result.needs == "setup"
    assert result.spoken_facts == ["Start Location setup first."]


async def test_accept_consent_again_later_is_not_worded_as_new():
    setup = SetupDouble()
    await _walk_to(setup, "precision")
    result = await onboarding.accept_location_setup_consent(
        _ctx(setup), onboarding.AcceptConsentInput(consent_version=CONSENT_VERSION)
    )
    assert result.status == "accepted"
    assert result.spoken_facts == ["Consent was already recorded.", "Next is the device key step."]


def test_accept_consent_summary_and_input_bounds():
    spec = _spec("accept_location_setup_consent")
    text = spec.summarize(_ctx(), onboarding.AcceptConsentInput(consent_version=CONSENT_VERSION))
    assert text == "accept the Location sharing consent"
    with pytest.raises(ValidationError):
        onboarding.AcceptConsentInput(consent_version="")
    with pytest.raises(ValidationError):
        onboarding.AcceptConsentInput.model_validate({})


# -- advance_location_setup: os_permission ----------------------------------


async def test_os_permission_before_consent_needs_consent():
    setup = SetupDouble()
    await _walk_to(setup, "intro")
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="os_permission", os_permission_state="granted")
    )
    assert result.status == "consent_required"
    assert result.needs == "consent"
    assert result.reason_code == "LOCATION_SETUP_CONSENT_REQUIRED"
    assert result.spoken_facts == [
        "Accept the Location consent before the device permission prompt."
    ]
    assert setup.progress.os_permission_state == "unknown"


async def test_os_permission_granted_advances():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="os_permission", os_permission_state="granted")
    )
    assert result.status == "advanced"
    assert result.step == "os_permission"
    assert result.next_step == "precision"
    assert result.spoken_facts == ["Location permission granted.", "Next is the precision step."]
    assert setup.calls[-1] == "record_os_permission:granted"


async def test_os_permission_denied_advances_but_tells_the_truth():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="os_permission", os_permission_state="denied")
    )
    assert result.status == "advanced"
    assert result.step == "os_permission"
    assert result.progress["os_permission_state"] == "denied"
    assert result.spoken_facts == [
        "Your device denied location access. You can change it in Settings.",
        "Next is the precision step.",
    ]


async def test_os_permission_prompt_is_not_worded_as_granted():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="os_permission", os_permission_state="prompt")
    )
    assert result.status == "advanced"
    assert result.spoken_facts[0] == "Your device hasn't answered the location prompt yet."


async def test_os_permission_without_state_asks_the_client():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="os_permission"))
    assert result.status == "rejected"
    assert result.reason_code == "os_permission_state_required"
    assert result.needs == "client_step"
    assert result.public()["client_step"] == {"kind": "report_os_permission"}
    assert not any(call.startswith("record_os_permission") for call in setup.calls)


async def test_os_permission_falls_back_to_sanitized_screen_context():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.advance_location_setup(
        _ctx(setup, os_permission="denied"), _advance(step="os_permission")
    )
    assert result.status == "advanced"
    assert setup.calls[-1] == "record_os_permission:denied"
    assert (
        result.spoken_facts[0]
        == "Your device denied location access. You can change it in Settings."
    )


# -- advance_location_setup: precision --------------------------------------


async def test_precision_before_os_permission_is_step_order():
    setup = SetupDouble()
    await _walk_to(setup, "consent")
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="precision", precision="approximate")
    )
    assert result.status == "step_order"
    assert result.reason_code == "LOCATION_SETUP_STEP_ORDER"
    assert result.spoken_facts == ["Finish the device permission step before choosing precision."]


async def test_precision_advances():
    setup = SetupDouble()
    await _walk_to(setup, "os_permission")
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="precision", precision="approximate")
    )
    assert result.status == "advanced"
    assert result.step == "precision"
    assert result.progress["precision"] == "approximate"
    assert result.spoken_facts == [
        "Location precision set to approximate.",
        "Next is the device key step.",
    ]


async def test_precision_without_value_is_rejected():
    setup = SetupDouble()
    await _walk_to(setup, "os_permission")
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="precision"))
    assert result.status == "rejected"
    assert result.reason_code == "precision_required"
    assert not any(call.startswith("set_precision") for call in setup.calls)


# -- advance_location_setup: recipient_key ----------------------------------


async def test_recipient_key_missing_asks_the_client_to_register():
    setup = SetupDouble(has_recipient_key=False)
    await _walk_to(setup, "precision")
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="recipient_key"))
    assert result.status == "recipient_key_missing"
    assert result.needs == "client_step"
    assert result.reason_code == "LOCATION_RECIPIENT_KEY_MISSING"
    assert result.client_step == {"kind": "register_recipient_key"}
    assert result.spoken_facts == ["This device has not registered a location key yet."]


async def test_recipient_key_advances():
    setup = SetupDouble()
    await _walk_to(setup, "precision")
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="recipient_key"))
    assert result.status == "advanced"
    assert result.step == "recipient_key"
    assert result.spoken_facts == [
        "This device's location key is registered.",
        "Next, finish setup to turn sharing on.",
    ]


# -- advance_location_setup: complete ---------------------------------------


async def test_complete_turns_sharing_on():
    setup = SetupDouble()
    await _walk_to(setup, "recipient_key")
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="complete"))
    assert result.status == "advanced"
    assert result.step == "done"
    assert result.next_step is None
    assert result.progress["completed"] is True
    assert setup.sharing_state == "on"
    assert result.spoken_facts == ["Location setup is complete.", "Location sharing is on."]


async def test_complete_too_early_is_step_order():
    setup = SetupDouble()
    await _walk_to(setup, "precision")
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="complete"))
    assert result.status == "step_order"
    assert result.spoken_facts == ["Finish every setup step first."]
    assert setup.sharing_state == "unset"


async def test_complete_without_recorded_consent_needs_consent():
    setup = SetupDouble()
    await _walk_to(setup, "recipient_key")
    setup.progress = SetupProgress(**{**setup.progress.__dict__, "consent_version": None})
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="complete"))
    assert result.status == "consent_required"
    assert result.needs == "consent"
    assert result.reason_code == "LOCATION_SHARING_CONSENT_REQUIRED"


async def test_complete_when_already_done_does_not_claim_sharing_it_cannot_see():
    setup = SetupDouble()
    await _walk_to(setup, "done")
    setup.sharing_state = "off"  # turned off later from settings
    result = await onboarding.advance_location_setup(_ctx(setup), _advance(step="complete"))
    assert result.status == "advanced"
    assert result.step == "done"
    assert result.spoken_facts == ["Location setup is complete."]


async def test_advance_before_start_is_rejected_with_setup_need():
    setup = SetupDouble()
    result = await onboarding.advance_location_setup(
        _ctx(setup), _advance(step="os_permission", os_permission_state="granted")
    )
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_SETUP_NOT_STARTED"
    assert result.needs == "setup"


async def test_unknown_exceptions_propagate_to_the_executor():
    class Broken(SetupDouble):
        def get(self, *, user_id: str) -> SetupProgress:
            raise KeyError("boom")

    with pytest.raises(KeyError):
        await onboarding.get_location_setup_state(_ctx(Broken()), onboarding.GetSetupStateInput())
