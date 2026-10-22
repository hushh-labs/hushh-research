"""Real PostgreSQL serialization of binding publication and device revocation."""

from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text

from db.db_client import DatabaseClient
from hushh_mcp.services.personal_agent_direct_admission import record_binding, record_endpoint
from hushh_mcp.services.trusted_device_service import PostgresTrustedDeviceStore
from tests.pkm_conformance import postgres_harness

pytestmark = pytest.mark.skipif(
    postgres_harness.find_pg_bin() is None, reason="PostgreSQL unavailable"
)


@pytest.fixture(scope="module")
def pg():
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = postgres_harness.TempPostgres()
    try:
        server.start()
        base = Path(__file__).resolve().parents[1] / "db/migrations"
        for name in (
            "parked/900_personal_agent_registry.sql",
            "parked/906_personal_agent_user_cloud.sql",
            "121_trusted_devices.sql",
        ):
            server.apply_file(base / name)
        server.execute("CREATE TABLE agent_chat_conversations (id UUID PRIMARY KEY)")
        server.execute(
            "CREATE TABLE one_adk_sessions (app_name TEXT, user_id TEXT, session_id TEXT, PRIMARY KEY(app_name,user_id,session_id))"
        )
        for name in (
            "114_one_action_directive_ledger.sql",
            "248_adk_chat_action_authority.sql",
            "parked/945_pod_mcp_action_authority.sql",
            "parked/966_pod_browser_action_authority.sql",
        ):
            server.apply_file(base / name)
        yield server
    finally:
        postgres_harness.MIGRATIONS = old
        server.stop()


@pytest.fixture
def db(pg):
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM one_action_directive_ledger"))
        conn.execute(text("DELETE FROM trusted_devices"))
        conn.execute(text("DELETE FROM personal_agent_registry"))
        conn.execute(
            text(
                "INSERT INTO personal_agent_registry (user_id,hushh_id,status,deployment_target,user_cloud_project,pod_key_id,pod_pubkey,backend_metadata) VALUES ('u','ha1_test','provisioned','user_gcp','synthetic-project','podk_test','public',CAST(:meta AS jsonb))"
            ),
            {
                "meta": json.dumps(
                    {
                        "url": "https://pod.example",
                        "serviceUid": "uid-1",
                        "runtime_service_account": "pod@synthetic.iam.gserviceaccount.com",
                        "ingress": "direct",
                        "directReadiness": {
                            "verified": True,
                            "serviceUid": "uid-1",
                            "podKeyId": "podk_test",
                            "url": "https://pod.example",
                        },
                        "bindings": {"other": {"version": 9}},
                        "retained": "keep",
                    }
                )
            },
        )
        conn.execute(
            text(
                "INSERT INTO trusted_devices (device_id,user_id,device_public_key,device_name,platform,created_at) VALUES ('tdv_test','u','device-public','Synthetic','web',1)"
            )
        )
    yield DatabaseClient(engine)
    engine.dispose()


def record(version=1):
    return {
        "version": version,
        "serviceUid": "uid-1",
        "envelope": {
            "binding": {
                "user_id": "u",
                "subject_id": "tdv_test",
                "subject_public_key": "device-public",
                "platform": "web",
                "hushh_id": "ha1_test",
                "deployment_target": "user_gcp",
                "pod_key_id": "podk_test",
                "pod_public_key": "public",
                "url": "https://pod.example",
                "version": version,
            }
        },
    }


def issue(db, version=1):
    return asyncio.run(
        record_binding(db, user_id="u", device_id="tdv_test", record=record(version))
    )


def revoke(db):
    store = PostgresTrustedDeviceStore.__new__(PostgresTrustedDeviceStore)
    store._db = db
    return store.revoke_device(user_id="u", device_id="tdv_test", now_ms=2)


def publish_endpoint(db, url="https://pod.example"):
    return asyncio.run(
        record_endpoint(
            db,
            user_id="u",
            hushh_id="ha1_test",
            pod_key_id="podk_test",
            pod_public_key="public",
            service_uid="uid-1",
            url=url,
        )
    )


def test_simultaneous_endpoint_discovery_reuses_one_committed_version(db):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: publish_endpoint(db), range(2)))
    assert results == [{"version": 1, "url": "https://pod.example", "podKeyId": "podk_test"}] * 2
    with db.engine.connect() as conn:
        meta = conn.execute(
            text("SELECT backend_metadata FROM personal_agent_registry WHERE user_id='u'")
        ).scalar_one()
    assert meta["retained"] == "keep"
    assert meta["bindings"]["other"] == {"version": 9}


@pytest.mark.parametrize("change", ["replacement", "readiness", "deleted"])
def test_waiting_discovery_cannot_publish_after_authority_changes(db, change):
    assert publish_endpoint(db)["version"] == 1
    reached_lock = threading.Event()

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("SELECT hushh_id"):
            reached_lock.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with db.engine.begin() as conn, ThreadPoolExecutor(max_workers=1) as pool:
            if change == "replacement":
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set(jsonb_set(backend_metadata, '{url}', '\"https://new-pod.example\"'), '{directReadiness,url}', '\"https://new-pod.example\"') WHERE user_id='u'"
                    )
                )
            elif change == "readiness":
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set(backend_metadata, '{directReadiness,verified}', 'false') WHERE user_id='u'"
                    )
                )
            else:
                conn.execute(text("DELETE FROM personal_agent_registry WHERE user_id='u'"))
            result = pool.submit(publish_endpoint, db)
            assert reached_lock.wait(5)
            conn.commit()
            assert result.result(timeout=5) is None
        if change == "replacement":
            assert publish_endpoint(db, "https://new-pod.example")["version"] == 2
            assert publish_endpoint(db) is None
            assert publish_endpoint(db, "https://new-pod.example")["version"] == 2
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_competing_issuers_publish_one_version_and_preserve_other_metadata(db):
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: issue(db), range(2))) == [False, True]
    assert issue(db, 2)
    with db.engine.connect() as conn:
        meta = conn.execute(
            text("SELECT backend_metadata FROM personal_agent_registry WHERE user_id='u'")
        ).scalar_one()
    assert meta["bindings"]["tdv_test"]["version"] == 2
    assert meta["bindings"]["other"] == {"version": 9}
    assert meta["retained"] == "keep"


