"""Explicit Cloud Run diagnostic; never a CI hook or a global queue drain.

The model check uses the authored planner and its existing graders. The optional
live check uses designated Google-connected A/B fixtures, real route authority,
native Drive files, the existing free exact-file sharing contract, and independent
recipient metadata reads. It never changes payment policy or invents a paid event.
Only identifiers of synthetic resources created by this invocation stay in memory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ORIGIN = "https://api.uat.hushh.ai"
BASE = "/api/connectors/google_drive/sharing"
SCHEMA = "drive.vertex.journey.v1"


class JourneyFailure(RuntimeError):
    """Only fixed diagnostic codes cross the process boundary."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise JourneyFailure(code)


def event(stage: str, outcome: str, **metrics) -> None:
    print(json.dumps({"schema": SCHEMA, "stage": stage, "outcome": outcome, **metrics}), flush=True)


def recipient_access_state(response, file_id: str) -> bool:
    """Quota, auth and configuration failures never prove access was removed."""
    if response.status_code == 200:
        require(response.json().get("id") == file_id, "recipient_file_identity_mismatch")
        return True
    if response.status_code == 404:
        require(response.json().get("error", {}).get("code") == 404, "recipient_access_unverified")
        return False
    raise JourneyFailure("recipient_access_unverified")


def require_fixture_plan(plan: dict, *, file_id: str, recipient: str, kind: str) -> None:
    require(plan.get("file_id") == file_id, "permission_fixture_identity_mismatch")
    if kind == "grant":
        require(
            plan.get("recipient", {}).get("user_id") == recipient,
            "permission_fixture_recipient_mismatch",
        )


async def model_check() -> None:
    from hushh_mcp.runtime_providers.managed_text import managed_text_binding
    from scripts.probe_drive_activity_planner import probe_drive_activity_planner

    binding = managed_text_binding()
    require(binding["provider"] == "gemini", "drive_processor_not_vertex")
    event("model", "started", provider="vertex", model=binding["deployment"])
    await probe_drive_activity_planner(provider="vertex")
    event("model", "passed", provider="vertex", model=binding["deployment"])


@dataclass(repr=False)
class LiveState:
    owner: str
    recipient: str
    person_ref: str
    oauth: Any
    transport: Any
    database: Any
    app: Any
    sessions: dict
    run_id: str = field(default_factory=lambda: uuid4().hex)
    created_files: list[str] = field(default_factory=list)
    question_id: str | None = None
    share_id: str | None = None
    grants_clean: bool = True
    write_outcome_unknown: bool = False


async def live_context() -> LiveState:
    from fastapi import FastAPI
    from firebase_admin import auth as firebase_auth

    from api.routes.drive_sharing import router
    from api.utils.firebase_admin import get_firebase_auth_app
    from db.db_client import get_db
    from hushh_mcp.services.external_connector_oauth_service import (
        get_external_connector_oauth_service,
    )
    from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
    from scripts._reviewer_session import exchange_custom_token, issue_vault_owner_token

    require(os.getenv("CLOUD_RUN_JOB") is not None, "live_check_requires_cloud_run_job")
    owner = os.getenv("REVIEWER_UID", "").strip()
    recipient = os.getenv("REVIEWER_COUNTERPART_UID", "").strip()
    require(bool(owner and recipient and owner != recipient), "designated_pair_missing")
    api_key = os.getenv("NEXT_PUBLIC_FIREBASE_API_KEY", "").strip()
    require(bool(api_key), "firebase_client_configuration_missing")
    oauth = get_external_connector_oauth_service().drive()
    # No grants, relationships or owner approvals are seeded.
    await oauth.current_credential(user_id=owner, required_profile="live")
    await oauth.current_credential(user_id=recipient, required_profile="live")
    database = get_db()
    profile = database.execute_raw(
        "SELECT public_person_ref FROM actor_profiles WHERE user_id=:owner AND public_profile_status='active'",
        {"owner": owner},
    ).data
    require(len(profile) == 1, "designated_owner_profile_missing")
    sessions = {}
    for role, uid in (("owner", owner), ("recipient", recipient)):
        custom = await asyncio.to_thread(
            firebase_auth.create_custom_token, uid, app=get_firebase_auth_app()
        )
        if isinstance(custom, bytes):
            custom = custom.decode()
        identity = await asyncio.to_thread(exchange_custom_token, custom, api_key)
        vault = await asyncio.to_thread(issue_vault_owner_token, ORIGIN, identity, uid)
        sessions[role] = {"Authorization": f"Bearer {identity}", "X-Hushh-Consent": vault}
    app = FastAPI()
    app.include_router(router)  # Real routes/dependencies; no authentication overrides.
    return LiveState(
        owner,
        recipient,
        str(profile[0]["public_person_ref"]),
        oauth,
        GoogleDriveRestTransport(oauth=oauth),
        database,
        app,
        sessions,
    )


