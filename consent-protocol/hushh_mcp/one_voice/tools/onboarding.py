"""Location setup (onboarding) tools over :class:`OneLocationSetupService`.

The setup is a strict forward state machine (migration 223):
``intro -> consent -> os_permission -> precision -> recipient_key -> done``.
Consent is recorded strictly before the OS permission prompt. The server never
triggers that prompt: the client shows it and reports the outcome through
``advance_location_setup(step="os_permission", os_permission_state=...)``.
The recipient key is verified against the real key table, and ``done`` turns
owner-level sharing on.

Every handler runs the sync service in a worker thread and maps
:class:`OneLocationAgentError` codes into the tool's status vocabulary, so a
refused step is a typed result the model must read back, never an exception.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    Needs,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.services.one_location_account_settings_service import (
    OneLocationAccountSettingsService,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_setup_service import (
    OneLocationSetupService,
    SetupProgress,
)

SETUP_SERVICE = "location_setup"
LOCATION_SETTINGS_SERVICE = "location_settings"

OPEN_SETUP_SCREEN: dict[str, str] = {"kind": "open_screen", "screen": "location_setup"}
REGISTER_RECIPIENT_KEY: dict[str, str] = {"kind": "register_recipient_key"}
REPORT_OS_PERMISSION: dict[str, str] = {"kind": "report_os_permission"}

# Plain words for each step, spoken as "the <word> step".
STEP_WORDS: dict[str, str] = {
    "intro": "introduction",
    "consent": "consent",
    "os_permission": "device permission",
    "precision": "precision",
    "recipient_key": "device key",
    "done": "done",
}

OsPermissionState = Literal["prompt", "granted", "denied"]
Precision = Literal["precise", "approximate"]
AdvanceStep = Literal["os_permission", "precision", "recipient_key", "complete"]

_DENIED_FACT = "Your device denied location access. You can change it in Settings."


def _next_step_fact(progress: SetupProgress) -> str:
    """What comes after the recorded step, in plain words."""
    if progress.completed:
        return "Location setup is complete."
    following = progress.next_step
    if following is None or following == "done":
        return "Next, finish setup to turn sharing on."
    return f"Next is the {STEP_WORDS[following]} step."


def _rejected(error: OneLocationAgentError) -> Rejected:
    needs: Needs | None = "setup" if error.code == "LOCATION_SETUP_NOT_STARTED" else None
    return Rejected(reason_code=error.code, spoken_facts=[error.message], needs=needs)


async def _run(fn: Callable[..., Any], /, **kwargs: Any) -> Any:
    return await asyncio.to_thread(fn, **kwargs)


# -- get_location_setup_state -----------------------------------------------


class GetSetupStateInput(ToolInput):
    pass


class SetupStateResult(ToolResult):
    status: Literal["not_started", "in_progress", "done"]
    current_step: str | None = None
    progress: dict[str, Any] = Field(default_factory=dict)


async def get_location_setup_state(ctx: ToolContext, args: GetSetupStateInput) -> ToolResult:
    setup = ctx.service(SETUP_SERVICE, OneLocationSetupService)
    progress: SetupProgress = await _run(setup.get, user_id=ctx.user_id)
    payload = progress.as_payload()
    if not progress.started:
        return SetupStateResult(
            status="not_started",
            current_step=None,
            progress=payload,
            spoken_facts=["You haven't started Location setup yet."],
        )
    if progress.completed:
        return SetupStateResult(
            status="done",
            current_step="done",
            progress=payload,
            spoken_facts=["Location setup is complete."],
        )
    current = progress.next_step or "done"
    facts = [
        "You're on the last step: finish setup to turn sharing on."
        if current == "done"
        else f"You're on the {STEP_WORDS[current]} step."
    ]
    if progress.os_permission_state == "denied":
        facts.append(_DENIED_FACT)
    return SetupStateResult(
        status="in_progress", current_step=current, progress=payload, spoken_facts=facts
    )


# -- start_location_setup ----------------------------------------------------


class StartSetupInput(ToolInput):
    pass


class StartSetupResult(ToolResult):
    status: Literal["started", "resumed", "done"]
    current_step: str | None = None
    client_step: dict[str, str] | None = None
    progress: dict[str, Any] = Field(default_factory=dict)


async def start_location_setup(ctx: ToolContext, args: StartSetupInput) -> ToolResult:
    setup = ctx.service(SETUP_SERVICE, OneLocationSetupService)
    before: SetupProgress = await _run(setup.get, user_id=ctx.user_id)
    if before.completed:
        return StartSetupResult(
            status="done",
            current_step="done",
            progress=before.as_payload(),
            spoken_facts=["Location setup is already complete."],
        )
    try:
        progress: SetupProgress = await _run(setup.start, user_id=ctx.user_id)
    except OneLocationAgentError as error:
        return _rejected(error)
    current = progress.next_step or "done"
    resumed = before.started
    facts = [
        (
            f"Picking up Location setup at the {STEP_WORDS[current]} step."
            if resumed
            else "Location setup started. First is the consent step."
        )
    ]
    return StartSetupResult(
        status="resumed" if resumed else "started",
        current_step=current,
        client_step=dict(OPEN_SETUP_SCREEN),
        progress=progress.as_payload(),
        spoken_facts=facts,
    )


# -- accept_location_setup_consent ------------------------------------------


class AcceptConsentInput(ToolInput):
    consent_version: str = Field(
        min_length=1,
        max_length=80,
        description="The Location sharing consent version shown on screen. Never invent it.",
    )


class AcceptConsentResult(ToolResult):
    status: Literal["accepted"]
    current_step: str | None = None
    consent_version: str | None = None
    progress: dict[str, Any] = Field(default_factory=dict)


async def accept_location_setup_consent(ctx: ToolContext, args: AcceptConsentInput) -> ToolResult:
    setup = ctx.service(SETUP_SERVICE, OneLocationSetupService)
    try:
        progress: SetupProgress = await _run(
            setup.accept_consent, user_id=ctx.user_id, consent_version=args.consent_version
        )
    except OneLocationAgentError as error:
        return _rejected(error)
    if progress.step == "consent":
        facts = ["Consent recorded. Next is your device's location permission."]
    else:
        facts = ["Consent was already recorded.", _next_step_fact(progress)]
    return AcceptConsentResult(
        status="accepted",
        current_step=progress.next_step or "done",
        consent_version=progress.consent_version,
        progress=progress.as_payload(),
        spoken_facts=facts,
    )


def summarize_accept_consent(ctx: ToolContext, args: AcceptConsentInput) -> str:
    return "accept the Location sharing consent"


# -- advance_location_setup --------------------------------------------------


class AdvanceSetupInput(ToolInput):
    step: AdvanceStep = Field(
        description=(
            "Which step to record: os_permission (the device's answer to the location prompt), "
            "precision (precise or approximate), recipient_key (this device's location key), "
            "or complete (finish and turn sharing on)."
        )
    )
    os_permission_state: OsPermissionState | None = Field(
        default=None,
        description=(
            "For step=os_permission: the outcome the device reported for the OS location prompt. "
            "The server never shows the prompt; only report what the device actually said."
        ),
    )
    precision: Precision | None = Field(
        default=None, description="For step=precision: precise or approximate."
    )


class AdvanceSetupResult(ToolResult):
    status: Literal["advanced", "consent_required", "step_order", "recipient_key_missing"]
    step: str | None = None
    next_step: str | None = None
    client_step: dict[str, str] | None = None
    progress: dict[str, Any] = Field(default_factory=dict)


def _advance_error(error: OneLocationAgentError) -> ToolResult:
    code = error.code
    if code in {"LOCATION_SETUP_CONSENT_REQUIRED", "LOCATION_SHARING_CONSENT_REQUIRED"}:
        return AdvanceSetupResult(
            status="consent_required",
            needs="consent",
            reason_code=code,
            spoken_facts=[error.message],
        )
    if code == "LOCATION_SETUP_STEP_ORDER":
        return AdvanceSetupResult(
            status="step_order", reason_code=code, spoken_facts=[error.message]
        )
    if code == "LOCATION_RECIPIENT_KEY_MISSING":
        return AdvanceSetupResult(
            status="recipient_key_missing",
            needs="client_step",
            reason_code=code,
            client_step=dict(REGISTER_RECIPIENT_KEY),
            spoken_facts=[error.message],
        )
    return _rejected(error)


async def advance_location_setup(ctx: ToolContext, args: AdvanceSetupInput) -> ToolResult:
    setup = ctx.service(SETUP_SERVICE, OneLocationSetupService)
    try:
        if args.step == "os_permission":
            state = args.os_permission_state
            if state is None and ctx.screen.os_location_permission != "unknown":
                # The sanitized app context already carries the device's answer.
                state = ctx.screen.os_location_permission
            if state is None:
                # ``client_step`` is an extra field (``ToolResult`` allows them), not a
                # declared one, so it is passed as a mapping.
                client_step: dict[str, Any] = {"client_step": dict(REPORT_OS_PERMISSION)}
                return Rejected(
                    reason_code="os_permission_state_required",
                    needs="client_step",
                    spoken_facts=[
                        "I need your device's answer to the location permission prompt first."
                    ],
                    **client_step,
                )
            progress: SetupProgress = await _run(
                setup.record_os_permission, user_id=ctx.user_id, state=state
            )
            if state == "denied":
                facts = [_DENIED_FACT, _next_step_fact(progress)]
            elif state == "granted":
                facts = ["Location permission granted.", _next_step_fact(progress)]
            else:
                facts = [
                    "Your device hasn't answered the location prompt yet.",
                    _next_step_fact(progress),
                ]
        elif args.step == "precision":
            if args.precision is None:
                return Rejected(
                    reason_code="precision_required",
                    spoken_facts=[
                        "I need to know whether you want precise or approximate location."
                    ],
                )
            progress = await _run(
                setup.set_precision, user_id=ctx.user_id, precision=args.precision
            )
            facts = [f"Location precision set to {progress.precision}.", _next_step_fact(progress)]
        elif args.step == "recipient_key":
            progress = await _run(setup.confirm_recipient_key, user_id=ctx.user_id)
            facts = ["This device's location key is registered.", _next_step_fact(progress)]
        else:  # complete
            progress = await _run(setup.complete, user_id=ctx.user_id)
            facts = ["Location setup is complete."]
            settings_service = ctx.service(
                LOCATION_SETTINGS_SERVICE, OneLocationAccountSettingsService
            )
            account = await _run(settings_service.get, user_id=ctx.user_id)
            if account.sharing_state == "on":
                facts.append("Location sharing is on.")
    except OneLocationAgentError as error:
        return _advance_error(error)
    return AdvanceSetupResult(
        status="advanced",
        step=progress.step,
        next_step=progress.next_step,
        progress=progress.as_payload(),
        spoken_facts=facts,
    )


# -- catalog -----------------------------------------------------------------

TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="get_location_setup_state",
        gateway_action_id="location.setup.status",
        policy=ToolPolicy.read,
        input_model=GetSetupStateInput,
        output_model=SetupStateResult,
        description=(
            "Read where the person is in Location setup: not started, the step they're on "
            "(consent, device permission, precision, device key), or done. Reads only."
        ),
        handler=get_location_setup_state,
    ),
    ToolSpec(
        name="start_location_setup",
        gateway_action_id="location.setup.start",
        policy=ToolPolicy.direct,
        input_model=StartSetupInput,
        output_model=StartSetupResult,
        description=(
            "Start or resume Location setup and open the setup flow on screen. Idempotent: an "
            "existing run resumes at its current step. Changes no sharing state by itself."
        ),
        handler=start_location_setup,
        ui_refresh=("location_setup",),
    ),
    ToolSpec(
        name="accept_location_setup_consent",
        gateway_action_id="location.setup.accept_consent",
        policy=ToolPolicy.confirm_tap,
        input_model=AcceptConsentInput,
        output_model=AcceptConsentResult,
        description=(
            "Record that the person accepted the Location sharing consent shown on screen, after "
            "they tap Confirm. Consent must be recorded BEFORE any device location permission "
            "prompt; the flow refuses the permission step until this is done."
        ),
        handler=accept_location_setup_consent,
        ui_refresh=("location_setup",),
        summarize=summarize_accept_consent,
    ),
    ToolSpec(
        name="advance_location_setup",
        gateway_action_id="location.setup.advance",
        policy=ToolPolicy.direct,
        input_model=AdvanceSetupInput,
        output_model=AdvanceSetupResult,
        description=(
            "Record the next Location setup step: os_permission with the device's reported answer "
            "to the OS prompt (the server never shows the prompt), precision (precise or "
            "approximate), recipient_key once this device registered its location key, or "
            "complete to finish and turn sharing on. Steps must be taken in order after consent."
        ),
        handler=advance_location_setup,
        ui_refresh=("location_setup", "location_settings"),
    ),
)

__all__ = [
    "TOOLS",
    "AcceptConsentResult",
    "AdvanceSetupResult",
    "OPEN_SETUP_SCREEN",
    "REGISTER_RECIPIENT_KEY",
    "REPORT_OS_PERMISSION",
    "STEP_WORDS",
    "SetupStateResult",
    "StartSetupResult",
]
