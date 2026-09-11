"""Transcript-first command orchestration for the Location brain.

This module deliberately sits between a text-only speech transport and the
Location Capability Graph.  It is *not* a conversational agent: a tap opens
PCM capture, Gemini's server-side endpoint detector closes the utterance, and
only then may the server retrieve and select an audited Location capability.

The module keeps no transcript, slot value, credential, entity value, route,
or provider payload after a result is produced.  Its wire outputs are typed
status/card projections only.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

from hushh_mcp.runtime_providers.factory import (
    VERTEX_ADC_AUTH_MODE,
    ManagedGeminiRuntimeBinding,
)
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.app_intelligence_runtime import (
    build_location_brain_model_routing_intent,
    build_location_brain_snapshot,
    get_capability,
    get_capability_workflow_revision_policy,
    load_capability_graph,
    record_runtime_milestone,
    retrieve_service_brain_candidates,
    validate_location_brain_selection,
)
from hushh_mcp.services.capability_run_service import (
    CapabilityRunAuthorityError,
    CapabilityRunConflictError,
    get_capability_run_store,
)
from hushh_mcp.services.location_circle_direct_executor import execute_location_create_circle
from hushh_mcp.services.location_circle_name_interaction import (
    LOCATION_CIRCLE_NAME_ACTION_ID,
    LOCATION_CIRCLE_NAME_FORM_ID,
    LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION,
    LOCATION_CIRCLE_NAME_SURFACE_ID,
    LocationCircleNameAuthorityError,
    LocationCircleNameConflictError,
    get_location_circle_name_interaction_service,
)
from hushh_mcp.services.location_onboarding_runtime import (
    LocationOnboardingAuthorityError,
    LocationOnboardingConflictError,
    get_location_onboarding_runtime_service,
)

logger = logging.getLogger(__name__)

# A new wire version is deliberate: v1 made a client press/release boundary
# authoritative. Accepting that client against automatic endpointing would
# reintroduce clipped-prefix routing, so a mismatched build fails closed.
ONE_COMMAND_PROTOCOL_VERSION = "one_command_v2"
LOCATION_COMMAND_PROTOCOL_VERSION = ONE_COMMAND_PROTOCOL_VERSION
LOCATION_COMMAND_RUNTIME_ENABLED_ENV = "HUSHH_LOCATION_COMMAND_RUNTIME_ENABLED"
DEFAULT_LOCATION_COMMAND_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live-preview"

_TURN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
_CONTEXT_REVISION_RE = re.compile(r"^[A-Za-z0-9_.:-]{0,191}$")
_SAFE_LOCATION_ROUTE_RE = re.compile(r"^/one/[A-Za-z0-9_./-]{0,191}$")
_CIRCLE_NAME_RE = re.compile(
    r"\b(?:called|named|name\s+(?:it|the\s+circle)?|title(?:d)?\s+as)\s+"
    r"(?P<name>[A-Za-z0-9][A-Za-z0-9 .,'&_-]{0,79})\s*[.!?]?$",
    flags=re.IGNORECASE,
)
_CIRCLE_NAME_ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+[A-Za-z][A-Za-z .'-]{1,72}\s"
    r"(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|place|pl)\b",
    flags=re.IGNORECASE,
)
_LOCATION_COMMAND_CIRCLE_SCOPE_DOMAIN = b"one.location.command.circle.scope.v1\x00"
_LOCATION_COMMAND_CIRCLE_SCOPE_PREFIX = "lcc1_"
# Identical confirmed Circle commands are replayed only across this short,
# server-governed interval. The resulting run record is durable; the interval
# prevents a later deliberate duplicate display name from being collapsed
# forever while still bridging a lost response/reconnect.
_LOCATION_COMMAND_CIRCLE_REPLAY_WINDOW_SECONDS = 120
_CIRCLE_NAME_DIRECTIVE_RE = re.compile(r"^loccirclecmd_[a-f0-9]{32}$")
_CIRCLE_NAME_LEASE_RE = re.compile(r"^loccirclelease_[0-9]{10,11}_[a-f0-9]{64}$")

_TERMINAL_OUTCOMES = frozenset(
    {"execute_started", "interaction_required", "navigate", "ask", "blocked", "failed"}
)
# These candidates advance a server-owned durable workflow or enter the audited
# Circle adapter.  They are intentionally distinct from semantic selection:
# selection can be bounded/cancelled safely, whereas an already-claimed advance
# must reach its durable terminal/replay path rather than being reported as a
# client-side routing timeout.
_DURABLE_ADVANCE_CAPABILITY_IDS = frozenset(
    {
        "workflow.setup.location",
        "native.request_device_location_permission",
        "location.onboarding.choose_place",
        "location.create_circle",
    }
)
_VERIFIED_STATUS_CARD_IDS: Mapping[str, str] = {
    # These are fixed, checked-in card identifiers rendered through the
    # existing display-only approved data-card surface. They contain no model
    # prose, slot value, entity value, or user-provided label.
    "location.create_circle": "one.location.command.circle_verified.v1",
    "workflow.setup.location": "one.location.command.location_verified.v1",
}


def location_command_runtime_enabled() -> bool:
    """Whether the independently rollable UAT command lane is enabled.

    The generated rollout config already hardens development and production
    deployments off. Keep the runtime boundary equally strict so a hand-set
    environment variable cannot accidentally make a non-UAT relay accept the
    transcript-first protocol.
    """

    if (os.getenv("ENVIRONMENT") or "").strip().lower() != "uat":
        return False
    return (os.getenv(LOCATION_COMMAND_RUNTIME_ENABLED_ENV) or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def location_command_transcribe_model_id() -> str:
    """Return the immutable model identity for the command lane.

    Deployment configuration must still provision capacity for this exact
    model, but it cannot select a different model at runtime.  A command
    transcript is part of a release-tested protocol (manual VAD, text-only
    responses and final-boundary semantics), not a generic Live alias.
    """

    return DEFAULT_LOCATION_COMMAND_TRANSCRIBE_MODEL


def _extract_server_owned_slots(candidate_id: str, transcript: str) -> dict[str, str]:
    """Extract only an audited direct-action slot without model disclosure.

    The transcript remains transient in the command process. It is never sent
    to embeddings, the text selector, telemetry, or a wire payload. New
    free-form capability slots require a dedicated validator here (or a typed
    interaction card); they may not be delegated to Gemini.
    """

    if candidate_id != "location.create_circle":
        return {}
    match = _CIRCLE_NAME_RE.search(" ".join(str(transcript or "").split()))
    if match is None:
        return {}
    name = " ".join(match.group("name").split()).strip(" .,!?")[:80]
    if not name or _CIRCLE_NAME_ADDRESS_RE.search(name):
        return {}
    return {"name": name}


def _circle_replay_generation(*, now_seconds: float | None = None) -> int:
    """Return the current server-owned bounded replay generation."""

    current = time.time() if now_seconds is None else float(now_seconds)
    return max(0, int(current) // _LOCATION_COMMAND_CIRCLE_REPLAY_WINDOW_SECONDS)


def _derive_circle_execution_scope(
    *,
    user_id: str,
    name: str,
    replay_generation: int | None = None,
) -> str | None:
    """Mint an opaque, short-lived execution scope for one Circle command.

    ``turn_id`` is only a client transport correlation value. A reconnect or
    lost response gets a fresh turn id, so it must not decide idempotency. The
    current server replay generation, plus the durable terminal-run lookup
    below, instead provides the retry boundary. The existing direct-capability
    dispatcher folds this opaque ``invocation_id`` into the durable
    ``CapabilityRunV1`` key.

    Owner and name are HMAC input only. They are neither logged nor emitted,
    and the capability-run store HMACs the opaque scope again before durable
    persistence. A new replay generation intentionally gets a new scope so
    the product can create two deliberately named-identical Circles. Missing
    signing material fails closed instead of falling back to a reversible hash.
    """

    owner = str(user_id or "").strip()[:256]
    # Preserve case because it is part of the display-name contract, but fold
    # whitespace and canonically equivalent Unicode into one replay boundary.
    normalized_name = unicodedata.normalize("NFC", " ".join(str(name or "").split()))[:160]
    if not owner or not normalized_name:
        return None
    generation = _circle_replay_generation() if replay_generation is None else replay_generation
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        return None
    try:
        signing_key = str(get_core_security_settings().app_signing_key or "").strip()
    except (AttributeError, ValueError):
        return None
    if len(signing_key) < 32:
        return None
    canonical = json.dumps(
        {
            "action_id": "location.create_circle",
            "owner": owner,
            "replay_generation": generation,
            "slots": {"name": normalized_name},
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    digest = hmac.new(
        signing_key.encode("utf-8"),
        _LOCATION_COMMAND_CIRCLE_SCOPE_DOMAIN + canonical,
        hashlib.sha256,
    ).hexdigest()
    return f"{_LOCATION_COMMAND_CIRCLE_SCOPE_PREFIX}{digest}"


async def _find_recent_circle_replay_run_id(
    *,
    user_id: str,
    name: str,
) -> tuple[str | None, str | None]:
    """Find one recent verified Circle run without exposing its slot values.

    This is the durable half of the replay boundary. The query is exact on
    authenticated owner, compiled graph revision, capability id, and a
    server-HMAC of normalized slots. It deliberately does not query Circle
    display names, which are allowed to repeat for distinct product actions.
    """

    try:
        graph = load_capability_graph()
        graph_revision = str(graph.get("revision") or "").strip()
        if not graph_revision:
            return None, "idempotency_unavailable"
        run = await get_capability_run_store().find_recent_verified_matching_slots(
            user_id=user_id,
            capability_id="location.create_circle",
            graph_revision=graph_revision,
            slots={"name": name},
            replay_window_seconds=_LOCATION_COMMAND_CIRCLE_REPLAY_WINDOW_SECONDS,
        )
    except (CapabilityRunAuthorityError, CapabilityRunConflictError, ValueError):
        return None, "idempotency_unavailable"
    except Exception:  # noqa: BLE001 - a missing replay proof must fail closed
        logger.info("location_command_circle_replay_lookup_unavailable")
        return None, "idempotency_unavailable"
    run_id = str(getattr(run, "run_id", "") or "").strip()
    return (run_id or None), None


async def _dispatch_circle_server_direct(
    *,
    user_id: str,
    consent_token: str,
    name: str,
    execution_scope: str,
    resume_run_id: str | None,
) -> Mapping[str, Any]:
    """Run the one audited Circle executor without importing the ADK gateway."""

    return await execute_location_create_circle(
        user_id=user_id,
        vault_owner_token=consent_token,
        name=name,
        execution_scope=execution_scope,
        resume_run_id=resume_run_id,
    )


def _build_managed_location_command_text_client(*, model: str) -> Any | None:
    """Return a selector client only for organization-managed Vertex ADC."""

    binding = ManagedGeminiRuntimeBinding.from_environment()
    if binding.auth_mode != VERTEX_ADC_AUTH_MODE:
        return None
    return binding.build_direct_client(model=model)


@dataclass
class LocationCommandTurnV1:
    """One in-memory tap-to-command boundary.

    ``transcript`` is transient: it is removed by :meth:`take_resolution`
    before any command result is sent.  ``turn_id`` is a client correlation
    token only and grants no authority.
    """

    turn_id: str
    start_sequence: int
    expected_sequence: int
    last_sequence: int = 0
    final_sequence: int | None = None
    # ``released`` is retained only for an explicit cancellation. It is never
    # a successful command boundary in the v2 protocol.
    released: bool = False
    cancelled: bool = False
    # Gemini Live's automatic VAD owns successful speech endpointing. The
    # relay still requires a final transcript plus provider turnComplete.
    speech_ended: bool = False
    # ``activity_end`` is a wire write, not merely an intent.  Keep a short
    # in-flight marker so a second error path cannot send it twice, but do not
    # treat a claimed write as an observed provider boundary until the SDK
    # write itself succeeds.
    provider_activity_end_sending: bool = False
    provider_activity_ended: bool = False
    provider_turn_complete: bool = False
    # Provider messages are not tagged with our command id. A final transcription
    # can arrive shortly after turnComplete, so completion alone is not a safe
    # reuse boundary for the next physical tap.
    provider_boundary_drained: bool = False
    transcript: str = ""
    resolution_taken: bool = False
    # Set only by the relay after a side-effect-free plan is selected and
    # immediately before a durable adapter/run advance begins.  From this
    # point a later transport fragment cannot retract the person's already
    # authorized command into a contradictory client-side timeout/failure.
    execution_committed: bool = False
    result_settled: bool = False

    @property
    def endpointed(self) -> bool:
        """Whether the authenticated provider completion boundary exists."""

        return self.speech_ended or self.released

    def accepts_audio(self, *, turn_id: Any, sequence: Any) -> str | None:
        if self.cancelled:
            return "released"
        # The client stops capture as soon as it receives the fixed
        # ``speech_ended`` control frame. Any packet already in WebSocket
        # flight must not manufacture a second command or a false failure.
        # Tell the relay to discard it rather than treating it as accepted:
        # forwarding post-end PCM to Gemini can open a stray second provider
        # activity turn even though it can never belong to this command.
        if self.speech_ended:
            return "post_endpoint_ignored"
        if str(turn_id or "") != self.turn_id:
            return "turn_mismatch"
        if not isinstance(sequence, int) or isinstance(sequence, bool):
            return "sequence_invalid"
        if sequence != self.expected_sequence:
            return "sequence_gap"
        self.last_sequence = sequence
        self.expected_sequence += 1
        return None

    def end(self, *, turn_id: Any, final_sequence: Any, cancelled: bool) -> str | None:
        if str(turn_id or "") != self.turn_id:
            return "turn_mismatch"
        if self.released or self.speech_ended:
            return "already_released"
        if not isinstance(final_sequence, int) or isinstance(final_sequence, bool):
            return "sequence_invalid"
        if final_sequence < 0 or final_sequence != self.last_sequence:
            return "sequence_gap"
        # v2 has no successful client-defined end. Its sole terminal client
        # control is cancellation; normal routing waits for Gemini Live VAD.
        if not cancelled:
            return "client_end_not_supported"
        self.final_sequence = final_sequence
        self.released = True
        self.cancelled = True
        return None

    def receive_final_transcript(self, text: Any) -> str | None:
        """Accept a final provider fragment after contiguous command audio.

        This lane trusts neither a local silence timer nor an RMS threshold.
        Gemini owns endpointing; the gate separately requires provider
        turnComplete before routing. A stale final before any command PCM is
        still rejected because provider messages have no client turn id.
        """

        if self.cancelled or self.resolution_taken or not isinstance(text, str):
            return None
        if self.last_sequence < self.start_sequence:
            return "final_transcript_before_audio"
        # A provider can deliver more than one final fragment.  Preserve only
        # the bounded current turn and never emit/log it.
        clean = " ".join(text.split())[:2_000]
        if clean:
            self.transcript = " ".join((self.transcript, clean)).strip()[:4_000]
        return None

    def take_resolution(self) -> tuple[str, str] | None:
        if (
            self.resolution_taken
            or self.cancelled
            or not self.speech_ended
            or not self.provider_turn_complete
            or not self.transcript
        ):
            return None
        self.resolution_taken = True
        transcript = self.transcript
        self.transcript = ""
        return self.turn_id, transcript


@dataclass
class LocationCommandTurnGate:
    """Strict one-active-turn state machine used by the websocket relay."""

    turn: LocationCommandTurnV1 | None = None

    def begin(
        self,
        payload: Any,
        *,
        provider_ready: bool,
        context_ready: bool,
    ) -> tuple[LocationCommandTurnV1 | None, str | None]:
        body = payload if isinstance(payload, Mapping) else {}
        if body.get("protocolVersion") != LOCATION_COMMAND_PROTOCOL_VERSION:
            return None, "protocol_mismatch"
        if not provider_ready or not context_ready:
            return None, "not_ready"
        turn_id = str(body.get("turnId") or "").strip()
        start_sequence = body.get("startSequence")
        if not _TURN_ID_RE.fullmatch(turn_id) or start_sequence != 1:
            return None, "invalid_begin"
        if self.turn is not None:
            # Provider transcription events are not tagged with a client turn
            # id. Do not replace an old command until its automatic endpoint
            # boundary has drained; otherwise a late N transcript could be
            # attached to N+1 after a cancel, sequence failure, or timeout.
            if not self.turn.provider_turn_complete or not self.turn.provider_boundary_drained:
                return None, "provider_turn_draining"
            if not self.turn.result_settled:
                return None, "turn_in_progress"
        self.turn = LocationCommandTurnV1(
            turn_id=turn_id,
            start_sequence=start_sequence,
            expected_sequence=start_sequence,
        )
        return self.turn, None

    def accept_audio(self, metadata: Any) -> str | None:
        if self.turn is None:
            return "turn_not_started"
        body = metadata if isinstance(metadata, Mapping) else {}
        return self.turn.accepts_audio(turn_id=body.get("turnId"), sequence=body.get("sequence"))

    def end(self, payload: Any) -> tuple[LocationCommandTurnV1 | None, str | None]:
        if self.turn is None:
            return None, "turn_not_started"
        body = payload if isinstance(payload, Mapping) else {}
        if body.get("protocolVersion") != LOCATION_COMMAND_PROTOCOL_VERSION:
            return None, "protocol_mismatch"
        reason = self.turn.end(
            turn_id=body.get("turnId"),
            final_sequence=body.get("finalSequence"),
            cancelled=body.get("cancelled") is True,
        )
        return (self.turn if reason is None else None), reason

    def receive_final_transcript(self, text: Any) -> str | None:
        if self.turn is not None:
            return self.turn.receive_final_transcript(text)
        return None

    def mark_provider_turn_complete(self) -> bool:
        """Accept Gemini's automatic speech-end boundary for active PCM.

        The associated final transcript can arrive immediately before or
        after this frame, so the relay keeps its post-turn grace before it can
        reuse the provider connection. A local button release is not part of
        this proof.
        """

        if (
            self.turn is None
            or self.turn.cancelled
            or self.turn.last_sequence < self.turn.start_sequence
        ):
            return False
        self.turn.speech_ended = True
        self.turn.provider_turn_complete = True
        return True

    def mark_provider_boundary_drained(self, *, turn_id: str) -> bool:
        """Mark the post-completion grace as safe for a fresh command."""

        if (
            self.turn is None
            or self.turn.turn_id != turn_id
            or not self.turn.provider_turn_complete
        ):
            return False
        self.turn.provider_boundary_drained = True
        return True

    def mark_result_settled(self, *, turn_id: str) -> None:
        if self.turn is not None and self.turn.turn_id == turn_id:
            self.turn.result_settled = True

    def may_emit_resolution_result(self, *, turn_id: str) -> bool:
        """Whether the claimed resolver still owns this terminal result.

        Resolution deliberately runs outside the relay's short state lock so
        provider-boundary draining cannot be blocked by retrieval/model I/O.
        A later transport failure may cancel this exact turn while that work is
        in flight; only the still-current, non-cancelled, unsettled turn may
        publish its result afterward.
        """

        return bool(
            self.turn is not None
            and self.turn.turn_id == turn_id
            and self.turn.resolution_taken
            and not self.turn.cancelled
            and not self.turn.result_settled
        )

    def claim_durable_advance(self, *, turn_id: str) -> bool:
        """Claim an authorized durable advance before its adapter is entered.

        This must run under the relay's short state lock.  It makes the
        release/final-transcript boundary durable before an adapter can issue a
        backend mutation, while preserving the adapter's own idempotency and
        settlement/replay authority.
        """

        if not self.may_emit_resolution_result(turn_id=turn_id):
            return False
        current = self.turn
        if current is None:
            return False
        current.execution_committed = True
        return True

    def claim_provider_activity_end(self, *, turn_id: str) -> bool:
        """Claim the sole manual activity-end write for one command.

        The claim deliberately does *not* make provider completion eligible.
        The caller must subsequently acknowledge the successful SDK write via
        :meth:`mark_provider_activity_end_sent`.
        """

        if (
            self.turn is None
            or self.turn.turn_id != turn_id
            or self.turn.provider_activity_ended
            or self.turn.provider_activity_end_sending
        ):
            return False
        self.turn.provider_activity_end_sending = True
        return True

    def mark_provider_activity_end_sent(self, *, turn_id: str) -> bool:
        """Acknowledge a successfully-written manual activity-end boundary."""

        if (
            self.turn is None
            or self.turn.turn_id != turn_id
            or self.turn.provider_activity_ended
            or not self.turn.provider_activity_end_sending
        ):
            return False
        self.turn.provider_activity_end_sending = False
        self.turn.provider_activity_ended = True
        return True

    def abandon_provider_activity_end(self, *, turn_id: str) -> bool:
        """Forget a failed activity-end write before the relay reconnects."""

        if (
            self.turn is None
            or self.turn.turn_id != turn_id
            or not self.turn.provider_activity_end_sending
            or self.turn.provider_activity_ended
        ):
            return False
        self.turn.provider_activity_end_sending = False
        return True

    def provider_boundary_pending(self, *, turn_id: str) -> bool:
        """Whether a released/cancelled turn still owns untagged provider events."""

        return bool(
            self.turn is not None
            and self.turn.turn_id == turn_id
            and self.turn.endpointed
            and not self.turn.provider_turn_complete
        )

    def fail(self) -> str | None:
        """Make the active command inert after a transport discontinuity."""

        if self.turn is None:
            return None
        # A result that has already claimed settlement is terminal. Late audio,
        # a duplicate release, or a delayed provider control frame must not
        # replace it with a contradictory failure after its websocket result is
        # being emitted.
        if self.turn.result_settled or self.turn.execution_committed:
            return None
        self.turn.released = True
        self.turn.cancelled = True
        self.turn.resolution_taken = True
        self.turn.transcript = ""
        return self.turn.turn_id

    def missing_final_transcript_after_completion(
        self, *, turn_id: str | None = None
    ) -> str | None:
        """Return an eligible turn that cannot make progress safely.

        ``turn_id`` fences the delayed provider-boundary watchdog in the relay:
        a late timeout for an old turn must never fail a subsequently started
        turn.
        """

        if (
            self.turn is None
            or self.turn.cancelled
            or not self.turn.endpointed
            or not self.turn.provider_turn_complete
            or self.turn.transcript
            or self.turn.resolution_taken
            or (turn_id is not None and self.turn.turn_id != turn_id)
        ):
            return None
        self.turn.resolution_taken = True
        return self.turn.turn_id

    def timeout_after_release(self, *, turn_id: str) -> str | None:
        """Expire one released turn that never reaches a safe provider boundary."""

        if (
            self.turn is None
            or self.turn.turn_id != turn_id
            or self.turn.cancelled
            or not self.turn.endpointed
            or self.turn.resolution_taken
        ):
            return None
        self.turn.cancelled = True
        self.turn.resolution_taken = True
        self.turn.transcript = ""
        return self.turn.turn_id

    def take_resolution(self) -> tuple[str, str] | None:
        return self.turn.take_resolution() if self.turn is not None else None


@dataclass(frozen=True)
class LocationCommandResultV1:
    """UI-safe terminal command result; no transcript or private slots."""

    turn_id: str
    outcome: str
    action_id: str | None = None
    reason_code: str | None = None
    run: dict[str, Any] | None = None
    directive: dict[str, Any] | None = None
    # A server-owned typed name form for the missing required Circle slot.
    # This is distinct from the Location onboarding route card and is never a
    # model-generated prompt or bare ASK outcome.
    circle_name_directive: dict[str, Any] | None = None
    navigation: dict[str, str] | None = None
    status_card: dict[str, str] | None = None
    settlement: str | None = None

    def wire_payload(self) -> dict[str, Any]:
        if self.outcome not in _TERMINAL_OUTCOMES:
            raise ValueError("Location command outcome is invalid.")
        payload: dict[str, Any] = {
            "protocolVersion": LOCATION_COMMAND_PROTOCOL_VERSION,
            "turnId": self.turn_id,
            "outcome": self.outcome,
        }
        if self.action_id:
            payload["actionId"] = self.action_id
        if self.reason_code:
            payload["reasonCode"] = self.reason_code
        if self.run is not None:
            payload["run"] = self.run
        if self.directive is not None:
            payload["directive"] = self.directive
        if self.circle_name_directive is not None:
            circle_name_directive = _safe_circle_name_directive(self.circle_name_directive)
            if circle_name_directive is None:
                raise ValueError("Location Circle name directive is invalid.")
            payload["circleNameDirective"] = circle_name_directive
        if self.navigation is not None:
            payload["navigation"] = self.navigation
        if self.status_card is not None:
            payload["statusCard"] = self.status_card
        if self.settlement:
            payload["settlement"] = self.settlement
        return payload


@dataclass(frozen=True)
class LocationCommandPlanV1:
    """A side-effect-free, transient plan for one finalized command.

    The plan is constructed only after semantic retrieval and constrained
    selection have validated a compiled candidate.  It intentionally retains
    no transcript and is never serialized, logged, sent to Gemini, or emitted
    to a client.  ``slots`` contains only server-extracted, adapter-validated
    transient values needed by a later durable advance.
    """

    turn_id: str
    selected_capability_id: str | None = None
    disposition: str | None = None
    slots: dict[str, str] | None = None
    immediate_result: LocationCommandResultV1 | None = None

    @property
    def requires_durable_advance(self) -> bool:
        """Whether advancing this plan may create/continue durable work."""

        return self.selected_capability_id in _DURABLE_ADVANCE_CAPABILITY_IDS


Selector = Callable[[str, Mapping[str, Any]], Awaitable[Mapping[str, Any] | None]]


def _facts_from_active_run(active_run: Mapping[str, Any] | None) -> dict[str, str]:
    """Reduce the durable run to the Location Brain's categorical facts."""

    facts = {
        "permission_status": "unknown",
        "position_receipt_status": "unknown",
        "place_status": "unknown",
        "circle_status": "unknown",
        "completion_status": "unknown",
    }
    if not isinstance(active_run, Mapping):
        return facts
    evidence = active_run.get("evidence") if isinstance(active_run.get("evidence"), Mapping) else {}
    step = str(active_run.get("step") or "").strip()
    status = str(active_run.get("status") or "").strip()
    if evidence.get("permission") is True:
        facts["permission_status"] = "granted"
    elif step in {
        "location.onboarding.permission",
        "location.onboarding.position",
        "location.onboarding.place",
        "location.onboarding.circle",
        "location.onboarding.complete",
    }:
        facts["permission_status"] = "needed"
    if step in {
        "location.onboarding.place",
        "location.onboarding.circle",
        "location.onboarding.complete",
    }:
        facts["position_receipt_status"] = "captured"
    elif step == "location.onboarding.position":
        facts["position_receipt_status"] = "needed"
    if step == "location.onboarding.place":
        facts["place_status"] = "needed"
    elif isinstance(active_run.get("draft"), Mapping):
        facts["place_status"] = "staged"
    if evidence.get("circle") is True:
        facts["circle_status"] = "provisioned"
    elif step == "location.onboarding.circle":
        facts["circle_status"] = "needed"
    elif status == "verified_failed":
        facts["circle_status"] = "failed"
    if evidence.get("completion") is True or status == "verified_succeeded":
        facts["completion_status"] = "completed"
    elif step or status:
        facts["completion_status"] = "incomplete"
    return facts


