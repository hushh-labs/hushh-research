from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    ReceiptCandidate,
    _parse_iso,
)


def _candidate(**overrides):
    base = ReceiptCandidate(
        gmail_message_id="msg_1",
        gmail_thread_id="thread_1",
        gmail_internal_date=datetime(2026, 3, 1, tzinfo=timezone.utc),
        gmail_history_id="100",
        labels=["CATEGORY_UPDATES"],
        subject="Your order confirmation",
        snippet="Thank you for your order. Amount paid $14.99",
        from_name="Amazon",
        from_email="store-news@amazon.com",
        message_id_header="<abc@example.com>",
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def test_state_token_round_trip():
    service = GmailReceiptsService()
    state = service._build_state_token(
        user_id="user_123",
        redirect_uri="http://localhost:3000/profile/gmail/oauth/return",
    )

    payload = service._verify_state_token(
        state=state,
        user_id="user_123",
        redirect_uri="http://localhost:3000/profile/gmail/oauth/return",
    )

    assert payload["uid"] == "user_123"
    assert payload["redirect_uri"] == "http://localhost:3000/profile/gmail/oauth/return"


def test_state_token_invalid_signature_rejected():
    service = GmailReceiptsService()
    state = service._build_state_token(
        user_id="user_123",
        redirect_uri="http://localhost:3000/profile/gmail/oauth/return",
    )
    broken = f"{state}x"

    with pytest.raises(GmailApiError) as exc_info:
        service._verify_state_token(
            state=broken,
            user_id="user_123",
            redirect_uri="http://localhost:3000/profile/gmail/oauth/return",
        )

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_verify_webhook_ingress_accepts_signed_pubsub_token(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "_webhook_auth_enabled", lambda: True)
    monkeypatch.setattr(
        service,
        "_webhook_audience",
        lambda: "https://example.com/api/kai/gmail/webhook",
    )
    monkeypatch.setattr(
        service,
        "_webhook_service_account_email",
        lambda: "gmail-push@project.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.google_id_token.verify_oauth2_token",
        lambda token, request, audience=None: {
            "aud": audience,
            "email": "gmail-push@project.iam.gserviceaccount.com",
            "email_verified": True,
            "iss": "accounts.google.com",
        },
    )

    claims = await service.verify_webhook_ingress(
        headers={"Authorization": "Bearer signed-pubsub-token"}
    )

    assert claims["email"] == "gmail-push@project.iam.gserviceaccount.com"


@pytest.mark.asyncio
async def test_verify_webhook_ingress_rejects_missing_bearer_token(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "_webhook_auth_enabled", lambda: True)
    monkeypatch.setattr(service, "_webhook_audience", lambda: "https://example.com/webhook")

    with pytest.raises(GmailApiError) as exc_info:
        await service.verify_webhook_ingress(headers={})

    assert exc_info.value.status_code == 401


def test_build_receipt_query_contains_keywords_and_after_epoch():
    service = GmailReceiptsService()
    since = datetime(2025, 1, 15, tzinfo=timezone.utc)

    query = service._build_receipt_query(query_since=since)

    assert "category:purchases" in query
    assert "subject:(receipt OR invoice OR order OR payment OR transaction)" in query
    assert '"order total"' in query
    assert f"after:{int(since.timestamp())}" in query


def test_classify_candidate_marks_high_confidence_receipt():
    service = GmailReceiptsService()
    candidate = _candidate(labels=["CATEGORY_PURCHASES"])

    result = service._classify_candidate(candidate)

    assert result["is_receipt"] is True
    assert result["confidence"] >= 0.55
    assert "gmail_category_purchases" in result["reasons"]


def test_classify_candidate_accepts_subject_plus_snippet_without_purchase_label():
    service = GmailReceiptsService()
    candidate = _candidate(
        labels=["CATEGORY_UPDATES"],
        subject="Order confirmation #A1B2C3D4",
        snippet="Thanks for your purchase. Order total $24.99",
        from_email="no-reply@examplemail.com",
    )

    result = service._classify_candidate(candidate)

    assert result["is_receipt"] is True
    assert result["confidence"] >= 0.5
    assert "subject_keyword" in result["reasons"]
    assert "snippet_keyword" in result["reasons"]


def test_classify_candidate_accepts_subject_plus_order_id_signal():
    service = GmailReceiptsService()
    candidate = _candidate(
        labels=["CATEGORY_UPDATES"],
        subject="Receipt for order #ABCD1234",
        snippet="View your recent activity.",
        from_email="no-reply@examplemail.com",
    )

    result = service._classify_candidate(candidate)

    assert result["is_receipt"] is True
    assert "order_id_signal" in result["reasons"]


def test_classify_candidate_subject_only_becomes_llm_candidate():
    service = GmailReceiptsService()
    candidate = _candidate(
        labels=["CATEGORY_UPDATES"],
        subject="Your payment receipt",
        snippet="View details in your account dashboard.",
        from_email="alerts@unknown-provider.dev",
    )

    result = service._classify_candidate(candidate)

    assert result["is_receipt"] is False
    assert result["needs_llm"] is True


def test_extract_receipt_fields_prefers_llm_values_when_present():
    service = GmailReceiptsService()
    candidate = _candidate()

    fields = service._extract_receipt_fields(
        candidate=candidate,
        classification={"confidence": 0.9, "source": "llm"},
        llm_payload={
            "merchant_name": "Amazon.com",
            "order_id": "A1B2C3D4",
            "amount": 22.45,
            "currency": "usd",
        },
    )

    assert fields["merchant_name"] == "Amazon.com"
    assert fields["order_id"] == "A1B2C3D4"
    assert fields["amount"] == 22.45
    assert fields["currency"] == "USD"
    assert fields["receipt_checksum"]


def test_parse_iso_normalizes_datetime_and_date_values_to_utc():
    aware = datetime(2026, 3, 1, 18, 30, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    naive = datetime(2026, 3, 1, 18, 30)
    day = date(2026, 3, 2)

    assert _parse_iso(aware) == datetime(2026, 3, 1, 13, 0, tzinfo=timezone.utc)
    assert _parse_iso(naive) == datetime(2026, 3, 1, 18, 30, tzinfo=timezone.utc)
    assert _parse_iso(day) == datetime(2026, 3, 2, 0, 0, tzinfo=timezone.utc)


def test_state_and_token_key_require_explicit_config_outside_local_dev(monkeypatch):
    monkeypatch.delenv("APP_SIGNING_KEY", raising=False)
    monkeypatch.delenv("GMAIL_OAUTH_TOKEN_KEY", raising=False)
    monkeypatch.delenv("GMAIL_ALLOW_LOCAL_DEV_FALLBACK", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")

    service = GmailReceiptsService()

    with pytest.raises(RuntimeError):
        service._state_secret()

    with pytest.raises(RuntimeError):
        service._token_key()


@pytest.mark.asyncio
async def test_complete_connect_returns_status_even_when_initial_queue_sync_fails(
    monkeypatch, caplog
):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_verify_state_token", lambda **kwargs: {"uid": "user_123"})
    monkeypatch.setattr(
        service,
        "_exchange_code",
        lambda **kwargs: asyncio.sleep(
            0,
            result={
                "access_token": "access-token",
                "refresh_token": "refresh-token",
                "scope": "gmail.readonly",
                "expires_in": 3600,
                "id_token": "id-token",
            },
        ),
    )
    monkeypatch.setattr(
        service,
        "_http_get_json",
        lambda *args, **kwargs: asyncio.sleep(0, result={"emailAddress": "user@example.com"}),
    )
    monkeypatch.setattr(
        service,
        "_decode_id_token_claims",
        lambda id_token: {"sub": "google-sub", "email": "user@example.com"},
    )
    monkeypatch.setattr(
        service,
        "_encrypt_token",
        lambda token: {
            "ciphertext": f"{token}-ciphertext",
            "iv": f"{token}-iv",
            "tag": f"{token}-tag",
        },
    )
    monkeypatch.setattr(service, "_fetch_connection_row", lambda user_id: None)

    async def _queue_sync(**kwargs):
        raise RuntimeError("queue offline")

    async def _get_status(user_id):
        return {"user_id": user_id, "status": "connected"}

    monkeypatch.setattr(service, "queue_sync", _queue_sync)
    monkeypatch.setattr(service, "get_status", _get_status)

    class _CaptureDb:
        def __init__(self):
            self.calls = []

        def execute_raw(self, sql, params=None):
            self.calls.append((sql, params))
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()

    with caplog.at_level("WARNING"):
        result = await service.complete_connect(
            user_id="user_123",
            code="oauth-code",
            state="state-token",
            redirect_uri="https://example.com/oauth/callback",
        )

    assert result == {"user_id": "user_123", "status": "connected"}
    assert any("gmail.connect.queue_failed" in record.message for record in caplog.records)
    assert any("INSERT INTO kai_gmail_connections" in sql for sql, _ in service._db.calls)


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeConn:
    def __init__(self, rows: list[dict | None]):
        self.rows = rows
        self.fetchrow_calls = 0
        self.inserted = None
        self.execute_calls: list[tuple[str, tuple[object, ...]]] = []

    async def fetchrow(self, query, *args):
        self.fetchrow_calls += 1
        if "INSERT INTO kai_gmail_sync_runs" in query:
            self.inserted = {
                "run_id": args[0],
                "user_id": args[1],
                "trigger_source": args[2],
                "status": "queued",
                "requested_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                "started_at": None,
                "completed_at": None,
                "listed_count": 0,
                "filtered_count": 0,
                "synced_count": 0,
                "extracted_count": 0,
                "duplicates_dropped": 0,
                "extraction_success_rate": 0,
                "error_message": None,
                "metrics_json": {},
            }
            return self.inserted
        if not self.rows:
            return None
        return self.rows.pop(0)

    async def execute(self, query, *args):
        self.execute_calls.append((query, args))
        return "UPDATE 1"

    def transaction(self):
        return _FakeTransaction()


class _FakePool:
    def __init__(self, conn: _FakeConn):
        self.conn = conn

    def acquire(self):
        return self

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


@pytest.mark.asyncio
async def test_queue_sync_rejects_disconnected_user_before_queuing(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setenv("GMAIL_OAUTH_TOKEN_KEY", "fixture-" + "tokenkey")
    conn = _FakeConn(
        rows=[
            {
                "user_id": "user_123",
                "status": "disconnected",
                "revoked": False,
            }
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_pool",
        lambda: asyncio.sleep(0, result=_FakePool(conn)),
    )

    with pytest.raises(GmailApiError) as exc_info:
        await service.queue_sync(user_id="user_123", trigger_source="manual")

    assert exc_info.value.status_code == 409
    assert conn.fetchrow_calls == 1


@pytest.mark.asyncio
async def test_queue_sync_returns_existing_active_run_without_inserting_duplicate(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setenv("GMAIL_OAUTH_TOKEN_KEY", "fixture-" + "tokenkey")
    active_now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    conn = _FakeConn(
        rows=[
            {
                "user_id": "user_123",
                "status": "connected",
                "revoked": False,
            },
            {
                "run_id": "gmail_sync_existing",
                "user_id": "user_123",
                "trigger_source": "manual",
                "status": "running",
                "requested_at": active_now,
                "started_at": active_now,
                "updated_at": active_now,
                "completed_at": None,
                "listed_count": 0,
                "filtered_count": 0,
                "synced_count": 0,
                "extracted_count": 0,
                "duplicates_dropped": 0,
                "extraction_success_rate": 0,
                "error_message": None,
                "metrics_json": {},
            },
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_pool",
        lambda: asyncio.sleep(0, result=_FakePool(conn)),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service._utcnow",
        lambda: active_now + timedelta(seconds=30),
    )

    result = await service.queue_sync(user_id="user_123", trigger_source="manual")

    assert result["accepted"] is False
    assert result["reason"] == "sync_already_running"
    assert result["run"]["run_id"] == "gmail_sync_existing"
    assert conn.inserted is None


@pytest.mark.asyncio
async def test_queue_sync_recovers_stale_running_run_before_enqueuing_replacement(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setenv("GMAIL_OAUTH_TOKEN_KEY", "fixture-" + "tokenkey")
    monkeypatch.setenv("KAI_GMAIL_RECEIPTS_RUN_STALE_TTL_SECONDS", "60")
    conn = _FakeConn(
        rows=[
            {
                "user_id": "user_123",
                "status": "connected",
                "revoked": False,
            },
            {
                "run_id": "gmail_sync_stale",
                "user_id": "user_123",
                "trigger_source": "manual",
                "status": "running",
                "requested_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                "started_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                "updated_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                "completed_at": None,
                "listed_count": 3,
                "filtered_count": 1,
                "synced_count": 1,
                "extracted_count": 1,
                "duplicates_dropped": 0,
                "extraction_success_rate": 1.0,
                "error_message": None,
                "metrics_json": {},
            },
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_pool",
        lambda: asyncio.sleep(0, result=_FakePool(conn)),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service._utcnow",
        lambda: datetime(2026, 3, 1, 0, 5, tzinfo=timezone.utc),
    )

    def _fake_create_task(coro):
        coro.close()
        return SimpleNamespace(add_done_callback=lambda cb: None)

    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.asyncio.create_task",
        _fake_create_task,
    )

    result = await service.queue_sync(user_id="user_123", trigger_source="manual")

    assert result["accepted"] is True
    assert conn.inserted is not None
    assert any(
        "UPDATE kai_gmail_sync_runs" in query and "status = 'failed'" in query
        for query, _ in conn.execute_calls
    )


@pytest.mark.asyncio
async def test_queue_sync_preempts_backfill_for_manual_request(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setenv("GMAIL_OAUTH_TOKEN_KEY", "fixture-" + "tokenkey")
    active_now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    conn = _FakeConn(
        rows=[
            {
                "user_id": "user_123",
                "status": "connected",
                "revoked": False,
            },
            {
                "run_id": "gmail_sync_backfill",
                "user_id": "user_123",
                "trigger_source": "backfill",
                "sync_mode": "backfill",
                "status": "running",
                "requested_at": active_now,
                "started_at": active_now,
                "updated_at": active_now,
                "completed_at": None,
                "listed_count": 12,
                "filtered_count": 6,
                "synced_count": 6,
                "extracted_count": 5,
                "duplicates_dropped": 0,
                "extraction_success_rate": 0.83,
                "error_message": None,
                "metrics_json": {},
            },
            None,
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_pool",
        lambda: asyncio.sleep(0, result=_FakePool(conn)),
    )

    canceled = {"value": False}

    class _LiveTask:
        def done(self):
            return False

        def cancel(self):
            canceled["value"] = True

    service._sync_tasks_by_run_id["gmail_sync_backfill"] = _LiveTask()

    def _fake_create_task(coro):
        coro.close()
        return SimpleNamespace(add_done_callback=lambda cb: None)

    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.asyncio.create_task",
        _fake_create_task,
    )

    result = await service.queue_sync(user_id="user_123", trigger_source="manual")

    assert result["accepted"] is True
    assert conn.inserted is not None
    assert canceled["value"] is True
    assert any(
        "UPDATE kai_gmail_sync_runs" in query and "status = 'canceled'" in query
        for query, _ in conn.execute_calls
    )


def test_reconcile_active_runs_cancels_stale_live_task(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setenv("KAI_GMAIL_RECEIPTS_RUN_STALE_TTL_SECONDS", "60")
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service._utcnow",
        lambda: datetime(2026, 3, 1, 0, 5, tzinfo=timezone.utc),
    )

    canceled = {"value": False}

    class _LiveTask:
        def done(self):
            return False

        def cancel(self):
            canceled["value"] = True

    service._sync_tasks_by_run_id["gmail_sync_live"] = _LiveTask()

    class _CaptureDb:
        def __init__(self):
            self.calls: list[tuple[str, dict | None]] = []

        def execute_raw(self, sql, params=None):
            self.calls.append((sql, params))
            if "SELECT run_id, user_id, status" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "run_id": "gmail_sync_live",
                            "user_id": "user_123",
                            "status": "running",
                            "requested_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                            "started_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                            "updated_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                            "completed_at": None,
                        }
                    ]
                )
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()

    service._reconcile_active_runs(user_id="user_123")

    assert canceled["value"] is True
    assert any(
        "UPDATE kai_gmail_sync_runs" in sql and params.get("status") == "failed"
        for sql, params in service._db.calls
        if params
    )


def test_upsert_receipt_uses_sqlalchemy_safe_json_cast(monkeypatch):
    service = GmailReceiptsService()
    captured_sql: list[str] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            captured_sql.append(sql)
            return SimpleNamespace(data=[{"inserted_new": True}])

    service._db = _CaptureDb()
    candidate = _candidate(gmail_message_id="msg_safe_sql")
    extracted = service._extract_receipt_fields(
        candidate=candidate,
        classification={"confidence": 0.9, "source": "deterministic"},
        llm_payload=None,
    )

    inserted = asyncio.run(
        service._upsert_receipt(user_id="user_123", candidate=candidate, extracted=extracted)
    )

    assert inserted is True
    upsert_sql = next(sql for sql in captured_sql if "INSERT INTO kai_gmail_receipts" in sql)
    assert "CAST(:raw_reference_json AS jsonb)" in upsert_sql
    assert ":raw_reference_json::jsonb" not in upsert_sql


@pytest.mark.asyncio
async def test_run_sync_worker_uses_sqlalchemy_safe_json_cast_for_metrics(monkeypatch):
    service = GmailReceiptsService()
    captured_sql: list[str] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            captured_sql.append(sql)
            if "SELECT trigger_source" in sql:
                return SimpleNamespace(data=[{"trigger_source": "manual"}])
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda user_id: asyncio.sleep(0, result=("token", {"last_sync_at": None})),
    )
    monkeypatch.setattr(
        service,
        "_list_messages",
        lambda **kwargs: asyncio.sleep(0, result={"messages": [], "nextPageToken": None}),
    )
    monkeypatch.setattr(service, "_is_connection_sync_active", lambda user_id: True)
    monkeypatch.setattr(service, "_is_run_sync_active", lambda run_id: True)

    await service._run_sync_worker(run_id="gmail_sync_test", user_id="user_123")

    completion_sql = next(
        sql
        for sql in captured_sql
        if "UPDATE kai_gmail_sync_runs" in sql and "status = 'completed'" in sql
    )
    assert "CAST(:metrics_json AS jsonb)" in completion_sql
    assert ":metrics_json::jsonb" not in completion_sql


@pytest.mark.asyncio
async def test_run_sync_worker_isolates_single_message_failures(monkeypatch):
    service = GmailReceiptsService()
    terminal_updates: list[tuple[str, dict | None]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            if "SELECT trigger_source" in sql:
                return SimpleNamespace(data=[{"trigger_source": "manual"}])
            if "UPDATE kai_gmail_sync_runs" in sql and "status = 'completed'" in sql:
                terminal_updates.append((sql, params))
            if "UPDATE kai_gmail_sync_runs" in sql and "status = 'failed'" in sql:
                raise AssertionError("single-message failures should not fail the entire sync")
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda user_id: asyncio.sleep(0, result=("token", {"last_sync_at": None})),
    )
    monkeypatch.setattr(
        service,
        "_list_messages",
        lambda **kwargs: asyncio.sleep(
            0,
            result={
                "messages": [{"id": "bad_msg"}, {"id": "good_msg"}],
                "nextPageToken": None,
            },
        ),
    )
    monkeypatch.setattr(service, "_is_connection_sync_active", lambda user_id: True)
    monkeypatch.setattr(service, "_is_run_sync_active", lambda run_id: True)

    async def _get_message_metadata(**kwargs):
        if kwargs["gmail_message_id"] == "bad_msg":
            raise RuntimeError("broken payload")
        return {"id": "good_msg"}

    monkeypatch.setattr(service, "_get_message_metadata", _get_message_metadata)
    monkeypatch.setattr(
        service,
        "_candidate_from_message",
        lambda metadata: _candidate(gmail_message_id=str(metadata["id"])),
    )
    monkeypatch.setattr(
        service,
        "_classify_candidate",
        lambda candidate: {"is_receipt": True, "confidence": 0.9, "source": "deterministic"},
    )
    monkeypatch.setattr(
        service,
        "_extract_receipt_fields",
        lambda **kwargs: {
            "merchant_name": "Amazon",
            "order_id": "ORDER-1",
            "amount": 19.99,
            "currency": "USD",
            "receipt_date": datetime(2026, 3, 1, tzinfo=timezone.utc),
            "classification_confidence": 0.9,
            "classification_source": "deterministic",
            "receipt_checksum": "checksum",
        },
    )

    async def _upsert_receipt(**kwargs):
        return True

    monkeypatch.setattr(service, "_upsert_receipt", _upsert_receipt)

    await service._run_sync_worker(run_id="gmail_sync_test", user_id="user_123")

    assert len(terminal_updates) == 1
    assert terminal_updates[0][1]["synced_count"] == 1


@pytest.mark.asyncio
async def test_run_sync_worker_cancels_when_connection_becomes_disconnected(monkeypatch):
    service = GmailReceiptsService()
    canceled_updates: list[tuple[str, dict | None]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            if "SELECT trigger_source" in sql:
                return SimpleNamespace(data=[{"trigger_source": "manual"}])
            if (
                "UPDATE kai_gmail_sync_runs" in sql
                and isinstance(params, dict)
                and params.get("status") == "canceled"
            ):
                canceled_updates.append((sql, params))
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda user_id: asyncio.sleep(0, result=("token", {"last_sync_at": None})),
    )
    monkeypatch.setattr(
        service,
        "_list_messages",
        lambda **kwargs: asyncio.sleep(0, result={"messages": [], "nextPageToken": None}),
    )
    state_iter = iter([True, False])
    monkeypatch.setattr(service, "_is_connection_sync_active", lambda user_id: next(state_iter))
    monkeypatch.setattr(service, "_is_run_sync_active", lambda run_id: True)

    with pytest.raises(asyncio.CancelledError):
        await service._run_sync_worker(run_id="gmail_sync_test", user_id="user_123")

    assert canceled_updates


@pytest.mark.asyncio
async def test_disconnect_cancels_inflight_sync_run_and_marks_it_canceled(monkeypatch):
    service = GmailReceiptsService()

    class _FakeTask:
        def __init__(self):
            self.cancel_calls = 0

        def cancel(self):
            self.cancel_calls += 1

    sync_task = _FakeTask()
    service._sync_tasks_by_run_id["gmail_sync_active"] = sync_task
    active_run_queries: list[tuple[str, dict | None]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            active_run_queries.append((sql, params))
            if "SELECT run_id" in sql and "kai_gmail_sync_runs" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "run_id": "gmail_sync_active",
                            "status": "running",
                        }
                    ]
                )
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_fetch_connection_row",
        lambda user_id: {
            "refresh_token_ciphertext": None,
            "refresh_token_iv": None,
            "refresh_token_tag": None,
        },
    )
    monkeypatch.setattr(service, "_decrypt_token", lambda *args, **kwargs: "")
    monkeypatch.setattr(
        service, "get_status", lambda user_id: asyncio.sleep(0, result={"status": "disconnected"})
    )

    result = await service.disconnect(user_id="user_123")

    assert result == {"status": "disconnected"}
    assert sync_task.cancel_calls == 1
    assert any(
        "UPDATE kai_gmail_sync_runs" in query
        and isinstance(params, dict)
        and params.get("status") == "canceled"
        for query, params in active_run_queries
    )


@pytest.mark.asyncio
async def test_get_status_returns_snapshot_without_remote_api_calls(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_watch_enabled", lambda: True)
    monkeypatch.setattr(service, "_reconcile_active_runs", lambda **kwargs: None)
    monkeypatch.setattr(
        service,
        "_fetch_connection_row",
        lambda user_id: {
            "status": "connected",
            "revoked": False,
            "google_email": "user@example.com",
            "google_sub": "sub_123",
            "scope_csv": "gmail.readonly",
            "last_sync_at": None,
            "last_sync_status": "idle",
            "last_sync_error": None,
            "auto_sync_enabled": True,
            "connected_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
            "disconnected_at": None,
            "bootstrap_state": "completed",
            "watch_status": "active",
            "watch_expiration_at": datetime(2030, 3, 2, tzinfo=timezone.utc),
            "status_refreshed_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
            "last_notification_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
            "receipt_total": 12,
        },
    )
    monkeypatch.setattr(service, "_latest_sync_run", lambda user_id: None)
    monkeypatch.setattr(
        service,
        "_count_receipts",
        lambda user_id: (_ for _ in ()).throw(AssertionError("status should use cached count")),
    )
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("status should not refresh tokens")),
    )

    status = await service.get_status(user_id="user_123")

    assert status["connected"] is True
    assert status["connection_state"] == "connected"
    assert status["sync_state"] == "idle"
    assert status["watch_status"] == "active"
    assert status["receipt_counts"]["total"] == 12


@pytest.mark.asyncio
async def test_reconcile_connection_renews_watch_without_listing_messages(monkeypatch):
    service = GmailReceiptsService()
    watch_updates: list[tuple[str, dict | None]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            watch_updates.append((sql, params))
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_watch_enabled", lambda: True)
    row = {
        "status": "connected",
        "revoked": False,
        "watch_status": "active",
        "watch_expiration_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
        "history_id": "200",
        "last_sync_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
        "last_notification_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
    }
    monkeypatch.setattr(service, "_fetch_connection_row", lambda user_id: row)
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda user_id: asyncio.sleep(0, result=("token", row)),
    )
    monkeypatch.setattr(
        service,
        "_register_watch",
        lambda **kwargs: asyncio.sleep(
            0,
            result={
                "watch_status": "active",
                "watch_expiration_at": datetime(2026, 3, 2, tzinfo=timezone.utc),
                "history_id": "210",
            },
        ),
    )
    monkeypatch.setattr(
        service,
        "_list_messages",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("reconcile must not scan mail")),
    )
    monkeypatch.setattr(
        service,
        "get_status",
        lambda user_id: asyncio.sleep(0, result={"user_id": user_id, "status": "connected"}),
    )

    result = await service.reconcile_connection(user_id="user_123")

    assert result == {"user_id": "user_123", "status": "connected"}
    assert any("watch_status = :watch_status" in sql for sql, _ in watch_updates)


