"""Turn-owned dependencies for the existing in-process specialist fleet.

Model execution and conversation persistence stay in the pod. Location reads
currently use the existing scoped broker; this is transitional information
access, not proof of the ledger's zero-hub-read assertion. Missing adapters fail
closed instead of constructing shared-runtime services.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.adk_bridge.dispatch import SpecialistRuntime
from hushh_mcp.runtime_providers.puppy_transport import PuppyCapabilityUnsupported
from hushh_mcp.services.pod_agent_chat_store import PodAgentChatStore
from hushh_mcp.services.pod_consent_client import require_owner_scope


class PodSpecialistCapabilityUnsupported(PuppyCapabilityUnsupported):
    """A specialist's model call asked the owner's device for a capability it lacks.

    Typed, and a subclass of the transport's refusal, so One's tool layer can name
    the outcome (``status: unsupported``) instead of folding it into the generic
    "specialist runtime failed" that would send the person to retry something
    that cannot succeed on this device.
    """


class PodSpecialistInformationUnavailable(RuntimeError):
    """A hub information door this specialist reads through could not be read.

    Typed so the failure is attributable to the door (and recorded on the
    dependency trace) rather than surfacing as an empty state the specialist would
    then narrate as fact: "you share with nobody" for a person who shares with many.
    """

    def __init__(self, door: str) -> None:
        super().__init__(f"Pod specialist information door unavailable: {door}")
        self.door = door


@dataclass
class SpecialistDependencyTrace:
    """What one specialist turn actually leaned on, counted as it happened.

    The ledger item ``specialists-run-in-pod`` requires
    ``hub_specialist_information_reads <= 0``, and until this existed nothing
    produced that number: every hub-door read was invisible to the turn response,
    so a receipt could only assert the count by hand. The trace is bound for the
    duration of one dispatch and records reads, consent verifications, doors that
    were unreachable and a capability the device refused. The turn response
    carries the result per specialist, and the parity probe derives the ledger
    observations from it rather than asserting them.
    """

    hub_reads: int = 0
    consent_verifies: int = 0
    doors_read: list[str] = field(default_factory=list)
    unavailable_doors: list[str] = field(default_factory=list)
    unsupported_capability: str = ""

    def record_hub_read(self, door: str) -> None:
        self.hub_reads += 1
        self.doors_read.append(door)

    def record_unavailable(self, door: str) -> None:
        self.unavailable_doors.append(door)

    def record_consent_verify(self) -> None:
        self.consent_verifies += 1

    def record_unsupported(self, capability: str) -> None:
        self.unsupported_capability = capability or "requested capability"

    @property
    def information_source(self) -> str:
        if self.unsupported_capability:
            return "unsupported"
        if self.unavailable_doors:
            return "unavailable"
        if self.hub_reads:
            return "hub_door"
        return "none"

    @property
    def reason(self) -> str:
        if self.unsupported_capability:
            return "provider_capability_unsupported"
        if self.unavailable_doors:
            return "hub_information_unavailable"
        return ""

    def payload(self) -> dict[str, Any]:
        """Shape, never content: counts, door names and state words."""
        return {
            "execution": "pod",
            "information_source": self.information_source,
            "hub_reads": self.hub_reads,
            "consent_verifies": self.consent_verifies,
            "doors": sorted(set(self.doors_read)),
            "unavailable_doors": sorted(set(self.unavailable_doors)),
            "reason": self.reason,
        }


_TRACE: ContextVar[SpecialistDependencyTrace | None] = ContextVar(
    "pod_specialist_dependency_trace", default=None
)


def current_dependency_trace() -> SpecialistDependencyTrace | None:
    return _TRACE.get()


@contextmanager
def trace_specialist_dependencies(
    trace: SpecialistDependencyTrace | None = None,
) -> Iterator[SpecialistDependencyTrace]:
    """Bind a trace for one dispatch. ``asyncio.to_thread`` copies the context, so
    the ports record onto the same object from their worker threads."""
    active = trace if trace is not None else SpecialistDependencyTrace()
    token = _TRACE.set(active)
    try:
        yield active
    finally:
        _TRACE.reset(token)


def _hub_read(door: str, scope_token: str, **options: Any) -> dict[str, Any]:
    """The one place a port reads a hub information door, so every read is counted
    and every failure is typed. Constructed here, after the owner check in the
    calling port, so a foreign owner never reaches the hub at all."""
    from hushh_mcp.services.pod_hub_client import PodHubClient, PodHubUnavailable

    trace = _TRACE.get()
    if trace is not None:
        trace.record_hub_read(door)
    try:
        return PodHubClient().read_specialist(door, scope_token, **options)
    except PodHubUnavailable as exc:
        if trace is not None:
            trace.record_unavailable(door)
        raise PodSpecialistInformationUnavailable(door) from exc


# Specialist model calls run inside One's turn and share its budget. The generic
# bound stays at 30 seconds; a local Puppy model has a measured cold first token
# above that (32.9 seconds on the owner pilot), so the Puppy lane receives the
# same first-event budget One's own turn already grants it.
_SPECIALIST_MODEL_TIMEOUT_SECONDS = 30.0
_PUPPY_SPECIALIST_MODEL_TIMEOUT_SECONDS = 60.0


def specialist_model_timeout_seconds(runtime_mode: str | None) -> float:
    """Model-call budget for one specialist turn, by runtime mode."""
    if str(runtime_mode or "").strip().lower() == "puppy_relay":
        return _PUPPY_SPECIALIST_MODEL_TIMEOUT_SECONDS
    return _SPECIALIST_MODEL_TIMEOUT_SECONDS


def _declare(
    *,
    executes_in_pod: bool,
    information_source: str,
    write_scope: str,
    confirmation_owner: str,
    why: str,
) -> dict[str, Any]:
    return {
        "executes_in_pod": executes_in_pod,
        "information_source": information_source,
        "write_scope": write_scope,
        "confirmation_owner": confirmation_owner,
        "why": why,
    }


_HUB_ONLY = "Registered on the hub with no owner adapter; service_for refuses it in the pod."

#: What each authored product agent may do inside an owner's pod, DECLARED here
#: and checked against the runtime source by
#: ``scripts/generate_pod_specialist_capability_matrix.py``. One row per manifest
#: in ``hushh_mcp/agents/*/agent.yaml``; the generator refuses a table that
#: disagrees with ``service_for`` or with which ports read the hub. Vocabulary:
#: ``information_source`` is ``pkm_projection`` (the head's couriered grounding),
#: ``hub_door`` (a counted read through the hub information door), ``none`` (no
#: information read in the pod) or ``hub`` (does not execute in the pod at all);
#: ``write_scope`` is ``none``, ``proposal_only`` or ``confirmed_action``;
#: ``confirmation_owner`` is who confirms a write: ``owner_browser``, ``owner``,
#: ``none`` or ``hub``. Hub-owned capabilities stay hub-owned here; a manifest is
#: not a claim of pod execution.
POD_SPECIALIST_EXECUTION: dict[str, dict[str, Any]] = {
    "agent_one": _declare(
        executes_in_pod=True,
        information_source="pkm_projection",
        write_scope="proposal_only",
        confirmation_owner="owner_browser",
        why=(
            "The routing head runs in the pod turn route, grounded on the couriered "
            "PKM projection or the pod replica; it proposes directives the hub relay "
            "re-validates before any card renders."
        ),
    ),
    "agent_location": _declare(
        executes_in_pod=True,
        information_source="hub_door",
        write_scope="proposal_only",
        confirmation_owner="owner_browser",
        why=(
            "The shared LocationChatService runs in the pod with pod ports; sharing "
            "state is read through the location door, and a public link is only "
            "proposed for the browser's owner-confirmation card."
        ),
    ),
    "agent_nav": _declare(
        executes_in_pod=True,
        information_source="hub_door",
        write_scope="none",
        confirmation_owner="none",
        why="Consent Center pages are read through the nav door; no mutation in the pod.",
    ),
    "agent_personal_information": _declare(
        executes_in_pod=True,
        information_source="hub_door",
        write_scope="none",
        confirmation_owner="none",
        why=(
            "Publication metadata and earnings are read through the marketplace door; "
            "the PKM replica has no production feed yet, so no owner-local read exists."
        ),
    ),
    "agent_email": _declare(
        executes_in_pod=True,
        information_source="hub_door",
        write_scope="none",
        confirmation_owner="none",
        why="Read-only nudges and inbox search through the email door; no send authority.",
    ),
    "agent_connected_systems": _declare(
        executes_in_pod=True,
        information_source="none",
        write_scope="none",
        confirmation_owner="hub",
        why=(
            "The A2A wrapper is constructed in the pod but refuses without task-specific "
            "authority; CRM connections and records stay on the hub."
        ),
    ),
    "agent_calendar": _declare(
        executes_in_pod=False,
        information_source="hub_door",
        write_scope="none",
        confirmation_owner="hub",
        why=(
            "Not dispatched in the pod: One's calendar tools render upcoming events "
            "deterministically through the calendar door; proposals need the hub."
        ),
    ),
    "agent_connections": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why=_HUB_ONLY,
    ),
    "agent_kai": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="Financial analysis needs the consented projection service; hub only today.",
    ),
    "agent_kyc": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="Identity verification writes vault records through the hub; not in the pod.",
    ),
    "agent_gmail": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="Connected-account OAuth tokens live on the hub; the pod holds no credential.",
    ),
    "agent_wallet": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="Wallet vault records and reveals are hub-confirmed actions; not in the pod.",
    ),
    "agent_onboarding": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="First-run guidance runs on the hub before a pod exists.",
    ),
    "agent_financial_guard": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why=_HUB_ONLY,
    ),
    "agent_memory_intent": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="PKM structuring sub-chain; hub-only and browser-gated today.",
    ),
    "agent_memory_merge": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="PKM structuring sub-chain; hub-only and browser-gated today.",
    ),
    "agent_memory_segmentation": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="PKM structuring sub-chain; hub-only and browser-gated today.",
    ),
    "agent_pkm_structure": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="PKM structuring sub-chain; hub-only and browser-gated today.",
    ),
    "agent_portfolio_import": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="Portfolio import writes holdings through the hub; not in the pod.",
    ),
    "agent_summary_reducer": _declare(
        executes_in_pod=False,
        information_source="hub",
        write_scope="none",
        confirmation_owner="hub",
        why="PKM structuring sub-chain; hub-only and browser-gated today.",
    ),
}


class PodLocationReadPort:
    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    def list_state(self, *, user_id: str) -> dict:
        if user_id != self._owner:
            raise PermissionError("Location owner mismatch")
        state = _hub_read("location", self._scope_token)
        if not isinstance(state, dict):
            raise PodSpecialistInformationUnavailable("location")
        return state

    def revoke_public_invite(self, **kwargs: Any) -> dict:
        raise PermissionError("Use the owner-confirmed Location controls to revoke this link")

    def refer_recipient(self, **kwargs: Any) -> dict:
        raise PermissionError("Use the owner-confirmed Location controls for this referral")


class PodConsentCenterReadPort:
    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    async def list_center(self, user_id: str, *, actor: str, surface: str, top: int) -> dict:
        if user_id != self._owner or actor != "investor" or surface not in {"active", "previous"}:
            raise PermissionError("Consent-center read scope denied")
        state = await asyncio.to_thread(_hub_read, "nav", self._scope_token)
        page = state.get(surface)
        if not isinstance(page, dict) or not isinstance(page.get("items"), list):
            raise PodSpecialistInformationUnavailable("nav")
        return {**page, "items": page["items"][: max(1, min(top, 10))]}


class PodMarketplaceReadPort:
    """Owner publication metadata only; no marketplace mutation authority."""

    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    async def _read(self, user_id: str, **options: Any) -> dict:
        if user_id != self._owner:
            raise PermissionError("Marketplace owner mismatch")
        from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions

        validated = MarketplaceReadOptions.model_validate(options)
        return await asyncio.to_thread(
            _hub_read,
            "marketplace",
            self._scope_token,
            marketplace_read=validated.model_dump(),
        )

    async def list_published_slices(self, *, user_id: str) -> list[dict]:
        return (await self._read(user_id, operation="published"))["items"]

    async def list_publishable_slices(
        self, *, user_id: str, topic: str | None = None
    ) -> list[dict]:
        return (await self._read(user_id, operation="publishable", topic=topic))["items"]

    async def earnings_summary(self, *, user_id: str, power: str, mood: str) -> dict:
        return (await self._read(user_id, operation="earnings", power=power, mood=mood))["result"]


class PodEmailReadPort:
    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    async def _read(self, user_id: str, **options: Any) -> dict:
        if user_id != self._owner:
            raise PermissionError("Email owner mismatch")
        from hushh_mcp.services.pod_email_read import EmailReadOptions

        query = EmailReadOptions.model_validate(options)
        return await asyncio.to_thread(
            _hub_read,
            "email",
            self._scope_token,
            email_read=query.model_dump(),
        )

    async def list_nudges(self, *, user_id: str, limit: int = 10) -> dict:
        return await self._read(user_id, operation="nudges", limit=limit)

    async def search_inbox(self, *, user_id: str, query: str, limit: int = 10) -> list[dict]:
        return (await self._read(user_id, operation="search", query=query, limit=limit))["results"]


def build_pod_specialist_runtime(
    *,
    user_id: str,
    hushh_id: str,
    consent_token: str,
    provider: str,
    model: str,
    runtime_mode: str,
    credential: str | None,
    credential_transport: Any,
    vertex_project: str | None,
    vertex_location: str | None,
    data_door_grants: dict[str, str],
    puppy_device_id: str | None = None,
    verifier: Any = None,
) -> SpecialistRuntime:
    # Construction does no storage/provider I/O. Admission precedes resolution.
    # ``verifier`` is the second consent seam: a turn admitted by the pod's own
    # session authority threads its local verifier here, so a specialist re-checks
    # the owner against the pod's tombstones rather than asking the hub. None keeps
    # the hub-verified path exactly as it was.
    log: Any = None
    client: Any = None

    async def require_access() -> None:
        trace = _TRACE.get()
        if trace is not None:
            trace.record_consent_verify()
        verdict = await require_owner_scope(
            consent_token, expected_scope="pkm.read", user_id=user_id, verifier=verifier
        )
        if verdict.hushh_id != hushh_id:
            raise PermissionError("Pod invocation owner mismatch")
        if log is not None:
            if getattr(log, "_owner_id", None) != hushh_id:
                raise PermissionError("Pod storage owner mismatch")
            await log.require_open()

    async def model_call(contents: Any, config: Any) -> Any:
        nonlocal client
        await require_access()
        if client is None:
            from hushh_mcp.runtime_providers.factory import (
                build_managed_runtime_client,
                build_runtime_client,
            )

            if runtime_mode in {"byok", "puppy_relay"}:
                client = build_runtime_client(
                    provider,
                    credential or "",
                    gemini_byok_transport=credential_transport,
                    vertex_project=vertex_project,
                    vertex_location=vertex_location,
                    puppy_device_id=puppy_device_id,
                )
            elif runtime_mode in {"user_adc", "hushh_managed_vertex"} and not credential:
                client = build_managed_runtime_client(provider)
            else:
                raise RuntimeError("Pod model authority unavailable")
        try:
            result = await asyncio.wait_for(
                client.aio.models.generate_content(model=model, contents=contents, config=config),
                timeout=specialist_model_timeout_seconds(runtime_mode),
            )
        except PuppyCapabilityUnsupported as exc:
            # Not "unavailable": the device answered and said no to a capability.
            trace = _TRACE.get()
            if trace is not None:
                trace.record_unsupported(exc.capability)
            raise PodSpecialistCapabilityUnsupported(exc.capability) from None
        except Exception:
            raise RuntimeError("Pod specialist provider unavailable") from None
        await require_access()
        return result

    async def service_for(agent_id: str) -> Any:
        nonlocal log
        await require_access()
        if agent_id == "agent_nav":
            from hushh_mcp.adk_bridge.nav_agent import NavAgent

            return NavAgent(
                service=PodConsentCenterReadPort(user_id, data_door_grants.get("nav", ""))
            )
        if agent_id == "agent_connected_systems":
            from hushh_mcp.adk_bridge.connected_systems_agent import ConnectedSystemsAgentA2A

            return ConnectedSystemsAgentA2A()
        # Never substitute a hub singleton when an owner adapter is absent.
        if agent_id not in {"agent_location", "agent_personal_information", "agent_email"}:
            raise RuntimeError("Pod specialist information adapter unavailable")
        if log is None:
            from hushh_mcp.services.pod_memory_service import _resolve_log

            log = _resolve_log()
        if log is None:
            raise RuntimeError("Pod conversation persistence unavailable")
        await require_access()
        from google.genai import types

        if agent_id == "agent_email":
            from hushh_mcp.adk_bridge.email_agent import EmailAgentA2A
            from hushh_mcp.services.email_chat_service import EmailChatService

            async def email_access() -> None:
                await require_access()
                verdict = await require_owner_scope(
                    data_door_grants.get("email", ""),
                    expected_scope="cap.email.inbox.view",
                    user_id=user_id,
                )
                if verdict.hushh_id != hushh_id:
                    raise PermissionError("Email pod owner mismatch")

            async def authorize_email(task: Any) -> None:
                if task.user_id != user_id:
                    raise PermissionError("Email owner mismatch")
                await email_access()

            async def email_model(contents: Any, config: Any) -> Any:
                await email_access()
                result = await model_call(contents, config)
                await email_access()
                return result

            return EmailAgentA2A(
                require_read=authorize_email,
                service=EmailChatService(
                    chat_store=PodAgentChatStore(
                        owner_user_id=user_id,
                        hushh_id=hushh_id,
                        log=log,
                        require_access=email_access,
                        agent_id=agent_id,
                        model=model,
                    ),
                    gmail_service=PodEmailReadPort(user_id, data_door_grants.get("email", "")),
                    model_call=email_model,
                    genai_types=types,
                ),
            )

        if agent_id == "agent_personal_information":
            from hushh_mcp.services.information_chat_service import InformationChatService

            return InformationChatService(
                chat_store=PodAgentChatStore(
                    owner_user_id=user_id,
                    hushh_id=hushh_id,
                    log=log,
                    require_access=require_access,
                    agent_id=agent_id,
                    model=model,
                ),
                model_call=model_call,
                genai_types=types,
                service_ports={
                    "marketplace_information": PodMarketplaceReadPort(
                        user_id, data_door_grants.get("marketplace", "")
                    ),
                },
                scope_tokens={"cap.pkm.marketplace.view": data_door_grants.get("marketplace", "")},
            )

        from hushh_mcp.services.location_chat_service import LocationChatService

        return LocationChatService(
            chat_store=PodAgentChatStore(
                owner_user_id=user_id,
                hushh_id=hushh_id,
                log=log,
                require_access=require_access,
                agent_id=agent_id,
                model=model,
            ),
            model_call=model_call,
            genai_types=types,
            location_service=PodLocationReadPort(user_id, data_door_grants.get("location", "")),
            scope_tokens={
                "cap.location.live.view": data_door_grants.get("location", ""),
                **{
                    scope: data_door_grants[scope]
                    for scope in ("cap.location.live.share", "cap.location.live.refer_request")
                    if data_door_grants.get(scope)
                },
            },
        )

    return SpecialistRuntime(user_id, require_access, service_for)