async def recipient_access(state: LiveState, file_id: str, expected: bool) -> None:
    for attempt in range(6):
        row, credential = await state.oauth.current_credential(
            user_id=state.recipient, required_profile="live"
        )
        async with httpx.AsyncClient(timeout=20) as provider:
            response = await provider.get(
                f"https://www.googleapis.com/drive/v3/files/{file_id}",
                params={"fields": "id", "supportsAllDrives": "true"},
                headers={"Authorization": "Bearer " + credential["accessToken"]},
            )
        current = await state.oauth.lifecycle.read(
            user_id=state.recipient, connector_id="google_drive"
        )
        require(
            current is not None
            and current["connection_generation"] == row["connection_generation"],
            "recipient_connection_changed",
        )
        if recipient_access_state(response, file_id) == expected:
            return
        if attempt < 5:
            await asyncio.sleep(2)
    raise JourneyFailure("recipient_access_not_confirmed")


async def fixture_write(state: LiveState, arguments: dict) -> dict:
    from hushh_mcp.services.google_drive_write_adapter import DriveWriteError

    try:
        result = await state.transport.write_tool(
            user_id=state.owner, tool_name="create_file", arguments=arguments
        )
    except asyncio.CancelledError:
        state.write_outcome_unknown = True
        event("fixture_write", "unverified", reason="write_outcome_unknown")
        raise
    except DriveWriteError as error:
        state.write_outcome_unknown = error.outcome_unknown
        event(
            "fixture_write",
            "unverified" if state.write_outcome_unknown else "failed",
            reason="write_outcome_unknown" if state.write_outcome_unknown else "write_rejected",
        )
        raise JourneyFailure("fixture_write_unverified") from None
    require(not result.is_error, "fixture_creation_failed")
    file = result.payload["file"]
    state.created_files.append(file["id"])
    return file


async def operations(state: LiveState, kind: str, matched: str) -> None:
    from hushh_mcp.services.drive_permission_executor import DrivePermissionExecutor
    from hushh_mcp.services.drive_revocation_executor import DriveRevocationExecutor

    rows = state.database.execute_raw(
        """SELECT * FROM drive_share_permission_operations
        WHERE user_id=:owner AND request_id=CAST(:request AS uuid) AND kind=:kind""",
        {"owner": state.owner, "request": state.share_id, "kind": kind},
    ).data
    require(len(rows) == 1, "scoped_permission_operation_count_mismatch")
    executor = DrivePermissionExecutor() if kind == "grant" else DriveRevocationExecutor()
    row = rows[0]
    require_fixture_plan(
        executor.store._plan(row), file_id=matched, recipient=state.recipient, kind=kind
    )
    if kind == "grant":
        await executor.grant(user_id=state.owner, operation_id=str(row["operation_id"]))
    else:
        await executor.revoke(user_id=state.owner, operation_id=str(row["operation_id"]))
    for attempt in range(10):
        settled = state.database.execute_raw(
            "SELECT state FROM drive_share_permission_operations WHERE user_id=:owner AND operation_id=CAST(:operation AS uuid)",
            {"owner": state.owner, "operation": str(row["operation_id"])},
        ).data
        if len(settled) != 1 or settled[0]["state"] not in {"queued", "dispatching"}:
            break
        if attempt < 9:
            await asyncio.sleep(2)  # Read-only observation of an already claimed effect.
    require(
        len(settled) == 1
        and settled[0]["state"] in ({"succeeded"} if kind == "grant" else {"succeeded", "absent"}),
        "permission_outcome_unverified",
    )


