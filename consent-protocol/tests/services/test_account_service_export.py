from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from api.routes.account import export_account_data
from hushh_mcp.services.account_service import AccountService
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

USER_ID = "user_export_123"
NOW = datetime(2026, 4, 27, tzinfo=timezone.utc)


class _QueryRows:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return self._rows


@contextmanager
def _db(conn):
    yield conn


def _conn_with_schema_rows():
    rows_by_table = {
        "actor_profiles": [
            {
                "user_id": USER_ID,
                "personas": ["investor"],
                "last_active_persona": "investor",
                "investor_marketplace_opt_in": True,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "runtime_persona_state": [
            {"user_id": USER_ID, "last_active_persona": "investor", "updated_at": NOW}
        ],
        "actor_verified_email_aliases": [
            {
                "alias_id": "alias_123",
                "user_id": USER_ID,
                "email": "original@example.com",
                "email_normalized": "original@example.com",
                "verification_status": "verified",
                "verification_source": "user_verified",
                "source_ref": None,
                "verification_requested_at": NOW,
                "verified_at": NOW,
                "revoked_at": None,
                "last_matched_at": None,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "vault_keys": [
            {
                "user_id": USER_ID,
                "vault_status": "active",
                "primary_method": "passkey",
                "primary_wrapper_id": "wrapper_123",
                "recovery_encrypted_vault_key": "ciphertext",
                "recovery_salt": "salt",
                "recovery_iv": "iv",
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "pkm_manifests": [
            {
                "user_id": USER_ID,
                "domain": "finance",
                "manifest_version": 1,
                "structure_decision": {"layout": "domain"},
                "summary_projection": {"summary": "encrypted"},
                "top_level_scope_paths": ["attr.financial.*"],
                "domain_contract_version": 1,
                "readable_summary_version": 1,
                "upgraded_at": NOW,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "pkm_index": [
            {
                "user_id": USER_ID,
                "available_domains": ["finance"],
                "domain_summaries": {"finance": "ready"},
                "computed_tags": ["investor"],
                "total_attributes": 4,
                "model_version": 2,
                "last_upgraded_at": NOW,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "pkm_blobs": [
            {
                "user_id": USER_ID,
                "domain": "finance",
                "segment_id": "holdings",
                "ciphertext": "encrypted-payload",
                "iv": "iv",
                "tag": "tag",
                "content_revision": 3,
                "manifest_revision": 2,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "consent_audit": [
            {
                "id": "audit_123",
                "token_id": "token_123",
                "user_id": USER_ID,
                "agent_id": "kai",
                "scope": "VAULT_OWNER",
                "action": "issued",
                "issued_at": NOW,
                "poll_timeout_at": NOW,
            }
        ],
    }

    def execute(query, _params):
        sql = str(query)
        for table, rows in rows_by_table.items():
            if f"FROM {table}" in sql:
                return _QueryRows(rows)
        return _QueryRows([])

    conn = MagicMock()
    conn.execute.side_effect = execute
    return conn


@pytest.mark.asyncio
async def test_export_data_uses_current_schema_contract_columns(monkeypatch):
    service = AccountService()
    conn = _conn_with_schema_rows()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.export_data(USER_ID)

    assert result["success"] is True
    assert result["requested_target"] == "account"
    assert result["data"]["actor_profile"]["user_id"] == USER_ID
    assert result["data"]["encrypted_pkm_index"][0]["available_domains"] == ["finance"]
    assert result["data"]["encrypted_pkm_blobs"][0]["ciphertext"] == "encrypted-payload"
    assert result["data"]["encrypted_pkm_manifests"][0]["manifest_version"] == 1
    assert result["data"]["consent_audit"][0]["issued_at"] == NOW
    assert result["data"]["verified_email_aliases"][0]["email_normalized"] == "original@example.com"

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "activity_score" not in executed_sql
    assert "encrypted_blob" not in executed_sql
    assert "blob_size" not in executed_sql
    assert "stored_version" not in executed_sql
    assert "storage_layout" not in executed_sql
    assert "occurred_at" not in executed_sql
    assert "vault_key_wrappers" not in executed_sql


@pytest.mark.asyncio
async def test_export_data_hides_raw_database_error():
    service = AccountService()

    with patch(
        "hushh_mcp.services.account_service.get_db_connection",
        side_effect=RuntimeError("database password leaked in stack"),
    ):
        result = await service.export_data(USER_ID)

    assert result == {"success": False, "error": "Account export failed"}


@pytest.mark.asyncio
async def test_export_route_hides_raw_export_failure(monkeypatch):
    class FailingAccountService:
        def prepare_export(self, _user_id):
            raise RuntimeError("raw database failure detail")

    monkeypatch.setattr("api.routes.account.AccountService", FailingAccountService)

    with pytest.raises(HTTPException) as exc_info:
        await export_account_data({"user_id": USER_ID})

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Account export failed"


@pytest.mark.asyncio
async def test_large_history_stream_uses_named_cursors_snapshot_and_bounded_memory(
    connector_postgres_url,  # noqa: F811
    monkeypatch,
    record_property,
):
    """Real PostgreSQL/ASGI regression for memory, send budget, snapshot and authority."""
    import hashlib
    import json
    import tracemalloc

    import anyio
    from sqlalchemy import create_engine, event, text
    from starlette.middleware.base import BaseHTTPMiddleware

    from api.routes.account import _AccountExportResponse

    metadata = {
        "entries": [
            {"label": f"source-entry-{n}", "details": {"text": 'r\u00e9sum\u00e9 "quoted"\nline'}}
            for n in range(2000)
        ]
    }

    engine = create_engine(connector_postgres_url)
    with engine.begin() as conn:
        conn.execute(
            text("""
            CREATE TABLE actor_profiles (
              user_id text, personas jsonb, last_active_persona text,
              investor_marketplace_opt_in boolean, created_at timestamptz, updated_at timestamptz);
            CREATE TABLE pkm_blobs (
              user_id text, domain text, segment_id text, ciphertext text, iv text, tag text,
              content_revision integer, manifest_revision integer,
              created_at timestamptz, updated_at timestamptz);
            CREATE TABLE pkm_domain_revisions (
              revision_id text PRIMARY KEY, user_id text, domain text,
              source_content_revision integer, source_manifest_revision integer,
              is_origin boolean, archive_reason text, source_commit_id text,
              manifest_snapshot jsonb, path_rows_snapshot jsonb, scope_rows_snapshot jsonb,
              index_domain_summary_snapshot jsonb, index_domain_present boolean,
              retention_expires_at timestamptz, restored_count integer,
              last_restored_at timestamptz, created_at timestamptz);
            CREATE TABLE pkm_domain_revision_segments (
              revision_id text, segment_id text, ciphertext text, iv text, tag text,
              algorithm text, original_content_revision integer,
              original_manifest_revision integer, size_bytes integer, created_at timestamptz);
            INSERT INTO actor_profiles VALUES
              ('owner-a', '["investor"]', 'original', false, now(), now()),
              ('owner-b', '[]', 'foreign-secret', false, now(), now());
            INSERT INTO pkm_blobs VALUES
              ('owner-a', 'projects', 'current', 'current-ciphertext', 'i', 't', 1, 1, now(), now());
            INSERT INTO pkm_domain_revisions (revision_id, user_id, domain, created_at)
              SELECT 'revision-' || n, 'owner-a', 'projects', now() FROM generate_series(1,256) n;
            INSERT INTO pkm_domain_revisions (revision_id, user_id, domain, created_at)
              VALUES ('foreign-revision', 'owner-b', 'projects', now());
            INSERT INTO pkm_domain_revision_segments (revision_id, segment_id, ciphertext, created_at)
              SELECT 'revision-' || n, 'segment-' || n, repeat('x', 262144), now()
                FROM generate_series(1,256) n;
            INSERT INTO pkm_domain_revision_segments (revision_id, segment_id, ciphertext)
              VALUES ('foreign-revision', 'secret', 'foreign-secret');
        """)
        )
        conn.execute(
            text("""UPDATE pkm_domain_revisions SET manifest_snapshot=CAST(:metadata AS jsonb)
                    WHERE revision_id='revision-2'"""),
            {"metadata": json.dumps(metadata)},
        )

    cursors = []

    @event.listens_for(engine, "after_cursor_execute")
    def capture_cursor(_conn, cursor, _statement, _params, context, _many):
        if context.execution_options.get("stream_results"):
            cursors.append(cursor)
            assert cursor.name  # psycopg2 otherwise buffers the complete result set.
            assert context.execution_options["yield_per"] == 1

    @contextmanager
    def connection():
        with engine.begin() as conn:
            yield conn

    monkeypatch.setattr("hushh_mcp.services.account_service.get_db_connection", connection)
    export = AccountService().prepare_export("owner-a")
    # A concurrent update/prune must not mix newer metadata with the snapshot's ciphertext.
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE actor_profiles SET last_active_persona='changed' WHERE user_id='owner-a'")
        )
        conn.execute(
            text("DELETE FROM pkm_domain_revision_segments WHERE revision_id='revision-1'")
        )

    digest = hashlib.sha256()
    byte_count = 0
    history_rows = 0
    metadata_entries = 0
    body_sends = 0
    max_chunk_bytes = 0
    ciphertext_tail = b""
    metadata_tail = b""
    safety_tail = b""
    tail = b""

    async def send(message):
        nonlocal byte_count, history_rows, metadata_entries, body_sends, max_chunk_bytes
        nonlocal ciphertext_tail, metadata_tail, safety_tail, tail
        if message["type"] != "http.response.body":
            return
        chunk = message.get("body", b"")
        body_sends += 1
        max_chunk_bytes = max(max_chunk_bytes, len(chunk))
        assert b"foreign-secret" not in safety_tail + chunk
        assert b'"changed"' not in safety_tail + chunk
        history_rows += (ciphertext_tail + chunk).count(b'"ciphertext"')
        metadata_entries += (metadata_tail + chunk).count(b"source-entry-")
        ciphertext_tail = (ciphertext_tail + chunk)[-len(b'"ciphertext"') + 1 :]
        metadata_tail = (metadata_tail + chunk)[-len(b"source-entry-") + 1 :]
        safety_tail = (safety_tail + chunk)[-32:]
        digest.update(chunk)
        byte_count += len(chunk)
        tail = (tail + chunk)[-40:]

    async def receive():
        await anyio.sleep_forever()

    async def passthrough(request, call_next):
        return await call_next(request)

    # Match the production sync-iterator/threadpool boundary and its two HTTP
    # middleware hops; direct generator iteration hid the tiny-token send cost.
    app = BaseHTTPMiddleware(
        BaseHTTPMiddleware(_AccountExportResponse(export), dispatch=passthrough),
        dispatch=passthrough,
    )
    tracemalloc.start()
    try:
        await app({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
        export.close()
    assert history_rows == 257  # All 256 retained revisions plus the current segment.
    assert metadata_entries == 2000
    assert byte_count > 64 * 1024 * 1024
    assert max_chunk_bytes <= 256 * 1024
    assert body_sends <= byte_count // (256 * 1024) + 3
    assert peak < 8 * 1024 * 1024
    assert tail.endswith(b',"success":true}')
    assert export._completed
    assert all(cursor.closed for cursor in cursors)
    assert engine.pool.checkedout() == 0
    record_property("stream_bytes", byte_count)
    record_property("python_peak_bytes", peak)
    record_property("asgi_body_sends", body_sends)
    record_property("max_chunk_bytes", max_chunk_bytes)
    record_property("sha256", digest.hexdigest())

    # Disconnect closes the named cursor/transaction without consuming history.
    export = AccountService().prepare_export("owner-a")
    iterator = iter(export)
    for chunk in iterator:
        if b'"ciphertext"' in chunk:
            break
    export.close()
    assert all(cursor.closed for cursor in cursors)
    assert engine.pool.checkedout() == 0

    # A later database failure must not become a valid, silently shortened backup.
    def fail_history(_conn, _cursor, statement, _params, _context, _many):
        if "FROM pkm_domain_revision_segments" in statement:
            raise RuntimeError("synthetic history read failed")

    event.listen(engine, "before_cursor_execute", fail_history)
    export = AccountService().prepare_export("owner-a")
    partial = bytearray()
    try:
        with pytest.raises(RuntimeError, match="synthetic history read failed"):
            for chunk in export:
                partial.extend(chunk)
    finally:
        export.close()
        event.remove(engine, "before_cursor_execute", fail_history)
    with pytest.raises(json.JSONDecodeError):
        json.loads(partial)
    assert b'"success":true' not in partial
    assert all(cursor.closed for cursor in cursors)
    assert engine.pool.checkedout() == 0
    engine.dispose()


@pytest.mark.asyncio
async def test_export_response_releases_snapshot_if_headers_fail():
    from api.routes.account import _AccountExportResponse

    export = MagicMock()
    export.remaining_seconds = 240.0
    export.__iter__.return_value = iter([b"never-sent"])

    async def send(_message):
        raise RuntimeError("disconnected before body")

    async def receive():
        return {"type": "http.disconnect"}

    with pytest.raises(RuntimeError, match="Account export interrupted"):
        await _AccountExportResponse(export)(
            {"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send
        )
    export.close.assert_called_once()


@pytest.mark.asyncio
async def test_export_response_deadline_closes_snapshot_even_when_send_is_stalled():
    import anyio

    from api.routes.account import _AccountExportResponse

    export = MagicMock()
    export.remaining_seconds = 0.02
    export.__iter__.return_value = iter([b"incomplete"])

    async def send(_message):
        await anyio.sleep_forever()

    async def receive():
        return {"type": "http.disconnect"}

    with pytest.raises(RuntimeError, match="Account export interrupted"):
        await _AccountExportResponse(export)(
            {"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send
        )
    export.close.assert_called_once()


@pytest.mark.asyncio
async def test_export_final_send_failure_never_records_complete_even_after_footer(caplog):
    """A buffered footer is not proof that the final ASGI handoff succeeded."""
    from api.routes.account import _AccountExportResponse
    from hushh_mcp.services.account_export_stream import AccountExportStream

    export = AccountExportStream(
        user_id="synthetic-owner",
        connection_factory=lambda: _db(MagicMock()),
        table_exists=lambda *_: False,
        queries={},
    ).prepare()
    sent_footer = False

    async def send(message):
        nonlocal sent_footer
        if message["type"] == "http.response.body":
            sent_footer |= message.get("body", b"").endswith(b',"success":true}')
            if not message.get("more_body", False):
                raise RuntimeError("synthetic final handoff failed")

    async def receive():
        return {"type": "http.disconnect"}

    with caplog.at_level("INFO"), pytest.raises(RuntimeError, match="Account export interrupted"):
        await _AccountExportResponse(export)(
            {"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send
        )
    assert sent_footer
    assert not export._completed
    assert not export._reserved
    assert "account_export outcome=incomplete" in caplog.text


@pytest.mark.asyncio
async def test_export_asgi23_disconnect_during_terminal_send_is_incomplete():
    import anyio

    from api.routes.account import _AccountExportResponse
    from hushh_mcp.services.account_export_stream import AccountExportStream

    export = AccountExportStream(
        user_id="synthetic-owner",
        connection_factory=lambda: _db(MagicMock()),
        table_exists=lambda *_: False,
        queries={},
    ).prepare()
    terminal_started = anyio.Event()

    async def send(message):
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            terminal_started.set()
            await anyio.sleep_forever()

    async def receive():
        await terminal_started.wait()
        return {"type": "http.disconnect"}

    with anyio.fail_after(2):
        await _AccountExportResponse(export)(
            {"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send
        )
    assert export._exhausted
    assert not export._completed
    assert not export._reserved