@pytest.mark.asyncio
async def test_handle_push_notification_updates_snapshot_and_queues_incremental(monkeypatch):
    service = GmailReceiptsService()
    db_calls: list[tuple[str, dict | None]] = []
    monkeypatch.setenv("GMAIL_WEBHOOK_AUTH_ENABLED", "false")
    monkeypatch.setattr(service, "_watch_enabled", lambda: True)

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            db_calls.append((sql, params))
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_fetch_connection_row_by_email",
        lambda google_email: {
            "user_id": "user_123",
            "status": "connected",
            "revoked": False,
            "history_id": "200",
        },
    )
    queued: list[dict[str, object]] = []

    async def _queue_sync(**kwargs):
        queued.append(kwargs)
        return {"accepted": True, "run": {"run_id": "gmail_sync_1"}}

    monkeypatch.setattr(service, "queue_sync", _queue_sync)
    payload = {
        "message": {
            "data": "eyJlbWFpbEFkZHJlc3MiOiAidXNlckBleGFtcGxlLmNvbSIsICJoaXN0b3J5SWQiOiAiMjEwIn0="
        }
    }

    result = await service.handle_push_notification(payload)

    assert result["accepted"] is True
    assert queued[0]["sync_mode"] == "incremental"
    assert queued[0]["end_history_id"] == "210"
    assert queued[0]["notification_history_id"] == "210"
    assert db_calls == []


