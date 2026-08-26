from __future__ import annotations

import asyncio
import copy
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.services import broker_funding_service as broker_funding_module
from hushh_mcp.services.broker_funding_service import (
    BrokerFundingService,
    FundingOrchestrationError,
)


class _Rows:
    def __init__(self, rows: list[dict[str, Any]] | None = None, *, returns_rows: bool = True):
        self._rows = rows or []
        self.returns_rows = returns_rows

    def fetchall(self) -> list[dict[str, Any]]:
        return self._rows


class _TransactionConnection:
    def __init__(self, database: "_AtomicFundingDb") -> None:
        self.database = database
        self.transfers = copy.deepcopy(database.transfers)
        self.events = copy.deepcopy(database.events)

    def execute(self, statement, params: dict[str, Any]) -> _Rows:
        sql = " ".join(str(statement).split())
        if sql.startswith("SELECT * FROM kai_funding_transfers"):
            row = self.transfers.get(params["transfer_id"])
            if row is None or row.get("user_id") != params["user_id"]:
                return _Rows([])
            return _Rows([copy.deepcopy(row)])

        if sql.startswith("INSERT INTO kai_funding_transfers"):
            transfer_id = params["transfer_id"]
            existing = self.transfers.get(transfer_id, {})
            self.transfers[transfer_id] = {
                **existing,
                "transfer_id": transfer_id,
                "user_id": params["user_id"],
                "alpaca_account_id": params["alpaca_account_id"],
                "relationship_id": params["relationship_id"],
                "item_id": params["item_id"],
                "account_id": params["account_id"],
                "direction": params["direction"],
                "amount": params["amount"],
                "currency": params["currency"],
                "status": params["status"],
                "user_facing_status": params["user_facing_status"],
                "failure_reason_code": params["failure_reason_code"],
                "failure_reason_message": params["failure_reason_message"],
                "idempotency_key": params["idempotency_key"],
                "request_payload_json": params["request_payload_json"],
                "response_payload_json": params["response_payload_json"],
                "completed_at": params["completed_at"],
                "requested_at": existing.get("requested_at", "2026-08-26T00:00:00Z"),
            }
            return _Rows(returns_rows=False)

        if sql.startswith("INSERT INTO kai_funding_transfer_events"):
            self.database.event_insert_attempts += 1
            event_id = params["event_id"]
            if event_id in self.events:
                return _Rows([])
            if self.database.fail_event_insert:
                raise RuntimeError("event insert failed")
            self.events[event_id] = copy.deepcopy(params)
            return _Rows([{"event_id": event_id}])

        raise AssertionError(f"Unexpected transactional SQL: {sql}")


class _Transaction:
    def __init__(self, database: "_AtomicFundingDb") -> None:
        self.database = database
        self.connection = _TransactionConnection(database)

    def __enter__(self) -> _TransactionConnection:
        self.database.transaction_log.append("begin")
        return self.connection

    def __exit__(self, exc_type, _exc, _traceback) -> bool:
        if exc_type is not None:
            self.database.transaction_log.append("rollback")
            return False
        self.database.transfers = self.connection.transfers
        self.database.events = self.connection.events
        self.database.transaction_log.append("commit")
        return False


class _Engine:
    def __init__(self, database: "_AtomicFundingDb") -> None:
        self.database = database

    def begin(self) -> _Transaction:
        return _Transaction(self.database)