async def call(api, state: LiveState, role: str, method: str, path: str, body=None):
    response = await api.request(method, BASE + path, headers=state.sessions[role], json=body)
    require(response.status_code in {200, 202}, f"api_http_{response.status_code}")
    return response.json()


async def revoke(api, state: LiveState, matched: str) -> None:
    review = await call(
        api, state, "owner", "POST", f"/requests/{state.share_id}/revocation/prepare"
    )
    await call(
        api,
        state,
        "owner",
        "POST",
        f"/requests/{state.share_id}/revocation/confirm",
        {
            "revision": review["revision"],
            "directiveId": review["directiveId"],
            "reviewDigest": review["reviewDigest"],
            "confirmed": True,
            "grantIds": [item["grantId"] for item in review["files"]],
        },
    )
    await operations(state, "revoke", matched)


async def seed_files(state: LiveState) -> tuple[str, str, str]:
    event("fixture", "started", run_id=state.run_id)
    marker = "HusshVertexQA" + state.run_id
    folder = await fixture_write(state, {"kind": "folder", "name": marker})
    names = [marker + " Meeting Notes", marker + " Private Control"]
    for name in names:
        await fixture_write(
            state,
            {
                "kind": "document",
                "name": name,
                "content": "Synthetic verification information.",
                "contentFormat": "text",
                "folderId": folder["id"],
            },
        )
    matched, control = state.created_files[1:]
    # Native indexing readiness is fixture setup, before the model query.
    for attempt in range(10):
        indexed = await state.transport.read_tool(
            user_id=state.owner,
            tool_name="search_files",
            arguments={
                "query": f"trashed = false and name = '{names[0]}'",
            },
        )
        require(not indexed.is_error, "fixture_index_check_failed")
        if {item["id"] for item in indexed.payload.get("files", [])} == {matched}:
            break
        if attempt == 9:
            raise JourneyFailure("fixture_index_not_ready")
        await asyncio.sleep(2)
    await recipient_access(state, matched, False)
    await recipient_access(state, control, False)
    return names[0], matched, control


async def query_and_share(api, state: LiveState, name: str) -> None:
    question = await call(
        api,
        state,
        "recipient",
        "POST",
        "/queries",
        {
            "ownerPersonRef": state.person_ref,
            "clientRequestId": str(uuid4()),
            "query": f'Find the file with the exact title "{name}".',
        },
    )
    state.question_id = question["requestId"]
    path = f"/queries/{state.question_id}"
    before = await call(api, state, "recipient", "GET", path)
    require(not (before.get("answer") or {}).get("files"), "owner_results_disclosed_before_allow")
    current = await call(api, state, "owner", "GET", path)
    await call(
        api,
        state,
        "owner",
        "POST",
        path + "/allow",
        {"revision": current["revision"], "timeZone": "UTC"},
    )
    answered = await call(api, state, "owner", "GET", path)
    files = (answered.get("answer") or {}).get("files", [])
    require(len(files) == 1 and files[0]["name"] == name, "native_search_ground_truth_mismatch")
    event("legacy_native_query", "passed", result_count=len(files))
    state.grants_clean = False  # An unknown share response retains the fixtures.
    shared = await call(
        api, state, "owner", "POST", path + "/share", {"fileRefs": [files[0]["ref"]]}
    )
    state.share_id = (shared.get("answer") or {}).get("shareRequestId")
    require(bool(state.share_id), "share_receipt_missing")