def test_revocation_commit_while_issuer_waits_prevents_publication(db):
    reached_device = threading.Event()

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("SELECT device_public_key"):
            reached_device.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with db.engine.connect() as conn, ThreadPoolExecutor(max_workers=1) as pool:
            tx = conn.begin()
            conn.execute(
                text("UPDATE trusted_devices SET status='revoked' WHERE device_id='tdv_test'")
            )
            result = pool.submit(issue, db)
            assert reached_device.wait(5)
            tx.commit()
            assert result.result(timeout=5) is False
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_issuer_commit_precedes_waiting_revoke_and_ceiling_is_retained(db):
    publishing = threading.Event()
    release = threading.Event()
    revoking = threading.Event()

    def hold(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("UPDATE personal_agent_registry"):
            publishing.set()
            assert release.wait(5)
        elif statement.startswith("UPDATE trusted_devices"):
            revoking.set()

    event.listen(db.engine, "before_cursor_execute", hold)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            issued = pool.submit(issue, db)
            assert publishing.wait(5)
            revoked = pool.submit(revoke, db)
            assert revoking.wait(5)
            release.set()
            assert issued.result(timeout=5) is True
            assert revoked.result(timeout=5) is True
        assert issue(db, 2) is False
        with db.engine.connect() as conn:
            assert (
                conn.execute(
                    text(
                        "SELECT backend_metadata->'bindings'->'tdv_test'->>'version' FROM personal_agent_registry WHERE user_id='u'"
                    )
                ).scalar_one()
                == "1"
            )
    finally:
        release.set()
        event.remove(db.engine, "before_cursor_execute", hold)


@pytest.mark.parametrize("changed", ["key", "pod", "erasure"])
def test_changed_authority_refuses_signed_candidate(db, changed):
    with db.engine.begin() as conn:
        if changed == "key":
            conn.execute(text("UPDATE trusted_devices SET device_public_key='replaced'"))
        elif changed == "pod":
            conn.execute(text("UPDATE personal_agent_registry SET pod_key_id='replaced'"))
        else:
            conn.execute(
                text(
                    "UPDATE personal_agent_registry SET backend_metadata=backend_metadata || '{\"erasure\":{}}'::jsonb"
                )
            )
    assert issue(db) is False


def test_canonical_trailing_slash_url_is_accepted(db):
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{url}','\" https://pod.example/ \"'::jsonb)"
            )
        )
    assert issue(db)


def test_database_failure_is_sanitized():
    from contextlib import contextmanager
    from types import SimpleNamespace

    from sqlalchemy.exc import OperationalError

    from db.db_client import DatabaseExecutionError

    @contextmanager
    def unavailable():
        raise OperationalError(
            "synthetic SQL", {"sensitive": "must-not-leak"}, Exception("driver details")
        )
        yield

    broken = SimpleNamespace(engine=SimpleNamespace(begin=unavailable))
    with pytest.raises(DatabaseExecutionError) as caught:
        issue(broken)
    assert caught.value.code == "POD_BINDING_STORAGE_UNAVAILABLE"
    assert "must-not-leak" not in str(caught.value)
    assert caught.value.__suppress_context__ is True


def test_courier_acknowledgment_preserves_concurrent_append_and_unknown_entries(db):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    repo = PersonalAgentRegistryRepo()
    repo._db = lambda: db
    a = {"intent": {"intentId": "a"}}
    b = {"intent": {"intentId": "b"}}
    asyncio.run(repo.append_pending_tombstone(user_id="u", entry=a))
    clearing = threading.Event()

    def observe(conn, cursor, statement, parameters, context, executemany):
        if "jsonb_agg(item ORDER BY ordinal)" in statement:
            clearing.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with db.engine.begin() as conn:
                # Hold the row with an append that has not committed when clear
                # starts. Its UPDATE must filter the row after our commit.
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = "
                        "jsonb_set(backend_metadata, '{pendingTombstones}', "
                        "backend_metadata->'pendingTombstones' || CAST(:entries AS jsonb)) "
                        "WHERE user_id='u'"
                    ),
                    {"entries": json.dumps([b, {"unknown": True}])},
                )
                future = pool.submit(
                    lambda: asyncio.run(
                        repo.clear_pending_tombstones(hushh_id="ha1_test", intent_ids=["a"])
                    )
                )
                assert clearing.wait(5)
            future.result(timeout=5)
        row = asyncio.run(repo.get("u"))
        assert row["backend_metadata"]["pendingTombstones"] == [b, {"unknown": True}]
        assert row["backend_metadata"]["retained"] == "keep"
        asyncio.run(repo.clear_pending_tombstones(hushh_id="ha1_test", intent_ids=["a"]))
        assert asyncio.run(repo.get("u"))["backend_metadata"] == row["backend_metadata"]
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_private_mcp_ledger_binds_exact_terms_and_consumes_once_without_hub_history(
    db, monkeypatch
):
    from hushh_mcp.services import pod_binding_service, pod_mcp_approval
    from hushh_mcp.services.action_directive_ledger import (
        ActionDirectiveAuthorityError,
        ActionDirectiveStore,
    )

    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"synthetic-ledger-key")
    )
    principal = pod_mcp_approval.VerifiedOwnerPod(
        "ha1_test", "pod@synthetic.iam.gserviceaccount.com"
    )
    review = pod_mcp_approval.PodMcpTerms(
        ownerId="u",
        hushhId="ha1_test",
        podKeyId="podk_test",
        environment="dev",
        epoch=1,
        conversationId="private-thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
    )

    def invoke(operation, terms, **kwargs):
        return asyncio.run(
            pod_mcp_approval.mutate_review(
                operation,
                pod_mcp_approval.PodMcpMutation(review=terms, **kwargs),
                principal=principal,
                db=db,
            )
        )

    issued = invoke("issue", review)
    bound = pod_mcp_approval.PodMcpTerms.model_validate(issued["podReview"])
    assert bound.serviceUid == "uid-1"
    for field, changed in (
        ("ownerId", "other"),
        ("hushhId", "other"),
        ("podKeyId", "other"),
        ("serviceUid", "other"),
        ("environment", "prod"),
        ("epoch", 2),
        ("conversationId", "other"),
        ("connectorId", "other"),
        ("callId", "other"),
        ("catalogRevision", "rev2"),
        ("commitment", "c" * 64),
    ):
        with pytest.raises(ActionDirectiveAuthorityError):
            invoke(
                "confirm",
                bound.model_copy(update={field: changed}),
                directiveId=issued["directiveId"],
            )
    confirmed = invoke("confirm", bound, directiveId=issued["directiveId"])

    def consume():
        try:
            return invoke(
                "consume", bound, directiveId=issued["directiveId"], receipt=confirmed["receipt"]
            )
        except ActionDirectiveAuthorityError:
            return "refused"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: consume(), range(2)))
    assert outcomes.count({"status": "consumed"}) == 1
    assert outcomes.count("refused") == 1
    with db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar() == 0
        row = conn.execute(text("SELECT * FROM one_action_directive_ledger")).mappings().one()
        assert row["channel"] == "pod_chat" and row["adk_app_name"] is None
        assert row["slots_hmac"] != bound.commitment
    # Rotate only the runtime account after authentication: no issue or consume may commit.
    pending = invoke("issue", review)
    pending_terms = pod_mcp_approval.PodMcpTerms.model_validate(pending["podReview"])
    approved = invoke("confirm", pending_terms, directiveId=pending["directiveId"])
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{runtime_service_account}','\"rotated@synthetic.iam.gserviceaccount.com\"')"
            )
        )
    with pytest.raises(ActionDirectiveAuthorityError, match="runtime identity"):
        invoke("issue", review)
    with pytest.raises(ActionDirectiveAuthorityError, match="runtime identity"):
        invoke(
            "consume",
            pending_terms,
            directiveId=pending["directiveId"],
            receipt=approved["receipt"],
        )
    with db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM one_action_directive_ledger")).scalar() == 2
        assert (
            conn.execute(
                text("SELECT consumed_at FROM one_action_directive_ledger WHERE directive_id=:id"),
                {"id": pending["directiveId"]},
            ).scalar()
            is None
        )
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{runtime_service_account}','\"pod@synthetic.iam.gserviceaccount.com\"')"
            )
        )
    # Replacement of the owner service disarms an otherwise exact pending approval.
    second = invoke("issue", review)
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{serviceUid}','\"replacement\"')"
            )
        )
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke(
            "confirm",
            pod_mcp_approval.PodMcpTerms.model_validate(second["podReview"]),
            directiveId=second["directiveId"],
        )