@pytest.mark.asyncio
async def test_handle_push_notification_rejects_unexpected_subscription(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setenv("GMAIL_WEBHOOK_AUTH_ENABLED", "false")
    monkeypatch.setenv("GMAIL_WEBHOOK_SUBSCRIPTION", "projects/demo/subscriptions/expected")

    with pytest.raises(GmailApiError) as exc_info:
        await service.handle_push_notification(
            {
                "subscription": "projects/demo/subscriptions/other",
                "message": {
                    "data": "eyJlbWFpbEFkZHJlc3MiOiAidXNlckBleGFtcGxlLmNvbSIsICJoaXN0b3J5SWQiOiAiMjEwIn0="
                },
            }
        )

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_handle_push_notification_ignores_stale_history(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setenv("GMAIL_WEBHOOK_AUTH_ENABLED", "false")
    monkeypatch.setattr(service, "_watch_enabled", lambda: True)
    db_calls: list[tuple[str, dict | None]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            db_calls.append((sql, params))
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_fetch_connection_row_by_email",
        lambda google_email: {
            "user_id": "user_123",
            "status": "connected",
            "revoked": False,
            "history_id": "210",
        },
    )

    result = await service.handle_push_notification(
        {
            "message": {
                "data": "eyJlbWFpbEFkZHJlc3MiOiAidXNlckBleGFtcGxlLmNvbSIsICJoaXN0b3J5SWQiOiAiMjA5In0="
            }
        }
    )

    assert result == {"accepted": True, "handled": False, "reason": "stale_history"}
    assert any("last_notification_at = NOW()" in sql for sql, _ in db_calls)


@pytest.mark.asyncio
async def test_queue_sync_advances_webhook_history_atomically(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setenv("GMAIL_OAUTH_TOKEN_KEY", "fixture-" + "tokenkey")

    conn = _FakeConn(
        rows=[
            {
                "user_id": "user_123",
                "status": "connected",
                "auto_sync_enabled": True,
                "revoked": False,
                "history_id": "200",
            },
            None,
        ]
    )

    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_pool",
        lambda: asyncio.sleep(0, result=_FakePool(conn)),
    )
    monkeypatch.setattr(service, "_dispatch_sync_run", lambda **kwargs: None)

    result = await service.queue_sync(
        user_id="user_123",
        trigger_source="webhook",
        sync_mode="incremental",
        end_history_id="210",
        notification_history_id="210",
        notification_received_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
    )

    assert result["accepted"] is True
    assert conn.inserted is not None
    assert conn.execute_calls
    assert "UPDATE kai_gmail_connections" in conn.execute_calls[0][0]
    assert "last_notification_at = COALESCE($3, last_notification_at)" in conn.execute_calls[0][0]


@pytest.mark.asyncio
async def test_run_sync_worker_incremental_uses_history_list(monkeypatch):
    service = GmailReceiptsService()
    history_calls: list[dict[str, object]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            if "SELECT" in sql and "FROM kai_gmail_sync_runs" in sql and "sync_mode" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "trigger_source": "manual",
                            "sync_mode": "incremental",
                            "start_history_id": "200",
                            "end_history_id": "210",
                            "window_start_at": None,
                            "window_end_at": None,
                        }
                    ]
                )
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda user_id: asyncio.sleep(0, result=("token", {"history_id": "200"})),
    )
    monkeypatch.setattr(service, "_is_connection_sync_active", lambda user_id: True)
    monkeypatch.setattr(service, "_is_run_sync_active", lambda run_id: True)

    async def _list_history(**kwargs):
        history_calls.append(kwargs)
        return {
            "history": [{"messagesAdded": [{"message": {"id": "msg_1"}}]}],
            "historyId": "210",
            "nextPageToken": None,
        }

    monkeypatch.setattr(service, "_list_history", _list_history)
    monkeypatch.setattr(
        service,
        "_get_message_metadata_batch",
        lambda **kwargs: asyncio.sleep(0, result=[{"id": "msg_1", "historyId": "210"}]),
    )
    monkeypatch.setattr(
        service,
        "_candidate_from_message",
        lambda metadata: _candidate(gmail_message_id=str(metadata["id"]), gmail_history_id="210"),
    )
    monkeypatch.setattr(
        service,
        "_classify_candidate",
        lambda candidate: {"is_receipt": True, "confidence": 0.9, "source": "deterministic"},
    )
    monkeypatch.setattr(
        service,
        "_extract_receipt_fields",
        lambda **kwargs: {
            "merchant_name": "Amazon",
            "order_id": "ORDER-1",
            "amount": 19.99,
            "currency": "USD",
            "receipt_date": datetime(2026, 3, 1, tzinfo=timezone.utc),
            "classification_confidence": 0.9,
            "classification_source": "deterministic",
            "receipt_checksum": "checksum",
        },
    )

    async def _upsert_receipt(**kwargs):
        return True

    monkeypatch.setattr(service, "_upsert_receipt", _upsert_receipt)

    await service._run_sync_worker(run_id="gmail_sync_test", user_id="user_123")

    assert len(history_calls) == 1
    assert history_calls[0]["start_history_id"] == "200"


