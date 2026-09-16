"""Location state tools: sharing posture, precision, map presence, auto-approve, ratings.

Everything here is about the person's *own* Location account -- no other
person or circle is targeted except the circles named to ``set_auto_approve``,
which must already be confirmed in the conversation's :class:`EntityContext`.

Two auth planes: every service called here is the vault-owner plane
(``ctx.user_id``), so no tool sets ``firebase_plane``. The canonical services
are sync SQLAlchemy and run through ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Annotated, Any, Literal

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    Unsupported,
)
from hushh_mcp.services.one_location_account_settings_service import (
    AccountSettings,
    OneLocationAccountSettingsService,
    SharingTransition,
)
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)
from hushh_mcp.services.one_location_feature_admission import OneLocationFeatureAdmission
from hushh_mcp.services.one_location_place_rating_service import (
    OneLocationPlaceRatingService,
    PlaceRatingError,
)

LOCATION_SERVICE = "location"
LOCATION_SETTINGS_SERVICE = "location_settings"
PLACE_RATING_SERVICE = "place_ratings"
FEATURE_ADMISSION_SERVICE = "feature_admission"

SharingState = Literal["unset", "on", "off"]
Precision = Literal["precise", "approximate"]
OsPermission = Literal["unknown", "prompt", "granted", "denied"]
PresenceMode = Literal["ghost", "foreground_private"]
AutoApproveScope = Literal["all_contacts", "circle", "circles"]
# A canonical circle id is always 36 characters; a spoken name never parses.
CircleId = Annotated[str, Field(min_length=36, max_length=36)]

RATINGS_SPOKEN_LIMIT = 5


# -- helpers -----------------------------------------------------------------


async def _run(fn: Callable[..., Any], /, **kwargs: Any) -> Any:
    return await asyncio.to_thread(fn, **kwargs)


def _rejected(error: OneLocationAgentError | PlaceRatingError) -> Rejected:
    return Rejected(reason_code=error.code, spoken_facts=[error.message])


def _settings_service(ctx: ToolContext) -> OneLocationAccountSettingsService:
    return ctx.service(LOCATION_SETTINGS_SERVICE, OneLocationAccountSettingsService)


def _location_service(ctx: ToolContext) -> OneLocationAgentService:
    service: OneLocationAgentService = ctx.service(LOCATION_SERVICE, OneLocationAgentService)
    return service


def _count(count: int, singular: str, plural: str | None = None) -> str:
    word = singular if count == 1 else (plural or f"{singular}s")
    return f"{count} {word}"


def _sharing_state(settings: AccountSettings) -> SharingState:
    state = str(settings.sharing_state or "unset")
    return state if state in {"unset", "on", "off"} else "unset"  # type: ignore[return-value]


def _precision(value: Any) -> Precision:
    return "approximate" if str(value or "") == "approximate" else "precise"


def _presence_mode(preferences: dict[str, Any] | None) -> PresenceMode:
    mode = str((preferences or {}).get("presenceMode") or "ghost")
    return "foreground_private" if mode == "foreground_private" else "ghost"


def _os_permission(ctx: ToolContext, settings: AccountSettings) -> tuple[OsPermission, str]:
    """The freshest permission fact we have and where it came from.

    The client's ``app_context`` is current for this session; the server row is
    what the app last recorded. Neither is authority -- the device is.
    """
    device = ctx.screen.os_location_permission
    if device != "unknown":
        return device, "device"
    server = str(settings.os_permission_reported or "unknown")
    if server in {"prompt", "granted", "denied"}:
        return server, "server"  # type: ignore[return-value]
    return "unknown", "none"


def _rows(state: dict[str, Any], key: str) -> list[dict[str, Any]]:
    return [row for row in (state.get(key) or []) if isinstance(row, dict)]


def _presence_fact(mode: PresenceMode) -> str:
    return "You're hidden on the map." if mode == "ghost" else "You're visible on the map."


def _auto_approve_fact(ctx: ToolContext, preference: dict[str, Any]) -> str:
    if not preference.get("enabled"):
        return "Automatic approval is off."
    raw_scope = preference.get("scope")
    scope: dict[str, Any] = raw_scope if isinstance(raw_scope, dict) else {}
    kind = str(scope.get("kind") or "")
    if kind == "circle":
        circle = ctx.entities.circle(str(scope.get("circleId") or ""))
        target = circle.name if circle else "one circle"
        return f"Automatic approval is on for {target}."
    if kind == "circles":
        ids = [str(item) for item in (scope.get("circleIds") or []) if item]
        names = [circle.name for circle_id in ids if (circle := ctx.entities.circle(circle_id))]
        if names and len(names) == len(ids):
            return f"Automatic approval is on for {_join(names)}."
        return f"Automatic approval is on for {_count(len(ids), 'circle')}."
    return "Automatic approval is on for all contacts."


def _join(names: list[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + f" and {names[-1]}"


# -- get_location_status -----------------------------------------------------


class GetLocationStatusInput(ToolInput):
    pass


class LocationStatusResult(ToolResult):
    status: Literal["ok"]
    sharing_state: SharingState
    sharing_enabled: bool
    precision: Precision
    os_permission_reported: OsPermission
    os_permission_source: Literal["device", "server", "none"]
    effective_sharing: bool
    active_shares: int
    received_shares: int
    pending_incoming_requests: int
    active_links: int
    active_sos: bool
    presence_mode: PresenceMode
    setup_required: bool


async def get_location_status(ctx: ToolContext, args: GetLocationStatusInput) -> ToolResult:
    settings_service = _settings_service(ctx)
    location = _location_service(ctx)
    try:
        settings: AccountSettings = await _run(settings_service.get, user_id=ctx.user_id)
        state: dict[str, Any] = await _run(location.list_state, user_id=ctx.user_id)
        preferences = await _run(location.get_map_preferences, user_id=ctx.user_id)
    except OneLocationAgentError as error:
        return _rejected(error)

    sharing_state = _sharing_state(settings)
    os_permission, os_source = _os_permission(ctx, settings)
    os_granted = os_permission == "granted"
    effective = sharing_state == "on" and os_granted

    active_owner = [row for row in _rows(state, "ownerGrants") if row.get("status") == "active"]
    active_sos = any(str(row.get("shareKind") or "") == "sos" for row in active_owner)
    received = [row for row in _rows(state, "receivedGrants") if row.get("status") == "active"]
    incoming = [
        row
        for row in _rows(state, "requests")
        if row.get("status") == "pending" and str(row.get("ownerUserId") or "") == ctx.user_id
    ]
    links = [row for row in _rows(state, "publicInvites") if row.get("status") == "active"]
    presence = _presence_mode(preferences)
    precision = _precision(settings.precision)

    facts: list[str] = []
    if sharing_state == "unset":
        facts.append(
            "Location setup hasn't been completed yet, so sharing with people isn't set up."
        )
        if os_granted:
            facts.append("Your device location permission is granted.")
        elif os_permission == "denied":
            facts.append("Your device location permission is denied.")
    elif sharing_state == "on":
        if os_granted:
            facts.append(
                "Sharing with people is on and your device location permission is granted."
            )
        elif os_permission == "denied":
            facts.append(
                "Sharing with people is on, but your device location permission is denied, "
                "so nothing is being shared right now."
            )
        elif os_permission == "prompt":
            facts.append(
                "Sharing with people is on, but your device hasn't been asked for location permission yet."
            )
        else:
            facts.append(
                "Sharing with people is on. I can't tell whether your device location permission is granted."
            )
    elif os_granted:
        facts.append("Your device permission is granted, but sharing with people is off.")
    elif os_permission == "denied":
        facts.append("Sharing with people is off, and your device location permission is denied.")
    else:
        facts.append("Sharing with people is off.")

    if active_sos:
        facts.append("Save My Soul is active.")

    parts: list[str] = []
    if active_owner:
        parts.append(_count(len(active_owner), "active share"))
    if received:
        parts.append(f"{_count(len(received), 'person', 'people')} sharing with you")
    if incoming:
        parts.append(f"{_count(len(incoming), 'request')} waiting for you")
    if links:
        parts.append(_count(len(links), "active link"))
    if parts:
        facts.append(f"You have {_join(parts)}.")
    else:
        facts.append("No active shares, no one is sharing with you, and no requests are waiting.")
    facts.append(_presence_fact(presence))
    if precision == "approximate":
        facts.append("Sharing precision is approximate.")

    return LocationStatusResult(
        status="ok",
        sharing_state=sharing_state,
        sharing_enabled=sharing_state == "on",
        precision=precision,
        os_permission_reported=os_permission,
        os_permission_source=os_source,  # type: ignore[arg-type]
        effective_sharing=effective,
        active_shares=len(active_owner),
        received_shares=len(received),
        pending_incoming_requests=len(incoming),
        active_links=len(links),
        active_sos=active_sos,
        presence_mode=presence,
        setup_required=sharing_state == "unset",
        spoken_facts=facts,
    )


# -- turn_sharing_on ---------------------------------------------------------


class TurnSharingOnInput(ToolInput):
    consent_version: str | None = Field(
        default=None,
        max_length=80,
        description=(
            "The Location sharing consent version the person accepted on screen, if the app "
            "supplied one. Never invent it; leave it unset and the server answers consent_required."
        ),
    )


class TurnSharingOnResult(ToolResult):
    status: Literal["on", "consent_required", "setup_required"]
    sharing_state: SharingState | None = None
    changed: bool | None = None
    os_permission_reported: OsPermission | None = None


async def turn_sharing_on(ctx: ToolContext, args: TurnSharingOnInput) -> ToolResult:
    settings_service = _settings_service(ctx)
    try:
        current: AccountSettings = await _run(settings_service.get, user_id=ctx.user_id)
    except OneLocationAgentError as error:
        return _rejected(error)
    if _sharing_state(current) == "unset":
        return TurnSharingOnResult(
            status="setup_required",
            needs="setup",
            reason_code="location_setup_incomplete",
            sharing_state="unset",
            spoken_facts=[
                "Location setup hasn't been completed yet, so sharing can't be turned on. "
                "Nothing was changed."
            ],
        )
    consent_version = str(args.consent_version or "").strip() or None
    try:
        transition: SharingTransition = await _run(
            settings_service.set_sharing_state,
            user_id=ctx.user_id,
            state="on",
            include_sos=False,
            consent_version=consent_version,
        )
    except OneLocationAgentError as error:
        if error.code == "LOCATION_SHARING_CONSENT_REQUIRED":
            return TurnSharingOnResult(
                status="consent_required",
                needs="consent",
                reason_code=error.code,
                sharing_state=_sharing_state(current),
                spoken_facts=["Accept the location consent first."],
            )
        return _rejected(error)
    settings = transition.settings
    if _sharing_state(settings) != "on":
        return Rejected(
            reason_code="sharing_state_not_on",
            spoken_facts=["Sharing didn't turn on. Nothing was changed."],
        )
    os_permission, _source = _os_permission(ctx, settings)
    facts = ["Sharing with people is on." if transition.changed else "Sharing was already on."]
    if os_permission == "denied":
        facts.append(
            "Your device location permission is denied, so nothing will be shared until you allow it."
        )
    elif os_permission == "prompt":
        facts.append("Your device hasn't been asked for location permission yet.")
    return TurnSharingOnResult(
        status="on",
        sharing_state="on",
        changed=transition.changed,
        os_permission_reported=os_permission,
        spoken_facts=facts,
    )


def summarize_turn_sharing_on(ctx: ToolContext, args: TurnSharingOnInput) -> str:
    return "turn location sharing on"


# -- turn_sharing_off --------------------------------------------------------


class TurnSharingOffInput(ToolInput):
    include_sos: bool = Field(
        default=False,
        description=(
            "Also stop an active Save My Soul share. Only set this when the person explicitly "
            "said to stop SOS too; otherwise an active SOS keeps sharing on."
        ),
    )


class TurnSharingOffResult(ToolResult):
    status: Literal["off", "sos_active"]
    sharing_state: SharingState | None = None
    changed: bool | None = None
    revoked_shares: int = 0
    revoked_links: int = 0
    notified_recipients: int = 0


async def turn_sharing_off(ctx: ToolContext, args: TurnSharingOffInput) -> ToolResult:
    settings_service = _settings_service(ctx)
    try:
        transition: SharingTransition = await _run(
            settings_service.set_sharing_state,
            user_id=ctx.user_id,
            state="off",
            include_sos=args.include_sos,
            consent_version=None,
        )
    except OneLocationAgentError as error:
        if error.code == "LOCATION_SOS_ACTIVE":
            return TurnSharingOffResult(
                status="sos_active",
                reason_code=error.code,
                spoken_facts=[error.message, "Nothing was changed."],
            )
        return _rejected(error)
    settings = transition.settings
    if _sharing_state(settings) != "off":
        return Rejected(
            reason_code="sharing_state_not_off",
            spoken_facts=["Sharing didn't turn off. Nothing was changed."],
        )
    revoked_shares = len(transition.revoked_grant_ids)
    revoked_links = len(transition.revoked_link_ids)
    if not transition.changed and not revoked_shares and not revoked_links:
        facts = ["Sharing was already off."]
    elif revoked_shares or revoked_links:
        stopped: list[str] = []
        if revoked_shares:
            stopped.append(_count(revoked_shares, "active share"))
        if revoked_links:
            stopped.append(_count(revoked_links, "link"))
        facts = [f"Sharing is off. I stopped {_join(stopped)}."]
    else:
        facts = ["Sharing is off. There were no active shares or links to stop."]
    return TurnSharingOffResult(
        status="off",
        sharing_state="off",
        changed=transition.changed,
        revoked_shares=revoked_shares,
        revoked_links=revoked_links,
        notified_recipients=int(transition.notified_recipients or 0),
        spoken_facts=facts,
    )


def summarize_turn_sharing_off(ctx: ToolContext, args: TurnSharingOffInput) -> str:
    if args.include_sos:
        return "turn location sharing off, stop Save My Soul, and stop your active shares"
    return "turn location sharing off and stop your active shares"


# -- set_precision -----------------------------------------------------------


class SetPrecisionInput(ToolInput):
    precision: Precision = Field(
        description="precise shares the device's exact position; approximate coarsens it on the device."
    )


class SetPrecisionResult(ToolResult):
    status: Literal["precise", "approximate"]
    changed: bool | None = None


async def set_precision(ctx: ToolContext, args: SetPrecisionInput) -> ToolResult:
    settings_service = _settings_service(ctx)
    try:
        before: AccountSettings = await _run(settings_service.get, user_id=ctx.user_id)
        settings: AccountSettings = await _run(
            settings_service.set_precision, user_id=ctx.user_id, precision=args.precision
        )
    except OneLocationAgentError as error:
        return _rejected(error)
    stored = str(settings.precision or "")
    if stored not in {"precise", "approximate"} or stored != args.precision:
        return Rejected(
            reason_code="LOCATION_PRECISION_NOT_STORED",
            spoken_facts=["The precision setting didn't save. Nothing was changed."],
        )
    changed = _precision(before.precision) != stored
    if stored == "approximate":
        facts = ["Sharing precision is now approximate on this device."]
    else:
        facts = ["Sharing precision is now precise."]
    if not changed:
        facts = [f"Sharing precision was already {stored}."]
    return SetPrecisionResult(status=stored, changed=changed, spoken_facts=facts)  # type: ignore[arg-type]


def summarize_set_precision(ctx: ToolContext, args: SetPrecisionInput) -> str:
    return f"set your sharing precision to {args.precision}"


# -- get_location_settings ---------------------------------------------------


class GetLocationSettingsInput(ToolInput):
    pass


class LocationSettingsResult(ToolResult):
    status: Literal["ok"]
    sharing_state: SharingState
    sharing_enabled: bool
    precision: Precision
    presence_mode: PresenceMode
    auto_approve_enabled: bool
    auto_approve_scope: dict[str, Any] | None = None
    setup_required: bool


async def get_location_settings(ctx: ToolContext, args: GetLocationSettingsInput) -> ToolResult:
    settings_service = _settings_service(ctx)
    location = _location_service(ctx)
    try:
        settings: AccountSettings = await _run(settings_service.get, user_id=ctx.user_id)
        preferences = await _run(location.get_map_preferences, user_id=ctx.user_id)
        auto_approve = await _run(location.get_auto_approve_preference, user_id=ctx.user_id)
    except OneLocationAgentError as error:
        return _rejected(error)
    auto_approve = auto_approve if isinstance(auto_approve, dict) else {}
    sharing_state = _sharing_state(settings)
    precision = _precision(settings.precision)
    presence = _presence_mode(preferences)

    facts: list[str] = []
    if sharing_state == "unset":
        facts.append("Location setup hasn't been completed yet.")
    elif sharing_state == "on":
        facts.append("Sharing with people is on.")
    else:
        facts.append("Sharing with people is off.")
    facts.append(f"Sharing precision is {precision}.")
    facts.append(_presence_fact(presence))
    facts.append(_auto_approve_fact(ctx, auto_approve))

    scope = auto_approve.get("scope")
    return LocationSettingsResult(
        status="ok",
        sharing_state=sharing_state,
        sharing_enabled=sharing_state == "on",
        precision=precision,
        presence_mode=presence,
        auto_approve_enabled=bool(auto_approve.get("enabled")),
        auto_approve_scope=scope if isinstance(scope, dict) else None,
        setup_required=sharing_state == "unset",
        spoken_facts=facts,
    )


# -- hide_on_map / show_on_map -----------------------------------------------


class MapPresenceInput(ToolInput):
    pass


class HideOnMapResult(ToolResult):
    status: Literal["hidden"]
    presence_mode: PresenceMode = "ghost"


class ShowOnMapResult(ToolResult):
    status: Literal["visible"]
    presence_mode: PresenceMode = "foreground_private"


async def hide_on_map(ctx: ToolContext, args: MapPresenceInput) -> ToolResult:
    location = _location_service(ctx)
    try:
        preferences = await _run(
            location.update_map_preferences,
            user_id=ctx.user_id,
            presence_mode="ghost",
            renderer_consent_version=None,
        )
    except OneLocationAgentError as error:
        return _rejected(error)
    if _presence_mode(preferences) != "ghost":
        return Rejected(
            reason_code="map_presence_not_updated",
            spoken_facts=["I couldn't hide you on the map. Nothing was changed."],
        )
    return HideOnMapResult(status="hidden", spoken_facts=["You're hidden on the map now."])


async def show_on_map(ctx: ToolContext, args: MapPresenceInput) -> ToolResult:
    settings_service = _settings_service(ctx)
    location = _location_service(ctx)
    try:
        settings: AccountSettings = await _run(settings_service.get, user_id=ctx.user_id)
    except OneLocationAgentError as error:
        return _rejected(error)
    if _sharing_state(settings) == "off":
        return Rejected(
            reason_code="LOCATION_SHARING_OFF",
            spoken_facts=[
                "Location sharing is turned off, so you stay hidden on the map. "
                "Turn sharing on first. Nothing was changed."
            ],
        )
    try:
        preferences = await _run(
            location.update_map_preferences,
            user_id=ctx.user_id,
            presence_mode="foreground_private",
            renderer_consent_version=None,
        )
    except OneLocationAgentError as error:
        return _rejected(error)
    if _presence_mode(preferences) != "foreground_private":
        return Rejected(
            reason_code="map_presence_not_updated",
            spoken_facts=["I couldn't show you on the map. Nothing was changed."],
        )
    return ShowOnMapResult(status="visible", spoken_facts=["You're visible on the map now."])


def summarize_show_on_map(ctx: ToolContext, args: MapPresenceInput) -> str:
    return "show you on the map"


# -- set_auto_approve --------------------------------------------------------


class SetAutoApproveInput(ToolInput):
    enabled: bool = Field(
        description="True approves new location requests automatically; False stops that."
    )
    scope: AutoApproveScope | None = Field(
        default=None,
        description=(
            "Who may be auto-approved when enabling: all_contacts, circle (exactly one circle_id), "
            "or circles (one or more circle_ids). Ignored when disabling."
        ),
    )
    circle_ids: list[CircleId] | None = Field(
        default=None,
        max_length=20,
        description=(
            "Canonical circle ids from list_circles/confirm_circle for scope circle or circles. "
            "Never a spoken circle name."
        ),
    )


class SetAutoApproveResult(ToolResult):
    status: Literal["on", "off"]
    scope: dict[str, Any] | None = None
    rule_version: int | None = None


def _requested_circle_ids(args: SetAutoApproveInput) -> list[str]:
    seen: list[str] = []
    for value in args.circle_ids or []:
        item = str(value or "").strip()
        if item and item not in seen:
            seen.append(item)
    return seen


def _circle_problem(ctx: ToolContext, args: SetAutoApproveInput) -> Rejected | None:
    """Every circle id must be a confirmed canonical id; a name never passes."""
    if not args.enabled:
        return None
    ids = _requested_circle_ids(args)
    if args.scope in {"circle", "circles"}:
        if not ids:
            return Rejected(
                reason_code="invalid_arguments",
                needs="disambiguation",
                spoken_facts=["I need to know which circle first."],
            )
        if args.scope == "circle" and len(ids) != 1:
            return Rejected(
                reason_code="invalid_arguments",
                needs="disambiguation",
                spoken_facts=["Automatic approval for one circle takes exactly one circle."],
            )
        for circle_id in ids:
            if len(circle_id) != 36 or ctx.entities.circle(circle_id) is None:
                return Rejected(
                    reason_code="circle_not_confirmed",
                    needs="disambiguation",
                    spoken_facts=["I need to confirm which circle you mean first."],
                )
        return None
    if args.scope == "all_contacts":
        if ids:
            return Rejected(
                reason_code="invalid_arguments",
                spoken_facts=["All contacts doesn't take a circle."],
            )
        return None
    return Rejected(
        reason_code="invalid_arguments",
        needs="disambiguation",
        spoken_facts=["I need to know who may be auto-approved: all contacts or a circle."],
    )


async def set_auto_approve(ctx: ToolContext, args: SetAutoApproveInput) -> ToolResult:
    problem = _circle_problem(ctx, args)
    if problem is not None:
        return problem
    location = _location_service(ctx)
    ids = _requested_circle_ids(args)
    scope_kind: str | None = args.scope if args.enabled else None
    circle_id = ids[0] if args.enabled and args.scope == "circle" else None
    circle_ids = ids if args.enabled and args.scope == "circles" else None
    try:
        preference = await _run(
            location.update_auto_approve_preference,
            user_id=ctx.user_id,
            enabled=args.enabled,
            scope_kind=scope_kind,
            circle_id=circle_id,
            circle_ids=circle_ids,
        )
    except OneLocationAgentError as error:
        return _rejected(error)
    preference = preference if isinstance(preference, dict) else {}
    enabled = bool(preference.get("enabled"))
    if enabled != args.enabled:
        return Rejected(
            reason_code="auto_approve_not_updated",
            spoken_facts=["Automatic approval didn't change."],
        )
    scope = preference.get("scope")
    rule_version = preference.get("ruleVersion")
    return SetAutoApproveResult(
        status="on" if enabled else "off",
        scope=scope if isinstance(scope, dict) else None,
        rule_version=int(rule_version) if isinstance(rule_version, int) else None,
        spoken_facts=[_auto_approve_fact(ctx, preference)],
    )


def summarize_set_auto_approve(ctx: ToolContext, args: SetAutoApproveInput) -> str:
    if not args.enabled:
        return "turn automatic approval of location requests off"
    if args.scope in {"circle", "circles"}:
        names = [
            circle.name
            for circle_id in _requested_circle_ids(args)
            if (circle := ctx.entities.circle(circle_id))
        ]
        target = _join(names) if names else "the confirmed circle"
        return f"turn automatic approval on for {target}"
    return "turn automatic approval on for all contacts"


# -- list_my_place_ratings ---------------------------------------------------


class ListMyPlaceRatingsInput(ToolInput):
    pass


class ListMyPlaceRatingsResult(ToolResult):
    status: Literal["listed", "empty"]
    count: int = 0
    ratings: list[dict[str, Any]] = Field(default_factory=list)


async def list_my_place_ratings(ctx: ToolContext, args: ListMyPlaceRatingsInput) -> ToolResult:
    admission = ctx.service(FEATURE_ADMISSION_SERVICE, OneLocationFeatureAdmission)
    if not admission.nearby_presence_enabled(ctx.user_id):
        return Unsupported(
            reason_code="ratings_not_available",
            spoken_facts=["Ratings aren't available for your account yet."],
        )
    ratings_service = ctx.service(PLACE_RATING_SERVICE, OneLocationPlaceRatingService)
    try:
        payload = await _run(ratings_service.list_own_ratings, user_id=ctx.user_id, limit=25)
    except (PlaceRatingError, OneLocationAgentError) as error:
        return _rejected(error)
    ratings = [row for row in ((payload or {}).get("ratings") or []) if isinstance(row, dict)]
    if not ratings:
        return ListMyPlaceRatingsResult(
            status="empty", count=0, spoken_facts=["You haven't rated any places yet."]
        )
    facts = [f"You've rated {_count(len(ratings), 'place')}."]
    for row in ratings[:RATINGS_SPOKEN_LIMIT]:
        label = str(row.get("placeLabel") or "").strip() or "a place"
        rating = int(row.get("rating") or 0)
        facts.append(f"{label}: {rating} out of 5.")
    if len(ratings) > RATINGS_SPOKEN_LIMIT:
        facts.append(f"And {len(ratings) - RATINGS_SPOKEN_LIMIT} more.")
    public = [
        {
            "place_id": str(row.get("placeId") or ""),
            "place_label": row.get("placeLabel"),
            "rating": int(row.get("rating") or 0),
            "visited_at": row.get("visitedAt"),
            "visit_count": int(row.get("visitCount") or 1),
        }
        for row in ratings
    ]
    return ListMyPlaceRatingsResult(
        status="listed", count=len(ratings), ratings=public, spoken_facts=facts
    )


# -- catalog -----------------------------------------------------------------


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="get_location_status",
        gateway_action_id="location.open_now",
        policy=ToolPolicy.read,
        input_model=GetLocationStatusInput,
        output_model=LocationStatusResult,
        description=(
            "Read the person's own Location status: whether sharing with people is on, off, or "
            "not set up; the device location permission (a separate thing from app sharing); "
            "how many active shares, people sharing with them, requests waiting, and active "
            "links there are; whether Save My Soul is active; and map visibility. Reads only. "
            "Use it for 'am I sharing my location', 'who can see me', 'is my location on'."
        ),
        handler=get_location_status,
    ),
    ToolSpec(
        name="turn_sharing_on",
        gateway_action_id="location.set_sharing_enabled",
        policy=ToolPolicy.confirm_voice,
        input_model=TurnSharingOnInput,
        output_model=TurnSharingOnResult,
        description=(
            "Turn owner-level location sharing on after the person confirms. Needs recorded "
            "consent (answers consent_required otherwise) and completed Location setup "
            "(answers setup_required otherwise). Turning it on does not start any share; it "
            "allows shares again. The device permission is separate and is not changed here."
        ),
        handler=turn_sharing_on,
        ui_refresh=("location_state", "location_settings"),
        summarize=summarize_turn_sharing_on,
    ),
    ToolSpec(
        name="turn_sharing_off",
        gateway_action_id="location.set_sharing_enabled",
        policy=ToolPolicy.confirm_tap,
        input_model=TurnSharingOffInput,
        output_model=TurnSharingOffResult,
        description=(
            "Turn owner-level location sharing off after the person taps Confirm. This stops "
            "every active share and every active link in the same transaction and hides them on "
            "the map. An active Save My Soul share blocks it (sos_active) unless include_sos is "
            "set because the person explicitly asked to stop SOS too."
        ),
        handler=turn_sharing_off,
        ui_refresh=("location_state", "location_settings", "location_map"),
        summarize=summarize_turn_sharing_off,
    ),
    ToolSpec(
        name="set_precision",
        gateway_action_id="location.set_precision",
        policy=ToolPolicy.confirm_voice,
        input_model=SetPrecisionInput,
        output_model=SetPrecisionResult,
        description=(
            "Choose precise or approximate sharing precision after the person confirms. The "
            "server only stores the preference: positions are encrypted on the device, so the "
            "coarsening itself happens on this device and the server cannot see or adjust "
            "coordinates. Save My Soul shares are always precise regardless of this setting."
        ),
        handler=set_precision,
        ui_refresh=("location_settings",),
        summarize=summarize_set_precision,
    ),
    ToolSpec(
        name="get_location_settings",
        gateway_action_id="location.open_settings",
        policy=ToolPolicy.read,
        input_model=GetLocationSettingsInput,
        output_model=LocationSettingsResult,
        description=(
            "Read the person's Location settings: sharing on/off/not set up, sharing precision, "
            "map visibility (hidden or visible), and automatic approval of location requests. "
            "Reads only."
        ),
        handler=get_location_settings,
    ),
    ToolSpec(
        name="hide_on_map",
        gateway_action_id="location.set_ghost_mode",
        policy=ToolPolicy.direct,
        input_model=MapPresenceInput,
        output_model=HideOnMapResult,
        description=(
            "Hide the person on the map (Ghost Mode) right away; no confirmation needed because "
            "it only increases privacy. Existing private shares keep going for the people they "
            "were made for; this changes who can find them generally."
        ),
        handler=hide_on_map,
        ui_refresh=("location_settings", "location_map"),
    ),
    ToolSpec(
        name="show_on_map",
        gateway_action_id="location.set_ghost_mode",
        policy=ToolPolicy.confirm_voice,
        input_model=MapPresenceInput,
        output_model=ShowOnMapResult,
        description=(
            "Make the person visible on the map (turn Ghost Mode off) after they confirm. Refused "
            "while owner-level sharing is off. It does not start any share."
        ),
        handler=show_on_map,
        ui_refresh=("location_settings", "location_map"),
        summarize=summarize_show_on_map,
    ),
    ToolSpec(
        name="set_auto_approve",
        gateway_action_id="location.set_auto_share",
        policy=ToolPolicy.confirm_voice,
        input_model=SetAutoApproveInput,
        output_model=SetAutoApproveResult,
        description=(
            "Turn automatic approval of incoming location requests on or off after the person "
            "confirms. When enabling, scope is all_contacts, or circle/circles with canonical "
            "circle ids that were confirmed in this conversation (never a spoken name). Applies "
            "only to requests that arrive afterwards; requests already waiting still need an answer."
        ),
        handler=set_auto_approve,
        ui_refresh=("location_settings",),
        summarize=summarize_set_auto_approve,
    ),
    ToolSpec(
        name="list_my_place_ratings",
        gateway_action_id="location.open_ratings",
        policy=ToolPolicy.read,
        input_model=ListMyPlaceRatingsInput,
        output_model=ListMyPlaceRatingsResult,
        description=(
            "Read the ratings the person has given to places they checked in at. Ratings are "
            "for places only: there is no such thing as rating a person, and this tool cannot "
            "rate anyone or anything. Answers unsupported when ratings aren't available for the "
            "account. Reads only."
        ),
        handler=list_my_place_ratings,
    ),
)


__all__ = ["TOOLS"]