@pytest.fixture
def private_review(db, monkeypatch):
    from hushh_mcp.services import pod_binding_service, pod_mcp_approval
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore

    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"synthetic-ledger-key")
    )
    principal = pod_mcp_approval.VerifiedOwnerPod(
        "ha1_test", "pod@synthetic.iam.gserviceaccount.com"
    )
    terms = pod_mcp_approval.PodMcpTerms(
        ownerId="u",
        hushhId="ha1_test",
        podKeyId="podk_test",
        environment="dev",
        epoch=1,
        conversationId="private-thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
    )

    def invoke(operation, terms, **kwargs):
        return asyncio.run(
            pod_mcp_approval.mutate_review(
                operation,
                pod_mcp_approval.PodMcpMutation(review=terms, **kwargs),
                principal=principal,
                db=db,
            )
        )

    issued = invoke("issue", terms)
    terms = pod_mcp_approval.PodMcpTerms.model_validate(issued["podReview"])
    return invoke, terms, issued


def test_private_review_restart_is_atomic_idempotent_and_requires_new_confirmation(
    db, private_review
):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    invoke, old, issued = private_review
    confirmation = invoke("confirm", old, directiveId=issued["directiveId"])
    current = old.model_copy(update={"epoch": 2})

    def recover():
        return invoke("rebind", current, previousReview=old, directiveId=issued["directiveId"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, repeated = list(pool.map(lambda _: recover(), range(2)))
    assert first == repeated and first["expiresAt"] == issued["expiresAt"]
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke("consume", old, directiveId=issued["directiveId"], receipt=confirmation["receipt"])
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke(
            "consume", current, directiveId=first["directiveId"], receipt=confirmation["receipt"]
        )
    fresh = invoke("confirm", current, directiveId=first["directiveId"])
    # A lost recovery acknowledgement cannot reset a confirmed successor.
    with pytest.raises(ActionDirectiveAuthorityError):
        recover()
    assert invoke(
        "consume", current, directiveId=first["directiveId"], receipt=fresh["receipt"]
    ) == {"status": "consumed"}
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke(
            "rebind",
            current.model_copy(update={"epoch": 3}),
            previousReview=current,
            directiveId=first["directiveId"],
        )
    with db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM one_action_directive_ledger")).scalar() == 2
        assert conn.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar() == 0


@pytest.mark.parametrize(
    "change", ["commitment", "conversationId", "epoch", "expired", "cancelled", "consumed"]
)
def test_private_review_recovery_cannot_broaden_or_replay(db, private_review, change):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    invoke, old, issued = private_review
    current = old.model_copy(update={"epoch": 2})
    if change in {"commitment", "conversationId", "epoch"}:
        current = current.model_copy(
            update={
                change: {"commitment": "c" * 64, "conversationId": "other-thread", "epoch": 1}[
                    change
                ]
            }
        )
    else:
        assignments = {
            "expired": "expires_at=clock_timestamp() - interval '1s'",
            "cancelled": "state='cancelled',settlement_reason_code='owner_cancelled'",
            "consumed": "state='confirmed',consumed_at=clock_timestamp()",
        }
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_action_directive_ledger SET "
                    + assignments[change]
                    + " WHERE directive_id=:id"
                ),
                {"id": issued["directiveId"]},
            )
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke("rebind", current, previousReview=old, directiveId=issued["directiveId"])
    with db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM one_action_directive_ledger")).scalar() == 1


@pytest.mark.parametrize("damage", ["missing", "changed_expiry", "changed_binding"])
def test_lost_review_acknowledgement_requires_exact_existing_successor(db, private_review, damage):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    invoke, old, issued = private_review
    current = old.model_copy(update={"epoch": 2})
    recovered = invoke("rebind", current, previousReview=old, directiveId=issued["directiveId"])
    with db.engine.begin() as conn:
        statement = {
            "missing": "DELETE FROM one_action_directive_ledger WHERE directive_id=:id",
            "changed_expiry": "UPDATE one_action_directive_ledger SET expires_at=expires_at + interval '1s' WHERE directive_id=:id",
            "changed_binding": "UPDATE one_action_directive_ledger SET slots_hmac='changed' WHERE directive_id=:id",
        }[damage]
        conn.execute(text(statement), {"id": recovered["directiveId"]})
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke("rebind", current, previousReview=old, directiveId=issued["directiveId"])