class _AtomicFundingDb:
    def __init__(self) -> None:
        self.transfers: dict[str, dict[str, Any]] = {}
        self.events: dict[str, dict[str, Any]] = {}
        self.transaction_log: list[str] = []
        self.persistence_log: list[str] = []
        self.event_insert_attempts = 0
        self.fail_event_insert = False
        self.engine = _Engine(self)

    def execute_raw(self, sql: str, params: dict[str, Any]) -> SimpleNamespace:
        normalized = " ".join(sql.split())
        if normalized.startswith("SELECT * FROM kai_funding_transfers"):
            row = self.transfers.get(params["transfer_id"])
            if row is None or row.get("user_id") != params["user_id"]:
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=[copy.deepcopy(row)])

        if normalized.startswith("INSERT INTO kai_funding_transfers"):
            transfer_id = params["transfer_id"]
            existing = self.transfers.get(transfer_id, {})
            self.transfers[transfer_id] = {
                **existing,
                "transfer_id": transfer_id,
                "user_id": params["user_id"],
                "alpaca_account_id": params["alpaca_account_id"],
                "relationship_id": params["relationship_id"],
                "item_id": params["item_id"],
                "account_id": params["account_id"],
                "direction": params["direction"],
                "amount": params["amount"],
                "currency": params["currency"],
                "status": params["status"],
                "user_facing_status": params["user_facing_status"],
                "failure_reason_code": params["failure_reason_code"],
                "failure_reason_message": params["failure_reason_message"],
                "idempotency_key": params["idempotency_key"],
                "request_payload_json": params["request_payload_json"],
                "response_payload_json": params["response_payload_json"],
                "completed_at": params["completed_at"],
                "requested_at": existing.get("requested_at", "2026-08-26T00:00:00Z"),
            }
            self.persistence_log.append("transfer_commit")
            return SimpleNamespace(data=[])

        if normalized.startswith("INSERT INTO kai_funding_transfer_events"):
            self.event_insert_attempts += 1
            event_id = params["event_id"]
            if event_id in self.events:
                return SimpleNamespace(data=[])
            if self.fail_event_insert:
                raise RuntimeError("event insert failed")
            self.events[event_id] = copy.deepcopy(params)
            self.persistence_log.append("event_commit")
            return SimpleNamespace(data=[{"event_id": event_id}])

        raise AssertionError(f"Unexpected committed SQL: {normalized}")


def _configure_create_transfer(
    monkeypatch: pytest.MonkeyPatch,
    service: BrokerFundingService,
    database: _AtomicFundingDb,
    *,
    status: str = "COMPLETED",
) -> list[dict[str, Any]]:
    monkeypatch.setattr(service, "_fetch_funding_item_row", lambda **_: {"item_id": "item-1"})
    monkeypatch.setattr(service, "_find_funding_account", lambda **_: {"account_id": "bank-1"})
    monkeypatch.setattr(service, "_set_default_funding_account", lambda **_: None)
    monkeypatch.setattr(service, "_resolve_alpaca_account_id", lambda **_: "alpaca-1")
    monkeypatch.setattr(service, "_upsert_brokerage_account", lambda **_: None)
    monkeypatch.setattr(service, "_get_funding_item_access_token", lambda _row: "token")
    monkeypatch.setattr(
        service,
        "_find_relationship_by_id",
        lambda **_: {"relationship_id": "relationship-1", "status": "APPROVED"},
    )

    async def _refresh_relationship_status(*, relationship):
        return relationship

    monkeypatch.setattr(service, "_refresh_relationship_status", _refresh_relationship_status)
    monkeypatch.setattr(service, "_relationship_status_requirements", lambda **_: None)
    monkeypatch.setattr(service, "_validate_amount_limit", lambda **_: None)

    @asynccontextmanager
    async def _reservation(**_kwargs):
        yield

    monkeypatch.setattr(service, "_funding_create_reservation", _reservation)
    monkeypatch.setattr(
        service,
        "_fetch_transfer_row_by_idempotency",
        lambda **_: next(iter(database.transfers.values()), None),
    )

    alpaca_posts: list[dict[str, Any]] = []

    async def _alpaca_post(_path: str, payload: dict[str, Any]):
        alpaca_posts.append(payload)
        return {
            "id": "transfer-1",
            "status": status,
            "direction": "INCOMING",
            "amount": "100.00",
            "currency": "USD",
        }

    monkeypatch.setattr(service, "_alpaca_post", _alpaca_post)

    async def _remote_transfer(**_kwargs):
        return {
            "transfer_id": "transfer-1",
            "status": status,
            "direction": "INCOMING",
            "amount": "100.00",
            "currency": "USD",
            "failure_reason_code": None,
            "failure_reason_message": None,
            "raw": {"id": "transfer-1", "status": status},
        }

    monkeypatch.setattr(service, "_fetch_transfer_from_alpaca", _remote_transfer)

    async def _process_trade_intents_for_transfer(**_kwargs):
        return []

    monkeypatch.setattr(
        service,
        "_process_trade_intents_for_transfer",
        _process_trade_intents_for_transfer,
    )
    return alpaca_posts


async def _create_transfer(service: BrokerFundingService) -> dict[str, Any]:
    return await service.create_transfer(
        user_id="user-1",
        funding_item_id="item-1",
        funding_account_id="bank-1",
        amount="100.00",
        user_legal_name="Test User",
        idempotency_key="idem-1",
        relationship_id="relationship-1",
    )


