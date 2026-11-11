"""Owner-present paid preparation; PKM and model execution stay in the owner pod."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from pathlib import Path
from uuid import UUID

import requests
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from api.routes.one.pod_commands import _admitted
from api.routes.one.pod_pkm_preparation import _owner_model, _selection
from api.routes.one.pod_session import verified_session
from api.routes.one.pod_turn import _require_enabled
from hushh_mcp.services.answer_composer import ANSWER_COMPOSE_SCHEMA, GENE_ID, AnswerComposer
from hushh_mcp.services.answer_projection_contract import valid_answer_projection
from hushh_mcp.services.pod_ai_effective_connection import paid_answer_runtime
from hushh_mcp.services.pod_ai_selection import ai_selection_revision
from hushh_mcp.services.pod_consent_read import ConsentReadOptions, project_consent_feed
from hushh_mcp.services.pod_hub_client import PodHubClient
from hushh_mcp.services.pod_owner_feed_client import owner_feed_client
from hushh_mcp.services.pod_session_authority import ROLE_APP, SCOPE_PKM_READ

router = APIRouter(prefix="/api/one/pod/answers", tags=["personal-agent"])


class ComposeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    requestId: str
    projection: dict


@router.post("/compose")
async def compose_private_answer(
    body: ComposeRequest, request: Request, authorization: str | None = Header(default=None)
):
    _require_enabled()
    try:
        request_id = str(UUID(body.requestId))
    except ValueError:
        raise HTTPException(422, detail={"code": "ANSWER_REQUEST_INVALID"}) from None
    async with _admitted(authorization, request) as claims:
        authority, _ = verified_session(authorization, role=ROLE_APP, scope=SCOPE_PKM_READ)
        selected, revision = _selection(), ai_selection_revision()
        model = _owner_model()
        try:
            runtime = paid_answer_runtime()
        except ValueError:
            raise HTTPException(409, detail={"code": "ANSWER_RUNTIME_UNAVAILABLE"}) from None
        if model.provider != runtime["provider"] or model.model != runtime["model"]:
            raise HTTPException(409, detail={"code": "ANSWER_RUNTIME_CHANGED"})

        async def current():
            actual, actual_claims = verified_session(
                authorization, role=ROLE_APP, scope=SCOPE_PKM_READ
            )
            if actual is not authority or actual_claims != claims:
                raise HTTPException(403, detail={"code": "ANSWER_OWNER_CHANGED"})
            await authority.require_held()
            if (
                _selection() != selected
                or ai_selection_revision() != revision
                or paid_answer_runtime() != runtime
            ):
                raise HTTPException(409, detail={"code": "OWNER_AI_SELECTION_CHANGED"})

        await current()
        client = owner_feed_client()
        if client is None:
            raise HTTPException(503, detail={"code": "ANSWER_AUTHORITY_UNAVAILABLE"})
        options = ConsentReadOptions(
            bundle_id=f"answer:{request_id}", read_nonce=secrets.token_hex(16)
        )
        projection = await asyncio.to_thread(
            client.read,
            "consent",
            claims["user_id"],
            params=options.model_dump(exclude_none=True),
            fresh=True,
        )
        await current()
        checked = project_consent_feed(projection)
        work = checked.get("paidAnswer")
        if (
            checked["readNonce"] != options.read_nonce
            or not work
            or work["requestId"] != request_id
            or work["runtimeBinding"]["owner"] != claims["user_id"]
            or work["runtimeBinding"]["hushh_id"] != claims["hushh_id"]
        ):
            raise HTTPException(403, detail={"code": "ANSWER_AUTHORITY_CHANGED"})
        if work["processingRuntime"] != runtime:
            raise HTTPException(409, detail={"code": "ANSWER_PROCESSOR_APPROVAL_REQUIRED"})
        if not valid_answer_projection(work, body.projection):
            raise HTTPException(422, detail={"code": "ANSWER_PROJECTION_INVALID"})

        async def run(prompt):
            from hushh_mcp.hushh_adk.manifest import ManifestLoader
            from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

            manifest = ManifestLoader.load(
                str(Path(__file__).resolve().parents[3] / "hushh_mcp/agents/one/agent.yaml")
            )
            gene = next(child for child in manifest.subagents if child.id == GENE_ID)
            if (
                gene.runtime.adk_mode != "single_turn"
                or gene.privacy.plaintext_telemetry
                or gene.model.provider != "gemini"
            ):
                raise HTTPException(503, detail={"code": "ANSWER_MODEL_UNAVAILABLE"})
            await current()
            # Explicit owner model: use OpenAI on Azure, Gemini on GCP; never a hub fallback.
            agent = build_single_turn_agent(gene, output_schema=ANSWER_COMPOSE_SCHEMA, model=model)
            return await run_single_turn(
                agent, prompt_parts=prompt, user_id=claims["user_id"], timeout_seconds=30
            )

        written = await AnswerComposer(runner=run).compose(
            question=work["question"],
            projection=body.projection,
            period=work["period"],
            omitted_scopes=work["omittedScopes"],
            user_id=claims["user_id"],
        )
        await current()
        if written["gaps"]:
            raise HTTPException(409, detail={"code": "ANSWER_COVERAGE_INCOMPLETE"})
        # A per-call secret blinds low-entropy facts. Only commitments leave for the hub.
        blind = secrets.token_bytes(32)

        def digest(value):
            return hmac.new(blind, value.encode(), hashlib.sha256).hexdigest()

        assertion = {
            "authorityToken": work["authorityToken"],
            "processingRuntime": runtime,
            "selectionRevision": revision,
            "runtimeMode": model.runtime_mode,
            "answerDigest": digest(written["answer"]),
            "inputDigest": digest(
                json.dumps(
                    {"projection": body.projection, "period": work["period"]},
                    sort_keys=True,
                    separators=(",", ":"),
                )
            ),
        }
        await current()
        with requests.Session() as session:
            hub = PodHubClient(session=session)
            response = await asyncio.to_thread(
                hub.post,
                f"/api/one/answer-requests/{request_id}/pod-composition-receipt",
                json=assertion,
            )
            await current()
            if response.status_code != 200:
                raise HTTPException(409, detail={"code": "ANSWER_RECEIPT_UNAVAILABLE"})
            receipt = response.json().get("compositionReceipt")
        if not isinstance(receipt, str) or not receipt.startswith("v2.") or len(receipt) > 2400:
            raise HTTPException(503, detail={"code": "ANSWER_RECEIPT_UNAVAILABLE"})
        return JSONResponse(
            {"answerMode": "agent", **written, "compositionReceipt": receipt},
            headers={"Cache-Control": "private, no-store"},
        )