def test_rebind_insert_failure_rolls_back_original_cancellation(db, private_review):
    invoke, old, issued = private_review

    def fail_insert(_conn, _cursor, statement, _parameters, _context, _many):
        if "INSERT INTO one_action_directive_ledger" in statement:
            raise RuntimeError("Synthetic unavailable ledger")

    event.listen(db.engine, "before_cursor_execute", fail_insert)
    try:
        with pytest.raises(RuntimeError, match="Synthetic"):
            invoke(
                "rebind",
                old.model_copy(update={"epoch": 2}),
                previousReview=old,
                directiveId=issued["directiveId"],
            )
    finally:
        event.remove(db.engine, "before_cursor_execute", fail_insert)
    with db.engine.begin() as conn:
        row = conn.execute(
            text("SELECT state,settlement_reason_code FROM one_action_directive_ledger")
        ).one()
        assert tuple(row) == ("issued", None)


def test_rebind_checks_expiry_after_waiting_for_the_ledger_lock(db, private_review):
    import time

    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    invoke, old, issued = private_review
    waiting = threading.Event()

    def observe(_conn, _cursor, statement, _parameters, _context, _many):
        if "SELECT * FROM one_action_directive_ledger" in statement and "FOR UPDATE" in statement:
            waiting.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with db.engine.begin() as lock:
            lock.execute(text("SELECT directive_id FROM one_action_directive_ledger FOR UPDATE"))
            lock.execute(
                text(
                    "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp() + interval '150 milliseconds'"
                )
            )
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    invoke,
                    "rebind",
                    old.model_copy(update={"epoch": 2}),
                    previousReview=old,
                    directiveId=issued["directiveId"],
                )
                assert waiting.wait(1)
                time.sleep(0.2)
                lock.commit()
                with pytest.raises(ActionDirectiveAuthorityError, match="expired"):
                    future.result(timeout=3)
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


