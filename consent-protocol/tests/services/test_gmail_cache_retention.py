"""Retention behavior against disposable PostgreSQL and the runtime readers."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import traceback
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import psycopg2
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from db.db_client import DatabaseClient
from hushh_mcp.services.gmail_cache_retention import maintain_gmail_cache
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from hushh_mcp.services.receipt_memory_service import ReceiptMemoryArtifactService
from tests.test_data_model_audit_postgres import isolated_postgres as isolated_postgres

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def engine(isolated_postgres):
    engine = create_engine(
        "postgresql+psycopg2://", creator=lambda: psycopg2.connect(isolated_postgres)
    )
    try:
        source = (ROOT / "consent-protocol/db/legacy/init_legacy_schema.sql").read_text()
        start = source.index("CREATE TABLE IF NOT EXISTS kai_gmail_sync_runs (")
        end = source.index("CREATE TABLE IF NOT EXISTS kai_gmail_receipts (", start)
        artifacts = (
            ROOT / "consent-protocol/db/migrations/040_kai_receipt_memory_artifacts.sql"
        ).read_text()
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE vault_keys (user_id text PRIMARY KEY)"))
            conn.execute(text("INSERT INTO vault_keys VALUES ('owner-a'), ('owner-b')"))
            conn.execute(text(source[start:end]))
            conn.execute(text(artifacts))
            conn.execute(text("CREATE TABLE pkm_blobs (user_id text, ciphertext text)"))
            conn.execute(text("INSERT INTO pkm_blobs VALUES ('owner-a', 'sealed-sentinel')"))
        yield engine
    finally:
        engine.dispose()


def _run(conn, run_id, *, status="completed", owner="owner-a", completed_days=31, updated_days=0):
    conn.execute(
        text("""
        INSERT INTO kai_gmail_sync_runs
            (run_id, user_id, trigger_source, status, requested_at, completed_at, updated_at)
        VALUES (:id, :owner, 'manual', :status, CURRENT_TIMESTAMP - interval '90 days',
                CURRENT_TIMESTAMP - make_interval(days => :completed),
                CURRENT_TIMESTAMP - make_interval(days => :updated))
    """),
        {
            "id": run_id,
            "owner": owner,
            "status": status,
            "completed": completed_days,
            "updated": updated_days,
        },
    )


def _preview(conn, artifact_id, *, owner="owner-a", days=8):
    conn.execute(
        text("""
        INSERT INTO kai_receipt_memory_artifacts
            (artifact_id, user_id, enrichment_cache_key, source_watermark_hash,
             deterministic_projection_hash, candidate_pkm_payload_hash, created_at, persisted_at)
        VALUES (:id, :owner, 'fixture-key', 'fixture-watermark', 'fixture-projection',
                'fixture-candidate', CURRENT_TIMESTAMP - make_interval(days => :days), CURRENT_TIMESTAMP)
    """),
        {"id": artifact_id, "owner": owner, "days": days},
    )


def _ids(engine, table):
    query = {
        "runs": "SELECT run_id FROM kai_gmail_sync_runs ORDER BY run_id",
        "previews": "SELECT artifact_id FROM kai_receipt_memory_artifacts ORDER BY artifact_id",
    }[table]
    with engine.connect() as conn:
        return list(conn.execute(text(query)).scalars())


def test_report_and_apply_preserve_active_recent_foreign_and_pkm(engine):
    with engine.begin() as conn:
        _run(conn, "expired")
        _run(conn, "fallback-expired", completed_days=None, updated_days=31)
        _run(conn, "fallback-recent", completed_days=None, updated_days=1)
        _run(conn, "recent", completed_days=1)
        _run(conn, "active", status="running")
        _run(conn, "queued", status="queued")
        _run(conn, "foreign", owner="owner-b")
        _preview(conn, "expired-preview")
        _preview(conn, "recent-preview", days=1)
        _preview(conn, "foreign-preview", owner="owner-b")
    before = _ids(engine, "runs")
    report = maintain_gmail_cache(engine, user_id="owner-a")
    assert report["mode"] == "report"
    assert report["families"]["sync_runs"]["expired_rows_observed"] == 2
    assert report["families"]["preview_artifacts"]["expired_rows_observed"] == 1
    assert report["scope_drained"] is False
    assert _ids(engine, "runs") == before
    result = maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert result["scope_drained"] is True
    assert result["families"]["sync_runs"]["deleted"] == 2
    assert result["families"]["preview_artifacts"]["deleted"] == 1
    assert _ids(engine, "runs") == ["active", "fallback-recent", "foreign", "queued", "recent"]
    assert _ids(engine, "previews") == ["foreign-preview", "recent-preview"]
    with engine.connect() as conn:
        assert (
            conn.execute(text("SELECT ciphertext FROM pkm_blobs")).scalar_one() == "sealed-sentinel"
        )
    assert "owner-a" not in json.dumps(result)
    repeat = maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert all(item["deleted"] == 0 for item in repeat["families"].values())


def test_bounded_batches_report_remaining_and_repeat(engine):
    with engine.begin() as conn:
        for n in range(4):
            _run(conn, f"run-{n}")
            _preview(conn, f"preview-{n}")
    first = maintain_gmail_cache(engine, user_id="owner-a", apply=True, batch_limit=1)
    assert first["scope_drained"] is False
    assert first["families"]["sync_runs"]["deleted"] == 1
    assert first["families"]["sync_runs"]["expired_rows_observed"] == 2
    assert first["families"]["sync_runs"]["expired_count_capped"] is True
    assert _ids(engine, "runs") == ["run-1", "run-2", "run-3"]
    for _ in range(3):
        result = maintain_gmail_cache(engine, user_id="owner-a", apply=True, batch_limit=1)
    assert result["scope_drained"] is True
    assert _ids(engine, "runs") == []
    assert _ids(engine, "previews") == []


def test_locked_row_is_not_erased_and_later_active_state_survives(engine):
    with engine.begin() as conn:
        _run(conn, "contested")
    with engine.begin() as competing:
        competing.execute(
            text("UPDATE kai_gmail_sync_runs SET status='running' WHERE run_id='contested'")
        )
        result = maintain_gmail_cache(engine, user_id="owner-a", apply=True)
        assert result["families"]["sync_runs"]["deleted"] == 0
        assert result["families"]["sync_runs"]["expired_rows_observed"] == 1
        assert result["scope_drained"] is False
    assert maintain_gmail_cache(engine, user_id="owner-a", apply=True)["scope_drained"] is True
    assert _ids(engine, "runs") == ["contested"]


def test_missing_optional_table_and_undated_rows_are_incomplete(engine):
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE kai_receipt_memory_artifacts"))
        conn.execute(text("ALTER TABLE kai_gmail_sync_runs ALTER COLUMN updated_at DROP NOT NULL"))
        _run(conn, "undated", completed_days=None, updated_days=None)
    result = maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert result["scope_drained"] is False
    assert result["families"]["preview_artifacts"]["status"] == "unavailable"
    assert result["families"]["sync_runs"]["undated_rows_observed"] == 1
    assert _ids(engine, "runs") == ["undated"]


def test_second_family_failure_rolls_back_first_deletion(engine):
    with engine.begin() as conn:
        _run(conn, "must-survive")
        conn.execute(
            text(
                "ALTER TABLE kai_receipt_memory_artifacts RENAME COLUMN created_at TO broken_clock"
            )
        )
    with pytest.raises(DBAPIError):
        maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert _ids(engine, "runs") == ["must-survive"]


def test_exact_boundary_and_runtime_reads_agree(engine):
    class TransactionDb:
        def __init__(self, conn):
            self.conn = conn

        def execute_raw(self, query, params=None):
            return SimpleNamespace(
                data=[dict(row) for row in self.conn.execute(text(query), params or {}).mappings()]
            )

    # A real transaction pins CURRENT_TIMESTAMP across writes, reads and cleanup.
    with engine.begin() as conn:
        _run(conn, "cutoff", completed_days=30)
        _preview(conn, "cutoff-preview", days=7)
        gmail = GmailReceiptsService()
        gmail._db = TransactionDb(conn)
        artifacts = ReceiptMemoryArtifactService()
        artifacts._db = TransactionDb(conn)
        assert gmail._latest_sync_run(user_id="owner-a") is None
        assert artifacts.get_artifact(artifact_id="cutoff-preview", user_id="owner-a") is None
        assert (
            artifacts.get_cached_artifact(
                user_id="owner-a",
                source_watermark_hash="fixture-watermark",
                inference_window_days=365,
                highlights_window_days=90,
                deterministic_schema_version=1,
                enrichment_cache_key="fixture-key",
            )
            is None
        )
        adapter = SimpleNamespace(dialect=engine.dialect, begin=lambda: nullcontext(conn))
        result = maintain_gmail_cache(adapter, user_id="owner-a", apply=True)
        assert result["families"]["sync_runs"]["deleted"] == 1
        assert result["families"]["preview_artifacts"]["deleted"] == 1
        sync = datetime.fromisoformat(result["families"]["sync_runs"]["cutoff"])
        preview = datetime.fromisoformat(result["families"]["preview_artifacts"]["cutoff"])
        assert preview - sync == timedelta(days=23)


@pytest.mark.asyncio
async def test_runtime_lookup_expires_terminal_and_keeps_active(engine, monkeypatch):
    with engine.begin() as conn:
        _run(conn, "expired")
        _run(conn, "active", status="running")
        _run(conn, "foreign", owner="owner-b", completed_days=1)
    service = GmailReceiptsService()
    service._db = DatabaseClient(engine=engine)
    monkeypatch.setattr(service, "_reconcile_active_runs", lambda **kwargs: None)
    assert await service.get_sync_run(run_id="expired", user_id="owner-a") is None
    assert await service.get_sync_run(run_id="foreign", user_id="owner-a") is None
    assert (await service.get_sync_run(run_id="active", user_id="owner-a"))["status"] == "running"


@pytest.mark.parametrize("owner,limit", [("", 1), (" ", 1), ("a", 0), ("a", 1001), ("a", True)])
def test_invalid_scope_or_batch_refuses_before_io(owner, limit):
    with pytest.raises(ValueError):
        maintain_gmail_cache(None, user_id=owner, batch_limit=limit)


def test_cli_defaults_to_report_and_omits_private_errors(monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location(
        "gmail_retention_cli", ROOT / "scripts/ops/gmail_cache_retention.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls = []

    class Engine:
        def dispose(self):
            calls.append("disposed")

    monkeypatch.setenv("RETENTION_TEST_URL", "private-url-sentinel")
    monkeypatch.setenv("RETENTION_TEST_OWNER", "private-owner-sentinel")
    monkeypatch.setattr(module, "create_engine", lambda *args, **kwargs: Engine())

    def maintain(engine, **kwargs):
        calls.append(kwargs)
        raise RuntimeError("private-error-sentinel")

    monkeypatch.setattr(module, "maintain_gmail_cache", maintain)
    assert (
        module.main(
            ["--database-url-env", "RETENTION_TEST_URL", "--owner-id-env", "RETENTION_TEST_OWNER"]
        )
        == 1
    )
    assert calls[0]["apply"] is False
    assert calls[-1] == "disposed"
    assert json.loads(capsys.readouterr().out) == {
        "status": "unavailable",
        "error_type": "RuntimeError",
    }


def test_temporary_shadow_tables_cannot_fake_public_cleanup(engine):
    with engine.begin() as conn:
        _run(conn, "public-expired")
        _preview(conn, "public-preview")
        conn.execute(
            text(
                "CREATE TEMP TABLE kai_gmail_sync_runs (LIKE public.kai_gmail_sync_runs INCLUDING ALL)"
            )
        )
        conn.execute(
            text(
                "CREATE TEMP TABLE kai_receipt_memory_artifacts (LIKE public.kai_receipt_memory_artifacts INCLUDING ALL)"
            )
        )
        adapter = SimpleNamespace(dialect=engine.dialect, begin=lambda: nullcontext(conn))
        result = maintain_gmail_cache(adapter, user_id="owner-a", apply=True)
        assert result["families"]["sync_runs"]["deleted"] == 1
        assert result["families"]["preview_artifacts"]["deleted"] == 1
        assert (
            conn.execute(text("SELECT count(*) FROM public.kai_gmail_sync_runs")).scalar_one() == 0
        )
        conn.execute(
            text("DROP TABLE pg_temp.kai_gmail_sync_runs, pg_temp.kai_receipt_memory_artifacts")
        )


def test_second_family_lock_timeout_rolls_back_first_family(engine):
    with engine.begin() as conn:
        _run(conn, "must-survive-timeout")
    with engine.begin() as competing:
        competing.execute(
            text("LOCK TABLE public.kai_receipt_memory_artifacts IN ACCESS EXCLUSIVE MODE")
        )
        with pytest.raises(DBAPIError):
            maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert _ids(engine, "runs") == ["must-survive-timeout"]


def test_rls_filtered_rows_cannot_earn_empty_evidence(engine, isolated_postgres):
    with engine.begin() as conn:
        _run(conn, "hidden-expired")
        conn.execute(text("CREATE ROLE retention_limited NOLOGIN"))
        conn.execute(
            text(
                "GRANT SELECT, DELETE ON public.kai_gmail_sync_runs, public.kai_receipt_memory_artifacts TO retention_limited"
            )
        )
        conn.execute(text("ALTER TABLE public.kai_gmail_sync_runs ENABLE ROW LEVEL SECURITY"))
    limited = create_engine(
        "postgresql+psycopg2://",
        creator=lambda: psycopg2.connect(isolated_postgres, options="-c role=retention_limited"),
    )
    try:
        for apply in (False, True):
            with pytest.raises(DBAPIError):
                maintain_gmail_cache(limited, user_id="owner-a", apply=apply)
    finally:
        limited.dispose()
    assert _ids(engine, "runs") == ["hidden-expired"]


def test_lost_commit_acknowledgement_never_returns_success(engine):
    with engine.begin() as conn:
        _run(conn, "commit-uncertain")

    @contextmanager
    def lose_ack():
        with engine.begin() as conn:
            yield conn
        raise RuntimeError("synthetic lost commit acknowledgement")

    adapter = SimpleNamespace(dialect=engine.dialect, begin=lose_ack)
    with pytest.raises(RuntimeError, match="lost commit acknowledgement"):
        maintain_gmail_cache(adapter, user_id="owner-a", apply=True)
    assert _ids(engine, "runs") == []
    repeat = maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert repeat["scope_drained"] is True
    assert repeat["families"]["sync_runs"]["deleted"] == 0


def test_statement_timeout_rolls_back_slow_deletion(engine):
    with engine.begin() as conn:
        _run(conn, "slow-delete")
        conn.execute(
            text("""
            CREATE FUNCTION slow_retention_delete() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(10); RETURN OLD; END $$;
            CREATE TRIGGER slow_retention_delete BEFORE DELETE ON kai_gmail_sync_runs
              FOR EACH ROW EXECUTE FUNCTION slow_retention_delete();
        """)
        )
    with pytest.raises(DBAPIError) as error:
        maintain_gmail_cache(engine, user_id="owner-a", apply=True)
    assert error.value.orig.pgcode == "57014"
    assert _ids(engine, "runs") == ["slow-delete"]


@pytest.fixture
def connected_gmail(engine, monkeypatch):
    source = (ROOT / "consent-protocol/db/legacy/init_legacy_schema.sql").read_text()
    start = source.index("CREATE TABLE IF NOT EXISTS kai_gmail_connections (")
    end = source.index("\n);", start) + 4
    with engine.begin() as conn:
        conn.execute(text(source[start:end]))
        conn.execute(
            text("""
            INSERT INTO kai_gmail_connections
                (user_id, status, refresh_token_ciphertext, refresh_token_iv,
                 refresh_token_tag, token_updated_at, connected_at)
            VALUES ('owner-a', 'connected', 'initial-refresh', 'initial-iv', 'initial-tag',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                   ('owner-b', 'connected', 'foreign-refresh', 'foreign-iv', 'foreign-tag',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """)
        )
    service = GmailReceiptsService()
    service._db = DatabaseClient(engine=engine)
    # Only cryptography and the external provider are substituted. All authority
    # reads and conditional writes execute the production SQL on PostgreSQL.
    monkeypatch.setattr(service, "_decrypt_token", lambda ciphertext, *args: ciphertext)
    monkeypatch.setattr(
        service,
        "_encrypt_token",
        lambda token: {"ciphertext": "sealed-" + token, "iv": "next-iv", "tag": "next-tag"},
    )
    return service


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_fails", [False, True])
@pytest.mark.parametrize("transition", ["disconnect", "reconnect", "concurrent_refresh"])
async def test_late_refresh_result_cannot_overwrite_changed_connection(
    engine, connected_gmail, monkeypatch, provider_fails, transition
):
    started, release = asyncio.Event(), asyncio.Event()

    async def refresh(**kwargs):
        started.set()
        await release.wait()
        if provider_fails:
            raise GmailApiError("synthetic old grant refused", status_code=401)
        return {"access_token": "late-access", "refresh_token": "late-refresh"}

    monkeypatch.setattr(connected_gmail, "_refresh_access_token", refresh)
    task = asyncio.create_task(connected_gmail._ensure_access_token(user_id="owner-a"))
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        with engine.begin() as conn:
            if transition == "disconnect":
                conn.execute(
                    text("""
                    UPDATE kai_gmail_connections SET status='disconnected', revoked=TRUE,
                      refresh_token_ciphertext=NULL, refresh_token_iv=NULL, refresh_token_tag=NULL,
                      access_token_ciphertext=NULL, token_updated_at=CURRENT_TIMESTAMP
                    WHERE user_id='owner-a'
                """)
                )
            elif transition == "reconnect":
                # Preserve timestamps deliberately: the changed encrypted envelope
                # must still invalidate old work, even with a clock collision.
                conn.execute(
                    text("""
                    UPDATE kai_gmail_connections SET refresh_token_ciphertext='replacement-refresh',
                      refresh_token_iv='replacement-iv', refresh_token_tag='replacement-tag',
                      access_token_ciphertext='replacement-access'
                    WHERE user_id='owner-a'
                """)
                )
            else:
                conn.execute(
                    text("""
                    UPDATE kai_gmail_connections SET token_updated_at=CURRENT_TIMESTAMP,
                      access_token_ciphertext='replacement-access'
                    WHERE user_id='owner-a'
                """)
                )
        before = connected_gmail._fetch_connection_row(user_id="owner-a")
        release.set()
        with pytest.raises(GmailApiError) as error:
            await asyncio.wait_for(task, timeout=5)
        assert error.value.status_code == 409
        assert "synthetic old grant refused" not in "".join(traceback.format_exception(error.value))
        assert connected_gmail._fetch_connection_row(user_id="owner-a") == before
        assert (
            connected_gmail._fetch_connection_row(user_id="owner-b")["refresh_token_ciphertext"]
            == "foreign-refresh"
        )
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_fails", [False, True])
async def test_current_refresh_persists_success_or_requires_reauth(
    connected_gmail, monkeypatch, provider_fails
):
    async def refresh(**kwargs):
        if provider_fails:
            raise GmailApiError("synthetic current grant refused", status_code=401)
        return {"access_token": "new-access", "refresh_token": "new-refresh"}

    monkeypatch.setattr(connected_gmail, "_refresh_access_token", refresh)
    if provider_fails:
        with pytest.raises(GmailApiError) as error:
            await connected_gmail._ensure_access_token(user_id="owner-a")
        assert error.value.status_code == 401
        assert "synthetic current grant refused" not in "".join(
            traceback.format_exception(error.value)
        )
        row = connected_gmail._fetch_connection_row(user_id="owner-a")
        assert row["status"] == "error" and row["revoked"] is True
        assert row["last_sync_error"] == "Gmail token refresh failed. Reconnect Gmail to continue."
    else:
        token, row = await connected_gmail._ensure_access_token(user_id="owner-a")
        assert token == "new-access"
        assert row == connected_gmail._fetch_connection_row(user_id="owner-a")
        assert row["access_token_ciphertext"] == "sealed-new-access"
        assert row["refresh_token_ciphertext"] == "sealed-new-refresh"
        assert row["status"] == "connected" and row["revoked"] is False


@pytest.mark.asyncio
async def test_revoked_connection_refuses_before_decryption(engine, connected_gmail, monkeypatch):
    with engine.begin() as conn:
        conn.execute(text("UPDATE kai_gmail_connections SET revoked=TRUE WHERE user_id='owner-a'"))

    def forbidden(*args):
        pytest.fail("revoked connection reached credential decryption")

    monkeypatch.setattr(connected_gmail, "_decrypt_token", forbidden)
    with pytest.raises(GmailApiError) as error:
        await connected_gmail._ensure_access_token(user_id="owner-a")
    assert error.value.status_code == 400