@pytest.mark.asyncio
async def test_creation_event_failure_retry_repairs_without_second_alpaca_post(monkeypatch):
    database = _AtomicFundingDb()
    database.fail_event_insert = True
    service = BrokerFundingService()
    service._db = database
    alpaca_posts = _configure_create_transfer(monkeypatch, service, database)
    pushes: list[dict[str, Any]] = []
    monkeypatch.setattr(
        service,
        "_queue_transfer_status_notification_if_needed",
        lambda **kwargs: pushes.append(kwargs),
    )

    with pytest.raises(RuntimeError, match="event insert failed"):
        await _create_transfer(service)

    assert database.transfers["transfer-1"]["status"] == "completed"
    assert database.events == {}
    assert database.persistence_log == ["transfer_commit"]
    assert pushes == []
    assert len(alpaca_posts) == 1

    database.fail_event_insert = False
    retried = await _create_transfer(service)

    assert retried["deduped"] is True
    assert len(alpaca_posts) == 1
    assert len(database.transfers) == 1
    assert len(database.events) == 1
    assert database.persistence_log == ["transfer_commit", "event_commit"]
    assert len(pushes) == 1


@pytest.mark.asyncio
async def test_creation_response_loss_retry_adds_no_event_or_push_duplicate(monkeypatch):
    database = _AtomicFundingDb()
    service = BrokerFundingService()
    service._db = database
    alpaca_posts = _configure_create_transfer(monkeypatch, service, database)
    pushes: list[dict[str, Any]] = []

    def _record_push(**kwargs):
        assert database.persistence_log[-1] == "event_commit"
        pushes.append(kwargs)

    monkeypatch.setattr(service, "_queue_transfer_status_notification_if_needed", _record_push)

    created = await _create_transfer(service)
    retried = await _create_transfer(service)

    assert created["transfer"]["transfer_id"] == "transfer-1"
    assert retried["deduped"] is True
    assert len(alpaca_posts) == 1
    assert len(database.transfers) == 1
    assert len(database.events) == 1
    assert database.event_insert_attempts == 2
    assert len(pushes) == 1


def _pending_transfer() -> dict[str, Any]:
    return {
        "transfer_id": "transfer-1",
        "user_id": "user-1",
        "alpaca_account_id": "alpaca-1",
        "relationship_id": "relationship-1",
        "item_id": "item-1",
        "account_id": "bank-1",
        "direction": "INCOMING",
        "amount": "100.00",
        "currency": "USD",
        "status": "pending",
        "user_facing_status": "pending",
        "failure_reason_code": None,
        "failure_reason_message": None,
        "idempotency_key": "idem-1",
        "request_payload_json": "{}",
        "response_payload_json": "{}",
        "completed_at": None,
        "requested_at": "2026-08-26T00:00:00Z",
    }


def _seed_creation_event(service: BrokerFundingService, database: _AtomicFundingDb) -> None:
    inserted = service._record_transfer_creation_event_from_row(
        database.transfers["transfer-1"],
        event_source="test_seed",
    )
    assert inserted is True
    database.event_insert_attempts = 0
    database.persistence_log.clear()


@pytest.mark.asyncio
async def test_terminal_event_failure_rolls_back_status_and_never_pushes(monkeypatch):
    database = _AtomicFundingDb()
    database.transfers["transfer-1"] = _pending_transfer()
    service = BrokerFundingService()
    service._db = database
    _seed_creation_event(service, database)
    database.fail_event_insert = True
    _configure_create_transfer(monkeypatch, service, database)
    pushes: list[dict[str, Any]] = []
    monkeypatch.setattr(
        service,
        "_queue_transfer_status_notification_if_needed",
        lambda **kwargs: pushes.append(kwargs),
    )

    with pytest.raises(RuntimeError, match="event insert failed"):
        await service.get_transfer(user_id="user-1", transfer_id="transfer-1")

    assert database.transfers["transfer-1"]["status"] == "pending"
    assert len(database.events) == 1
    assert database.transaction_log == ["begin", "rollback"]
    assert pushes == []