async def test_private_native_mcp_suspend_preview_confirm_resume(
    db, monkeypatch, tmp_path, request
):
    """Real ADK pause/preview/browser approval/resume; fake only model/provider transport."""
    from copy import deepcopy
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from ag_ui.core import EventType, ResumeEntry, RunAgentInput, UserMessage
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from google.adk.agents import LlmAgent
    from google.adk.models.llm_response import LlmResponse
    from google.adk.tools.mcp_tool.mcp_tool import McpTool
    from google.genai import types

    from api.middleware import require_vault_owner_token
    from api.routes import external_connectors
    from api.routes.one import pod_agent_chat
    from api.routes.one import pod_mcp_approval as broker_route
    from db import db_client
    from hushh_mcp import runtime_settings
    from hushh_mcp.one_adk import governed_mcp_toolset as governed
    from hushh_mcp.one_adk import pod_agui_lifetime as lifetime
    from hushh_mcp.one_adk.agui_factory import build_authenticated_agui
    from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
    from hushh_mcp.one_adk.mcp_call_approval import review_private_call
    from hushh_mcp.one_adk.pod_adk_session_repository import (
        PodAdkSessionProjection,
        PodAdkSessionRepository,
    )
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.one_adk.pod_mcp_review import prepare_private_review
    from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
    from hushh_mcp.services import pod_binding_service
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
    from hushh_mcp.services.pod_mcp_approval import PodMcpApprovalPort
    from hushh_mcp.services.pod_request_signing import VerifiedPod
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission
    from tests.helpers.chat_keys import bound_request_chat_key
    from tests.test_adk_specialist_chat_services import _ScriptedModel

    owner_id, hushh_id, thread = "u", "ha1_test", "private-mcp-native"
    connector = "custom_" + "a" * 32
    tool_name = governed.mcp_tool_name(connector, "search")
    private_argument = "SYNTHETIC_PRIVATE_MCP_ARGUMENT"
    configuration = {
        "version": 1,
        "connectorId": connector,
        "revision": "00000000-0000-0000-0000-000000000001",
        "displayName": "Synthetic connector",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {
            "kind": "api_key",
            "header": "Authorization",
            "value": "synthetic-connector-secret",
        },
        # Changed formerly blocked tools require review under the existing policy.
        "blockedTools": [{"id": tool_name, "fingerprint": "0" * 64}],
    }
    monkeypatch.setenv("APP_SIGNING_KEY", "synthetic-pod-signing-key-32-bytes")
    runtime_settings.clear_runtime_settings_caches()
    request.addfinalizer(runtime_settings.clear_runtime_settings_caches)
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"separate-synthetic-hub-ledger-key")
    )
    monkeypatch.setattr(db_client, "get_db", lambda: db)
    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(broker_route, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        broker_route,
        "verify_pod_request",
        AsyncMock(
            return_value=VerifiedPod(
                hushh_id, service_account="pod@synthetic.iam.gserviceaccount.com"
            )
        ),
    )
    native = AsyncMock(return_value={"content": [], "structuredContent": {"count": 1}})
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    provider_session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(
                tools=[
                    SimpleNamespace(
                        name="search",
                        inputSchema={
                            "type": "object",
                            "properties": {"q": {"type": "string"}},
                            "required": ["q"],
                        },
                    )
                ],
                nextCursor=None,
            )
        )
    )
    monkeypatch.setattr(
        governed._GovernedMcpSessionManager,
        "create_session",
        AsyncMock(return_value=provider_session),
    )

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"k" * 32, owner_id=hushh_id)
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    monkeypatch.setattr(lifetime, "ADMISSION", admission)
    monkeypatch.setattr(lifetime, "pod_incarnation", lambda: "synthetic-incarnation")
    owner = PodChatContext.__new__(PodChatContext)
    owner.owner, owner.hushh_id, owner.log = owner_id, hushh_id, log
    owner.claims = {"user_id": owner_id, "hushh_id": hushh_id}
    owner.require_access = AsyncMock()
    from hushh_mcp.services.pod_action_checkpoints import MCP_OBJECT, PodActionCheckpointStorage
    from hushh_mcp.services.pod_mcp_pending import PodMcpPendingStore

    def recovery_store():
        return PodMcpPendingStore(
            PodActionCheckpointStorage(
                owner=owner_id,
                hushh_id=hushh_id,
                store=log._store,
                require_access=owner.require_access,
                slot=MCP_OBJECT,
            )
        )

    owner.mcp_pending = recovery_store()
    owner.runtime = SimpleNamespace(owner_user_id=owner_id)
    owner.authority = SimpleNamespace(
        pod_key_id="podk_test",
        environment="dev",
        epoch=1,
        lease=SimpleNamespace(state=AsyncMock(return_value="held")),
        local_token=lambda _: "synthetic-local-session-authority",
    )
    owner.sessions = EncryptedAdkSessionService(
        repository=PodAdkSessionRepository(
            projection=PodAdkSessionProjection(owner_id=owner_id, hushh_id=hushh_id, log=log),
            require_access=owner.require_access,
        )
    )
    model = _ScriptedModel(
        [
            LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name=tool_name, args={"q": private_argument}
                            )
                        )
                    ],
                )
            ),
            LlmResponse(
                content=types.Content(role="model", parts=[types.Part.from_text(text="Completed.")])
            ),
        ]
    )

    def make_agent():
        agent = build_authenticated_agui(
            LlmAgent(
                name="one",
                model=model,
                instruction="Use the requested connector tool.",
                tools=[RegisteredMcpToolset(authorize_call=review_private_call)],
            ),
            owner.sessions,
            app_name="hussh_one",
            user_id_extractor=lambda _: owner_id,
            agent_class=lifetime.PodTimedADKAgent,
            max_concurrent_executions=1,
        )
        agent.configure_pod_turn(
            require_access=owner.require_access,
            runtime_scope=owner.runtime_scope,
            mcp_owner_admission=owner._mcp_owner_admission,
        )
        return agent

    def make_input(run_id, messages, *, approval=None, resume=None):
        forwarded = {"mcpConfigurations": [deepcopy(configuration)]}
        if approval is not None:
            forwarded["mcpApproval"] = approval
        value = RunAgentInput(
            thread_id=thread,
            run_id=run_id,
            state={},
            messages=messages,
            tools=[],
            context=[],
            forwarded_props=forwarded,
            resume=resume,
        )
        state, _ = pod_agent_chat.trusted_state(value, owner)
        return value.model_copy(update={"state": state, "forwarded_props": {}})

    app = FastAPI()
    app.include_router(broker_route.router)
    app.include_router(external_connectors.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": owner_id,
        "token": "synthetic-browser-authority",
    }
    machine_requests = []
    lose_rebind_response = True
    with bound_request_chat_key(owner_id), TestClient(app) as hub:

        def pod_post(path, *, json):
            nonlocal lose_rebind_response
            machine_requests.append((path, deepcopy(json)))
            response = hub.post(path, json=json)
            if path.endswith("/rebind") and response.status_code == 200 and lose_rebind_response:
                from hushh_mcp.services.pod_hub_client import PodHubUnavailable

                lose_rebind_response = False
                raise PodHubUnavailable("Synthetic lost acknowledgement")
            return response

        owner.mcp_approval = PodMcpApprovalPort(owner, client=SimpleNamespace(post=pod_post))
        first = [
            event
            async for event in make_agent().run(
                make_input(
                    "first",
                    [UserMessage(id="user-1", role="user", content="Search synthetic records.")],
                )
            )
        ]
        assert not any(event.type == EventType.RUN_ERROR for event in first)
        finished = next(event for event in reversed(first) if event.type == EventType.RUN_FINISHED)
        assert finished.outcome.type == "interrupt"
        native.assert_not_awaited()
        assert (await admission.status(incarnation="synthetic-incarnation"))["activeWork"] == 0
        interrupt = finished.outcome.interrupts[0]
        encoded = "".join(
            event.delta
            for event in first
            if event.type == EventType.TOOL_CALL_ARGS
            and event.tool_call_id == interrupt.tool_call_id
        )
        reference = json.loads(encoded)["toolConfirmation"]["payload"]
        assert private_argument not in encoded
        # Drop every request-local secret and reconstruct the keyed recovery
        # adapter, native session repository and process epoch before review.
        from hushh_mcp.one_adk import request_secrets
        from hushh_mcp.one_adk.pod_mcp_restore import pending_reviews, restore_resume

        request_secrets._values.clear()
        owner.mcp_pending = recovery_store()
        owner.sessions = EncryptedAdkSessionService(
            repository=PodAdkSessionRepository(
                projection=PodAdkSessionProjection(owner_id=owner_id, hushh_id=hushh_id, log=log),
                require_access=owner.require_access,
            )
        )
        owner.authority.epoch = 2
        restored_session = await owner.sessions.get_session(
            app_name="hussh_one", user_id=owner_id, session_id=thread
        )
        recovered_review = await pending_reviews(owner, restored_session)
        assert len(recovered_review) == 1 and recovered_review[0]["interruptId"] == interrupt.id
        assert private_argument not in json.dumps(recovered_review)
        review_body = external_connectors.McpReviewRequest(
            conversationId=thread,
            toolName=tool_name,
            arguments={},
            pendingHandle=reference["pendingHandle"],
            connectorConfiguration=configuration,
            directiveId=reference["directiveId"],
        )
        from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

        with pytest.raises(ActionDirectiveAuthorityError):
            await prepare_private_review(owner, connector, review_body)
        owner.mcp_pending = recovery_store()
        owner.authority.epoch = 3
        preview = await prepare_private_review(
            owner,
            connector,
            review_body,
        )
        assert preview["arguments"] == {"q": private_argument}
        assert preview["directiveId"] != reference["directiveId"]
        assert preview["expiresAt"] == reference["expiresAt"]
        assert preview["replacesDirectiveId"] == reference["directiveId"]
        native.assert_not_awaited()
        confirmed = hub.post(
            f"/api/connectors/{connector}/mcp/confirm",
            json={
                "podReview": preview["podReview"],
                "directiveId": preview["directiveId"],
                "confirmed": True,
            },
        )
        assert confirmed.status_code == 200
        receipt = confirmed.json()["receipt"]
        with db.engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT state FROM one_action_directive_ledger WHERE directive_id=:id"),
                    {"id": preview["directiveId"]},
                ).scalar_one()
                == "confirmed"
            )
        native.assert_not_awaited()
        approval = {
            key: reference[key]
            for key in ("directiveId", "connectorId", "toolName", "pendingHandle")
        }
        approval["directiveId"] = preview["directiveId"]
        second = [
            event
            async for event in make_agent().run(
                await restore_resume(
                    owner,
                    make_input(
                        "resume",
                        [],
                        approval={**approval, "receipt": receipt},
                        resume=[
                            ResumeEntry(
                                interrupt_id=interrupt.id,
                                status="resolved",
                                payload={"confirmed": True},
                            )
                        ],
                    ),
                )
            )
        ]
        assert not any(event.type == EventType.RUN_ERROR for event in second)
        assert any(event.type == EventType.RUN_FINISHED for event in second)
        native.assert_awaited_once()
        assert native.await_args.kwargs["args"] == {"q": private_argument}
        recovered = await owner.sessions.get_session(
            app_name="hussh_one", user_id=owner_id, session_id=thread
        )
        assert recovered is not None and private_argument not in recovered.model_dump_json()
        assert private_argument not in json.dumps(machine_requests)
        assert "synthetic-connector-secret" not in json.dumps(machine_requests)
        assert [path.rsplit("/", 1)[-1] for path, _ in machine_requests] == [
            "issue",
            "rebind",
            "rebind",
            "rebind",
            "consume",
        ]
        with db.engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT state FROM one_action_directive_ledger WHERE directive_id=:id"),
                    {"id": preview["directiveId"]},
                ).scalar_one()
                == "consumed"
            )
            assert conn.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar_one() == 0
        assert (await admission.status(incarnation="synthetic-incarnation"))["activeWork"] == 0


