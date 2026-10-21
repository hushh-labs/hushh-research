"""Independently supplied public sources, separate from Google grounded research."""

from __future__ import annotations

import asyncio
import json
import time
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.encrypted_session_service import EncryptedSessionCheckpointStore
from hushh_mcp.one_adk.profile_research import ProfileReport, ProfileSourceRef
from hushh_mcp.one_adk.public_sources import public_source_urls
from hushh_mcp.one_adk.world_model import POLICY, manifest
from hushh_mcp.runtime_settings import one_profile_research_enabled
from hushh_mcp.services.world_model_preferences import checkpoint_before_write

STORE = EncryptedSessionCheckpointStore(
    app_name="one.personal_world_model.sources.v1",
    session_id="review",
    before_write=checkpoint_before_write,
)
PROFESSIONAL_TOPICS = {
    "career",
    "projects",
    "publications",
    "achievements",
    "community",
    "digital_presence",
}


def scoped_store(token):
    async def before_write(conn, user_id):
        await checkpoint_before_write(conn, user_id)
        if await validate_first_party_owner_token(user_id, token, conn=conn) is None:
            raise PermissionError("Owner session ended")

    return EncryptedSessionCheckpointStore(
        app_name=STORE.app_name, session_id=STORE.session_id, before_write=before_write
    )


class SourceReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    urls: list[str] = Field(min_length=1, max_length=3)
    purpose: str = Field(pattern=r"^(owner|invitation)$")
    permitted_public_sources: bool

    @field_validator("urls")
    @classmethod
    def public_urls(cls, values):
        return public_source_urls(values)


async def require_owner(user_id, token):
    from hushh_mcp.services.world_model_invitations import verified_owner

    if not one_profile_research_enabled():
        raise PermissionError("Research is disabled")
    return await verified_owner(user_id, token)


def successful_sources(response, urls):
    requested = set(urls)
    receipts = {}
    if len(response.candidates or []) != 1:
        raise ValueError("Expected one source response")
    for candidate in response.candidates:
        metadata = getattr(candidate, "url_context_metadata", None)
        for item in getattr(metadata, "url_metadata", None) or []:
            if item.retrieved_url not in requested:
                raise ValueError("Provider retrieved an unrequested source")
            status = getattr(item.url_retrieval_status, "value", item.url_retrieval_status)
            if item.retrieved_url in requested and status == "URL_RETRIEVAL_STATUS_SUCCESS":
                if item.retrieved_url not in receipts.values():
                    receipts[f"s{len(receipts) + 1}"] = item.retrieved_url
    if not receipts:
        raise ValueError("No supplied source was retrieved")
    return receipts


