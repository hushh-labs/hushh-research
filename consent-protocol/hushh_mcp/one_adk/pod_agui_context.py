"""Request-owned dependencies for direct, encrypted One chat in an owner pod."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any

from fastapi import HTTPException

from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.pod_adk_session_repository import (
    PodAdkSessionProjection,
    PodAdkSessionRepository,
)
from hushh_mcp.services.chat_key import bind_request_chat_key_owner, request_has_chat_key

_projection: PodAdkSessionProjection | None = None


class PodChatContext:
    def __init__(self, authorization: str | None, *, needs_key: bool = True) -> None:
        from api.routes.one.pod_session import verified_session
        from hushh_mcp.services.pod_memory_service import _resolve_log
        from hushh_mcp.services.pod_session_authority import ROLE_APP, SCOPE_PKM_READ

        self.authorization = authorization
        self.authority, self.claims = verified_session(
            authorization, role=ROLE_APP, scope=SCOPE_PKM_READ
        )
        self.owner = str(self.claims.get("user_id") or "")
        self.hushh_id = str(self.claims.get("hushh_id") or "")
        if not self.owner or not self.hushh_id or self.hushh_id != os.environ.get("HUSSH_ID"):
            raise HTTPException(403, detail={"code": "POD_CHAT_OWNER_MISMATCH"})
        global _projection
        self.log = _projection.log if _projection is not None else _resolve_log()
        if self.log is None or self.log._owner_id != self.hushh_id:
            raise HTTPException(503, detail={"code": "POD_CHAT_RECOVERY_UNAVAILABLE"})
        bind_request_chat_key_owner(self.owner)
        if needs_key and not request_has_chat_key(self.owner):
            raise HTTPException(403, detail={"code": "CHAT_KEY_REQUIRED"})
        if _projection is None:
            _projection = PodAdkSessionProjection(
                owner_id=self.owner, hushh_id=self.hushh_id, log=self.log
            )
        if _projection.owner_id != self.owner or _projection.hushh_id != self.hushh_id:
            raise HTTPException(403, detail={"code": "POD_CHAT_OWNER_MISMATCH"})
        self.sessions = EncryptedAdkSessionService(
            repository=PodAdkSessionRepository(
                projection=_projection, require_access=self.require_access
            )
        )
        self.runtime: Any = None

    async def require_access(self) -> None:
        from api.routes.one.pod_session import verified_session
        from hushh_mcp.services.pod_session_authority import ROLE_APP, SCOPE_PKM_READ

        authority, claims = verified_session(
            self.authorization, role=ROLE_APP, scope=SCOPE_PKM_READ
        )
        if authority is not self.authority or claims != self.claims:
            raise HTTPException(403, detail={"code": "POD_CHAT_SESSION_CHANGED"})
        await authority.require_held()
        await self.log.require_open()

    async def _files_access(self, *, manage: bool = False) -> None:
        from api.routes.one.pod_session import verified_session
        from hushh_mcp.services.pod_session_authority import ROLE_APP

        await self.require_access()
        verified_session(
            self.authorization, role=ROLE_APP, scope="files.manage" if manage else "files.read"
        )

    async def _files_manage(self) -> None:
        await self._files_access(manage=True)

    async def _mcp_owner_admission(self, context: Any) -> bool:
        from secrets import compare_digest

        from hushh_mcp.one_adk.request_secrets import resolve_request_secret

        await self.require_access()
        return context.user_id == self.owner and compare_digest(
            resolve_request_secret(context.state.get("hussh:consent_token")),
            self.authority.local_token(self.claims),
        )

    @contextmanager
    def runtime_scope(self):
        from hushh_mcp.adk_bridge.dispatch import bind_specialist_runtime
        from hushh_mcp.services.pod_files.runtime import files_access

        if self.runtime is None:
            raise RuntimeError("Pod chat runtime is unavailable.")
        with (
            bind_specialist_runtime(self.runtime),
            files_access(self._files_access, manage=self._files_manage),
        ):
            yield

    async def build_agent(self, options: Any):
        from api.routes.one.pod_turn import (
            _require_local_puppy_admission,
            _resolve_model,
            _resolve_runtime_mode,
        )
        from hushh_mcp.one_adk.agent_tree import (
            ONE_APP_NAME,
            _PrivateLiveAccessPlugin,
            build_one_text_agent,
        )
        from hushh_mcp.one_adk.agui_factory import build_authenticated_agui
        from hushh_mcp.one_adk.pod_agui_lifetime import PodTimedADKAgent
        from hushh_mcp.one_adk.text_runtime import _runtime_model
        from hushh_mcp.services.pod_specialist_runtime import build_pod_specialist_runtime

        await self.require_access()
        token = self.authority.local_token(self.claims)
        provider, model = _resolve_model(options)
        if provider == "puppy":
            await _require_local_puppy_admission(
                self.claims,
                str(options.puppy_device_id or ""),
                user_id=self.owner,
                hushh_id=self.hushh_id,
            )
            options = options.model_copy(update={"runtime_credential": token})
        mode = _resolve_runtime_mode(options, provider)
        self.runtime = build_pod_specialist_runtime(
            user_id=self.owner,
            hushh_id=self.hushh_id,
            session_owner_id=self.owner,
            consent_token=token,
            provider=provider,
            model=model,
            runtime_mode=mode,
            credential=options.runtime_credential,
            credential_transport=options.runtime_credential_transport,
            vertex_project=options.vertex_project,
            vertex_location=options.vertex_location,
            data_door_grants=options.data_door_grants or {},
            puppy_device_id=options.puppy_device_id,
            verifier=self.authority.local_verifier(self.claims),
        )
        owner_model = _runtime_model(
            runtime_model=model,
            runtime_provider=provider,
            runtime_mode=mode,
            runtime_credential=options.runtime_credential,
            puppy_device_id=options.puppy_device_id,
            runtime_credential_transport=options.runtime_credential_transport,
            runtime_vertex_project=options.vertex_project,
            runtime_vertex_location=options.vertex_location,
        )
        from hushh_mcp.one_adk.pod_chat_memory import PodChatMemory
        from hushh_mcp.one_adk.text_runtime import _resolve_pod_memory_service

        service = _resolve_pod_memory_service()
        memory = PodChatMemory(self, service) if service is not None else None

        async def prepare(input):
            if memory is not None:
                await memory.prepare(input, model=owner_model, provider=provider, model_id=model)

        agent = build_authenticated_agui(
            build_one_text_agent(
                model=owner_model,
                allow_workspace_tools=False,
                allow_private_mcp=True,
                include_thought_summaries=True,
            ),
            self.sessions,
            app_name=ONE_APP_NAME,
            user_id_extractor=lambda _: self.owner,
            agent_class=PodTimedADKAgent,
            max_concurrent_executions=1,
            memory_service=memory,
            plugins=[_PrivateLiveAccessPlugin(self.require_access)],
        )
        agent.configure_pod_turn(
            require_access=self.require_access,
            runtime_scope=self.runtime_scope,
            before_run=prepare,
            after_run=memory.commit if memory is not None else None,
            mcp_owner_admission=self._mcp_owner_admission,
        )
        return agent