def test_browser_review_requires_owner_receipt_and_keeps_private_terms_off_hub(
    db, pg, monkeypatch, tmp_path
):
    """Real registry/ledger CAS with only the HTTP hop replaced by an in-memory client."""
    import time
    from types import SimpleNamespace

    from hushh_mcp.services import pod_binding_service
    from hushh_mcp.services.action_directive_ledger import (
        ActionDirectiveAuthorityError,
        ActionDirectiveStore,
    )
    from hushh_mcp.services.pod_browser.contracts import BrowserBinding, BrowserRefused
    from hushh_mcp.services.pod_browser.review_client import PodBrowserReviews
    from hushh_mcp.services.pod_browser.review_contracts import BrowserHubMutation
    from hushh_mcp.services.pod_browser.review_ledger import mutate_browser_review
    from hushh_mcp.services.pod_request_signing import VerifiedPod

    # Dev schema replay preserves existing receipts and the explicit action wall.
    pg.apply_file(
        Path(__file__).resolve().parents[1]
        / "db/migrations/parked/966_pod_browser_action_authority.sql"
    )
    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"synthetic-ledger-key")
    )
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE personal_agent_registry ADD COLUMN IF NOT EXISTS pod_signing_key_id TEXT"
            )
        )
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET pod_signing_key_id='signed-test' WHERE user_id='u'"
            )
        )
    principal = VerifiedPod("ha1_test", key_id="signed-test")
    bound = BrowserBinding(
        owner_id="u",
        pod_id="ha1_test",
        incarnation="revision-a",
        task_id="browser-task",
        environment="development",
        expires_at=int(time.time()) + 600,
    )
    calls = []
    lose_consume = False
    fail_issue = False
    revoked = False
    fail_before_consume = [False]

    async def admission(binding):
        if revoked or binding != bound:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")

    def post(path, json):
        nonlocal lose_consume, fail_issue
        operation = path.rsplit("/", 1)[-1]
        calls.append((operation, json))
        if operation == "issue" and fail_issue:
            fail_issue = False
            raise OSError("synthetic transient issuance failure")
        if operation == "consume" and fail_before_consume[0]:
            fail_before_consume[0] = False
            raise OSError("synthetic failure before ledger admission")
        result = asyncio.run(
            mutate_browser_review(
                operation, BrowserHubMutation.model_validate(json), principal=principal, db=db
            )
        )
        if operation == "consume" and lose_consume:
            lose_consume = False
            raise OSError("synthetic response lost after durable commit")
        raw = __import__("json").dumps(result).encode()
        return SimpleNamespace(
            status_code=200, content=raw, json=lambda: result, close=lambda: None
        )

    reviews = PodBrowserReviews(
        key=b"r" * 32,
        pod_key_id="podk_test",
        environment="dev",
        epoch=1,
        check_binding=admission,
        client=SimpleNamespace(post=post),
    )

    async def scenario():
        nonlocal lose_consume, fail_issue, revoked
        terms = {"task_goal": "private synthetic goal", "model": "synthetic-model"}
        # Live dev had 945/966 receipts, then canonical 248 replay replaced the
        # channel checks. Reproduce the actual first-review refusal before repair.
        base = Path(__file__).resolve().parents[1] / "db/migrations"
        pg.apply_file(base / "248_adk_chat_action_authority.sql")
        with pytest.raises(BrowserRefused, match="REVIEW_UNAVAILABLE"):
            await reviews.offer_review(bound, "model_process", terms)
        with db.engine.connect() as conn:
            assert (
                conn.execute(text("SELECT count(*) FROM one_action_directive_ledger")).scalar() == 0
            )
        pg.apply_file(base / "parked/971_private_action_channel_continuity.sql")
        offer = await reviews.offer_review(bound, "model_process", terms)
        assert offer.coordination.service_uid == "uid-1"
        # Real base replay runs on every dev deployment. Preserve the exact
        # successor and its existing review rows while retaining unrelated DDL.
        from db.migration_authority import _replay_sql, build_manifest_entries

        pg.execute(
            "ALTER TABLE one_adk_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()"
        )
        entries = build_manifest_entries(
            base,
            (
                "212_location_command_runtime.sql",
                "231_document_review_authority.sql",
                "248_adk_chat_action_authority.sql",
            ),
        )
        for _ in range(2):
            for entry in entries:
                pg.execute(_replay_sql(entry))
        with db.engine.connect() as conn:
            assert (
                conn.execute(text("SELECT count(*) FROM one_action_directive_ledger")).scalar() == 1
            )
            assert (
                conn.execute(
                    text(
                        "SELECT count(*) FROM pg_constraint WHERE conrelid='one_action_directive_ledger'::regclass AND conname IN ('document_review_identity_required','adk_chat_action_identity','adk_chat_action_session_fk')"
                    )
                ).scalar()
                == 3
            )
        # Ledger approval expiry is shorter than the task lifetime. A refresh
        # presents a new directive; it does not silently approve the new terms.
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp()-interval '1 second'"
                )
            )
        reviews._pending[offer.review_id].approval_expires_at = time.time() - 1
        fail_issue = True
        with pytest.raises(BrowserRefused, match="REVIEW_UNAVAILABLE"):
            await reviews.refresh_review(bound, offer.review_id)
        assert offer.review_id in reviews._pending
        refreshed = await reviews.refresh_review(bound, offer.review_id)
        assert refreshed.review_id != offer.review_id and refreshed.terms == terms
        offer = refreshed
        with pytest.raises(BrowserRefused, match="OWNER_APPROVAL_REQUIRED"):
            await reviews.require(bound, "model_process", terms)
        with pytest.raises(ActionDirectiveAuthorityError, match="Owner confirmation"):
            await mutate_browser_review(
                "confirm",
                BrowserHubMutation(review=offer.coordination, directive_id=offer.review_id),
                principal=principal,
                db=db,
            )
        for changed in (
            offer.coordination.model_copy(update={"commitment": "c" * 64}),
            offer.coordination.model_copy(update={"epoch": 2}),
            offer.coordination.model_copy(update={"service_uid": "replaced"}),
            offer.coordination.model_copy(
                update={"binding": bound.model_copy(update={"incarnation": "replaced"})}
            ),
            offer.coordination.model_copy(
                update={"binding": bound.model_copy(update={"expires_at": 1})}
            ),
        ):
            with pytest.raises(ActionDirectiveAuthorityError):
                await mutate_browser_review(
                    "confirm",
                    BrowserHubMutation(review=changed, directive_id=offer.review_id),
                    db=db,
                )
        confirmed = await mutate_browser_review(
            "confirm",
            BrowserHubMutation(review=offer.coordination, directive_id=offer.review_id),
            db=db,
        )
        # A lost hub response or client remount can recover only the same
        # authenticated exact confirmation, without replacing its receipt.
        assert confirmed == await mutate_browser_review(
            "confirm",
            BrowserHubMutation(review=offer.coordination, directive_id=offer.review_id),
            db=db,
        )
        lose_consume = True
        with pytest.raises(BrowserRefused, match="REVIEW_UNAVAILABLE"):
            await reviews.confirm_review(bound, offer.review_id, confirmed["receipt"])
        with db.engine.connect() as conn:
            consumed_receipt = conn.execute(
                text(
                    "SELECT consumed_at,expires_at FROM one_action_directive_ledger WHERE directive_id=:id"
                ),
                {"id": offer.review_id},
            ).one()
        await reviews.confirm_review(bound, offer.review_id, confirmed["receipt"])
        assert sum(op == "consume" for op, _ in calls) == 2
        with db.engine.connect() as conn:
            assert (
                consumed_receipt
                == conn.execute(
                    text(
                        "SELECT consumed_at,expires_at FROM one_action_directive_ledger WHERE directive_id=:id"
                    ),
                    {"id": offer.review_id},
                ).one()
            )
        assert confirmed == await mutate_browser_review(
            "confirm",
            BrowserHubMutation(review=offer.coordination, directive_id=offer.review_id),
            db=db,
        )
        await reviews.require(bound, "model_process", terms)
        await reviews.require(bound, "model_process", terms)
        with pytest.raises(BrowserRefused, match="OWNER_APPROVAL_REQUIRED"):
            await reviews.require(bound, "model_process", {**terms, "model": "changed"})
        disclosure = await reviews.offer_review(
            bound, "disclose", {"destination": "private synthetic destination"}
        )
        confirmed = await mutate_browser_review(
            "confirm",
            BrowserHubMutation(review=disclosure.coordination, directive_id=disclosure.review_id),
            db=db,
        )
        await reviews.confirm_review(bound, disclosure.review_id, confirmed["receipt"])
        await reviews.require(bound, "disclose", {"destination": "private synthetic destination"})
        with pytest.raises(BrowserRefused, match="OWNER_APPROVAL_REQUIRED"):
            await reviews.require(
                bound, "disclose", {"destination": "private synthetic destination"}
            )
        fresh = await reviews.offer_review(
            bound, "disclose", {"destination": "private synthetic destination"}
        )
        assert fresh.review_id != disclosure.review_id
        fresh_mutation = BrowserHubMutation(review=fresh.coordination, directive_id=fresh.review_id)
        fresh_confirmation = await mutate_browser_review("confirm", fresh_mutation, db=db)
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp()-interval '1 second' WHERE directive_id=:id"
                ),
                {"id": fresh.review_id},
            )
        with pytest.raises(ActionDirectiveAuthorityError):
            await mutate_browser_review(
                "consume",
                fresh_mutation.model_copy(update={"receipt": fresh_confirmation["receipt"]}),
                principal=principal,
                db=db,
            )
        revoked = True
        with pytest.raises(BrowserRefused, match="BINDING_REFUSED"):
            await reviews.require(bound, "model_process", terms)
        await reviews.release(bound)
        assert not reviews._pending

    asyncio.run(scenario())
    asyncio.run(
        _composed_browser_owner_journey(db, monkeypatch, tmp_path, post, fail_before_consume)
    )
    assert "private synthetic" not in json.dumps(calls)
    with db.engine.begin() as conn:
        rows = conn.execute(text("SELECT * FROM one_action_directive_ledger")).mappings().all()
        assert "private synthetic" not in str(rows)
        assert all(row["channel"] == "pod_chat" for row in rows)
        assert conn.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar() == 0
    from sqlalchemy.exc import IntegrityError

    for mutation in (
        "action_id='browser.arbitrary'",
        "requires_confirmation=FALSE",
        "trusted_activation_required=FALSE",
    ):
        with pytest.raises(IntegrityError, match="pod_chat_action_identity"):
            with db.engine.begin() as conn:
                conn.execute(text("UPDATE one_action_directive_ledger SET " + mutation))