async def prepare(user_id, token, body: SourceReviewInput):
    from hushh_mcp.managed_ai_config import load_pwm_policy

    if len(body.urls) > load_pwm_policy()["preview_source_limit"]:
        raise ValueError("Source count exceeds the configured limit")
    identity = await require_owner(user_id, token)
    store = scoped_store(token)
    if not body.permitted_public_sources:
        raise ValueError("Confirm source permission")
    if body.purpose == "owner" and body.name.strip() != identity["full_name"]:
        raise ValueError("Use your current profile name")
    state = await STORE.get(user_id)
    starts = [at for at in (state or {}).get("starts", []) if at > time.time() - 3600]
    if len(starts) >= 3:
        raise ValueError("Source review limit reached; retry later")
    draft_id = str(uuid.uuid4())
    pending = {"job_id": draft_id, "status": "pending", "starts": [*starts, time.time()]}
    revision = await store.write(user_id, pending, state)
    if revision is None:
        raise RuntimeError("Source draft changed")
    try:
        from google.adk.agents import LlmAgent
        from google.genai import types

        from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
        from hushh_mcp.runtime_providers import build_managed_regional_gemini_adk_model
        from hushh_mcp.runtime_providers.factory import build_managed_runtime_client
        from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

        task = manifest()
        model_name = resolve_fleet_model_name(task.model.name)
        source_instruction = task.system_instruction.split("OWNER-SUPPLIED SOURCE REVIEW\n", 1)[1]
        async with asyncio.timeout(150):
            from hushh_mcp.managed_ai_config import load_managed_runtime_policy

            runtime_policy = load_managed_runtime_policy()
            if runtime_policy is not None:
                from hushh_mcp.one_adk.public_source_fetch import retrieve_public_sources

                async def current():
                    current_policy = load_managed_runtime_policy()
                    if (
                        current_policy is None
                        or current_policy["generation"] != runtime_policy["generation"]
                    ):
                        raise PermissionError("Source-review processor selection changed")
                    await require_owner(user_id, token)

                retrieved = await retrieve_public_sources(body.urls, require_current=current)
                sources = {item.ref: item.url for item in retrieved}
                parts = [types.Part(text=json.dumps(body.model_dump()))]
                parts.extend(part for item in retrieved for part in item.parts)
                response = await build_managed_runtime_client("gemini").aio.models.generate_content(
                    model=model_name,
                    contents=types.Content(role="user", parts=parts),
                    config=types.GenerateContentConfig(
                        system_instruction=source_instruction,
                        max_output_tokens=8192,
                    ),
                )
            else:
                response = await build_managed_runtime_client("gemini").aio.models.generate_content(
                    model=model_name,
                    contents=json.dumps(body.model_dump()),
                    config=types.GenerateContentConfig(
                        system_instruction=source_instruction,
                        tools=[types.Tool(url_context=types.UrlContext())],
                        max_output_tokens=8192,
                    ),
                )
                sources = successful_sources(response, body.urls)
            await require_owner(user_id, token)
            agent = LlmAgent(
                name=task.id,
                model=build_managed_regional_gemini_adk_model(model_name),
                mode="task",
                instruction=source_instruction,
                include_contents="none",
                disallow_transfer_to_parent=True,
                disallow_transfer_to_peers=True,
                output_schema=ProfileReport[ProfileSourceRef],
            )
            turn = await run_specialist_adk_turn(
                agent=agent,
                app_name="one_personal_world_model_sources",
                user_id=user_id,
                consent_token=token,
                message=json.dumps(
                    {
                        "input": body.model_dump(),
                        "source_receipts": sources,
                        "source_response": response.text,
                    }
                ),
                max_llm_calls=2,
                first_event_timeout_s=60,
                between_event_timeout_s=60,
                total_timeout_s=75,
            )
        await require_owner(user_id, token)
        report = ProfileReport[ProfileSourceRef].model_validate(turn.structured_output).model_dump()
        if body.purpose == "invitation":
            if any(s["kind"] not in PROFESSIONAL_TOPICS for s in report["sections"]):
                raise ValueError("Preview includes non-professional findings")
            if sum(len(s["facts"]) for s in report["sections"]) > POLICY["preview_fact_limit"]:
                raise ValueError("Preview exceeds fact limit")
        for section in report["sections"]:
            for fact in section["facts"]:
                for source in fact["sources"]:
                    ref = source.pop("ref")
                    if ref not in sources:
                        raise ValueError("Finding lacks a successful requested-source receipt")
                    source["url"] = sources[ref]
        report = ProfileReport.model_validate(report).model_dump()
        result = {
            "status": "offered",
            "pkm_written": False,
            "draft_id": draft_id,
            "report": report,
            "search_suggestions": [],
        }
        finished = {
            **pending,
            "status": "offered",
            "result": result,
            "purpose": body.purpose,
            "allowed_use": "reviewable_fact",
            "source_origin": "independently_supplied",
            "finished_at": time.time(),
        }
        if await store.write(user_id, finished, revision) is None:
            raise RuntimeError("Source draft changed")
        return result
    except BaseException:
        try:
            await asyncio.shield(
                store.write(
                    user_id,
                    {**pending, "status": "unavailable", "finished_at": time.time()},
                    revision,
                )
            )
        except Exception:
            pass
        raise


async def read(user_id, token, draft_id=None):
    await require_owner(user_id, token)
    state = await STORE.get(user_id)
    if (
        not state
        or state.get("status") != "offered"
        or state.get("allowed_use") != "reviewable_fact"
        or time.time() - state.get("finished_at", 0) > 86400
        or (draft_id and state["job_id"] != str(draft_id))
    ):
        raise ValueError("Source draft unavailable")
    return state


async def discard(user_id, token, draft_id):
    state = await read(user_id, token, draft_id)
    tombstone = {"job_id": state["job_id"], "status": "saved", "starts": state["starts"]}
    if await validate_first_party_owner_token(user_id, token) is None:
        raise PermissionError("Owner session ended")
    if await scoped_store(token).write(user_id, tombstone, state) is None:
        raise RuntimeError("Source draft changed")
