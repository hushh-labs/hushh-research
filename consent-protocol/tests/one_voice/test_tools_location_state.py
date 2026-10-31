"""Location state tools: sharing posture, precision, map presence, auto-approve, ratings.

Handlers are exercised directly with service doubles injected through
``ToolContext.services``; the registry is not imported so this file does not
depend on the other families.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.tools import location_state
from hushh_mcp.one_voice.tools.base import (
    ConfirmedCircle,
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    ToolSpec,
    now_iso,
)
from hushh_mcp.services.one_location_account_settings_service import (
    AccountSettings,
    SharingTransition,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_feature_admission import (
    OneLocationFeatureAdmission,
    nearby_presence_enabled,
)
from hushh_mcp.services.one_location_place_rating_service import PlaceRatingError

OWNER = "owner-1"
CONVERSATION = "c" * 36
DEVICE_TOOLS = ("resume_device_location_updates", "pause_device_location_updates")
FAMILY_ID = str(uuid.uuid4())
WORK_ID = str(uuid.uuid4())
STRANGER_ID = str(uuid.uuid4())


# -- doubles -----------------------------------------------------------------


class SettingsDouble:
    def __init__(self, settings: AccountSettings | None = None, *, sos_active: bool = False):
        self.state = settings or AccountSettings(user_id=OWNER)
        self.sos_active = sos_active
        self.calls: list[tuple[Any, ...]] = []
        self.revoked_grants: tuple[str, ...] = ()
        self.revoked_links: tuple[str, ...] = ()

    def get(self, *, user_id: str) -> AccountSettings:
        assert user_id == OWNER
        return self.state

    def set_precision(self, *, user_id: str, precision: str) -> AccountSettings:
        self.calls.append(("precision", precision))
        self.state = AccountSettings(
            user_id=user_id,
            sharing_state=self.state.sharing_state,
            precision=precision,
            sharing_consent_accepted_at=self.state.sharing_consent_accepted_at,
        )
        return self.state

    def set_sharing_state(
        self, *, user_id: str, state: str, include_sos: bool, consent_version: str | None
    ) -> SharingTransition:
        self.calls.append(("sharing", state, include_sos, consent_version))
        previous = self.state.sharing_state
        if state == "on" and not (self.state.sharing_consent_accepted_at or consent_version):
            raise OneLocationAgentError(
                "LOCATION_SHARING_CONSENT_REQUIRED",
                "Accept location sharing consent before turning sharing on.",
                status_code=409,
            )
        if state == "off" and self.sos_active and not include_sos:
            raise OneLocationAgentError(
                "LOCATION_SOS_ACTIVE",
                "Save My Soul is active. Stop it explicitly before turning sharing off.",
                status_code=409,
            )
        self.state = AccountSettings(
            user_id=user_id,
            sharing_state=state,
            precision=self.state.precision,
            sharing_consent_accepted_at=self.state.sharing_consent_accepted_at or "now",
            os_permission_reported=self.state.os_permission_reported,
        )
        if state == "off":
            return SharingTransition(
                settings=self.state,
                changed=previous != "off",
                revoked_grant_ids=self.revoked_grants,
                revoked_link_ids=self.revoked_links,
                notified_recipients=len(self.revoked_grants),
            )
        return SharingTransition(settings=self.state, changed=previous != "on")


def _grant(*, status: str = "active", share_kind: str = "share", owner: str = OWNER) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "ownerUserId": owner,
        "recipientUserId": "someone",
        "status": status,
        "shareKind": share_kind,
    }


class LocationDouble:
    def __init__(self, *, state: dict[str, Any] | None = None, presence: str = "ghost"):
        self.state = state or {}
        self.presence = presence
        self.auto_approve: dict[str, Any] = {"enabled": False, "scope": None, "ruleVersion": 0}
        self.owned_circles = {FAMILY_ID, WORK_ID}
        self.calls: list[tuple[Any, ...]] = []

    def list_state(self, *, user_id: str) -> dict[str, Any]:
        assert user_id == OWNER
        return self.state

    def get_map_preferences(self, *, user_id: str) -> dict[str, Any]:
        return {"presenceMode": self.presence, "rendererConsentVersion": None, "updatedAt": None}

    def update_map_preferences(self, *, user_id: str, presence_mode, renderer_consent_version):
        self.calls.append(("map", presence_mode, renderer_consent_version))
        self.presence = presence_mode
        return self.get_map_preferences(user_id=user_id)

    def get_auto_approve_preference(self, *, user_id: str) -> dict[str, Any]:
        return dict(self.auto_approve)

    def update_auto_approve_preference(
        self, *, user_id: str, enabled: bool, scope_kind, circle_id, circle_ids=None
    ) -> dict[str, Any]:
        self.calls.append(("auto", enabled, scope_kind, circle_id, circle_ids))
        if not enabled:
            self.auto_approve = {"enabled": False, "scope": None, "ruleVersion": 2}
            return dict(self.auto_approve)
        if scope_kind == "circle":
            if circle_id not in self.owned_circles:
                raise OneLocationAgentError(
                    "LOCATION_AUTO_APPROVE_SCOPE_INVALID",
                    "Choose a Circle you created.",
                    status_code=403,
                )
            scope = {"kind": "circle", "circleId": circle_id}
        elif scope_kind == "circles":
            if set(circle_ids or []) - self.owned_circles:
                raise OneLocationAgentError(
                    "LOCATION_AUTO_APPROVE_SCOPE_INVALID",
                    "Choose Circles you created.",
                    status_code=403,
                )
            scope = {"kind": "circles", "circleIds": list(circle_ids)}
        elif scope_kind == "all_contacts":
            scope = {"kind": "all_contacts"}
        else:
            raise OneLocationAgentError(
                "LOCATION_AUTO_APPROVE_SCOPE_INVALID",
                "Choose who can be auto-approved.",
                status_code=422,
            )
        self.auto_approve = {"enabled": True, "scope": scope, "ruleVersion": 2}
        return dict(self.auto_approve)


class AdmissionDouble(OneLocationFeatureAdmission):
    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.asked_for: list[str | None] = []

    def nearby_presence_enabled(self, user_id: str | None = None) -> bool:
        self.asked_for.append(user_id)
        return self.enabled


class RatingsDouble:
    def __init__(self, rows: list[dict[str, Any]] | None = None, *, error: Exception | None = None):
        self.rows = rows or []
        self.error = error
        self.calls: list[tuple[Any, ...]] = []

    def list_own_ratings(self, *, user_id: str, limit: int = 25) -> dict[str, Any]:
        self.calls.append((user_id, limit))
        if self.error:
            raise self.error
        return {"ratings": list(self.rows)}


# -- context -----------------------------------------------------------------


def _ctx(
    *,
    services: dict[str, Any] | None = None,
    os_permission: str = "unknown",
    circles: dict[str, str] | None = None,
) -> ToolContext:
    entities = EntityContext()
    for circle_id, name in (circles or {}).items():
        entities.remember_circle(
            ConfirmedCircle(circle_id=circle_id, name=name, kind="family", confirmed_at=now_iso())
        )
    return ToolContext(
        user_id=OWNER,
        conversation_id=CONVERSATION,
        entities=entities,
        screen=ScreenContext(os_location_permission=os_permission),
        vault_owner_token="vault-token",  # noqa: S106 - test fixture, not a secret
        services=dict(services or {}),
    )


def _tool(name: str) -> ToolSpec:
    return next(tool for tool in location_state.TOOLS if tool.name == name)


async def _call(name: str, ctx: ToolContext, **args: Any):
    tool = _tool(name)
    return await tool.handler(ctx, tool.input_model.model_validate(args))


def _on(**overrides: Any) -> AccountSettings:
    fields: dict[str, Any] = {
        "user_id": OWNER,
        "sharing_state": "on",
        "sharing_consent_accepted_at": "2026-01-01T00:00:00+00:00",
    }
    fields.update(overrides)
    return AccountSettings(**fields)


# -- catalog -----------------------------------------------------------------


def test_catalog_policies_and_gateway_bindings():
    expected = {
        "get_location_status": (ToolPolicy.read, "location.open_now"),
        "turn_sharing_on": (ToolPolicy.confirm_voice, "location.set_sharing_enabled"),
        "turn_sharing_off": (ToolPolicy.confirm_tap, "location.set_sharing_enabled"),
        "set_precision": (ToolPolicy.confirm_voice, "location.set_precision"),
        "get_location_settings": (ToolPolicy.read, "location.open_settings"),
        "hide_on_map": (ToolPolicy.direct, "location.set_ghost_mode"),
        "show_on_map": (ToolPolicy.confirm_voice, "location.set_ghost_mode"),
        "set_auto_approve": (ToolPolicy.confirm_voice, "location.set_auto_share"),
        "list_my_place_ratings": (ToolPolicy.read, "location.open_ratings"),
        "resume_device_location_updates": (ToolPolicy.direct, "location.resume_updates"),
        "pause_device_location_updates": (ToolPolicy.direct, "location.pause_updates"),
    }
    assert {tool.name for tool in location_state.TOOLS} == set(expected)
    assert len(location_state.TOOLS) == 11
    for tool in location_state.TOOLS:
        policy, action_id = expected[tool.name]
        assert tool.policy is policy, tool.name
        assert tool.gateway_action_id == action_id, tool.name
        if tool.name in DEVICE_TOOLS:
            # The device switch is a local_handler action; account-level sharing
            # (location.set_sharing_enabled) is never bound to it.
            assert tool.gateway_action_id != "location.set_sharing_enabled", tool.name
            assert tool.ui_refresh == (), tool.name
        if tool.policy.needs_confirmation:
            assert tool.summarize is not None, f"{tool.name} needs a confirmation summary"
        # Vault-owner plane only: nothing here touches connections or profile.
        assert tool.firebase_plane is False
        declaration = tool.declaration()
        assert "$defs" not in declaration["parameters_json_schema"]
        assert declaration["parameters_json_schema"].get("additionalProperties") is False


def test_no_tool_accepts_a_free_text_person_or_circle_name():
    for tool in location_state.TOOLS:
        fields = tool.input_model.model_fields
        for forbidden in ("name", "person", "person_name", "circle_name", "display_name"):
            assert forbidden not in fields, f"{tool.name} exposes {forbidden}"
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"person_name": "Ayesha Sharma"})
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"circle_name": "Family"})
    # The only circle slot takes canonical 36-character ids; a spoken name never parses.
    with pytest.raises(ValidationError):
        location_state.SetAutoApproveInput.model_validate(
            {"enabled": True, "scope": "circle", "circle_ids": ["Family"]}
        )


def test_ratings_description_says_people_cannot_be_rated():
    description = _tool("list_my_place_ratings").description.lower()
    assert "places only" in description
    assert "rating a person" in description


# -- get_location_status -----------------------------------------------------


async def test_status_combines_settings_state_counts_and_device_permission():
    state = {
        "ownerGrants": [
            _grant(),
            _grant(share_kind="sos"),
            _grant(status="revoked"),
        ],
        "receivedGrants": [_grant(owner="friend"), _grant(owner="friend", status="expired")],
        "requests": [
            {"id": "r1", "ownerUserId": OWNER, "status": "pending"},
            {"id": "r2", "ownerUserId": "other", "requesterUserId": OWNER, "status": "pending"},
            {"id": "r3", "ownerUserId": OWNER, "status": "approved"},
        ],
        "publicInvites": [{"id": "l1", "status": "active"}, {"id": "l2", "status": "revoked"}],
    }
    location = LocationDouble(state=state, presence="foreground_private")
    settings = SettingsDouble(_on(precision="approximate"))
    ctx = _ctx(
        services={"location": location, "location_settings": settings},
        os_permission="granted",
    )

    result = await _call("get_location_status", ctx)

    assert result.status == "ok"
    assert result.sharing_state == "on"
    assert result.sharing_enabled is True
    assert result.effective_sharing is True
    assert result.os_permission_reported == "granted"
    assert result.os_permission_source == "device"
    assert result.active_shares == 2
    assert result.received_shares == 1
    assert result.pending_incoming_requests == 1
    assert result.active_links == 1
    assert result.active_sos is True
    assert result.presence_mode == "foreground_private"
    assert result.precision == "approximate"
    assert result.setup_required is False
    assert result.spoken_facts == [
        "Sharing with people is on and your device location permission is granted.",
        "Save My Soul is active.",
        "You have 2 active shares, 1 person sharing with you, 1 request waiting for you and 1 active link.",
        "You're visible on the map.",
        "Sharing precision is approximate.",
    ]


async def test_status_distinguishes_device_permission_from_app_sharing():
    ctx = _ctx(
        services={
            "location": LocationDouble(),
            "location_settings": SettingsDouble(_on(sharing_state="off")),
        },
        os_permission="granted",
    )

    result = await _call("get_location_status", ctx)

    assert result.sharing_state == "off"
    assert result.effective_sharing is False
    assert result.active_sos is False
    assert result.spoken_facts[0] == (
        "Your device permission is granted, but sharing with people is off."
    )
    assert "No active shares, no one is sharing with you, and no requests are waiting." in (
        result.spoken_facts
    )
    assert "You're hidden on the map." in result.spoken_facts


async def test_status_sharing_on_with_denied_device_permission_is_not_effective():
    ctx = _ctx(
        services={"location": LocationDouble(), "location_settings": SettingsDouble(_on())},
        os_permission="denied",
    )

    result = await _call("get_location_status", ctx)

    assert result.sharing_enabled is True
    assert result.effective_sharing is False
    assert result.spoken_facts[0] == (
        "Sharing with people is on, but your device location permission is denied, "
        "so nothing is being shared right now."
    )


async def test_status_reports_setup_required_when_posture_is_unset():
    ctx = _ctx(
        services={
            "location": LocationDouble(),
            "location_settings": SettingsDouble(AccountSettings(user_id=OWNER)),
        }
    )

    result = await _call("get_location_status", ctx)

    assert result.sharing_state == "unset"
    assert result.setup_required is True
    assert result.sharing_enabled is False
    assert result.spoken_facts[0].startswith("Location setup hasn't been completed yet")


async def test_status_falls_back_to_server_recorded_permission_when_device_is_unknown():
    ctx = _ctx(
        services={
            "location": LocationDouble(),
            "location_settings": SettingsDouble(_on(os_permission_reported="denied")),
        },
        os_permission="unknown",
    )

    result = await _call("get_location_status", ctx)

    assert result.os_permission_reported == "denied"
    assert result.os_permission_source == "server"
    assert result.effective_sharing is False


async def test_status_maps_service_errors_to_rejected():
    class Broken(LocationDouble):
        def list_state(self, *, user_id: str):
            raise OneLocationAgentError(
                "LOCATION_STATE_FAILED", "State is unavailable.", status_code=503
            )

    ctx = _ctx(services={"location": Broken(), "location_settings": SettingsDouble(_on())})

    result = await _call("get_location_status", ctx)

    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_STATE_FAILED"
    assert result.spoken_facts == ["State is unavailable."]


# -- turn_sharing_on ---------------------------------------------------------


async def test_turn_sharing_on_after_off_with_recorded_consent():
    settings = SettingsDouble(_on(sharing_state="off"))
    ctx = _ctx(services={"location_settings": settings}, os_permission="granted")

    result = await _call("turn_sharing_on", ctx)

    assert result.status == "on"
    assert result.changed is True
    assert result.spoken_facts == ["Sharing with people is on."]
    assert settings.calls == [("sharing", "on", False, None)]


async def test_turn_sharing_on_without_consent_needs_consent():
    settings = SettingsDouble(
        AccountSettings(user_id=OWNER, sharing_state="off", sharing_consent_accepted_at=None)
    )
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_on", ctx)

    assert result.status == "consent_required"
    assert result.needs == "consent"
    assert result.reason_code == "LOCATION_SHARING_CONSENT_REQUIRED"
    assert result.spoken_facts == ["Accept the location consent first."]
    assert settings.state.sharing_state == "off"


async def test_turn_sharing_on_forwards_the_consent_version_the_app_supplied():
    settings = SettingsDouble(
        AccountSettings(user_id=OWNER, sharing_state="off", sharing_consent_accepted_at=None)
    )
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_on", ctx, consent_version="location-sharing-v1")

    assert result.status == "on"
    assert settings.calls == [("sharing", "on", False, "location-sharing-v1")]


async def test_turn_sharing_on_requires_completed_setup_when_posture_is_unset():
    settings = SettingsDouble(AccountSettings(user_id=OWNER))
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_on", ctx)

    assert result.status == "setup_required"
    assert result.needs == "setup"
    assert settings.calls == []
    assert "Nothing was changed." in result.spoken_facts[0]


async def test_turn_sharing_on_mentions_a_denied_device_permission_honestly():
    settings = SettingsDouble(_on(sharing_state="off"))
    ctx = _ctx(services={"location_settings": settings}, os_permission="denied")

    result = await _call("turn_sharing_on", ctx)

    assert result.status == "on"
    assert result.os_permission_reported == "denied"
    assert result.spoken_facts == [
        "Sharing with people is on.",
        "Your device location permission is denied, so nothing will be shared until you allow it.",
    ]


async def test_turn_sharing_on_when_already_on_says_so():
    settings = SettingsDouble(_on())
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_on", ctx)

    assert result.status == "on"
    assert result.changed is False
    assert result.spoken_facts == ["Sharing was already on."]


def test_turn_sharing_on_summary():
    ctx = _ctx()
    tool = _tool("turn_sharing_on")
    assert tool.summarize(ctx, tool.input_model()) == "turn location sharing on"


# -- turn_sharing_off --------------------------------------------------------


async def test_turn_sharing_off_states_real_revoked_counts():
    settings = SettingsDouble(_on())
    settings.revoked_grants = ("g1", "g2")
    settings.revoked_links = ("l1",)
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_off", ctx)

    assert result.status == "off"
    assert result.revoked_shares == 2
    assert result.revoked_links == 1
    assert result.notified_recipients == 2
    assert result.spoken_facts == ["Sharing is off. I stopped 2 active shares and 1 link."]
    assert settings.calls == [("sharing", "off", False, None)]


async def test_turn_sharing_off_with_one_share_and_no_links():
    settings = SettingsDouble(_on())
    settings.revoked_grants = ("g1",)
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_off", ctx)

    assert result.spoken_facts == ["Sharing is off. I stopped 1 active share."]


async def test_turn_sharing_off_with_nothing_to_stop():
    settings = SettingsDouble(_on())
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_off", ctx)

    assert result.status == "off"
    assert result.spoken_facts == ["Sharing is off. There were no active shares or links to stop."]


async def test_turn_sharing_off_when_already_off():
    settings = SettingsDouble(_on(sharing_state="off"))
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_off", ctx)

    assert result.status == "off"
    assert result.changed is False
    assert result.spoken_facts == ["Sharing was already off."]


async def test_turn_sharing_off_is_blocked_by_an_active_sos():
    settings = SettingsDouble(_on(), sos_active=True)
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_off", ctx)

    assert result.status == "sos_active"
    assert result.reason_code == "LOCATION_SOS_ACTIVE"
    assert result.spoken_facts == [
        "Save My Soul is active. Stop it explicitly before turning sharing off.",
        "Nothing was changed.",
    ]
    assert settings.state.sharing_state == "on"


async def test_turn_sharing_off_can_include_sos_when_explicitly_asked():
    settings = SettingsDouble(_on(), sos_active=True)
    settings.revoked_grants = ("sos-grant",)
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("turn_sharing_off", ctx, include_sos=True)

    assert result.status == "off"
    assert settings.calls == [("sharing", "off", True, None)]


def test_turn_sharing_off_summary():
    ctx = _ctx()
    tool = _tool("turn_sharing_off")
    assert tool.summarize(ctx, tool.input_model()) == (
        "turn location sharing off and stop your active shares"
    )
    assert tool.summarize(ctx, tool.input_model(include_sos=True)) == (
        "turn location sharing off, stop Save My Soul, and stop your active shares"
    )


# -- set_precision -----------------------------------------------------------


async def test_set_precision_approximate_is_worded_as_a_device_setting():
    settings = SettingsDouble(_on())
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("set_precision", ctx, precision="approximate")

    assert result.status == "approximate"
    assert result.changed is True
    assert result.spoken_facts == ["Sharing precision is now approximate on this device."]
    assert settings.calls == [("precision", "approximate")]


async def test_set_precision_back_to_precise():
    settings = SettingsDouble(_on(precision="approximate"))
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("set_precision", ctx, precision="precise")

    assert result.status == "precise"
    assert result.spoken_facts == ["Sharing precision is now precise."]


async def test_set_precision_unchanged_is_not_worded_as_a_change():
    settings = SettingsDouble(_on())
    ctx = _ctx(services={"location_settings": settings})

    result = await _call("set_precision", ctx, precision="precise")

    assert result.status == "precise"
    assert result.changed is False
    assert result.spoken_facts == ["Sharing precision was already precise."]


def test_set_precision_rejects_unknown_values_and_summarizes():
    with pytest.raises(ValidationError):
        location_state.SetPrecisionInput.model_validate({"precision": "fuzzy"})
    tool = _tool("set_precision")
    assert tool.summarize(_ctx(), tool.input_model(precision="approximate")) == (
        "set your sharing precision to approximate"
    )


# -- get_location_settings ---------------------------------------------------


async def test_settings_read_names_the_confirmed_circle():
    location = LocationDouble(presence="ghost")
    location.auto_approve = {
        "enabled": True,
        "scope": {"kind": "circle", "circleId": FAMILY_ID},
        "ruleVersion": 3,
    }
    ctx = _ctx(
        services={"location": location, "location_settings": SettingsDouble(_on())},
        circles={FAMILY_ID: "Family"},
    )

    result = await _call("get_location_settings", ctx)

    assert result.status == "ok"
    assert result.sharing_state == "on"
    assert result.precision == "precise"
    assert result.presence_mode == "ghost"
    assert result.auto_approve_enabled is True
    assert result.auto_approve_scope == {"kind": "circle", "circleId": FAMILY_ID}
    assert result.spoken_facts == [
        "Sharing with people is on.",
        "Sharing precision is precise.",
        "You're hidden on the map.",
        "Automatic approval is on for Family.",
    ]


async def test_settings_read_does_not_invent_a_name_for_an_unconfirmed_circle():
    location = LocationDouble(presence="foreground_private")
    location.auto_approve = {
        "enabled": True,
        "scope": {"kind": "circles", "circleIds": [FAMILY_ID, WORK_ID]},
        "ruleVersion": 3,
    }
    ctx = _ctx(
        services={
            "location": location,
            "location_settings": SettingsDouble(_on(sharing_state="off")),
        },
        circles={FAMILY_ID: "Family"},
    )

    result = await _call("get_location_settings", ctx)

    assert result.sharing_enabled is False
    assert "Automatic approval is on for 2 circles." in result.spoken_facts
    assert "You're visible on the map." in result.spoken_facts


async def test_settings_read_with_everything_off():
    ctx = _ctx(
        services={
            "location": LocationDouble(),
            "location_settings": SettingsDouble(AccountSettings(user_id=OWNER)),
        }
    )

    result = await _call("get_location_settings", ctx)

    assert result.setup_required is True
    assert result.spoken_facts == [
        "Location setup hasn't been completed yet.",
        "Sharing precision is precise.",
        "You're hidden on the map.",
        "Automatic approval is off.",
    ]


# -- hide_on_map / show_on_map -----------------------------------------------


async def test_hide_on_map_is_direct_and_sets_ghost():
    location = LocationDouble(presence="foreground_private")
    ctx = _ctx(services={"location": location})

    result = await _call("hide_on_map", ctx)

    assert result.status == "hidden"
    assert result.presence_mode == "ghost"
    assert result.spoken_facts == ["You're hidden on the map now."]
    assert location.calls == [("map", "ghost", None)]


async def test_show_on_map_sets_foreground_private_when_sharing_is_on():
    location = LocationDouble(presence="ghost")
    ctx = _ctx(services={"location": location, "location_settings": SettingsDouble(_on())})

    result = await _call("show_on_map", ctx)

    assert result.status == "visible"
    assert result.presence_mode == "foreground_private"
    assert result.spoken_facts == ["You're visible on the map now."]
    assert location.calls == [("map", "foreground_private", None)]


async def test_show_on_map_is_refused_while_sharing_is_off():
    location = LocationDouble(presence="ghost")
    ctx = _ctx(
        services={
            "location": location,
            "location_settings": SettingsDouble(_on(sharing_state="off")),
        }
    )

    result = await _call("show_on_map", ctx)

    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_SHARING_OFF"
    assert location.calls == []
    assert location.presence == "ghost"


async def test_map_presence_service_error_is_rejected():
    class Broken(LocationDouble):
        def update_map_preferences(self, **kwargs):
            raise OneLocationAgentError(
                "LOCATION_MAP_PRESENCE_INVALID", "Map presence mode is invalid.", status_code=422
            )

    ctx = _ctx(services={"location": Broken()})

    result = await _call("hide_on_map", ctx)

    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_MAP_PRESENCE_INVALID"
    assert result.spoken_facts == ["Map presence mode is invalid."]


def test_show_on_map_summary():
    tool = _tool("show_on_map")
    assert tool.summarize(_ctx(), tool.input_model()) == "show you on the map"


# -- set_auto_approve --------------------------------------------------------


async def test_set_auto_approve_for_all_contacts():
    location = LocationDouble()
    ctx = _ctx(services={"location": location})

    result = await _call("set_auto_approve", ctx, enabled=True, scope="all_contacts")

    assert result.status == "on"
    assert result.scope == {"kind": "all_contacts"}
    assert result.rule_version == 2
    assert result.spoken_facts == ["Automatic approval is on for all contacts."]
    assert location.calls == [("auto", True, "all_contacts", None, None)]


async def test_set_auto_approve_for_a_confirmed_circle_uses_its_real_name():
    location = LocationDouble()
    ctx = _ctx(services={"location": location}, circles={FAMILY_ID: "Family"})

    result = await _call(
        "set_auto_approve", ctx, enabled=True, scope="circle", circle_ids=[FAMILY_ID]
    )

    assert result.status == "on"
    assert result.spoken_facts == ["Automatic approval is on for Family."]
    assert location.calls == [("auto", True, "circle", FAMILY_ID, None)]


async def test_set_auto_approve_for_several_confirmed_circles():
    location = LocationDouble()
    ctx = _ctx(services={"location": location}, circles={FAMILY_ID: "Family", WORK_ID: "Work"})

    result = await _call(
        "set_auto_approve", ctx, enabled=True, scope="circles", circle_ids=[FAMILY_ID, WORK_ID]
    )

    assert result.status == "on"
    assert result.spoken_facts == ["Automatic approval is on for Family and Work."]
    assert location.calls == [("auto", True, "circles", None, [FAMILY_ID, WORK_ID])]


async def test_set_auto_approve_refuses_an_unconfirmed_circle_id():
    location = LocationDouble()
    ctx = _ctx(services={"location": location}, circles={FAMILY_ID: "Family"})

    result = await _call(
        "set_auto_approve", ctx, enabled=True, scope="circle", circle_ids=[STRANGER_ID]
    )

    assert result.status == "rejected"
    assert result.reason_code == "circle_not_confirmed"
    assert result.needs == "disambiguation"
    assert location.calls == []


async def test_set_auto_approve_enable_without_scope_is_invalid():
    location = LocationDouble()
    ctx = _ctx(services={"location": location})

    result = await _call("set_auto_approve", ctx, enabled=True)

    assert result.status == "rejected"
    assert result.reason_code == "invalid_arguments"
    assert location.calls == []


async def test_set_auto_approve_single_circle_scope_takes_exactly_one_circle():
    location = LocationDouble()
    ctx = _ctx(services={"location": location}, circles={FAMILY_ID: "Family", WORK_ID: "Work"})

    result = await _call(
        "set_auto_approve", ctx, enabled=True, scope="circle", circle_ids=[FAMILY_ID, WORK_ID]
    )

    assert result.status == "rejected"
    assert result.reason_code == "invalid_arguments"
    assert location.calls == []


async def test_set_auto_approve_off_ignores_scope():
    location = LocationDouble()
    location.auto_approve = {"enabled": True, "scope": {"kind": "all_contacts"}, "ruleVersion": 1}
    ctx = _ctx(services={"location": location})

    result = await _call("set_auto_approve", ctx, enabled=False, scope="all_contacts")

    assert result.status == "off"
    assert result.scope is None
    assert result.spoken_facts == ["Automatic approval is off."]
    assert location.calls == [("auto", False, None, None, None)]


async def test_set_auto_approve_maps_service_refusal_to_rejected():
    location = LocationDouble()
    location.owned_circles = set()
    ctx = _ctx(services={"location": location}, circles={FAMILY_ID: "Family"})

    result = await _call(
        "set_auto_approve", ctx, enabled=True, scope="circle", circle_ids=[FAMILY_ID]
    )

    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_AUTO_APPROVE_SCOPE_INVALID"
    assert result.spoken_facts == ["Choose a Circle you created."]


def test_set_auto_approve_summaries_name_the_confirmed_circles():
    tool = _tool("set_auto_approve")
    ctx = _ctx(circles={FAMILY_ID: "Family", WORK_ID: "Work"})
    assert tool.summarize(ctx, tool.input_model(enabled=False)) == (
        "turn automatic approval of location requests off"
    )
    assert tool.summarize(ctx, tool.input_model(enabled=True, scope="all_contacts")) == (
        "turn automatic approval on for all contacts"
    )
    assert (
        tool.summarize(ctx, tool.input_model(enabled=True, scope="circle", circle_ids=[FAMILY_ID]))
        == "turn automatic approval on for Family"
    )
    assert (
        tool.summarize(
            ctx, tool.input_model(enabled=True, scope="circles", circle_ids=[FAMILY_ID, WORK_ID])
        )
        == "turn automatic approval on for Family and Work"
    )


# -- list_my_place_ratings ---------------------------------------------------


async def test_ratings_are_unsupported_when_nearby_is_not_admitted():
    admission = AdmissionDouble(enabled=False)
    ratings = RatingsDouble([{"placeId": "p1", "placeLabel": "Blue Bottle", "rating": 5}])
    ctx = _ctx(services={"feature_admission": admission, "place_ratings": ratings})

    result = await _call("list_my_place_ratings", ctx)

    assert result.status == "unsupported"
    assert result.reason_code == "ratings_not_available"
    assert result.needs == "unsupported"
    assert result.spoken_facts == ["Ratings aren't available for your account yet."]
    assert admission.asked_for == [OWNER]
    assert ratings.calls == []


async def test_ratings_are_listed_from_the_service_rows():
    rows = [
        {"placeId": "p1", "placeLabel": "Blue Bottle Coffee", "rating": 5, "visitCount": 3},
        {"placeId": "p2", "placeLabel": None, "rating": 2},
    ]
    ratings = RatingsDouble(rows)
    ctx = _ctx(services={"feature_admission": AdmissionDouble(True), "place_ratings": ratings})

    result = await _call("list_my_place_ratings", ctx)

    assert result.status == "listed"
    assert result.count == 2
    assert result.spoken_facts == [
        "You've rated 2 places.",
        "Blue Bottle Coffee: 5 out of 5.",
        "a place: 2 out of 5.",
    ]
    assert result.ratings[0] == {
        "place_id": "p1",
        "place_label": "Blue Bottle Coffee",
        "rating": 5,
        "visited_at": None,
        "visit_count": 3,
    }
    assert ratings.calls == [(OWNER, 25)]


async def test_ratings_empty_state():
    ctx = _ctx(
        services={"feature_admission": AdmissionDouble(True), "place_ratings": RatingsDouble([])}
    )

    result = await _call("list_my_place_ratings", ctx)

    assert result.status == "empty"
    assert result.spoken_facts == ["You haven't rated any places yet."]


async def test_ratings_service_error_is_rejected():
    error = PlaceRatingError(
        "PLACE_RATING_READ_FAILED", "Couldn't read your ratings.", status_code=503
    )
    ctx = _ctx(
        services={
            "feature_admission": AdmissionDouble(True),
            "place_ratings": RatingsDouble(error=error),
        }
    )

    result = await _call("list_my_place_ratings", ctx)

    assert result.status == "rejected"
    assert result.reason_code == "PLACE_RATING_READ_FAILED"
    assert result.spoken_facts == ["Couldn't read your ratings."]


async def test_ratings_admission_defaults_to_the_lifted_predicate(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", raising=False)
    ctx = _ctx(services={"place_ratings": RatingsDouble([])})

    result = await _call("list_my_place_ratings", ctx)

    assert result.status == "unsupported"
    assert isinstance(ctx.services["feature_admission"], OneLocationFeatureAdmission)


# -- resume/pause_device_location_updates ------------------------------------


RESUME = "resume_device_location_updates"
PAUSE = "pause_device_location_updates"
STEP_EXPIRES_AT = 1_000.0
ON_OFF_FACTS = {"Location is on.", "Location is off."}


class UntouchedSettings(SettingsDouble):
    """The device switch has no server row: even a read is a defect."""

    def get(self, *, user_id: str) -> AccountSettings:
        raise AssertionError("location_settings must not be read by the device tools")


class UntouchedLocation(LocationDouble):
    def list_state(self, *, user_id: str) -> dict[str, Any]:
        raise AssertionError("location state must not be read by the device tools")

    def get_map_preferences(self, *, user_id: str) -> dict[str, Any]:
        raise AssertionError("map preferences must not be read by the device tools")


def _step(desired: str, *, expires_at: float | None = STEP_EXPIRES_AT) -> dict[str, Any]:
    """The record ``VoiceSession._emit_side_effects`` keeps for a pending step."""
    action = (
        location_state.RESUME_UPDATES_ACTION_ID
        if desired == "on"
        else location_state.PAUSE_UPDATES_ACTION_ID
    )
    record: dict[str, Any] = {
        "kind": location_state.SET_LOCATION_UPDATES_STEP_KIND,
        "desired_state": desired,
        "gateway_action_id": action,
        "timeout_s": location_state.LOCATION_UPDATES_STEP_TIMEOUT_S,
        "tool": RESUME if desired == "on" else PAUSE,
        "call_id": "c1",
        "requested_at": 0.0,
    }
    if expires_at is not None:
        record["expires_at"] = expires_at
    return record


def _report(step: dict[str, Any], outcome: str, observed: str = "unknown", **extra: Any) -> dict:
    payload: dict[str, Any] = {
        "gateway_action_id": step["gateway_action_id"],
        "desired_state": step["desired_state"],
        "outcome": outcome,
        "observed_state": observed,
    }
    payload.update(extra)
    return payload


def _settle(step, *, status="ok", payload, now=0.0):
    return location_state.settle_location_updates_step(
        step, status=status, payload=payload, now=now
    )


def test_device_tool_descriptions_separate_the_switch_from_account_sharing():
    status = _tool("get_location_status").description
    assert "is my location on" not in status.lower()
    assert "does not read or change this device's Location updates switch" in status

    for name in ("turn_sharing_on", "turn_sharing_off"):
        description = _tool(name).description
        assert "account-level sharing with people" in description, name
        assert "not this device's Location updates switch" in description, name
        assert RESUME in description and PAUSE in description, name
    resume = _tool(RESUME).description
    pause = _tool(PAUSE).description
    assert "This is this device's Location switch, not sharing with people (turn_sharing_on)" in (
        resume
    )
    assert "This is this device's Location switch, not sharing with people (turn_sharing_off" in (
        pause
    )
    assert "Does not change account-level sharing consent" in resume
    assert "Preserves existing sharing grants and account-level sharing consent" in pause
    for description in (resume, pause):
        assert "Returns location_updates_pending first" in description
        assert "[ONE_EVENT] tool_result" in description
    assert "Reports already_on" in resume and "Reports already_off" in pause


def test_device_tool_inputs_take_no_arguments():
    for name in DEVICE_TOOLS:
        assert _tool(name).input_model.model_fields == {}
        with pytest.raises(ValidationError):
            _tool(name).input_model.model_validate({"desired_state": "on"})
        assert _tool(name).declaration()["parameters_json_schema"] == {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        }


@pytest.mark.parametrize(
    ("name", "desired", "action_id"),
    [
        (RESUME, "on", "location.resume_updates"),
        (PAUSE, "off", "location.pause_updates"),
    ],
)
async def test_device_tools_answer_pending_with_a_typed_step_and_touch_no_service(
    name, desired, action_id
):
    settings = UntouchedSettings(_on(sharing_state="off", os_permission_reported="denied"))
    location = UntouchedLocation()
    # A denied device permission is deliberately not consulted: only the
    # device's real capture decides, and the step carries that decision back.
    ctx = _ctx(
        services={"location": location, "location_settings": settings},
        os_permission="denied",
    )

    result = await _call(name, ctx)

    assert result.status == "location_updates_pending"
    assert result.needs == "client_step"
    assert result.desired_state == desired
    assert result.gateway_action_id == action_id
    assert result.observed_state == "unknown"
    assert result.changed is None
    assert result.reason_code is None
    assert result.client_step == {
        "kind": "set_location_updates",
        "desired_state": desired,
        "gateway_action_id": action_id,
        "timeout_s": 45,
    }
    assert result.ui_refresh == []
    assert result.spoken_facts == [f"Switching location updates {desired} for this device now."]
    assert not ON_OFF_FACTS & set(result.spoken_facts)
    assert settings.calls == []
    assert location.calls == []
    # The pending result is what the relay's tool.result frame reports as ok:false.
    assert protocol.tool_result(call_id="c1", tool=name, result_public=result.public())["ok"] is (
        False
    )


@pytest.mark.parametrize(
    ("desired", "outcome", "status", "changed", "spoken"),
    [
        ("on", "on", "on", True, "Location is on."),
        ("on", "already_on", "already_on", False, "Location is already on."),
        ("off", "off", "off", True, "Location is off."),
        ("off", "already_off", "already_off", False, "Location is already off."),
    ],
)
def test_settle_accepts_the_four_ok_outcomes_with_exact_facts(
    desired, outcome, status, changed, spoken
):
    step = _step(desired)
    result = _settle(step, payload=_report(step, outcome, desired, navigated=True), now=10.0)

    assert result.status == status
    assert result.reason_code is None
    assert result.desired_state == desired
    assert result.gateway_action_id == step["gateway_action_id"]
    assert result.observed_state == desired
    assert result.changed is changed
    assert result.spoken_facts == [spoken]
    assert result.client_step is None
    assert result.needs is None


def test_settle_at_the_deadline_is_still_in_time():
    step = _step("on")
    result = _settle(step, payload=_report(step, "on", "on"), now=STEP_EXPIRES_AT)
    assert result.status == "on"


def _cases():
    """(label, desired, status, payload-or-builder, expected reason_code)."""
    return [
        (
            "tampered_gateway_action_id",
            "on",
            "ok",
            lambda s: _report(s, "on", "on", gateway_action_id="location.pause_updates"),
            "inconsistent_step_payload",
        ),
        (
            "tampered_gateway_action_id_account_sharing",
            "on",
            "ok",
            lambda s: _report(s, "on", "on", gateway_action_id="location.set_sharing_enabled"),
            "inconsistent_step_payload",
        ),
        (
            "tampered_desired_state",
            "on",
            "ok",
            lambda s: _report(s, "off", "off", desired_state="off"),
            "inconsistent_step_payload",
        ),
        (
            "extra_key_latitude",
            "on",
            "ok",
            lambda s: _report(s, "on", "on", latitude=12.97, longitude=77.59),
            "invalid_step_payload",
        ),
        (
            "extra_key_free_text",
            "on",
            "ok",
            lambda s: _report(s, "on", "on", spoken_facts=["Location is on."]),
            "invalid_step_payload",
        ),
        (
            "missing_outcome",
            "on",
            "ok",
            lambda s: {"gateway_action_id": s["gateway_action_id"], "desired_state": "on"},
            "invalid_step_payload",
        ),
        (
            "unknown_outcome",
            "on",
            "ok",
            lambda s: _report(s, "enabled", "on"),
            "invalid_step_payload",
        ),
        (
            "failed_status_with_on_outcome",
            "on",
            "failed",
            lambda s: _report(s, "on", "on"),
            "inconsistent_step_payload",
        ),
        (
            "ok_status_with_failure_outcome",
            "on",
            "ok",
            lambda s: _report(s, "permission_denied", "off"),
            "inconsistent_step_payload",
        ),
        (
            "wrong_polarity_outcome",
            "on",
            "ok",
            lambda s: _report(s, "off", "off"),
            "inconsistent_step_payload",
        ),
        (
            "wrong_polarity_already",
            "off",
            "ok",
            lambda s: _report(s, "already_on", "on"),
            "inconsistent_step_payload",
        ),
        (
            "observed_contradicts_outcome",
            "on",
            "ok",
            lambda s: _report(s, "on", "off"),
            "inconsistent_step_payload",
        ),
        (
            "observed_unknown_on_success",
            "on",
            "ok",
            lambda s: _report(s, "on", "unknown"),
            "inconsistent_step_payload",
        ),
        (
            "provider_no_handler",
            "on",
            "failed",
            lambda s: {"reason": "no_handler"},
            "handler_unavailable",
        ),
        (
            "provider_timed_out",
            "off",
            "failed",
            lambda s: {"reason": "timed_out"},
            "timed_out",
        ),
        (
            "provider_unknown_reason",
            "on",
            "failed",
            lambda s: {"reason": "exploded"},
            "invalid_step_payload",
        ),
        (
            "nearby_checkout_failed_on_a_resume_step",
            "on",
            "failed",
            lambda s: _report(s, "nearby_checkout_failed", "off"),
            "inconsistent_step_payload",
        ),
        (
            "vault_locked_on_a_resume_step",
            "on",
            "failed",
            lambda s: _report(s, "vault_locked", "off"),
            "inconsistent_step_payload",
        ),
        (
            "permission_denied_on_a_pause_step",
            "off",
            "failed",
            lambda s: _report(s, "permission_denied", "off", os_permission="denied"),
            "inconsistent_step_payload",
        ),
        (
            "no_fix_on_a_pause_step",
            "off",
            "failed",
            lambda s: _report(s, "no_fix", "off"),
            "inconsistent_step_payload",
        ),
        (
            "generic_failure",
            "on",
            "failed",
            lambda s: _report(s, "failed", "off"),
            "failed",
        ),
        (
            "signed_out",
            "on",
            "failed",
            lambda s: _report(s, "signed_out", "unknown"),
            "signed_out",
        ),
    ]


@pytest.mark.parametrize(
    ("desired", "status", "build", "reason_code"),
    [case[1:] for case in _cases()],
    ids=[case[0] for case in _cases()],
)
def test_settle_refuses_everything_off_the_allowlist(desired, status, build, reason_code):
    step = _step(desired)

    result = _settle(step, status=status, payload=build(step), now=10.0)

    assert result.status == "rejected"
    assert result.reason_code == reason_code
    assert result.desired_state == desired
    assert result.gateway_action_id == step["gateway_action_id"]
    assert result.changed is not True
    assert len(result.spoken_facts) == 1
    assert not ON_OFF_FACTS & set(result.spoken_facts)
    assert "already" not in result.spoken_facts[0]


@pytest.mark.parametrize("desired", ["on", "off"])
def test_settle_rejects_a_late_but_otherwise_perfect_report(desired):
    step = _step(desired)
    payload = _report(step, desired, desired)
    assert _settle(step, payload=payload, now=STEP_EXPIRES_AT).status == desired

    late = _settle(step, payload=payload, now=STEP_EXPIRES_AT + 0.001)

    assert late.status == "rejected"
    assert late.reason_code == "step_expired"
    assert late.observed_state == "unknown"
    assert late.changed is None
    assert late.spoken_facts == [
        "I couldn't verify the Location switch. Check it on the Location screen."
    ]


def test_settle_provider_sentinels_are_exact_and_carry_no_state():
    step = _step("on")
    unavailable = _settle(step, status="failed", payload={"reason": "no_handler"}, now=1.0)
    assert (unavailable.status, unavailable.reason_code) == ("rejected", "handler_unavailable")
    assert unavailable.observed_state == "unknown" and unavailable.changed is None
    assert unavailable.spoken_facts == [
        "I couldn't open Location on this device. Open Location and try the switch."
    ]

    timed_out = _settle(step, status="failed", payload={"reason": "timed_out"}, now=1.0)
    assert (timed_out.status, timed_out.reason_code) == ("rejected", "timed_out")
    assert timed_out.observed_state == "unknown" and timed_out.changed is None
    assert timed_out.spoken_facts == [
        "I couldn't confirm the Location switch in time. Check the switch on the Location screen."
    ]
    # The sentinel is exactly one key: a coordinate riding along is not a sentinel.
    smuggled = _settle(
        step, status="failed", payload={"reason": "timed_out", "latitude": 1.0}, now=1.0
    )
    assert (smuggled.status, smuggled.reason_code) == ("rejected", "invalid_step_payload")


def test_settle_partial_pause_states_the_nearby_gap_exactly():
    step = _step("off")

    result = _settle(
        step,
        status="failed",
        payload=_report(step, "nearby_checkout_failed", "off", navigated=True),
        now=1.0,
    )

    assert result.status == "rejected"
    assert result.reason_code == "nearby_checkout_failed"
    assert result.observed_state == "off"
    assert result.changed is None
    assert result.spoken_facts == [
        "Location updates are paused on this device, but I couldn't check you out of Nearby -- "
        "you may still be visible to people around you."
    ]
    assert not ON_OFF_FACTS & set(result.spoken_facts)


def test_settle_vault_locked_pause_states_the_unlock_ask_exactly():
    step = _step("off")
    result = _settle(step, status="failed", payload=_report(step, "vault_locked", "off"), now=1.0)
    assert (result.status, result.reason_code) == ("rejected", "vault_locked")
    assert result.spoken_facts == [
        "Location updates are paused on this device, but One is locked so I couldn't check you "
        "out of Nearby. Unlock One and ask again."
    ]


def test_settle_permission_denied_and_no_fix_state_the_device_facts_exactly():
    step = _step("on")

    denied = _settle(
        step,
        status="failed",
        payload=_report(step, "permission_denied", "off", os_permission="denied"),
        now=1.0,
    )
    assert (denied.status, denied.reason_code) == ("rejected", "permission_denied")
    assert denied.observed_state == "off"
    assert denied.changed is None
    assert denied.spoken_facts == [
        "Location is off for Hussh on this device. Allow location for Hussh in your device "
        "settings, then ask me again."
    ]

    no_fix = _settle(step, status="failed", payload=_report(step, "no_fix", "off"), now=1.0)
    assert (no_fix.status, no_fix.reason_code) == ("rejected", "no_fix")
    assert no_fix.spoken_facts == [
        "I couldn't get a position from this device, so Location stayed off. Try again in a moment."
    ]


@pytest.mark.parametrize(
    ("outcome", "spoken"),
    [
        ("superseded", "That request was replaced by a newer Location change."),
        ("cancelled", "That Location change was cancelled."),
        (
            "handler_unavailable",
            "I couldn't open Location on this device. Open Location and try the switch.",
        ),
    ],
)
def test_settle_device_reported_abandonment_is_not_a_change(outcome, spoken):
    step = _step("on")
    result = _settle(step, status="failed", payload=_report(step, outcome, "unknown"), now=1.0)
    assert (result.status, result.reason_code) == ("rejected", outcome)
    assert result.changed is False
    assert result.spoken_facts == [spoken]


def test_settle_without_a_deadline_never_expires_but_still_validates():
    step = _step("on", expires_at=None)
    ok = _settle(step, payload=_report(step, "on", "on"), now=10_000.0)
    assert ok.status == "on"
    bad = _settle(step, payload=_report(step, "on", "on", latitude=0.0), now=10_000.0)
    assert (bad.status, bad.reason_code) == ("rejected", "invalid_step_payload")


# -- lifted admission predicate ----------------------------------------------


def test_nearby_admission_semantics_are_unchanged(monkeypatch):
    for key in (
        "ENVIRONMENT",
        "HUSHH_DEPLOY_ENV",
        "ONE_LOCATION_NEARBY_PRESENCE_MODE",
        "ONE_LOCATION_NEARBY_PRESENCE_COHORT",
    ):
        monkeypatch.delenv(key, raising=False)
    # No environment at all is treated as hosted: closed.
    assert nearby_presence_enabled("u1") is False

    monkeypatch.setenv("ENVIRONMENT", "test")
    assert nearby_presence_enabled("u1") is True
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "disabled")
    assert nearby_presence_enabled("u1") is False
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "uat_simulation")
    assert nearby_presence_enabled("u1") is True

    monkeypatch.setenv("ENVIRONMENT", "production")
    assert nearby_presence_enabled("u1") is False
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "production")
    assert nearby_presence_enabled("u1") is False
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", "someone-else,u2")
    assert nearby_presence_enabled("u1") is False
    assert nearby_presence_enabled("u2") is True
    assert nearby_presence_enabled(None) is False
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", "all")
    assert nearby_presence_enabled("anyone") is True
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    assert nearby_presence_enabled("anyone") is False


def test_location_routes_gate_on_the_lifted_predicate():
    from api.routes.one import location as location_routes

    assert location_routes._nearby_presence_enabled is nearby_presence_enabled
    assert location_routes._nearby_presence_simulation_enabled is nearby_presence_enabled