@pytest.mark.parametrize(
    "drift", ["missing_marker", "unvalidated", "changed_identity", "missing_prerequisite"]
)
def test_private_channel_replay_refuses_unqualified_successor(db, pg, drift):
    from sqlalchemy.exc import DBAPIError

    from db.migration_authority import _replay_sql, build_manifest_entries

    base = Path(__file__).resolve().parents[1] / "db/migrations"
    forward = base / "parked/971_private_action_channel_continuity.sql"
    pg.apply_file(forward)
    entry = build_manifest_entries(base, ("248_adk_chat_action_authority.sql",))[0]
    with db.engine.connect() as conn:
        transaction = conn.begin()
        try:
            if drift == "missing_marker":
                conn.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS schema_migrations(migration_id TEXT, status TEXT)"
                    )
                )
                conn.execute(text("INSERT INTO schema_migrations VALUES ('971','applied')"))
                for name in (
                    "one_action_directive_ledger_channel_check",
                    "one_action_directive_ledger_check",
                ):
                    conn.execute(
                        text(f"COMMENT ON CONSTRAINT {name} ON one_action_directive_ledger IS NULL")
                    )
            elif drift == "unvalidated":
                definition = conn.execute(
                    text(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='one_action_directive_ledger'::regclass AND conname='one_action_directive_ledger_check'"
                    )
                ).scalar()
                conn.execute(
                    text(
                        "ALTER TABLE one_action_directive_ledger DROP CONSTRAINT one_action_directive_ledger_check"
                    )
                )
                conn.exec_driver_sql(
                    "ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_check "
                    + definition
                    + " NOT VALID"
                )
                conn.execute(
                    text(
                        "COMMENT ON CONSTRAINT one_action_directive_ledger_check ON one_action_directive_ledger IS 'private-action-channel.v1/971'"
                    )
                )
            else:
                conn.execute(
                    text(
                        "ALTER TABLE one_action_directive_ledger DROP CONSTRAINT pod_chat_action_identity"
                    )
                )
                conn.execute(
                    text(
                        "ALTER TABLE one_action_directive_ledger ADD CONSTRAINT pod_chat_action_identity CHECK (TRUE)"
                    )
                )
            with pytest.raises(
                DBAPIError,
                match="authority is required|successor constraints changed|successor marker missing",
            ):
                conn.exec_driver_sql(
                    forward.read_text() if drift == "missing_prerequisite" else _replay_sql(entry)
                )
        finally:
            transaction.rollback()