def _safe_run_projection(
    value: Mapping[str, Any],
    *,
    directive: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Rebuild the existing bounded run projection for the route card host.

    The command result must use the same strict schema as the HTTP Location
    runtime; a partial status object cannot be upgraded into a client card.
    This maps only known, already-client-safe fields and deliberately omits
    raw service adapters, endpoint details, entity values, coordinates, and
    every unrecognized source field.
    """

    try:
        workflow_version = int(value.get("workflow_version"))
        revision = int(value.get("revision"))
    except (TypeError, ValueError):
        return {}
    evidence_source = value.get("evidence")
    if (
        not isinstance(evidence_source, Mapping)
        or not all(
            isinstance(evidence_source.get(key), bool)
            for key in ("permission", "place", "circle", "completion")
        )
        or not isinstance(value.get("completion_claim_allowed"), bool)
    ):
        return {}
    interaction = directive
    if interaction is None:
        interaction = _safe_interaction_directive(value.get("interaction"))
    if value.get("interaction") is not None and interaction is None:
        return {}
    result: dict[str, Any] = {
        "schemaVersion": "one.location_run_projection.v1",
        "workflowId": str(value.get("workflow_id") or ""),
        "workflowVersion": workflow_version,
        "graphRevision": str(value.get("graph_revision") or ""),
        "runId": str(value.get("run_id") or ""),
        "revision": revision,
        "status": str(value.get("status") or ""),
        "cursor": str(value.get("step") or ""),
        "completionClaimAllowed": value.get("completion_claim_allowed") is True,
        "pendingDirective": dict(interaction) if interaction is not None else None,
        "evidence": {
            "permission": evidence_source["permission"],
            "place": evidence_source["place"],
            "circle": evidence_source["circle"],
            "completion": evidence_source["completion"],
        },
        "draft": None,
        "pkmFinalizeAuthorization": None,
    }
    draft = value.get("draft")
    if draft is not None:
        if not isinstance(draft, Mapping):
            return {}
        result["draft"] = {
            "draftRef": str(draft.get("draft_ref") or ""),
            "status": str(draft.get("status") or ""),
            "expiresAt": str(draft.get("expires_at") or ""),
        }
    authorization = value.get("pkm_finalize_authorization")
    if authorization is not None:
        if not isinstance(authorization, Mapping):
            return {}
        # This is the pre-existing opaque browser finalization authority. It
        # is required only for its registered route card and never crosses to
        # Gemini, telemetry, or the command continuation payload.
        result["pkmFinalizeAuthorization"] = {
            "schemaVersion": str(authorization.get("schema_version") or ""),
            "authorizationId": str(authorization.get("authorization_id") or ""),
            "token": str(authorization.get("token") or ""),
            "runId": str(authorization.get("run_id") or ""),
            "runRevision": authorization.get("run_revision"),
            "leaseId": str(authorization.get("lease_id") or ""),
            "directiveId": str(authorization.get("directive_id") or ""),
            "draftRef": str(authorization.get("draft_ref") or ""),
            "draftDigest": str(authorization.get("draft_digest") or ""),
            "expectedCommitId": str(authorization.get("expected_commit_id") or ""),
            "expiresAt": str(authorization.get("expires_at") or ""),
        }
    return result


def _safe_interaction_directive(value: Any) -> dict[str, Any] | None:
    """Return only the compiled card contract and opaque one-time lease."""

    body = value if isinstance(value, Mapping) else None
    if body is None:
        return None
    lease_id = str(body.get("lease_id") or "").strip()
    directive_id = str(body.get("directive_id") or "").strip()
    if not lease_id or not directive_id:
        return None
    allowed_actions = body.get("allowed_actions")
    if not isinstance(allowed_actions, list):
        return None
    contract_id = str(body.get("surface_id") or "")
    return {
        "schemaVersion": "one.location_interaction_directive.v1",
        "directiveId": directive_id,
        "contractId": contract_id,
        "kind": str(body.get("kind") or "status"),
        "surfaceId": "render.one_location_workflow_card",
        "titleKey": str(body.get("title_key") or ""),
        "bodyKey": str(body.get("body_key") or ""),
        "allowedResults": [str(item) for item in allowed_actions[:12]],
        "expiresAt": str(body.get("expires_at") or ""),
        "lease": {
            "leaseId": lease_id,
            "runRevision": int(body.get("run_revision") or 0),
        },
    }


def _safe_circle_name_directive(value: Any) -> dict[str, Any] | None:
    """Validate the fixed server-issued Circle-name form before wire output.

    Unlike a conversational ``ASK``, this is a concrete, revision-bound
    render contract.  Rebuilding the narrow projection here means a future
    service field (especially a slot value or backend detail) cannot leak via
    the real-time command relay by accident.
    """

    body = value if isinstance(value, Mapping) else None
    if body is None or set(body.keys()) != {
        "schemaVersion",
        "actionId",
        "surfaceId",
        "formId",
        "directiveId",
        "run",
        "lease",
        "expiresAt",
        "titleKey",
        "bodyKey",
        "fields",
        "submitKey",
    }:
        return None
    run = body.get("run") if isinstance(body.get("run"), Mapping) else None
    lease = body.get("lease") if isinstance(body.get("lease"), Mapping) else None
    fields = body.get("fields")
    if (
        run is None
        or lease is None
        or not isinstance(fields, list)
        or len(fields) != 1
        or set(run.keys()) != {"runId", "revision", "graphRevision", "contextRevision", "status"}
        or set(lease.keys()) != {"leaseId", "runRevision"}
        or body.get("schemaVersion") != LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION
        or body.get("actionId") != LOCATION_CIRCLE_NAME_ACTION_ID
        or body.get("surfaceId") != LOCATION_CIRCLE_NAME_SURFACE_ID
        or body.get("formId") != LOCATION_CIRCLE_NAME_FORM_ID
        or not isinstance(body.get("directiveId"), str)
        or not _CIRCLE_NAME_DIRECTIVE_RE.fullmatch(str(body.get("directiveId") or ""))
        or not isinstance(run.get("runId"), str)
        or not str(run.get("runId") or "").startswith("run_")
        or not isinstance(run.get("revision"), int)
        or isinstance(run.get("revision"), bool)
        or run.get("revision") < 1
        or not isinstance(run.get("graphRevision"), str)
        or not str(run.get("graphRevision") or "").strip()
        or not isinstance(run.get("contextRevision"), str)
        or not _CONTEXT_REVISION_RE.fullmatch(str(run.get("contextRevision") or ""))
        or run.get("status") != "needs_input"
        or not isinstance(lease.get("leaseId"), str)
        or not _CIRCLE_NAME_LEASE_RE.fullmatch(str(lease.get("leaseId") or ""))
        or lease.get("runRevision") != run.get("revision")
        or not isinstance(body.get("expiresAt"), str)
        or not str(body.get("expiresAt") or "").strip()
        or len(str(body.get("expiresAt") or "")) > 64
        or body.get("titleKey") != "one.location.circle_name.title"
        or body.get("bodyKey") != "one.location.circle_name.body"
        or body.get("submitKey") != "one.location.circle_name.submit"
    ):
        return None
    field = fields[0] if isinstance(fields[0], Mapping) else None
    if field is None or set(field.keys()) != {"fieldId", "type", "required", "maxLength"}:
        return None
    if (
        field.get("fieldId") != "name"
        or field.get("type") != "string"
        or field.get("required") is not True
        or field.get("maxLength") != 80
    ):
        return None
    return {
        "schemaVersion": LOCATION_CIRCLE_NAME_INTERACTION_SCHEMA_VERSION,
        "actionId": LOCATION_CIRCLE_NAME_ACTION_ID,
        "surfaceId": LOCATION_CIRCLE_NAME_SURFACE_ID,
        "formId": LOCATION_CIRCLE_NAME_FORM_ID,
        "directiveId": str(body["directiveId"]),
        "run": {
            "runId": str(run["runId"]),
            "revision": run["revision"],
            "graphRevision": str(run["graphRevision"]),
            "contextRevision": str(run["contextRevision"]),
            "status": "needs_input",
        },
        "lease": {"leaseId": str(lease["leaseId"]), "runRevision": run["revision"]},
        "expiresAt": str(body["expiresAt"]),
        "titleKey": "one.location.circle_name.title",
        "bodyKey": "one.location.circle_name.body",
        "fields": [{"fieldId": "name", "type": "string", "required": True, "maxLength": 80}],
        "submitKey": "one.location.circle_name.submit",
    }


def _safe_navigation_directive(capability_id: str) -> dict[str, str] | None:
    """Return a compiled, route-only navigation target for a selected action.

    Selection cards intentionally omit routes from the model view. The relay
    re-reads the checked-in graph after selection and emits only a static,
    query-free route already registered for the capability. A client may
    settle this navigation, but it cannot treat the route as proof that a
    product mutation completed.
    """

    try:
        capability = get_capability(capability_id)
    except Exception:  # noqa: BLE001 - stale graph is a safe non-navigation result
        return None
    if not isinstance(capability, Mapping):
        return None
    execution = capability.get("execution")
    execution = execution if isinstance(execution, Mapping) else {}
    target = execution.get("target")
    target = target if isinstance(target, Mapping) else {}
    navigation = capability.get("navigation")
    navigation = navigation if isinstance(navigation, Mapping) else {}
    candidates = [target.get("target"), navigation.get("fallback")]
    routes = navigation.get("routes")
    if isinstance(routes, list):
        candidates.extend(routes)
    for raw in candidates:
        route = str(raw or "").strip()
        if not _SAFE_LOCATION_ROUTE_RE.fullmatch(route):
            continue
        return {
            "schemaVersion": "one.location_navigation_directive.v1",
            "capabilityId": capability_id,
            "route": route,
            "settlement": "route_settlement_required",
        }
    return None


def _verified_status_card(action_id: str) -> dict[str, str] | None:
    """Return the display-only card contract for an audited settlement.

    This is deliberately an identifier-only data card. Its static client
    catalog chooses copy and visual treatment, so a model, transcript, or
    backend response can never generate result UI or leak a private Circle
    label. The card does not grant a follow-up action.
    """

    card_id = _VERIFIED_STATUS_CARD_IDS.get(action_id)
    if not card_id:
        return None
    return {
        "schemaVersion": "one.location_command_status_card.v1",
        "surfaceId": "render.data_card",
        "cardId": card_id,
        "actionId": action_id,
        "settlement": "verified",
    }


class LocationCommandRuntime:
    """Resolve one completed transcription through the Location Brain.

    Dependency seams make the trust boundary testable without a database or a
    live model.  Production uses only server-owned managed GCP clients and
    durable Location adapters.
    """

    def __init__(
        self,
        *,
        selector: Selector | None = None,
        semantic_retriever: Callable[..., Mapping[str, Any]] = retrieve_service_brain_candidates,
    ) -> None:
        self._selector = selector or self._select_with_managed_gemini
        self._semantic_retriever = semantic_retriever

    async def _select_with_managed_gemini(
        self,
        routing_text: str,
        projection: Mapping[str, Any],
    ) -> Mapping[str, Any] | None:
        """Ask the governed text alias for one candidate/declared public slots.

        A model failure is an ``ASK`` at the caller.  It never falls back to
        aliases, keywords, or a guessed action id.
        """

        try:
            from google.genai import types as genai_types

            from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

            model = resolve_fleet_model_name("gemini-default")
            client = _build_managed_location_command_text_client(model=model)
            if client is None:
                return None
            candidates = projection.get("candidates")
            if not isinstance(candidates, list):
                return None
            prompt = {
                "instruction": (
                    "Select exactly one candidate_id_or_ASK. Use only candidate ids in "
                    "selection_contract.allowed_values. Return JSON only. Do not explain, "
                    "do not invent actions, and include only declared public string slots."
                ),
                "redacted_command": routing_text,
                "candidates": candidates,
                "selection_contract": projection.get("selection_contract"),
            }
            response = await client.aio.models.generate_content(
                model=model,
                contents=json.dumps(prompt, separators=(",", ":")),
                config=genai_types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0,
                    max_output_tokens=160,
                ),
            )
            text = getattr(response, "text", None)
            parsed = json.loads(text) if isinstance(text, str) and text.strip() else None
            return parsed if isinstance(parsed, Mapping) else None
        except Exception:  # noqa: BLE001 - model/provider detail is not user or telemetry data
            logger.info("location_command_selector_unavailable")
            return None

    async def _active_run(self, *, user_id: str) -> tuple[dict[str, Any] | None, str | None]:
        try:
            policy = get_capability_workflow_revision_policy("workflow.setup.location")
            result = await get_location_onboarding_runtime_service().find_active(
                user_id=user_id,
                graph_revision=policy.current_revision,
                compatible_graph_revisions=policy.compatible_revisions,
                migration_required_graph_revisions=policy.migration_required_revisions,
                rejected_graph_revisions=policy.rejected_revisions,
            )
            return (dict(result) if isinstance(result, Mapping) else None), None
        except (LocationOnboardingAuthorityError, LocationOnboardingConflictError):
            return None, "runtime_unavailable"
        except Exception:  # noqa: BLE001 - never expose store/provider details
            logger.info("location_command_active_run_unavailable")
            return None, "runtime_unavailable"

    async def _start_or_resume_workflow(
        self,
        *,
        user_id: str,
        context_revision: str,
    ) -> tuple[dict[str, Any] | None, str | None]:
        try:
            policy = get_capability_workflow_revision_policy("workflow.setup.location")
            result = await get_location_onboarding_runtime_service().start_or_resume(
                user_id=user_id,
                graph_revision=policy.current_revision,
                context_revision=context_revision,
                compatible_graph_revisions=policy.compatible_revisions,
                migration_required_graph_revisions=policy.migration_required_revisions,
                rejected_graph_revisions=policy.rejected_revisions,
            )
            return (dict(result) if isinstance(result, Mapping) else None), None
        except (LocationOnboardingAuthorityError, LocationOnboardingConflictError):
            return None, "runtime_unavailable"
        except Exception:  # noqa: BLE001 - durable runtime details remain private
            logger.info("location_command_workflow_start_unavailable")
            return None, "runtime_unavailable"

    async def _execute_circle(
        self,
        *,
        user_id: str,
        consent_token: str,
        turn_id: str,
        slots: Mapping[str, str],
        context_revision: str = "",
    ) -> LocationCommandResultV1:
        name = " ".join(str(slots.get("name") or "").split())[:160]
        if not consent_token:
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="blocked",
                action_id="location.create_circle",
                reason_code="consent_required",
            )
        if not name:
            # Missing free-form input is a durable, approved typed form --
            # never a conversational question. The form lease binds owner,
            # run revision, graph/context revisions and expiry before the
            # existing audited Circle adapter can receive a name.
            try:
                issued = await get_location_circle_name_interaction_service().issue(
                    user_id=user_id,
                    context_revision=context_revision,
                )
                directive = _safe_circle_name_directive(issued.wire_projection())
            except LocationCircleNameConflictError:
                return LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    action_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                    reason_code="circle_name_request_changed",
                )
            except LocationCircleNameAuthorityError:
                return LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    action_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                    reason_code="circle_name_form_unavailable",
                )
            except Exception:  # noqa: BLE001 - form/storage details stay private
                logger.info("location_command_circle_name_form_unavailable")
                return LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    action_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                    reason_code="circle_name_form_unavailable",
                )
            if directive is None:
                return LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    action_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                    reason_code="circle_name_form_unavailable",
                )
            record_runtime_milestone(
                "interaction_rendered",
                action_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                status="issued",
            )
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="interaction_required",
                action_id=LOCATION_CIRCLE_NAME_ACTION_ID,
                circle_name_directive=directive,
            )
        resume_run_id, replay_error = await _find_recent_circle_replay_run_id(
            user_id=user_id,
            name=name,
        )
        if replay_error:
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="failed",
                action_id="location.create_circle",
                reason_code=replay_error,
            )
        execution_scope = _derive_circle_execution_scope(user_id=user_id, name=name)
        if execution_scope is None:
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="failed",
                action_id="location.create_circle",
                reason_code="idempotency_unavailable",
            )
        try:
            # This pre-existing audited adapter revalidates the owner token,
            # uses a durable idempotency run, and verifies its backend result.
            # Crucially, its invocation scope is derived from server-owned
            # action facts rather than the client transport turn id, so a
            # lost response/reconnect resolves to the original run.
            # `typed_input` is its existing non-conversational server entrypoint;
            # no ADK Live tool or browser action proposal participates here.
            result = await _dispatch_circle_server_direct(
                user_id=user_id,
                consent_token=consent_token,
                name=name,
                execution_scope=execution_scope,
                resume_run_id=resume_run_id,
            )
        except Exception:  # noqa: BLE001 - backend detail stays server-side
            logger.info("location_command_circle_execution_failed")
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="failed",
                action_id="location.create_circle",
                reason_code="execution_unavailable",
            )
        status = str(result.get("status") or "") if isinstance(result, Mapping) else ""
        if status == "completed":
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="execute_started",
                action_id="location.create_circle",
                status_card=_verified_status_card("location.create_circle"),
                settlement="verified",
            )
        if status in {"input_needed", "invalid_slots"}:
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="ask",
                action_id="location.create_circle",
                reason_code="missing_required_slot"
                if status == "input_needed"
                else "invalid_slots",
            )
        if status in {"blocked", "paused"}:
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="blocked",
                action_id="location.create_circle",
                reason_code="execution_blocked",
            )
        return LocationCommandResultV1(
            turn_id=turn_id,
            outcome="failed",
            action_id="location.create_circle",
            reason_code="execution_failed",
        )

    async def plan(
        self,
        *,
        turn_id: str,
        transcript: str,
        user_id: str | None,
    ) -> LocationCommandPlanV1:
        """Build a bounded, side-effect-free plan from a final transcript.

        This is the only portion of a Location command which is safe to put
        behind a relay routing deadline.  It reads authoritative state and
        performs semantic retrieval/selection, but does not create a run,
        invoke a native/backend adapter, navigate, or render a card.
        """

        owner = str(user_id or "").strip()
        if not owner:
            return LocationCommandPlanV1(
                turn_id=turn_id,
                immediate_result=LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="blocked",
                    reason_code="authentication_required",
                ),
            )
        active_run, active_error = await self._active_run(user_id=owner)
        if active_error:
            return LocationCommandPlanV1(
                turn_id=turn_id,
                immediate_result=LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    reason_code=active_error,
                ),
            )
        active_workflow: dict[str, Any] | None = None
        if active_run is not None:
            try:
                active_workflow = {
                    "workflow_id": str(active_run.get("workflow_id") or "workflow.setup.location"),
                    "workflow_version": int(active_run.get("workflow_version") or 0),
                    "step_id": str(active_run.get("step") or ""),
                    "status": str(active_run.get("status") or ""),
                }
            except (TypeError, ValueError):
                return LocationCommandPlanV1(
                    turn_id=turn_id,
                    immediate_result=LocationCommandResultV1(
                        turn_id=turn_id,
                        outcome="failed",
                        reason_code="runtime_unavailable",
                    ),
                )
        try:
            snapshot = build_location_brain_snapshot(
                runtime_facts=_facts_from_active_run(active_run),
                active_run=active_workflow,
            )
        except (TypeError, ValueError):
            return LocationCommandPlanV1(
                turn_id=turn_id,
                immediate_result=LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    reason_code="brain_unavailable",
                ),
            )
        # This is the only representation that may reach a managed embedding
        # or selector. It is derived from the checked-in brain vocabulary and
        # replaces every free-form transcript value with a static marker.
        model_routing_intent = build_location_brain_model_routing_intent(transcript)
        retrieval = await asyncio.to_thread(
            self._semantic_retriever,
            query=model_routing_intent,
            snapshot=snapshot,
            limit=6,
        )
        if not isinstance(retrieval, Mapping) or retrieval.get("retrieval_status") != "READY":
            record_runtime_milestone("candidate_retrieval", status="ask")
            return LocationCommandPlanV1(
                turn_id=turn_id,
                immediate_result=LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="ask",
                    reason_code=str(
                        retrieval.get("reason_code")
                        if isinstance(retrieval, Mapping)
                        else "retrieval_unavailable"
                    ),
                ),
            )
        projection = {
            key: retrieval.get(key)
            for key in (
                "schema_version",
                "graph_revision",
                "brain_revision",
                "context_revision",
                "candidates",
                "selection_contract",
            )
        }
        selection = await self._selector(model_routing_intent, projection)
        selected = validate_location_brain_selection(
            projection,
            selection.get("candidate_id_or_ASK") if isinstance(selection, Mapping) else "ASK",
        )
        if selected == "ASK":
            return LocationCommandPlanV1(
                turn_id=turn_id,
                immediate_result=LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="ask",
                    reason_code="selection_required",
                ),
            )
        candidates = projection.get("candidates")
        candidate = next(
            (
                item
                for item in candidates or []
                if isinstance(item, Mapping) and item.get("candidate_id") == selected
            ),
            None,
        )
        if not isinstance(candidate, Mapping):
            return LocationCommandPlanV1(
                turn_id=turn_id,
                immediate_result=LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="ask",
                    reason_code="selection_required",
                ),
            )
        # The constrained selector may choose only a candidate. Private or
        # free-form values are extracted by the server-owned adapter below,
        # never returned by Gemini as a model-produced slot.
        slots = _extract_server_owned_slots(selected, transcript)
        return LocationCommandPlanV1(
            turn_id=turn_id,
            selected_capability_id=selected,
            disposition=str(candidate.get("disposition") or ""),
            slots=slots or None,
        )

    async def advance(
        self,
        plan: LocationCommandPlanV1,
        *,
        user_id: str | None,
        consent_token: str | None,
        context_revision: str | None,
    ) -> LocationCommandResultV1:
        """Advance one server-produced plan through its safe outcome.

        Durable branches are deliberately outside the relay's semantic-routing
        deadline.  The caller first claims the turn, then waits for this
        method's audited adapter/settlement result or relies on its existing
        durable replay boundary after a disconnected client.
        """

        if plan.immediate_result is not None:
            return plan.immediate_result
        turn_id = str(plan.turn_id or "").strip()
        selected = str(plan.selected_capability_id or "").strip()
        if not turn_id or not selected:
            return LocationCommandResultV1(
                turn_id=turn_id or "unknown_turn",
                outcome="failed",
                reason_code="plan_unavailable",
            )
        owner = str(user_id or "").strip()
        if not owner:
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="blocked",
                reason_code="authentication_required",
            )
        slots = dict(plan.slots or {})
        if selected in {
            "workflow.setup.location",
            "native.request_device_location_permission",
            "location.onboarding.choose_place",
        }:
            revision = str(context_revision or "").strip()
            if not _CONTEXT_REVISION_RE.fullmatch(revision):
                revision = ""
            run, run_error = await self._start_or_resume_workflow(
                user_id=owner,
                context_revision=revision,
            )
            if run is None:
                return LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="failed",
                    action_id="workflow.setup.location",
                    reason_code=run_error or "runtime_unavailable",
                )
            directive = _safe_interaction_directive(run.get("interaction"))
            safe_run = _safe_run_projection(run, directive=directive)
            outcome = "interaction_required" if directive is not None else "execute_started"
            if directive is not None:
                record_runtime_milestone(
                    "interaction_rendered", action_id="workflow.setup.location", status="issued"
                )
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome=outcome,
                action_id="workflow.setup.location",
                run=safe_run,
                directive=directive,
                status_card=(
                    _verified_status_card("workflow.setup.location")
                    if run.get("completion_claim_allowed") is True
                    else None
                ),
                settlement="verified" if run.get("completion_claim_allowed") is True else None,
            )
        if selected == "location.create_circle":
            revision = str(context_revision or "").strip()
            if not _CONTEXT_REVISION_RE.fullmatch(revision):
                revision = ""
            return await self._execute_circle(
                user_id=owner,
                consent_token=str(consent_token or "").strip(),
                turn_id=turn_id,
                slots=slots,
                context_revision=revision,
            )
        disposition = str(plan.disposition or "")
        if disposition == "NAVIGATE":
            navigation = _safe_navigation_directive(selected)
            if navigation is None:
                return LocationCommandResultV1(
                    turn_id=turn_id,
                    outcome="blocked",
                    action_id=selected,
                    reason_code="navigation_unavailable",
                )
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="navigate",
                action_id=selected,
                reason_code="registered_navigation",
                navigation=navigation,
            )
        if disposition == "RENDER_INTERACTION":
            # Location's currently approved non-workflow interaction is the
            # run-bound place picker handled above. Do not emit a status-only
            # RENDER outcome when no issued, typed card is available.
            return LocationCommandResultV1(
                turn_id=turn_id,
                outcome="blocked",
                action_id=selected,
                reason_code="interaction_unavailable",
            )
        return LocationCommandResultV1(
            turn_id=turn_id,
            outcome="blocked",
            action_id=selected,
            reason_code="unbound_or_unsupported",
        )

    async def resolve(
        self,
        *,
        turn_id: str,
        transcript: str,
        user_id: str | None,
        consent_token: str | None,
        context_revision: str | None,
    ) -> LocationCommandResultV1:
        """Compatibility wrapper for non-relay callers and focused tests.

        The command relay calls :meth:`plan` and :meth:`advance` separately so
        only side-effect-free selection has a bounded deadline.  Existing
        entrypoints retain the old one-call contract while following the same
        plan/advance implementation.
        """

        plan = await self.plan(
            turn_id=turn_id,
            transcript=transcript,
            user_id=user_id,
        )
        return await self.advance(
            plan,
            user_id=user_id,
            consent_token=consent_token,
            context_revision=context_revision,
        )


_runtime: LocationCommandRuntime | None = None


def get_location_command_runtime() -> LocationCommandRuntime:
    global _runtime
    if _runtime is None:
        _runtime = LocationCommandRuntime()
    return _runtime


__all__ = [
    "DEFAULT_LOCATION_COMMAND_TRANSCRIBE_MODEL",
    "LOCATION_COMMAND_PROTOCOL_VERSION",
    "LOCATION_COMMAND_RUNTIME_ENABLED_ENV",
    "LocationCommandPlanV1",
    "LocationCommandResultV1",
    "LocationCommandRuntime",
    "LocationCommandTurnGate",
    "LocationCommandTurnV1",
    "get_location_command_runtime",
    "location_command_runtime_enabled",
    "location_command_transcribe_model_id",
]
