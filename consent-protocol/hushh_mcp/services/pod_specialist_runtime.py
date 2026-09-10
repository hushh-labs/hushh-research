"""Turn-owned dependencies for the existing in-process specialist fleet.

Model execution and conversation persistence stay in the pod. Location reads
currently use the existing scoped broker; this is transitional information
access, not proof of the ledger's zero-hub-read assertion. Missing adapters fail
closed instead of constructing shared-runtime services.
"""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.adk_bridge.dispatch import SpecialistRuntime
from hushh_mcp.services.pod_agent_chat_store import PodAgentChatStore
from hushh_mcp.services.pod_consent_client import require_owner_scope


class PodLocationReadPort:
    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    def list_state(self, *, user_id: str) -> dict:
        if user_id != self._owner:
            raise PermissionError("Location owner mismatch")
        from hushh_mcp.services.pod_hub_client import PodHubClient

        state = PodHubClient().read_specialist("location", self._scope_token)
        if not isinstance(state, dict):
            raise RuntimeError("Location read unavailable")
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
        from hushh_mcp.services.pod_hub_client import PodHubClient

        state = await asyncio.to_thread(PodHubClient().read_specialist, "nav", self._scope_token)
        page = state.get(surface)
        if not isinstance(page, dict) or not isinstance(page.get("items"), list):
            raise RuntimeError("Consent-center read unavailable")
        return {**page, "items": page["items"][: max(1, min(top, 10))]}


class PodMarketplaceReadPort:
    """Owner publication metadata only; no marketplace mutation authority."""

    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    async def _read(self, user_id: str, **options: Any) -> dict:
        if user_id != self._owner:
            raise PermissionError("Marketplace owner mismatch")
        from hushh_mcp.services.pod_hub_client import PodHubClient
        from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions

        validated = MarketplaceReadOptions.model_validate(options)
        return await asyncio.to_thread(
            PodHubClient().read_specialist,
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
        from hushh_mcp.services.pod_hub_client import PodHubClient

        query = EmailReadOptions.model_validate(options)
        return await asyncio.to_thread(
            PodHubClient().read_specialist,
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
) -> SpecialistRuntime:
    # Construction does no storage/provider I/O. Admission precedes resolution.
    log: Any = None
    client: Any = None

    async def require_access() -> None:
        verdict = await require_owner_scope(
            consent_token, expected_scope="pkm.read", user_id=user_id
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
                timeout=30,
            )
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