@pytest.mark.asyncio
async def test_run_sync_worker_history_gap_queues_recovery(monkeypatch):
    service = GmailReceiptsService()

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            if "SELECT" in sql and "FROM kai_gmail_sync_runs" in sql and "sync_mode" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "trigger_source": "manual",
                            "sync_mode": "incremental",
                            "start_history_id": "200",
                            "end_history_id": None,
                            "window_start_at": None,
                            "window_end_at": None,
                        }
                    ]
                )
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_ensure_access_token",
        lambda user_id: asyncio.sleep(0, result=("token", {"history_id": "200"})),
    )
    monkeypatch.setattr(service, "_is_connection_sync_active", lambda user_id: True)
    monkeypatch.setattr(service, "_is_run_sync_active", lambda run_id: True)

    async def _list_history(**kwargs):
        raise GmailApiError("history missing", status_code=404)

    monkeypatch.setattr(service, "_list_history", _list_history)
    queued: list[dict[str, object]] = []

    async def _queue_sync(**kwargs):
        queued.append(kwargs)
        return {"accepted": True, "run": {"run_id": "gmail_sync_recovery"}}

    monkeypatch.setattr(service, "queue_sync", _queue_sync)

    await service._run_sync_worker(run_id="gmail_sync_test", user_id="user_123")

    assert queued
    assert queued[0]["sync_mode"] == "recovery"


