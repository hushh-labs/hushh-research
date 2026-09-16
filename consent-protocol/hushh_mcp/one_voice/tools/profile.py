"""Profile tools: read the person's own identity and privacy posture, change
their display name, and set contact discoverability.

Profile is the Firebase plane: every mutation here sets ``firebase_plane`` so
the relay demands a fresh Firebase proof at confirmation. Email and phone are
masked before they reach ``spoken_facts``; the model never receives the raw
value and so can never read it back.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.consent.pii_sanitizer import mask_email
from hushh_mcp.one_voice.tools.base import (
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.contact_sync_contract import CONTACT_SYNC_CONSENT_CONTRACT_VERSION
from hushh_mcp.services.one_location_account_settings_service import (
    OneLocationAccountSettingsService,
)
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

IDENTITY_SERVICE = "identity"
IAM_SERVICE = "iam"
LOCATION_SETTINGS_SERVICE = "location_settings"

SharingState = Literal["unset", "on", "off"]
Precision = Literal["precise", "approximate"]

_PERSONA_WORDS = {"investor": "an investor", "ria": "an RIA"}
_SHARING_WORDS: dict[SharingState, str] = {
    "on": "Location sharing is on.",
    "off": "Location sharing is off.",
    "unset": "Location sharing hasn't been set up yet.",
}


# -- maskers -----------------------------------------------------------------


def mask_phone_number(value: str | None) -> str | None:
    """``+15551234567`` -> ``+1 ••• 4567``; ``5551234567`` -> ``••• 4567``.

    The country code is whatever precedes the last ten digits (E.164 national
    numbers are ten digits for the markets Hussh serves); when there is none
    only the last four digits survive. Shorter values are fully masked.
    """
    raw = str(value or "").strip()
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 7:
        return "••••"
    country = digits[:-10] if raw.startswith("+") and len(digits) > 10 else ""
    tail = digits[-4:]
    return f"+{country} ••• {tail}" if country else f"••• {tail}"


def mask_email_address(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    # ``mask_email`` lives in the un-followed consent package; pin its str contract.
    masked: str = mask_email(raw)
    if masked == raw and "@" in raw:
        # The sanitizer only rewrites well-formed addresses; never echo a raw one.
        return "*@" + raw.rsplit("@", 1)[1]
    return masked


def _spoken_persona(persona: str | None) -> str | None:
    if not persona:
        return None
    return f"You're using Hussh as {_PERSONA_WORDS.get(persona, persona)}."


def _sharing_state(value: Any) -> SharingState:
    if value == "on":
        return "on"
    if value == "off":
        return "off"
    return "unset"


def _precision(value: Any) -> Precision:
    return "approximate" if value == "approximate" else "precise"


async def _persona_state(ctx: ToolContext) -> dict[str, Any] | None:
    iam = ctx.service(IAM_SERVICE, RIAIAMService)
    try:
        state = await iam.get_persona_state(ctx.user_id)
    except IAMSchemaNotReadyError:
        return None
    return dict(state or {})


# -- get_profile -------------------------------------------------------------


class GetProfileInput(ToolInput):
    pass


class GetProfileResult(ToolResult):
    status: Literal["ok"]
    display_name: str | None = None
    email_masked: str | None = None
    email_verified: bool = False
    phone_masked: str | None = None
    phone_verified: bool = False
    has_photo: bool = False
    persona: str | None = None


async def get_profile(ctx: ToolContext, args: GetProfileInput) -> ToolResult:
    identity_service = ctx.service(IDENTITY_SERVICE, ActorIdentityService)
    identity = dict(await identity_service.sync_from_firebase(ctx.user_id) or {})
    persona_state = await _persona_state(ctx)
    persona = str((persona_state or {}).get("active_persona") or "") or None

    display_name = str(identity.get("display_name") or "").strip() or None
    email_masked = mask_email_address(identity.get("email"))
    phone_masked = mask_phone_number(identity.get("phone_number"))
    email_verified = bool(identity.get("email_verified"))
    phone_verified = bool(identity.get("phone_verified"))
    has_photo = bool(str(identity.get("photo_url") or "").strip())

    facts: list[str] = []
    if display_name:
        facts.append(f"Your Hussh name is {display_name}.")
    else:
        facts.append("You haven't set a Hussh name yet.")
    if email_masked:
        facts.append(
            f"Your email is {email_masked}, {'verified' if email_verified else 'not verified yet'}."
        )
    if phone_masked:
        facts.append(
            f"Your phone number ends in {phone_masked[-4:]}, "
            f"{'verified' if phone_verified else 'not verified yet'}."
        )
    if not email_masked and not phone_masked:
        facts.append("There's no email or phone number on your profile.")
    if has_photo:
        facts.append("You have a profile photo.")
    spoken_persona = _spoken_persona(persona)
    if spoken_persona:
        facts.append(spoken_persona)

    return GetProfileResult(
        status="ok",
        display_name=display_name,
        email_masked=email_masked,
        email_verified=email_verified,
        phone_masked=phone_masked,
        phone_verified=phone_verified,
        has_photo=has_photo,
        persona=persona,
        spoken_facts=facts,
    )


# -- update_display_name -----------------------------------------------------


class UpdateDisplayNameInput(ToolInput):
    display_name: str = Field(
        min_length=1,
        max_length=120,
        description="The person's own new Hussh name, exactly as they said it (2-60 characters, no links or handles).",
    )


class UpdateDisplayNameResult(ToolResult):
    status: Literal["updated", "invalid", "unavailable"]
    display_name: str | None = None


def _clean_name(value: str) -> str:
    return " ".join(str(value or "").split())


async def update_display_name(ctx: ToolContext, args: UpdateDisplayNameInput) -> ToolResult:
    identity_service = ctx.service(IDENTITY_SERVICE, ActorIdentityService)
    try:
        updated = await identity_service.update_display_name(ctx.user_id, args.display_name)
    except ValueError as exc:
        return UpdateDisplayNameResult(
            status="invalid",
            reason_code="display_name_invalid",
            spoken_facts=[f"{exc} Your name wasn't changed."],
        )
    except RuntimeError:
        return UpdateDisplayNameResult(
            status="unavailable",
            reason_code="identity_provider_unavailable",
            spoken_facts=["I couldn't reach the identity provider, so your name wasn't changed."],
        )
    stored = str((updated or {}).get("display_name") or "").strip()
    if not stored:
        return UpdateDisplayNameResult(
            status="unavailable",
            reason_code="identity_not_stored",
            spoken_facts=["The name change didn't save. Your name wasn't changed."],
        )
    return UpdateDisplayNameResult(
        status="updated",
        display_name=stored,
        spoken_facts=[f"Your Hussh name is now {stored}."],
    )


def summarize_update_display_name(ctx: ToolContext, args: UpdateDisplayNameInput) -> str:
    return f"change your Hussh name to {_clean_name(args.display_name)}"


# -- get_privacy_settings ----------------------------------------------------


class GetPrivacySettingsInput(ToolInput):
    pass


class GetPrivacySettingsResult(ToolResult):
    status: Literal["ok"]
    contact_discoverable: bool = False
    directory_visible: bool = False
    marketplace_opt_in: bool = False
    location_sharing_state: SharingState = "unset"
    location_precision: Precision = "precise"


async def get_privacy_settings(ctx: ToolContext, args: GetPrivacySettingsInput) -> ToolResult:
    iam = ctx.service(IAM_SERVICE, RIAIAMService)
    try:
        discoverability = dict(await iam.get_contact_discoverability(ctx.user_id) or {})
        persona_state = dict(await iam.get_persona_state(ctx.user_id) or {})
    except IAMSchemaNotReadyError:
        return Rejected(
            reason_code="iam_schema_not_ready",
            spoken_facts=["Your privacy settings aren't available right now."],
        )
    settings_service = ctx.service(LOCATION_SETTINGS_SERVICE, OneLocationAccountSettingsService)
    account = await asyncio.to_thread(settings_service.get, user_id=ctx.user_id)

    contact_discoverable = bool(discoverability.get("contact_discoverable"))
    directory_visible = bool(discoverability.get("directory_visible"))
    marketplace_opt_in = bool(persona_state.get("investor_marketplace_opt_in"))
    sharing_state = _sharing_state(account.sharing_state)
    precision = _precision(account.precision)

    facts = [
        "People with your number or email can find you."
        if contact_discoverable
        else "People can't find you by your number or email.",
        "You're opted in to the marketplace."
        if marketplace_opt_in
        else "You're not opted in to the marketplace.",
        _SHARING_WORDS[sharing_state],
    ]
    if sharing_state == "on":
        facts.append(f"Your location precision is {precision}.")

    return GetPrivacySettingsResult(
        status="ok",
        contact_discoverable=contact_discoverable,
        directory_visible=directory_visible,
        marketplace_opt_in=marketplace_opt_in,
        location_sharing_state=sharing_state,
        location_precision=precision,
        spoken_facts=facts,
    )


# -- set_contact_discoverable ------------------------------------------------


class SetContactDiscoverableInput(ToolInput):
    enabled: bool = Field(
        description="True lets people who have your number or email find and connect with you."
    )
    consent_version: str | None = Field(
        default=None,
        max_length=80,
        description=(
            "The contact-sync consent disclosure version the person accepted on screen. "
            "Required to enable; never invent it."
        ),
    )


class SetContactDiscoverableResult(ToolResult):
    status: Literal["updated", "consent_required"]
    contact_discoverable: bool | None = None
    directory_visible: bool | None = None
    consent_contract_version: str = CONTACT_SYNC_CONSENT_CONTRACT_VERSION


async def set_contact_discoverable(
    ctx: ToolContext, args: SetContactDiscoverableInput
) -> ToolResult:
    consent_version = str(args.consent_version or "").strip() or None
    if args.enabled and consent_version is None:
        return SetContactDiscoverableResult(
            status="consent_required",
            needs="consent",
            reason_code="consent_version_required",
            spoken_facts=[
                "Turning contact matching on needs you to accept the contact sync disclosure first. Nothing was changed."
            ],
        )
    iam = ctx.service(IAM_SERVICE, RIAIAMService)
    try:
        result = dict(
            await iam.set_contact_discoverability(
                ctx.user_id, args.enabled, consent_version=consent_version
            )
            or {}
        )
    except RIAIAMPolicyError as exc:
        return SetContactDiscoverableResult(
            status="consent_required",
            needs="consent",
            reason_code="consent_version_stale",
            spoken_facts=[f"{exc} Nothing was changed."],
        )
    except IAMSchemaNotReadyError:
        return Rejected(
            reason_code="iam_schema_not_ready",
            spoken_facts=["Contact matching can't be changed right now. Nothing was changed."],
        )

    stored = bool(result.get("stored_contact_discoverable"))
    effective = bool(result.get("contact_discoverable"))
    directory_visible = bool(result.get("directory_visible"))
    if stored and not effective:
        fact = (
            "Contact matching is saved as on, but you're hidden from the directory, "
            "so people can't find you yet."
        )
    elif effective:
        fact = "Contact matching is now on. People with your number or email can find you."
    else:
        fact = "Contact matching is now off. People can't find you by your number or email."
    return SetContactDiscoverableResult(
        status="updated",
        contact_discoverable=effective,
        directory_visible=directory_visible,
        spoken_facts=[fact],
    )


def summarize_set_contact_discoverable(ctx: ToolContext, args: SetContactDiscoverableInput) -> str:
    return "turn contact matching on" if args.enabled else "turn contact matching off"


# -- catalog -----------------------------------------------------------------

TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="get_profile",
        gateway_action_id="route.profile",
        policy=ToolPolicy.read,
        input_model=GetProfileInput,
        output_model=GetProfileResult,
        description=(
            "Read the person's own Hussh profile: display name, masked email, masked phone, "
            "whether a photo is set, verification, and active persona. Reads only; the raw email "
            "and phone are never returned."
        ),
        handler=get_profile,
    ),
    ToolSpec(
        name="update_display_name",
        gateway_action_id="profile.update_display_name",
        policy=ToolPolicy.confirm_tap,
        input_model=UpdateDisplayNameInput,
        output_model=UpdateDisplayNameResult,
        description=(
            "Change the person's own Hussh display name after they tap Confirm. 2-60 characters, "
            "no links or handles. This is the caller's own name, never another person."
        ),
        handler=update_display_name,
        ui_refresh=("profile",),
        firebase_plane=True,
        summarize=summarize_update_display_name,
    ),
    ToolSpec(
        name="get_privacy_settings",
        gateway_action_id="route.profile_privacy",
        policy=ToolPolicy.read,
        input_model=GetPrivacySettingsInput,
        output_model=GetPrivacySettingsResult,
        description=(
            "Read the person's privacy posture: whether people can find them by phone or email, "
            "marketplace opt-in, and whether Location sharing is on, off, or not set up."
        ),
        handler=get_privacy_settings,
    ),
    ToolSpec(
        name="set_contact_discoverable",
        gateway_action_id="profile.set_contact_discoverable",
        policy=ToolPolicy.confirm_tap,
        input_model=SetContactDiscoverableInput,
        output_model=SetContactDiscoverableResult,
        description=(
            "Turn contact matching on or off after the person taps Confirm. On means people who "
            "have their number or email can find and auto-connect with them. Turning it on needs "
            "the consent_version of the disclosure they accepted on screen."
        ),
        handler=set_contact_discoverable,
        ui_refresh=("profile_privacy",),
        firebase_plane=True,
        summarize=summarize_set_contact_discoverable,
    ),
)

__all__ = [
    "TOOLS",
    "GetPrivacySettingsResult",
    "GetProfileResult",
    "SetContactDiscoverableResult",
    "UpdateDisplayNameResult",
    "mask_email_address",
    "mask_phone_number",
]
