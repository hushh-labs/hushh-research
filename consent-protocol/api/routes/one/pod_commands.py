"""Direct private interpretation. Checkpoints and effect authority stay on the hub."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager, suppress
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from google.genai.errors import APIError
from pydantic import Field

from api.routes.one.agent_context import sanitize_agent_context
from api.routes.one.pod_session import verified_session
from api.routes.one.pod_turn import PodTurnRequest, _resolve_model, _resolve_runtime_mode
from hushh_mcp.agents.location.command_brain import LocationCommandBrain, _load_transcriber_gene
from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.operons.location.plan import (
    CommandValue,
    LocationCommandStepV2,
    LocationWorkflowStep,
)
from hushh_mcp.operons.location.references import LocationObservation
from hushh_mcp.services.location_command_semantics import assess_semantics
from hushh_mcp.services.pod_command_reads import PodCommandReads
from hushh_mcp.services.pod_consent_client import require_owner_scope
from hushh_mcp.services.pod_hub_client import PodHubUnavailable
from hushh_mcp.services.pod_session_authority import ROLE_APP, PodSessionRefused
from hushh_mcp.services.pod_upgrade_admission import (
    ADMISSION,
    PodUpgradeAdmissionRefused,
    pod_incarnation,
)

router = APIRouter(prefix="/api/one/pod/commands", tags=["personal-agent"])
_slots = asyncio.Semaphore(2)


class CommandModel(CommandValue):
    runtimeCredential: str | None = Field(default=None, max_length=12000, repr=False)
    runtimeCredentialTransport: Literal["developer_api", "vertex_api_key"] = "developer_api"
    runtimeProvider: Literal["puppy"] | None = None
    puppyDeviceId: str | None = Field(default=None, max_length=128)
    vertexProject: str | None = Field(default=None, max_length=64)
    vertexLocation: str | None = Field(default=None, max_length=64)


class AssessRequest(CommandValue):
    query: str = Field(min_length=1, max_length=8192)
    context: dict[str, Any]
    plan_version: Literal["location.plan.v1", "location.plan.v2"] = "location.plan.v2"
    scope_token: str = Field(min_length=1, max_length=4096, repr=False)
    observations: list[LocationObservation] = Field(default_factory=list, max_length=50)
    saved_observations: list[LocationObservation] = Field(default_factory=list, max_length=50)
    completed_steps: list[LocationCommandStepV2 | LocationWorkflowStep] = Field(
        default_factory=list, max_length=12
    )
    model: CommandModel = Field(default_factory=CommandModel)


class TranscribeRequest(CommandValue):
    audio_base64: str = Field(min_length=64, max_length=2_580_000, repr=False)
    model: CommandModel = Field(default_factory=CommandModel)


async def _brain(model: CommandModel, owner: str, token: str, claims: dict) -> LocationCommandBrain:
    from pathlib import Path

    from hushh_mcp.agents.location import command_brain
    from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
    from hushh_mcp.runtime_providers.factory import (
        build_gemini_byok_adk_model,
        build_managed_gemini_adk_model,
        build_managed_runtime_client,
        build_runtime_client,
    )
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    selection = PodTurnRequest(message="private-command", **model.model_dump(exclude_none=True))
    provider, selected_model = _resolve_model(selection)
    if provider == "puppy":
        from api.routes.one.pod_turn import _require_local_puppy_admission
        from hushh_mcp.services.pod_session_authority import active_session_authority

        await _require_local_puppy_admission(
            claims, model.puppyDeviceId or "", user_id=owner, hushh_id=claims["hushh_id"]
        )
        authority = active_session_authority()
        if authority is None:
            raise HTTPException(503, detail={"code": "LOCAL_AUTHORITY_UNAVAILABLE"})
        # Use this verified app session, never a caller-selected owner credential.
        marker = authority.local_token(claims)
        model = model.model_copy(update={"runtimeCredential": marker})
        selection = selection.model_copy(update={"runtime_credential": marker})
    mode = _resolve_runtime_mode(selection, provider)
    manifest = ManifestLoader.load(str(Path(command_brain.__file__).with_name("agent.yaml")))

    def adk(name: str):
        name = resolve_fleet_model_name(name)
        if provider == "gemini":
            if mode == "byok":
                return build_gemini_byok_adk_model(
                    name,
                    model.runtimeCredential or "",
                    transport=model.runtimeCredentialTransport,
                    vertex_project=model.vertexProject,
                    vertex_location=model.vertexLocation,
                )
            return build_managed_gemini_adk_model(name)
        return ProviderAdkModel(
            model=selected_model,
            provider=provider,
            credential=model.runtimeCredential or "",
            device_id=model.puppyDeviceId,
            runtime_mode=mode,
        )

    client = (
        build_runtime_client(
            provider,
            model.runtimeCredential or "",
            gemini_byok_transport=model.runtimeCredentialTransport,
            vertex_project=model.vertexProject,
            vertex_location=model.vertexLocation,
            puppy_device_id=model.puppyDeviceId,
        )
        if mode in {"byok", "puppy_relay"}
        else build_managed_runtime_client(provider)
    )
    return LocationCommandBrain(
        client=client,
        manifest=manifest,
        adk_model=adk(manifest.model_config_for_runtime().name),
        transcriber_adk_model=adk(_load_transcriber_gene().model.name),
        user_id=owner,
        consent_token=token,
    )


@asynccontextmanager
async def _admitted(authorization: str | None, request: Request):
    authority, claims = verified_session(authorization, role=ROLE_APP, scope="pkm.read")
    permit = None
    current = asyncio.current_task()

    async def disconnect():
        while True:
            if await request.is_disconnected():
                if current is not None:
                    current.cancel()
                return
            await asyncio.sleep(0.5)

    watcher = asyncio.create_task(disconnect())
    try:
        await authority.require_held()
        permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
        async with asyncio.timeout(150), _slots:
            verified_session(authorization, role=ROLE_APP, scope="pkm.read")
            await authority.require_held()
            yield claims
        verified_session(authorization, role=ROLE_APP, scope="pkm.read")
        await authority.require_held()
    except PodSessionRefused as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from None
    except PodUpgradeAdmissionRefused:
        raise HTTPException(503, detail={"code": "POD_DRAINING"}) from None
    except PermissionError:
        raise HTTPException(403, detail={"code": "COMMAND_AUTHORITY_REFUSED"}) from None
    except PodHubUnavailable:
        raise HTTPException(503, detail={"code": "COMMAND_HUB_AUTHORITY_UNAVAILABLE"}) from None
    except (APIError, TimeoutError):
        raise HTTPException(503, detail={"code": "COMMAND_PROVIDER_UNAVAILABLE"}) from None
    except ValueError:
        raise HTTPException(422, detail={"code": "COMMAND_ASSESSMENT_INVALID"}) from None
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher
        if permit is not None:
            await permit.release()


@router.post("/transcriptions")
async def transcribe(
    body: TranscribeRequest, request: Request, authorization: str | None = Header(default=None)
):
    async with _admitted(authorization, request) as claims:
        brain = await _brain(body.model, claims["user_id"], "location.transcribe", claims)
        transcript = await brain.transcribe(body.audio_base64)
    return {"transcript": transcript}


@router.post("/assess")
async def assess(
    body: AssessRequest, request: Request, authorization: str | None = Header(default=None)
):
    async with _admitted(authorization, request) as claims:
        if len(json.dumps(body.context)) > 48_000:
            raise HTTPException(413, detail={"code": "COMMAND_CONTEXT_TOO_LARGE"})
        context = sanitize_agent_context(body.context)
        settings = context.get("voice_settings") or {}
        if settings.get("voice_enabled") is False or "location" in settings.get(
            "disabled_domains", []
        ):
            raise HTTPException(403, detail={"code": "COMMAND_DISABLED"})

        async def check():
            try:
                await require_owner_scope(
                    body.scope_token,
                    expected_scope=ConsentScope.CAP_LOCATION_COMMAND_READ.value,
                    user_id=claims["user_id"],
                )
            except RuntimeError:
                raise PodHubUnavailable("Command authority unavailable") from None

        await check()
        result = await assess_semantics(
            query=body.query,
            context=context,
            plan_version=body.plan_version,
            brain=await _brain(body.model, claims["user_id"], body.scope_token, claims),
            reads=PodCommandReads(
                user_id=claims["user_id"],
                scope_token=body.scope_token,
                observations=body.observations,
                saved_observations=body.saved_observations,
            ),
            consent_token=body.scope_token,
            completed_steps=body.completed_steps,
        )
        await check()
    return result