@pytest.mark.asyncio
async def test_ensure_access_token_marks_needs_reauth_on_refresh_failure(monkeypatch):
    service = GmailReceiptsService()
    db_calls: list[tuple[str, dict | None]] = []

    class _CaptureDb:
        def execute_raw(self, sql, params=None):
            db_calls.append((sql, params))
            return SimpleNamespace(data=[])

    service._db = _CaptureDb()
    monkeypatch.setattr(
        service,
        "_fetch_connection_row",
        lambda user_id: {
            "status": "connected",
            "refresh_token_ciphertext": "cipher",
            "refresh_token_iv": "iv",
            "refresh_token_tag": "tag",
            "access_token_ciphertext": None,
            "access_token_iv": None,
            "access_token_tag": None,
            "access_token_expires_at": None,
        },
    )
    monkeypatch.setattr(service, "_decrypt_token", lambda *args, **kwargs: "refresh-token")

    async def _refresh_access_token(**kwargs):
        raise GmailApiError("invalid_grant", status_code=401)

    monkeypatch.setattr(service, "_refresh_access_token", _refresh_access_token)

    with pytest.raises(GmailApiError) as exc_info:
        await service._ensure_access_token(user_id="user_123")

    assert exc_info.value.status_code == 401
    assert any("SET status = 'error'" in sql for sql, _ in db_calls)