def test_private_channel_rollback_preserves_review_history(db, pg):
    from sqlalchemy.exc import DBAPIError

    base = Path(__file__).resolve().parents[1] / "db/migrations"
    forward = base / "parked/971_private_action_channel_continuity.sql"
    down = base / "rollback/971_private_action_channel_continuity.rollback.sql"
    pg.apply_file(forward)
    pg.apply_file(down)
    pg.apply_file(forward)
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO one_action_directive_ledger(directive_id,user_id,channel,session_id,action_id,context_revision,action_contract_digest,slots_hmac,resource_binding_hmac,trusted_activation_required,expires_at) VALUES ('dir_retained','u','pod_chat','retained-task','browser.model_process','revision',:digest,:digest,:digest,TRUE,now()+interval '5 minutes')"
            ),
            {"digest": "a" * 64},
        )
    with pytest.raises(DBAPIError, match="Private review history must be retained"):
        with db.engine.begin() as conn:
            conn.exec_driver_sql(down.read_text())
    with db.engine.connect() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM one_action_directive_ledger WHERE directive_id='dir_retained'"
                )
            ).scalar()
            == 1
        )


async def _composed_browser_owner_journey(db, monkeypatch, tmp_path, post, fail_before_consume):
    """Real composition, ledger and sealed log; no cloud/model acceptance claim."""
    from hushh_mcp.one_adk.computer_use_agent import browser_task_invocation, start_browser_task
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
    from hushh_mcp.services.pod_browser.contracts import BrowserRefused
    from hushh_mcp.services.pod_browser.review_contracts import BrowserHubMutation
    from hushh_mcp.services.pod_browser.review_ledger import mutate_browser_review
    from tests.helpers.pod_browser_composition import composed_browser_fixture, wait_phase

    fixture = composed_browser_fixture(monkeypatch, tmp_path, post)
    owner = fixture.owner
    try:
        runtime = await fixture.composed.bind(owner)
        with browser_task_invocation(runtime, owner):
            created = await start_browser_task(
                "composed-request", "private synthetic research", ["https://example.com"]
            )
        assert created["status"] == "accepted" and "summary" not in created, created
        task_id = created["binding"]["task_id"]

        waiting = await wait_phase(runtime, owner, task_id, "needs_owner")
        assert waiting.review.purpose == "model_process"
        assert fixture.launcher.launch.await_count == 0 and not fixture.model_calls
        mutation = BrowserHubMutation(
            review=waiting.review.coordination, directive_id=waiting.review.review_id
        )
        with db.engine.begin() as conn:
            conn.execute(text("UPDATE personal_agent_registry SET pod_key_id='replacement'"))
        with pytest.raises(ActionDirectiveAuthorityError):
            await mutate_browser_review("confirm", mutation, db=db)
        assert fixture.launcher.launch.await_count == 0 and not fixture.model_calls
        with db.engine.begin() as conn:
            conn.execute(text("UPDATE personal_agent_registry SET pod_key_id='podk_test'"))
        confirmed = await mutate_browser_review("confirm", mutation, db=db)
        fail_before_consume[0] = True
        with pytest.raises(BrowserRefused, match="REVIEW_UNAVAILABLE"):
            await runtime.confirm_review(
                owner, task_id, waiting.review.review_id, confirmed["receipt"]
            )
        assert fixture.launcher.launch.await_count == 0 and not fixture.model_calls
        await runtime.confirm_review(owner, task_id, waiting.review.review_id, confirmed["receipt"])
        completed = await wait_phase(runtime, owner, task_id, "completed")
        assert fixture.launcher.launch.await_count == 1 and len(fixture.model_calls) == 1
        assert (await runtime.list_tasks(owner))[0].binding == completed.binding
        with browser_task_invocation(runtime, owner):
            duplicate = await start_browser_task(
                "composed-request", "private synthetic research", ["https://example.com"]
            )
        assert duplicate["binding"] == created["binding"]
        assert fixture.launcher.launch.await_count == 1 and len(fixture.model_calls) == 1
        # Completed means the owner can start another task immediately, while
        # retrying the original request still returns its single terminal receipt.
        assert fixture.admission._states["revision-a"].active == 0
        assert (await runtime.read(owner, task_id)).control_owner == "stopped"
        with pytest.raises(BrowserRefused, match="CONTROL_UNAVAILABLE"):
            await runtime.control(owner, task_id, "takeover", completed.control_epoch)
        with browser_task_invocation(runtime, owner):
            next_task = await start_browser_task(
                "composed-next-request", "another synthetic research", ["https://example.com"]
            )
        assert next_task["binding"]["task_id"] != task_id
        await wait_phase(runtime, owner, next_task["binding"]["task_id"], "needs_owner")
        assert fixture.launcher.launch.await_count == 1 and len(fixture.model_calls) == 1
        # The real update admission owns joined Browser teardown and sealed idle.
        await fixture.admission.prepare(operation_id="synthetic-update", incarnation="revision-a")
        idle = await fixture.admission.wait_idle(
            operation_id="synthetic-update", incarnation="revision-a", timeout=1
        )
        assert idle["state"] == "idle" and idle["activeWork"] == 0 and idle["idleReceipt"]
        assert fixture.executor.calls.count("close") == 1
        assert "private synthetic research" not in str(await fixture.log.replay())
    finally:
        await fixture.composed.close()
    fixture.launcher.close.assert_awaited_once()
