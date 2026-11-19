"""Feed must reflect one canonical outcome, without implying saved information."""

import asyncio
import json
import uuid
from contextvars import ContextVar

import pytest
from fastapi import HTTPException

from api.routes.kai import import_run_manager, run_manager, stream
from tests.test_feed_account_session_postgres import feed_db as feed_db


class Request:
    async def is_disconnected(self):
        return False


def frame(event, terminal=True):
    return {
        "event": event,
        "id": "1",
        "data": json.dumps(
            {"event": event, "terminal": terminal, "payload": {"private": "never-in-feed"}}
        ),
    }


def setup_run(monkeypatch, importing):
    module = import_run_manager if importing else run_manager
    calls = []

    class Feed:
        def record_event(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(module, "FeedService", Feed, raising=False)
    if importing:
        manager = module.KaiPortfolioImportRunManager(store=False)
        run = module.PortfolioImportRunRecord(
            run_id="run",
            user_id="owner",
            filename="private.pdf",
            content=b"private",
            is_csv_upload=False,
        )
    else:
        manager = module.KaiAnalyzeRunManager(store=False)
        run = module.AnalyzeRunRecord(
            run_id="run",
            user_id="owner",
            debate_session_id="session",
            ticker="AAPL",
            risk_profile="balanced",
            context=None,
            consent_token=f"consent_{uuid.uuid4().hex}",
        )
    return manager, run, calls, module


@pytest.mark.parametrize("importing", [False, True])
def test_first_terminal_is_delivered_once_and_end_cursor_is_not_delivery(monkeypatch, importing):
    manager, run, calls, _ = setup_run(monkeypatch, importing)

    async def scenario():
        await manager._append_frame(run, frame("complete" if importing else "decision"))
        await manager._append_frame(run, frame("error"))
        assert run.status == "completed" and len(run.events) == 1
        assert [
            f async for f in manager.stream_run_events(run=run, start_cursor=1, request=Request())
        ] == []
        assert not run.terminal_delivered and calls == []
        assert (
            len(
                [
                    f
                    async for f in manager.stream_run_events(
                        run=run, start_cursor=0, request=Request()
                    )
                ]
            )
            == 1
        )
        assert (
            len(
                [
                    f
                    async for f in manager.stream_run_events(
                        run=run, start_cursor=0, request=Request()
                    )
                ]
            )
            == 1
        )

    asyncio.run(scenario())
    assert run.terminal_delivered and calls == []


@pytest.mark.parametrize("importing", [False, True])
@pytest.mark.parametrize("outcome", ["error", "aborted", "missing", "crash", "unknown"])
def test_worker_terminal_outcome_without_an_attached_stream(monkeypatch, importing, outcome):
    manager, run, calls, _ = setup_run(monkeypatch, importing)

    async def generator(*args):
        if outcome == "crash":
            raise RuntimeError("private-provider-error")
        if outcome != "missing":
            yield frame(outcome)

    asyncio.run(manager._run_worker(run, generator))
    expected = "canceled" if outcome == "aborted" else "failed"
    assert run.status == expected and run.terminal_frame is not None
    assert calls == []


@pytest.mark.parametrize("importing", [False, True])
def test_completion_wins_over_cancel_intent_and_late_generator_error(monkeypatch, importing):
    manager, run, calls, _ = setup_run(monkeypatch, importing)
    run.cancel_event.set()
    context = ContextVar("worker_context")
    cleanup = []

    async def generator(*args):
        token = context.set("owner")
        try:
            yield frame("complete" if importing else "decision")
            raise RuntimeError("late-private-error")
        finally:
            context.reset(token)
            cleanup.append(True)

    asyncio.run(manager._run_worker(run, generator))
    assert run.status == "completed" and len(run.events) == 1
    assert calls == (
        []
        if importing
        else [
            {
                "user_id": "owner",
                "source_domain": "kai",
                "event_type": "kai_analysis_completed",
                "actor_label": "Kai",
                "metadata": {"run_id": "run", "ticker": "AAPL"},
                "source_row_id": "run",
            }
        ]
    )
    assert cleanup == [True]


@pytest.mark.asyncio
async def test_feed_result_checks_run_owner_and_completed_state(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    run = SimpleNamespace(user_id="owner", run_id="run-1", status="completed", ticker="AAPL")
    monkeypatch.setattr(stream._RUN_MANAGER, "get_run", AsyncMock(return_value=run))
    from contextlib import asynccontextmanager

    from api.routes.kai.analysis_report_availability import SharedReportReceipt

    receipt = SharedReportReceipt(
        reportTicker="AAPL",
        libraryId="11111111-1111-4111-8111-111111111111",
        namespace="a" * 64,
        objectId="b" * 64,
        generation="1",
        leaseId="22222222-2222-4222-8222-222222222222",
    )

    @asynccontextmanager
    async def confirmed(request, owner, observed):
        assert owner == "owner" and observed is receipt
        yield

    monkeypatch.setattr(stream, "confirmed_report_object", confirmed)
    record = AsyncMock()
    monkeypatch.setattr(
        stream,
        "FeedService",
        lambda: SimpleNamespace(
            record_saved_analysis=record,
            completed_analysis_source=lambda owner, run: (
                "AAPL" if owner == "owner" and run == "run-1" else None
            ),
        ),
    )

    def owner_token(*, user_id, token_data):
        assert token_data["user_id"] == user_id

    monkeypatch.setattr(stream, "_require_stream_owner_token", owner_token)
    with pytest.raises(HTTPException) as wrong_owner:
        await stream.analyze_run_feed_result(
            "run-1", Request(), receipt, "other", {"user_id": "other"}
        )
    assert wrong_owner.value.status_code == 404
    run.status = "failed"
    with pytest.raises(HTTPException) as failed:
        await stream.analyze_run_feed_result(
            "run-1", Request(), receipt, "owner", {"user_id": "owner"}
        )
    assert failed.value.status_code == 409
    record.assert_not_called()

    run.status = "completed"
    await stream.analyze_run_feed_result("run-1", Request(), receipt, "owner", {"user_id": "owner"})
    record.assert_awaited_once_with("owner", "run-1", "AAPL", connection=None)
    record.side_effect = RuntimeError("database unavailable")
    with pytest.raises(HTTPException) as unavailable:
        await stream.analyze_run_feed_result(
            "run-1", Request(), receipt, "owner", {"user_id": "owner"}
        )
    assert unavailable.value.status_code == 503

    record.side_effect = None
    monkeypatch.setattr(stream._RUN_MANAGER, "get_run", AsyncMock(return_value=None))
    assert await stream.analyze_run_feed_result(
        "run-1", Request(), receipt, "owner", {"user_id": "owner"}
    ) == {"status": "ok"}
    with pytest.raises(HTTPException) as unknown:
        await stream.analyze_run_feed_result(
            "unknown", Request(), receipt, "owner", {"user_id": "owner"}
        )
    assert unknown.value.status_code == 404


@pytest.mark.asyncio
async def test_shared_report_ack_checks_current_owner_library_generation_and_lease(monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from api.routes.kai.analysis_report_availability import (
        SharedReportReceipt,
        confirmed_report_object,
    )
    from api.routes.one import shared_files
    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files import registry

    receipt = SharedReportReceipt(
        reportTicker="AAPL",
        libraryId="11111111-1111-4111-8111-111111111111",
        namespace="a" * 64,
        objectId="b" * 64,
        generation="5",
        leaseId="22222222-2222-4222-8222-222222222222",
    )
    provider = AsyncMock(return_value=(b"ciphertext", "5"))
    store = SimpleNamespace(get_bounded_with_generation=provider)
    select = AsyncMock(return_value=(store, {"user_id": "owner", "library_id": receipt.libraryId}))
    monkeypatch.setattr(shared_files, "_store", select)
    monkeypatch.setattr(shared_files, "_security", AsyncMock())
    owner_check = AsyncMock()
    monkeypatch.setattr(shared_files, "_fresh_owner", owner_check)

    @asynccontextmanager
    async def held(owner, library, lease):
        assert owner == "owner" and library == receipt.libraryId and lease == receipt.leaseId
        yield

    monkeypatch.setattr(registry, "locked_lease", held)
    async with confirmed_report_object(Request(), "owner", receipt):
        pass
    select.assert_awaited_once_with("owner", receipt.libraryId, create=False)
    owner_check.assert_awaited_once()
    for result in [(None, ""), (b"other-generation", "6")]:
        provider.return_value = result
        with pytest.raises(HTTPException) as changed:
            async with confirmed_report_object(Request(), "owner", receipt):
                pass
        assert changed.value.status_code == 409
    provider.return_value = (b"ciphertext", "5")

    @asynccontextmanager
    async def stale(*_args):
        raise FilesRefused("FILES_LIBRARY_CHANGED", 409)
        yield

    monkeypatch.setattr(registry, "locked_lease", stale)
    with pytest.raises(HTTPException) as stale_lease:
        async with confirmed_report_object(Request(), "owner", receipt):
            pass
    assert stale_lease.value.status_code == 409


@pytest.mark.asyncio
async def test_existing_only_report_storage_lookup_never_enrolls(monkeypatch):
    from unittest.mock import AsyncMock, Mock

    from api.routes.one import shared_files
    from hushh_mcp.services.shared_files import bucket_admission, registry

    monkeypatch.setenv("HUSSH_SHARED_FILES_ENABLED", "true")
    monkeypatch.setenv("HUSSH_SHARED_FILES_BUCKET", "synthetic-private-files")
    source = AsyncMock(return_value=None)
    observe = AsyncMock()
    factory = Mock()
    monkeypatch.setattr(registry, "resource", source)
    monkeypatch.setattr(bucket_admission, "observe", observe)
    monkeypatch.setattr(shared_files, "_configured_store", factory)
    with pytest.raises(HTTPException) as missing:
        await shared_files._store("owner", create=False)
    assert missing.value.detail == {"code": "FILES_SETUP_REQUIRED"}
    source.assert_awaited_once_with("owner")
    observe.assert_not_awaited()
    factory.assert_not_called()


def test_completion_proof_is_purpose_bound_and_contains_no_report_or_access_authority(monkeypatch):
    import base64

    from hushh_mcp.services import kai_completion_proof as proofs
    from hushh_mcp.services.external_connector_credentials_service import (
        ExternalConnectorCredentialsService,
    )

    monkeypatch.setenv(
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY", base64.urlsafe_b64encode(bytes(range(32))).decode()
    )
    monkeypatch.setenv("ENVIRONMENT", "uat")
    cipher = ExternalConnectorCredentialsService(db=object())
    monkeypatch.setattr(proofs, "ExternalConnectorCredentialsService", lambda: cipher)
    proof = proofs.issue_completion_proof("owner", "run-one", "AAPL")
    assert proofs.verify_completion_proof("owner", "run-one", proof) == "AAPL"
    for owner, run in [("other", "run-one"), ("owner", "other-run")]:
        with pytest.raises(ValueError):
            proofs.verify_completion_proof(owner, run, proof)
    with pytest.raises(ValueError):
        proofs.verify_completion_proof("owner", "run-one", {**proof, "algorithm": "wrong"})
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(ValueError):
        proofs.verify_completion_proof("owner", "run-one", proof)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv(
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY", base64.urlsafe_b64encode(bytes(range(1, 33))).decode()
    )
    with pytest.raises(ValueError):
        proofs.verify_completion_proof("owner", "run-one", proof)


@pytest.mark.asyncio
async def test_analysis_read_intent_racing_publication_uses_fresh_snapshot_and_never_reads_other_agents(
    feed_db,
):
    import asyncpg

    from hushh_mcp.services.feed_event_writer import mark_analysis_viewed, record_saved_analysis

    pool = await asyncpg.create_pool(
        feed_db.url.set(drivername="postgresql").render_as_string(hide_password=False),
        min_size=2,
        max_size=4,
    )

    async def load_pool():
        return pool

    try:
        await pool.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS report_source_once ON feed_events(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL"
        )
        await pool.execute(
            "INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata) VALUES('report-owner','kai','kai_analysis_completed','run-one','{\"run_id\":\"run-one\",\"ticker\":\"AAPL\"}'),('report-owner','connections','connection_request_accepted','other-agent','{}'),('foreign-owner','kai','kai_analysis_saved','run-one','{}')"
        )
        async with pool.acquire() as held:
            transaction = held.transaction()
            await transaction.start()
            await held.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                "report-owner:finance-analysis:run-one",
            )
            await held.execute(
                "UPDATE feed_events SET metadata=metadata || '{\"finance_result_viewed\":true}'::jsonb WHERE user_id='report-owner' AND event_type='kai_analysis_completed'"
            )
            pending = asyncio.create_task(
                record_saved_analysis(load_pool, "report-owner", "run-one", "AAPL")
            )
            for _ in range(50):
                waiting = await pool.fetchval(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'"
                )
                if waiting:
                    break
                await asyncio.sleep(0.02)
            assert waiting, "Publication must serialize behind the source read intent"
            await transaction.commit()
            await pending
        row = await pool.fetchrow(
            "SELECT read_at FROM feed_events WHERE user_id='report-owner' AND event_type='kai_analysis_saved'"
        )
        assert row["read_at"] is not None
        await record_saved_analysis(load_pool, "report-owner", "run-one", "AAPL")
        assert (
            await pool.fetchval(
                "SELECT count(*) FROM feed_events WHERE user_id='report-owner' AND event_type='kai_analysis_saved'"
            )
            == 1
        )
        await record_saved_analysis(load_pool, "report-owner", "run-two", "AAPL")
        await mark_analysis_viewed(load_pool, "report-owner", "run-one")
        assert (
            await pool.fetchval(
                "SELECT read_at FROM feed_events WHERE user_id='report-owner' AND source_row_id='other-agent'"
            )
            is None
        )
        assert (
            await pool.fetchval(
                "SELECT read_at FROM feed_events WHERE user_id='foreign-owner' AND source_row_id='run-one'"
            )
            is None
        )
        assert (
            await pool.fetchval(
                "SELECT read_at FROM feed_events WHERE user_id='report-owner' AND source_row_id='run-two'"
            )
            is None
        )
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_proof_only_late_publication_and_cross_device_read_keep_exact_run(monkeypatch):
    import base64
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from api.routes.kai.analysis_report_availability import (
        ReportReadReceipt,
        SharedObjectReceipt,
        SharedReportReceipt,
    )
    from hushh_mcp.services import kai_completion_proof as proofs
    from hushh_mcp.services.external_connector_credentials_service import (
        ExternalConnectorCredentialsService,
    )

    monkeypatch.setenv(
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY", base64.urlsafe_b64encode(bytes(range(32))).decode()
    )
    cipher = ExternalConnectorCredentialsService(db=object())
    monkeypatch.setattr(proofs, "ExternalConnectorCredentialsService", lambda: cipher)
    proof = proofs.issue_completion_proof("owner", "run-one", "AAPL")
    receipt = SharedReportReceipt(
        libraryId="1" * 36,
        namespace="a" * 64,
        objectId="b" * 64,
        generation="1",
        leaseId="2" * 36,
        reportTicker="AAPL",
        completionProof=proof,
    )
    # Removal consumes the actual client receipt without publication-only fields.
    SharedObjectReceipt.model_validate(
        receipt.model_dump(include={"libraryId", "namespace", "objectId", "generation", "leaseId"})
    )
    read, save = AsyncMock(), AsyncMock()
    monkeypatch.setattr(stream, "_require_stream_owner_token", lambda **_: None)
    monkeypatch.setattr(stream._RUN_MANAGER, "get_run", AsyncMock(return_value=None))
    monkeypatch.setattr(
        stream,
        "FeedService",
        lambda: SimpleNamespace(
            completed_analysis_source=lambda *_: None,
            mark_analysis_viewed=read,
            record_saved_analysis=save,
        ),
    )
    held_connection = object()

    @asynccontextmanager
    async def held(*_):
        yield held_connection

    monkeypatch.setattr(stream, "confirmed_report_object", held)
    await stream.read_analyze_feed_result(
        "run-one", ReportReadReceipt(completionProof=proof), "owner", {}
    )
    read.assert_awaited_once_with("owner", "run-one", "AAPL")
    await stream.analyze_run_feed_result("run-one", Request(), receipt, "owner", {})
    save.assert_awaited_once_with("owner", "run-one", "AAPL", connection=held_connection)
    with pytest.raises(HTTPException) as wrong_ticker:
        await stream.analyze_run_feed_result(
            "run-one", Request(), receipt.model_copy(update={"reportTicker": "MSFT"}), "owner", {}
        )
    assert wrong_ticker.value.status_code == 409
    for owner, run in [("other", "run-one"), ("owner", "run-two")]:
        with pytest.raises(HTTPException) as invalid:
            await stream.analyze_run_feed_result(run, Request(), receipt, owner, {})
        assert invalid.value.status_code == 404
    assert save.await_count == 1


@pytest.mark.parametrize("seal_fails", [False, True])
def test_completion_proof_is_adopted_before_terminal_delivery_without_changing_model_output(
    monkeypatch, seal_fails
):
    manager, run, _, _ = setup_run(monkeypatch, importing=False)
    marker = {
        "version": 1,
        "ciphertext": "sealed",
        "iv": "nonce",
        "algorithm": "aes-256-gcm-aad-v1",
    }

    def seal(owner, run_id, ticker):
        assert run.events == [] and run.status == "running"
        assert (owner, run_id, ticker) == ("owner", "run", "AAPL")
        if seal_fails:
            raise RuntimeError("private custody failure")
        return marker

    monkeypatch.setattr(run_manager, "issue_completion_proof", seal)
    asyncio.run(manager._append_frame(run, frame("decision")))
    payload = json.loads(run.events[0]["data"])["payload"]
    assert payload["private"] == "never-in-feed" and run.status == "completed"
    if seal_fails:
        assert payload["completion_proof_unavailable"] is True
        assert "completion_proof" not in payload
    else:
        assert payload["completion_proof"] == marker


@pytest.mark.asyncio
async def test_report_publication_reuses_library_transaction_with_single_connection_pool(
    feed_db, monkeypatch
):
    import asyncpg

    from hushh_mcp.services.feed_event_writer import mark_analysis_viewed, record_saved_analysis
    from hushh_mcp.services.shared_files import registry

    pool = await asyncpg.create_pool(
        feed_db.url.set(drivername="postgresql").render_as_string(hide_password=False),
        min_size=1,
        max_size=1,
    )

    async def load_pool():
        return pool

    monkeypatch.setattr(registry, "get_pool", load_pool)
    library, lease = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        await pool.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS report_source_once ON feed_events(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL"
        )
        await pool.execute(
            "CREATE TABLE shared_files_storage(user_id TEXT,library_id UUID,state TEXT,lease_id UUID,lease_until TIMESTAMPTZ)"
        )
        await pool.execute(
            "INSERT INTO shared_files_storage VALUES('owner',$1::uuid,'active',$2::uuid,now()+interval '1 minute')",
            library,
            lease,
        )

        async def publish():
            async with registry.locked_lease("owner", library, lease) as connection:
                await mark_analysis_viewed(load_pool, "owner", "run", "AAPL", connection=connection)
                await record_saved_analysis(
                    load_pool, "owner", "run", "AAPL", connection=connection
                )

        await asyncio.wait_for(publish(), timeout=2)
        assert await pool.fetchval(
            "SELECT read_at IS NOT NULL FROM feed_events WHERE user_id='owner' AND event_type='kai_analysis_saved'"
        )
    finally:
        await pool.close()