async def verify_delivery(api, state: LiveState, matched: str, control: str) -> None:
    await operations(state, "grant", matched)
    await recipient_access(state, matched, True)
    await recipient_access(state, control, False)
    event("recipient_access", "passed", granted_count=1, excluded_control_count=1)
    await revoke(api, state, matched)
    await recipient_access(state, matched, False)
    state.grants_clean = True
    event("revocation", "passed", revoked_count=1)


async def cleanup(api, state: LiveState) -> None:
    try:
        if state.share_id and not state.grants_clean:
            await revoke(api, state, state.created_files[1])
            await recipient_access(state, state.created_files[1], False)
            state.grants_clean = True
        elif state.question_id and not state.share_id:
            current = await call(api, state, "recipient", "GET", f"/queries/{state.question_id}")
            if current.get("status") in {"pending", "failed"}:
                await call(
                    api,
                    state,
                    "recipient",
                    "POST",
                    f"/queries/{state.question_id}/cancel",
                    {"revision": current["revision"]},
                )
    finally:
        cleaned = 0
        for file_id in reversed(state.created_files):
            if not state.grants_clean or state.write_outcome_unknown:
                break
            row, _ = await state.oauth.current_credential(
                user_id=state.owner, required_profile="live"
            )
            result = await state.transport.write_tool(
                user_id=state.owner,
                tool_name="trash_file",
                arguments={"fileId": file_id},
                expected_generation=row["connection_generation"],
            )
            require(not result.is_error, "fixture_cleanup_failed")
            cleaned += 1
        event(
            "cleanup",
            "passed"
            if cleaned == len(state.created_files)
            and state.grants_clean
            and not state.write_outcome_unknown
            else "incomplete",
            created_count=len(state.created_files),
            trashed_count=cleaned,
        )


async def live_check() -> None:
    from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel

    state = await live_context()
    original_azure = AzureOpenAIAdkModel.generate_content_async

    async def forbid_azure(*_args, **_kwargs):
        raise JourneyFailure("unexpected_azure_model_call")
        yield  # Match the model port's asynchronous generator contract.

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=state.app), base_url=ORIGIN, timeout=100
    ) as api:
        try:
            AzureOpenAIAdkModel.generate_content_async = forbid_azure
            name, matched, control = await seed_files(state)
            await query_and_share(api, state, name)
            await verify_delivery(api, state, matched, control)
        finally:
            try:
                await cleanup(api, state)
            finally:
                AzureOpenAIAdkModel.generate_content_async = original_azure


async def run(args) -> None:
    from hushh_mcp.runtime_settings import hydrate_runtime_environment

    hydrate_runtime_environment()
    if not args.live:
        from scripts.verify_azure_pwm_runtime import _initialize_synthetic_runtime

        _initialize_synthetic_runtime()  # Process-only keys; no application authority or stores.
    require((os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT")) == "uat", "uat_required")
    try:
        async with asyncio.timeout(900):
            await model_check()
            if args.live:
                require(args.allow_fixture_mutations, "explicit_fixture_mutation_opt_in_required")
                await live_check()
    finally:
        from db import db_client
        from db.connection import close_pool

        await close_pool()
        if db_client._engine is not None:
            db_client._engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live", action="store_true", help="Use designated real Google-connected A/B fixtures."
    )
    parser.add_argument(
        "--allow-fixture-mutations",
        action="store_true",
        help="Create, share, revoke and trash only this run's synthetic files.",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.ERROR)
    started = time.monotonic()
    try:
        asyncio.run(run(args))
    except JourneyFailure as error:
        event(
            "journey",
            "failed",
            reason=str(error),
            elapsed_ms=round((time.monotonic() - started) * 1000),
        )
        return 1
    except Exception as error:
        # Provider bodies, URLs, identifiers and credentials never enter the receipt.
        event(
            "journey",
            "failed",
            reason="execution_failed",
            error_type=type(error).__name__,
            elapsed_ms=round((time.monotonic() - started) * 1000),
        )
        return 1
    event(
        "journey", "passed", live=args.live, elapsed_ms=round((time.monotonic() - started) * 1000)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