@pytest.mark.asyncio
async def test_unchanged_terminal_retry_does_not_duplicate_event_or_push(monkeypatch):
    database = _AtomicFundingDb()
    database.transfers["transfer-1"] = _pending_transfer()
    service = BrokerFundingService()
    service._db = database
    _seed_creation_event(service, database)
    _configure_create_transfer(monkeypatch, service, database)
    pushes: list[dict[str, Any]] = []
    monkeypatch.setattr(
        service,
        "_queue_transfer_status_notification_if_needed",
        lambda **kwargs: pushes.append(kwargs),
    )

    await service.get_transfer(user_id="user-1", transfer_id="transfer-1")
    await service.get_transfer(user_id="user-1", transfer_id="transfer-1")

    assert database.transfers["transfer-1"]["status"] == "completed"
    assert len(database.events) == 2
    assert database.event_insert_attempts == 1
    assert len(pushes) == 1
    assert pushes[0]["previous_status"] == "PENDING"
    assert pushes[0]["current_status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_concurrent_same_idempotency_key_allows_only_one_alpaca_post(monkeypatch):
    database = _AtomicFundingDb()
    service = BrokerFundingService()
    service._db = database
    _configure_create_transfer(monkeypatch, service, database)
    reservation_held = False

    @asynccontextmanager
    async def _exclusive_reservation(**_kwargs):
        nonlocal reservation_held
        if reservation_held:
            raise FundingOrchestrationError(
                "already in progress",
                code="FUNDING_TRANSFER_CREATION_IN_PROGRESS",
                status_code=409,
            )
        reservation_held = True
        try:
            yield
        finally:
            reservation_held = False

    monkeypatch.setattr(service, "_funding_create_reservation", _exclusive_reservation)
    post_started = asyncio.Event()
    allow_post_response = asyncio.Event()
    alpaca_posts: list[dict[str, Any]] = []

    async def _controlled_alpaca_post(_path: str, payload: dict[str, Any]):
        alpaca_posts.append(payload)
        post_started.set()
        await allow_post_response.wait()
        return {
            "id": "transfer-1",
            "status": "COMPLETED",
            "direction": "INCOMING",
            "amount": "100.00",
            "currency": "USD",
        }

    monkeypatch.setattr(service, "_alpaca_post", _controlled_alpaca_post)
    first = asyncio.create_task(_create_transfer(service))
    await post_started.wait()

    with pytest.raises(FundingOrchestrationError) as concurrent:
        await _create_transfer(service)
    assert concurrent.value.code == "FUNDING_TRANSFER_CREATION_IN_PROGRESS"
    assert concurrent.value.status_code == 409

    allow_post_response.set()
    created = await first
    retried = await _create_transfer(service)

    assert created["transfer"]["transfer_id"] == "transfer-1"
    assert retried["deduped"] is True
    assert len(alpaca_posts) == 1
    assert len(database.transfers) == 1
    assert len(database.events) == 1


@pytest.mark.asyncio
async def test_create_reservation_uses_postgres_advisory_lock_and_releases(monkeypatch):
    calls: list[tuple[str, int]] = []
    results = [True, True]

    class _Connection:
        async def fetchval(self, sql: str, lock_key: int) -> bool:
            calls.append((sql, lock_key))
            return results.pop(0)

    class _Acquire:
        async def __aenter__(self):
            return _Connection()

        async def __aexit__(self, _exc_type, _exc, _traceback):
            return False

    class _Pool:
        def acquire(self):
            return _Acquire()

    async def _get_pool():
        return _Pool()

    monkeypatch.setattr(broker_funding_module, "get_pool", _get_pool)
    service = BrokerFundingService()

    async with service._funding_create_reservation(
        user_id="user-1",
        idempotency_key="idem-1",
    ):
        assert calls[0][0] == "SELECT pg_try_advisory_lock($1)"

    assert calls[1][0] == "SELECT pg_advisory_unlock($1)"
    assert calls[0][1] == calls[1][1]

    calls.clear()
    results.append(False)
    with pytest.raises(FundingOrchestrationError) as concurrent:
        async with service._funding_create_reservation(
            user_id="user-1",
            idempotency_key="idem-1",
        ):
            raise AssertionError("A concurrent owner must not enter the reservation body")
    assert concurrent.value.code == "FUNDING_TRANSFER_CREATION_IN_PROGRESS"
    assert [sql for sql, _lock_key in calls] == ["SELECT pg_try_advisory_lock($1)"]
