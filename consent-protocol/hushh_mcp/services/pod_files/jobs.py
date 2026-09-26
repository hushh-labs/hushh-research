"""Owner-project Cloud Tasks delivery; identifiers only, finite consent-bound work."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from hushh_mcp.services.pod_files.contracts import decode_metadata
from hushh_mcp.services.pod_files.library import FilesRefused, identifier
from hushh_mcp.services.pod_files.runtime import files_access, operation


class OrganizationResult(BaseModel):
    state: Literal["organized", "unchanged", "unsupported", "failed"]
    explanation: str = Field(min_length=1, max_length=2000)


def worker_origin() -> str:
    """A previously admitted, hub-signed app binding supplies the destination."""
    from hushh_mcp.services.pod_session_authority import active_session_authority

    authority = active_session_authority()
    if authority is None:
        raise FilesRefused("FILES_AUTHORITY_UNAVAILABLE", 503)
    records = [
        record
        for record in authority.store.trusted_subjects()
        if record.role == "app" and record.binding.get("pod_key_id") == authority.pod_key_id
    ]
    if not records:
        raise FilesRefused("FILES_WORKER_DESTINATION_UNAVAILABLE", 503)
    return str(max(records, key=lambda record: record.recorded_at_ms).binding["url"]).rstrip("/")


async def prepare_delivery(
    library: Any, *, file_id: str, automatic: bool = False, request_id: str = ""
) -> dict[str, Any]:
    settings = await library.analysis_allowed(file_id)
    entry = await library.stat(file_id)
    if entry["kind"] != "file" or entry["state"] != "ready":
        raise FilesRefused("FILES_SOURCE_UNAVAILABLE")
    if automatic:
        manifest, _ = await library._read(library._path(file_id))
        if (
            not settings["automatic"]
            or manifest.get("automaticConsentRevision") != settings["revision"]
        ):
            return {"state": "not_requested"}
    queue = os.getenv("POD_FILES_TASK_QUEUE", "")
    service_account = os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT", "")
    if not queue or not service_account:
        raise FilesRefused("FILES_BACKGROUND_NOT_CONFIGURED", 503)
    job_id = file_id  # one serialized job per file; cancelled/failed jobs need explicit retry
    path = f"jobs/{job_id}.bin"
    job = None
    try:
        job, generation = await library._read(path)
        if job["state"] in {"queued", "running"} or (
            job["state"] == "completed" and (not request_id or job.get("requestId") == request_id)
        ):
            return {"id": job_id, "state": job["state"]}
        if automatic and job["state"] != "pending_delivery":
            return {"id": job_id, "state": job["state"]}
    except FilesRefused as exc:
        if exc.status != 404:
            raise
        generation = 0
    if job is None or job["state"] != "pending_delivery":
        history = (
            list((job or {}).get("history", []))
            + (
                [
                    {
                        key: job[key]
                        for key in ("delivery", "state", "result", "expiresAt")
                        if key in job
                    }
                ]
                if job
                else []
            )
        )[-20:]
        job = {
            "history": history,
            "requestId": request_id,
            "id": job_id,
            "file": file_id,
            "revision": entry["revision"],
            "consentRevision": settings["revision"],
            "state": "pending_delivery",
            "attempts": 0,
            "expiresAt": int(time.time()) + 86400,
            "owner": library.owner,
            "delivery": uuid4().hex,
        }
        await library._write(path, job, generation)
    return job


async def deliver(library: Any, job: dict[str, Any]) -> dict[str, Any]:
    """Network I/O outside the library mutation lock; CAS cannot resurrect cancellation."""
    if job.get("state") != "pending_delivery":
        return {key: job[key] for key in ("id", "state") if key in job}
    job_id = identifier(job["id"])
    path = f"jobs/{job_id}.bin"
    queue = os.getenv("POD_FILES_TASK_QUEUE", "")
    service_account = os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT", "")
    if not queue or not service_account:
        raise FilesRefused("FILES_BACKGROUND_NOT_CONFIGURED", 503)
    await library.check()
    # The encrypted outbox survives a lost create-task response. Reuse its exact
    # delivery ID on retry; Cloud Tasks' named-task deduplication prevents a second job.
    origin = worker_origin()
    task = {
        "name": f"{queue}/tasks/files-{job['delivery']}",
        "dispatchDeadline": "180s",
        "httpRequest": {
            "httpMethod": "POST",
            "url": origin + "/api/one/pod/files/worker",
            "headers": {"Content-Type": "application/json"},
            "oidcToken": {"serviceAccountEmail": service_account, "audience": origin},
            "body": base64.b64encode(
                json.dumps({"job_id": job_id, "delivery": job["delivery"]}).encode()
            ).decode(),
        },
    }
    # Use the same keyless owner-project credential transport as encrypted storage.
    store = library.store
    try:
        response = await asyncio.to_thread(
            store._authorized,
            lambda headers: store._session.post(
                f"https://cloudtasks.googleapis.com/v2/{queue}/tasks",
                headers=headers,
                json={"task": task},
                timeout=20,
                allow_redirects=False,
            ),
        )
    except Exception:
        raise FilesRefused("FILES_JOB_DELIVERY_UNCONFIRMED", 503) from None
    if response.status_code not in {200, 201, 409}:
        raise FilesRefused("FILES_JOB_DELIVERY_FAILED", 503)
    latest, generation = await library._read(path)
    if latest["delivery"] == job["delivery"] and latest["state"] == "pending_delivery":
        latest["state"] = "queued"
        await library._write(path, latest, generation)
    return {"id": job_id, "state": latest["state"]}


async def enqueue(library: Any, *, file_id: str, automatic: bool = False) -> dict[str, Any]:
    return await deliver(
        library, await prepare_delivery(library, file_id=file_id, automatic=automatic)
    )


async def history_page(library: Any, cursor: str = "") -> dict[str, Any]:
    names, following = await library.store.list_page("jobs", cursor, limit=50)
    entries = []
    for path in names:
        if not path.endswith(".bin"):
            continue
        job, _ = await library._read(path)
        entries.append(
            {
                key: job[key]
                for key in ("id", "file", "state", "attempts", "expiresAt", "result", "history")
                if key in job
            }
        )
    return {"entries": entries, "cursor": following}


async def status(library: Any, file_id: str, *, cancel: bool = False) -> dict[str, Any]:
    path = f"jobs/{identifier(file_id)}.bin"
    job, generation = await library._read(path)
    if cancel and job["state"] not in {"completed", "cancelled"}:
        job["state"] = "cancelled"
        await library._write(path, job, generation)
    return {
        key: job[key]
        for key in ("id", "state", "attempts", "expiresAt", "result", "history")
        if key in job
    }


async def run_job(job_id: str, delivery: str) -> dict[str, str]:
    """The route verifies OIDC first. No task payload can supply a model instruction."""
    from hushh_mcp.one_adk.files_tools import job_target
    from hushh_mcp.services.pod_session_authority import active_session_authority

    identifier(job_id)
    identifier(delivery)
    authority = active_session_authority()
    if authority is None:
        raise FilesRefused("FILES_AUTHORITY_UNAVAILABLE", 503)

    async def owner_check() -> None:
        await authority.require_held()

    with files_access(owner_check):
        async with operation(mutation=True) as library:
            path = f"jobs/{job_id}.bin"
            job, generation = await library._read(path)
            if job["delivery"] != delivery:
                return {"state": "superseded"}
            if job["state"] in {"completed", "cancelled", "failed", "review_required"}:
                return {"state": job["state"]}
            if job["state"] == "running" and job.get("leaseUntil", 0) > time.time():
                raise FilesRefused("FILES_JOB_BUSY", 503)
            if job["state"] == "running":
                # A process may have committed a move before dying. Never replay a
                # semantic decision automatically when completion is uncertain.
                job["state"] = "review_required"
                await library._write(path, job, generation)
                return {"state": "review_required"}
            settings = await library.settings()
            if (
                job["owner"] != library.owner
                or job["expiresAt"] <= time.time()
                or job["consentRevision"] != settings["revision"]
                or not settings["analysis"]
            ):
                job["state"] = "cancelled"
                await library._write(path, job, generation)
                return {"state": "cancelled"}
            entry = await library.stat(job["file"])
            if entry["revision"] != job["revision"]:
                job["state"] = "review_required"
                await library._write(path, job, generation)
                return {"state": "review_required"}
            if job["attempts"] >= 3:
                job["state"] = "failed"
                await library._write(path, job, generation)
                return {"state": "failed"}
            job.update(
                state="running", attempts=job["attempts"] + 1, leaseUntil=int(time.time()) + 150
            )
            await library._write(path, job, generation)

        async def job_check() -> None:
            await authority.require_held()
            # Read directly to avoid recursive authorization through library._read.
            raw = await library.store.get(path)
            current = decode_metadata(library._open(path, raw)) if raw else {}
            settings_raw = await library.store.get("settings.bin")
            config = (
                decode_metadata(library._open("settings.bin", settings_raw)) if settings_raw else {}
            )
            if (
                current.get("state") != "running"
                or current.get("delivery") != job["delivery"]
                or current.get("leaseUntil", 0) <= time.time()
                or not config.get("analysis")
                or config.get("revision") != job["consentRevision"]
            ):
                raise FilesRefused("FILES_JOB_AUTHORITY_CHANGED", 403)

        outcome = "completed"
        result = None
        try:
            with files_access(job_check), job_target(job["file"]):
                async with operation():
                    await library.analysis_allowed(job["file"])
                    result = await _organize(job["file"])
                    await job_check()
                    if result.state == "failed":
                        outcome = "failed"
        except Exception:
            # Exceptions can contain file/model content. Persist a state only.
            outcome = "failed"
        async with operation(mutation=True):
            latest, generation = await library._read(path)
            if latest["state"] == "running" and latest["delivery"] == job["delivery"]:
                latest["state"] = outcome
                if result is not None:
                    latest["result"] = result.model_dump()
                await library._write(path, latest, generation)
            return {"state": latest["state"]}


async def _organize(file_id: str) -> OrganizationResult:
    from google.adk.agents import LlmAgent, SequentialAgent
    from google.adk.agents.run_config import RunConfig
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.adk.telemetry.context import ContentCapturingMode, TelemetryConfig
    from google.genai import types

    from hushh_mcp.one_adk.agent_tree import _load_product_agent_manifest
    from hushh_mcp.one_adk.files_tools import create_folder, list_files, organize_file, read_file
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    manifest = _load_product_agent_manifest("agent_files")
    # Provisioning pins Vertex ADC to the owner's project. No user-cloud project, no call.
    if (
        os.getenv("HUSSH_POD_USER_ADC_ENABLED", "").lower() not in {"1", "true"}
        or not os.getenv("GOOGLE_CLOUD_PROJECT")
        or not os.getenv("POD_FILES_TASK_QUEUE", "").startswith(
            f"projects/{os.getenv('GOOGLE_CLOUD_PROJECT')}/"
        )
    ):
        raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503)
    agent = LlmAgent(
        name="files",
        mode="task",
        model=build_managed_gemini_adk_model(
            resolve_fleet_model_name(manifest.model_config_for_runtime().name)
        ),
        instruction=manifest.system_instruction,
        tools=[create_folder, list_files, read_file, organize_file],
        output_schema=OrganizationResult,
    )
    sessions = InMemorySessionService()
    app, user, session_id = "files_organization", "private_job", uuid4().hex
    await sessions.create_session(app_name=app, user_id=user, session_id=session_id)
    runner = Runner(
        app_name=app,
        agent=SequentialAgent(name="files_job", sub_agents=[agent]),
        session_service=sessions,
    )
    try:
        result = None
        async with asyncio.timeout(120):
            async for event in runner.run_async(
                user_id=user,
                session_id=session_id,
                new_message=types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(
                            text=f"Organize file {file_id} under the owner's recorded request. Inspect it before choosing a reversible rename or move. Leave it unchanged if unsupported. Report the result and explanation accurately; a refused tool is not a completed change."
                        )
                    ],
                ),
                run_config=RunConfig(
                    max_llm_calls=6,
                    telemetry=TelemetryConfig(
                        capture_message_content=ContentCapturingMode.NO_CONTENT
                    ),
                ),
            ):
                if event.author == "files" and event.is_final_response() and event.content:
                    text = "".join(
                        part.text or "" for part in event.content.parts or [] if not part.thought
                    )
                    result = OrganizationResult.model_validate_json(text)
        if result is None:
            raise FilesRefused("FILES_MODEL_RESULT_MISSING", 503)
        return result
    finally:
        await runner.close()
        await sessions.delete_session(app_name=app, user_id=user, session_id=session_id)
