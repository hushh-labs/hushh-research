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


def test_build_receipt_query_contains_keywords_and_after_epoch():
    service = GmailReceiptsService()
    since = datetime(2025, 1, 15, tzinfo=timezone.utc)

    query = service._build_receipt_query(query_since=since)

    assert "category:purchases" in query
    assert "subject:(receipt OR invoice OR order OR payment OR transaction)" in query
    assert "\"order total\"" in query
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
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("GMAIL_TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("GMAIL_ALLOW_LOCAL_DEV_FALLBACK", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")

    service = GmailReceiptsService()

    with pytest.raises(RuntimeError):
        service._state_secret()

    with pytest.raises(RuntimeError):
        service._token_key()


@pytest.mark.asyncio
async def test_complete_connect_returns_status_even_when_initial_queue_sync_fails(monkeypatch, caplog):
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
    monkeypatch.setattr(service, "_http_get_json", lambda *args, **kwargs: asyncio.sleep(0, result={"emailAddress": "user@example.com"}))
    monkeypatch.setattr(service, "_decode_id_token_claims", lambda id_token: {"sub": "google-sub", "email": "user@example.com"})
    monkeypatch.setattr(
        service,
        "_encrypt_token",
        lambda token: {"ciphertext": f"{token}-ciphertext", "iv": f"{token}-iv", "tag": f"{token}-tag"},
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
    monkeypatch.setenv("GMAIL_TOKEN_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
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
    monkeypatch.setenv("GMAIL_TOKEN_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
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
                "requested_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
                "started_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
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

    result = await service.queue_sync(user_id="user_123", trigger_source="manual")

    assert result["accepted"] is False
    assert result["reason"] == "sync_already_running"
    assert result["run"]["run_id"] == "gmail_sync_existing"
    assert conn.inserted is None


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

    inserted = service._upsert_receipt(user_id="user_123", candidate=candidate, extracted=extracted)

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
    monkeypatch.setattr(service, "_ensure_access_token", lambda user_id: asyncio.sleep(0, result=("token", {"last_sync_at": None})))
    monkeypatch.setattr(
        service,
        "_list_messages",
        lambda **kwargs: asyncio.sleep(0, result={"messages": [], "nextPageToken": None}),
    )

    await service._run_sync_worker(run_id="gmail_sync_test", user_id="user_123")

    completion_sql = next(sql for sql in captured_sql if "UPDATE kai_gmail_sync_runs" in sql and "status = 'completed'" in sql)
    assert "CAST(:metrics_json AS jsonb)" in completion_sql
    assert ":metrics_json::jsonb" not in completion_sql
