"""Profile tool family: identity read, display-name change, privacy posture,
contact discoverability. Services are injected doubles; nothing touches
Firebase or the database."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import profile
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    now_iso,
)
from hushh_mcp.services.contact_sync_contract import CONTACT_SYNC_CONSENT_CONTRACT_VERSION
from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError, RIAIAMPolicyError

USER = "firebase-uid-owner"
FRIEND = "firebase-uid-friend"


def _fixture_credential(kind: str) -> str:
    """Non-production fixture credential without an inline secret-like literal."""
    return f"{kind}-fixture"


# -- doubles -----------------------------------------------------------------


class IdentityDouble:
    def __init__(self, identity: dict[str, Any] | None) -> None:
        self.identity = identity
        self.update_calls: list[tuple[str, str]] = []
        self.update_error: Exception | None = None

    async def sync_from_firebase(
        self, user_id: str, *, force: bool = False
    ) -> dict[str, Any] | None:
        assert user_id == USER
        return self.identity

    async def update_display_name(self, user_id: str, display_name: str) -> dict[str, Any] | None:
        self.update_calls.append((user_id, display_name))
        if self.update_error is not None:
            raise self.update_error
        # The real service normalizes whitespace at the source of truth; the
        # tool must speak the stored value, not the argument.
        stored = " ".join(display_name.split())
        self.identity = {**(self.identity or {}), "display_name": stored}
        return self.identity


class IamDouble:
    def __init__(
        self,
        *,
        persona: str = "investor",
        marketplace_opt_in: bool = False,
        contact_discoverable: bool = False,
        directory_visible: bool = True,
        schema_ready: bool = True,
    ) -> None:
        self.persona = persona
        self.marketplace_opt_in = marketplace_opt_in
        self.contact_discoverable = contact_discoverable
        self.directory_visible = directory_visible
        self.schema_ready = schema_ready
        self.set_calls: list[tuple[str, bool, str | None]] = []

    def _check_schema(self) -> None:
        if not self.schema_ready:
            raise IAMSchemaNotReadyError()

    async def get_persona_state(self, user_id: str, *, force: bool = False) -> dict[str, Any]:
        self._check_schema()
        return {
            "user_id": user_id,
            "active_persona": self.persona,
            "investor_marketplace_opt_in": self.marketplace_opt_in,
        }

    async def get_contact_discoverability(self, user_id: str) -> dict[str, Any]:
        self._check_schema()
        return {
            "user_id": user_id,
            "contact_discoverable": self.contact_discoverable and self.directory_visible,
            "stored_contact_discoverable": self.contact_discoverable,
            "directory_visible": self.directory_visible,
        }

    async def set_contact_discoverability(
        self, user_id: str, enabled: bool, *, consent_version: str | None = None
    ) -> dict[str, Any]:
        self.set_calls.append((user_id, enabled, consent_version))
        if enabled and consent_version != CONTACT_SYNC_CONSENT_CONTRACT_VERSION:
            raise RIAIAMPolicyError(
                "Contact sync consent disclosure is out of date. Refresh the app and try again.",
                status_code=409,
            )
        self._check_schema()
        self.contact_discoverable = enabled
        return {
            "user_id": user_id,
            "contact_discoverable": enabled and self.directory_visible,
            "stored_contact_discoverable": enabled,
            "directory_visible": self.directory_visible,
        }


@dataclass(frozen=True)
class AccountSettingsDouble:
    sharing_state: str = "unset"
    precision: str = "precise"


class LocationSettingsDouble:
    def __init__(self, sharing_state: str = "unset", precision: str = "precise") -> None:
        self._settings = AccountSettingsDouble(sharing_state=sharing_state, precision=precision)

    def get(self, *, user_id: str) -> AccountSettingsDouble:
        assert user_id == USER
        return self._settings


def _identity(**overrides: Any) -> dict[str, Any]:
    base = {
        "user_id": USER,
        "display_name": "Ayesha Sharma",
        "email": "ayesha.sharma@example.com",
        "phone_number": "+15551234567",
        "photo_url": "https://cdn.example/ayesha.png",
        "email_verified": True,
        "phone_verified": True,
    }
    base.update(overrides)
    return base


def _ctx(**services: Any) -> ToolContext:
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
        screen=ScreenContext(),
        vault_owner_token=_fixture_credential("vault"),
        firebase_id_token=_fixture_credential("firebase"),
        services=services,
    )


def _spec(name: str):
    return next(tool for tool in profile.TOOLS if tool.name == name)


# -- catalog shape -----------------------------------------------------------


def test_catalog_policies_and_gateway_ids():
    by_name = {tool.name: tool for tool in profile.TOOLS}
    assert set(by_name) == {
        "get_profile",
        "update_display_name",
        "get_privacy_settings",
        "set_contact_discoverable",
    }
    assert by_name["get_profile"].policy is ToolPolicy.read
    assert by_name["get_profile"].gateway_action_id == "route.profile"
    assert by_name["update_display_name"].policy is ToolPolicy.confirm_tap
    assert by_name["update_display_name"].gateway_action_id == "profile.update_display_name"
    assert by_name["get_privacy_settings"].policy is ToolPolicy.read
    assert by_name["get_privacy_settings"].gateway_action_id == "route.profile_privacy"
    assert by_name["set_contact_discoverable"].policy is ToolPolicy.confirm_tap
    assert (
        by_name["set_contact_discoverable"].gateway_action_id == "profile.set_contact_discoverable"
    )


def test_mutations_are_on_the_firebase_plane_and_have_summaries():
    for name in ("update_display_name", "set_contact_discoverable"):
        spec = _spec(name)
        assert spec.firebase_plane is True
        assert spec.summarize is not None
    for name in ("get_profile", "get_privacy_settings"):
        spec = _spec(name)
        assert spec.firebase_plane is False
        assert spec.summarize is None


def test_no_tool_accepts_a_free_text_person_or_circle_name():
    for tool in profile.TOOLS:
        # Profile tools act on the caller only; they never target another person.
        assert tool.person_args == ()
        assert tool.circle_args == ()
        fields = set(tool.input_model.model_fields)
        assert not fields & {"person", "person_name", "circle", "circle_name", "name", "user_id"}
        for smuggled in ({"person_name": "Rahul"}, {"name": "Rahul"}, {"user_id": FRIEND}):
            with pytest.raises(ValidationError):
                tool.input_model.model_validate(smuggled)


def test_declarations_are_self_contained():
    for tool in profile.TOOLS:
        declaration = tool.declaration()
        assert declaration["name"] == tool.name
        assert "$defs" not in declaration["parameters_json_schema"]


# -- maskers -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+15551234567", "+1 ••• 4567"),
        ("+919876543210", "+91 ••• 3210"),
        ("+44 7911 123456", "+44 ••• 3456"),
        ("5551234567", "••• 4567"),
        ("(555) 123-4567", "••• 4567"),
        ("12345", "••••"),
        ("", None),
        (None, None),
    ],
)
def test_mask_phone_number(raw, expected):
    assert profile.mask_phone_number(raw) == expected


def test_mask_email_address_never_echoes_the_raw_value():
    assert profile.mask_email_address("ayesha.sharma@example.com") == "a***a@example.com"
    assert profile.mask_email_address("ab@x.io") == "*@x.io"
    assert profile.mask_email_address("weird@localhost") == "*@localhost"
    assert profile.mask_email_address(None) is None
    assert profile.mask_email_address("  ") is None


# -- get_profile -------------------------------------------------------------


async def test_get_profile_speaks_only_masked_stored_data():
    ctx = _ctx(identity=IdentityDouble(_identity()), iam=IamDouble(persona="investor"))
    result = await profile.get_profile(ctx, profile.GetProfileInput())
    assert result.status == "ok"
    assert result.display_name == "Ayesha Sharma"
    assert result.email_masked == "a***a@example.com"
    assert result.phone_masked == "+1 ••• 4567"
    assert result.has_photo is True
    assert result.phone_verified is True
    assert result.persona == "investor"
    assert result.spoken_facts == [
        "Your Hussh name is Ayesha Sharma.",
        "Your email is a***a@example.com, verified.",
        "Your phone number ends in 4567, verified.",
        "You have a profile photo.",
        "You're using Hussh as an investor.",
    ]
    joined = " ".join(result.spoken_facts) + str(result.public())
    assert "ayesha.sharma@example.com" not in joined
    assert "+15551234567" not in joined
    assert "5551234567" not in joined


async def test_get_profile_with_no_identity_is_honest():
    ctx = _ctx(identity=IdentityDouble(None), iam=IamDouble(schema_ready=False))
    result = await profile.get_profile(ctx, profile.GetProfileInput())
    assert result.status == "ok"
    assert result.display_name is None
    assert result.persona is None
    assert result.spoken_facts == [
        "You haven't set a Hussh name yet.",
        "There's no email or phone number on your profile.",
    ]


async def test_get_profile_marks_unverified_contact_points():
    ctx = _ctx(
        identity=IdentityDouble(
            _identity(email_verified=False, phone_verified=False, photo_url=None)
        ),
        iam=IamDouble(persona="ria"),
    )
    result = await profile.get_profile(ctx, profile.GetProfileInput())
    assert "Your email is a***a@example.com, not verified yet." in result.spoken_facts
    assert "Your phone number ends in 4567, not verified yet." in result.spoken_facts
    assert "You have a profile photo." not in result.spoken_facts
    assert "You're using Hussh as an RIA." in result.spoken_facts


# -- update_display_name -----------------------------------------------------


async def test_update_display_name_speaks_the_stored_name():
    identity = IdentityDouble(_identity())
    ctx = _ctx(identity=identity)
    args = profile.UpdateDisplayNameInput(display_name="  Ayesha   S ")
    result = await profile.update_display_name(ctx, args)
    assert result.status == "updated"
    assert result.display_name == "Ayesha S"
    assert result.spoken_facts == ["Your Hussh name is now Ayesha S."]
    assert identity.update_calls == [(USER, "  Ayesha   S ")]


async def test_update_display_name_invalid_is_not_worded_as_success():
    identity = IdentityDouble(_identity())
    identity.update_error = ValueError("Display name cannot contain links or handles.")
    ctx = _ctx(identity=identity)
    result = await profile.update_display_name(
        ctx, profile.UpdateDisplayNameInput(display_name="@ayesha")
    )
    assert result.status == "invalid"
    assert result.reason_code == "display_name_invalid"
    assert result.spoken_facts == [
        "Display name cannot contain links or handles. Your name wasn't changed."
    ]
    assert result.display_name is None


async def test_update_display_name_provider_down_is_unavailable():
    identity = IdentityDouble(_identity())
    identity.update_error = RuntimeError("Identity provider is not configured.")
    ctx = _ctx(identity=identity)
    result = await profile.update_display_name(
        ctx, profile.UpdateDisplayNameInput(display_name="Ayesha S")
    )
    assert result.status == "unavailable"
    assert result.reason_code == "identity_provider_unavailable"
    assert "wasn't changed" in result.spoken_facts[0]


async def test_update_display_name_without_stored_result_is_unavailable():
    class NoneIdentity(IdentityDouble):
        async def update_display_name(self, user_id: str, display_name: str) -> None:
            return None

    ctx = _ctx(identity=NoneIdentity(_identity()))
    result = await profile.update_display_name(
        ctx, profile.UpdateDisplayNameInput(display_name="Ayesha S")
    )
    assert result.status == "unavailable"
    assert result.reason_code == "identity_not_stored"


def test_update_display_name_summary_names_the_new_name():
    spec = _spec("update_display_name")
    text = spec.summarize(_ctx(), profile.UpdateDisplayNameInput(display_name="  Ayesha   S "))
    assert text == "change your Hussh name to Ayesha S"


def test_update_display_name_refuses_empty_and_unknown_fields():
    with pytest.raises(ValidationError):
        profile.UpdateDisplayNameInput(display_name="")
    with pytest.raises(ValidationError):
        profile.UpdateDisplayNameInput.model_validate(
            {"display_name": "A", "person": {"user_id": FRIEND}}
        )


# -- get_privacy_settings ----------------------------------------------------


async def test_get_privacy_settings_reads_all_three_services():
    ctx = _ctx(
        iam=IamDouble(contact_discoverable=True, marketplace_opt_in=True),
        location_settings=LocationSettingsDouble(sharing_state="on", precision="approximate"),
    )
    result = await profile.get_privacy_settings(ctx, profile.GetPrivacySettingsInput())
    assert result.status == "ok"
    assert result.contact_discoverable is True
    assert result.directory_visible is True
    assert result.marketplace_opt_in is True
    assert result.location_sharing_state == "on"
    assert result.location_precision == "approximate"
    assert result.spoken_facts == [
        "People with your number or email can find you.",
        "You're opted in to the marketplace.",
        "Location sharing is on.",
        "Your location precision is approximate.",
    ]


async def test_get_privacy_settings_unset_sharing_and_hidden_directory():
    ctx = _ctx(
        iam=IamDouble(contact_discoverable=True, directory_visible=False),
        location_settings=LocationSettingsDouble(),
    )
    result = await profile.get_privacy_settings(ctx, profile.GetPrivacySettingsInput())
    assert result.contact_discoverable is False
    assert result.directory_visible is False
    assert result.location_sharing_state == "unset"
    assert result.spoken_facts == [
        "People can't find you by your number or email.",
        "You're not opted in to the marketplace.",
        "Location sharing hasn't been set up yet.",
    ]


async def test_get_privacy_settings_rejects_when_iam_schema_not_ready():
    ctx = _ctx(iam=IamDouble(schema_ready=False), location_settings=LocationSettingsDouble())
    result = await profile.get_privacy_settings(ctx, profile.GetPrivacySettingsInput())
    assert result.status == "rejected"
    assert result.reason_code == "iam_schema_not_ready"


# -- set_contact_discoverable ------------------------------------------------


async def test_enable_without_consent_version_needs_consent_and_changes_nothing():
    iam = IamDouble()
    ctx = _ctx(iam=iam)
    result = await profile.set_contact_discoverable(
        ctx, profile.SetContactDiscoverableInput(enabled=True)
    )
    assert result.status == "consent_required"
    assert result.needs == "consent"
    assert result.reason_code == "consent_version_required"
    assert result.consent_contract_version == CONTACT_SYNC_CONSENT_CONTRACT_VERSION
    assert "Nothing was changed" in result.spoken_facts[0]
    assert iam.set_calls == []


async def test_enable_with_consent_version_updates():
    iam = IamDouble()
    ctx = _ctx(iam=iam)
    result = await profile.set_contact_discoverable(
        ctx,
        profile.SetContactDiscoverableInput(
            enabled=True, consent_version=CONTACT_SYNC_CONSENT_CONTRACT_VERSION
        ),
    )
    assert result.status == "updated"
    assert result.contact_discoverable is True
    assert iam.set_calls == [(USER, True, CONTACT_SYNC_CONSENT_CONTRACT_VERSION)]
    assert result.spoken_facts == [
        "Contact matching is now on. People with your number or email can find you."
    ]


async def test_enable_with_stale_consent_version_needs_consent():
    iam = IamDouble()
    ctx = _ctx(iam=iam)
    result = await profile.set_contact_discoverable(
        ctx, profile.SetContactDiscoverableInput(enabled=True, consent_version="old_v0")
    )
    assert result.status == "consent_required"
    assert result.needs == "consent"
    assert result.reason_code == "consent_version_stale"
    assert result.spoken_facts == [
        "Contact sync consent disclosure is out of date. Refresh the app and try again. Nothing was changed."
    ]


async def test_disable_needs_no_consent_and_speaks_off():
    iam = IamDouble(contact_discoverable=True)
    ctx = _ctx(iam=iam)
    result = await profile.set_contact_discoverable(
        ctx, profile.SetContactDiscoverableInput(enabled=False)
    )
    assert result.status == "updated"
    assert result.contact_discoverable is False
    assert iam.set_calls == [(USER, False, None)]
    assert result.spoken_facts == [
        "Contact matching is now off. People can't find you by your number or email."
    ]


async def test_enable_while_hidden_from_directory_is_not_worded_as_findable():
    iam = IamDouble(directory_visible=False)
    ctx = _ctx(iam=iam)
    result = await profile.set_contact_discoverable(
        ctx,
        profile.SetContactDiscoverableInput(
            enabled=True, consent_version=CONTACT_SYNC_CONSENT_CONTRACT_VERSION
        ),
    )
    assert result.status == "updated"
    assert result.contact_discoverable is False
    assert result.directory_visible is False
    assert result.spoken_facts == [
        "Contact matching is saved as on, but you're hidden from the directory, so people can't find you yet."
    ]


async def test_set_contact_discoverable_schema_not_ready_is_rejected():
    iam = IamDouble(schema_ready=False)
    ctx = _ctx(iam=iam)
    result = await profile.set_contact_discoverable(
        ctx, profile.SetContactDiscoverableInput(enabled=False)
    )
    assert result.status == "rejected"
    assert result.reason_code == "iam_schema_not_ready"


def test_set_contact_discoverable_summary():
    spec = _spec("set_contact_discoverable")
    assert spec.summarize(_ctx(), profile.SetContactDiscoverableInput(enabled=True)) == (
        "turn contact matching on"
    )
    assert spec.summarize(_ctx(), profile.SetContactDiscoverableInput(enabled=False)) == (
        "turn contact matching off"
    )


def test_ctx_service_uses_injected_double_over_factory():
    sentinel = IamDouble()
    ctx = _ctx(iam=sentinel)

    def explode() -> None:  # pragma: no cover - must never run
        raise AssertionError("factory must not be called when a double is injected")

    assert ctx.service(profile.IAM_SERVICE, explode) is sentinel


async def test_update_display_name_pending_shadow_is_committed_not_failed():
    """Provider accepted the name; the shadow is still syncing. One must not
    say the name wasn't changed, and must speak the name the provider holds."""
    identity = IdentityDouble(_identity())

    async def pending_update(user_id: str, display_name: str) -> dict[str, Any]:
        identity.update_calls.append((user_id, display_name))
        return {
            "user_id": USER,
            "display_name": " ".join(display_name.split()),
            "shadow_sync": "pending",
        }

    identity.update_display_name = pending_update  # type: ignore[method-assign]
    ctx = _ctx(identity=identity)
    result = await profile.update_display_name(
        ctx, profile.UpdateDisplayNameInput(display_name="Ayesha S")
    )
    assert result.status == "committed_sync_pending"
    assert result.display_name == "Ayesha S"
    assert result.reason_code == "identity_shadow_sync_pending"
    spoken = " ".join(result.spoken_facts)
    assert "Ayesha S" in spoken
    assert "wasn't changed" not in spoken
    assert "didn't save" not in spoken


async def test_update_display_name_synced_shadow_is_plain_updated():
    identity = IdentityDouble(_identity())

    async def synced_update(user_id: str, display_name: str) -> dict[str, Any]:
        return {"user_id": USER, "display_name": display_name, "shadow_sync": "synced"}

    identity.update_display_name = synced_update  # type: ignore[method-assign]
    ctx = _ctx(identity=identity)
    result = await profile.update_display_name(
        ctx, profile.UpdateDisplayNameInput(display_name="Ayesha S")
    )
    assert result.status == "updated"
    assert result.spoken_facts == ["Your Hussh name is now Ayesha S."]
