"""Transient Cloud SQL proxy handling for the local IAM preflight."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import asyncpg

from db.verify import verify_iam_schema


def test_connect_with_retry_recovers_from_proxy_reset(monkeypatch) -> None:
    connection = object()
    connect = AsyncMock(
        side_effect=[
            asyncpg.ConnectionDoesNotExistError("connection reset by peer"),
            connection,
        ]
    )
    sleep = AsyncMock()
    monkeypatch.setattr(verify_iam_schema.asyncpg, "connect", connect)
    monkeypatch.setattr(verify_iam_schema.asyncio, "sleep", sleep)

    assert asyncio.run(verify_iam_schema._connect_with_retry()) is connection
    assert connect.await_count == 2
    sleep.assert_awaited_once_with(1)


def test_connect_with_retry_reports_bounded_failure(monkeypatch) -> None:
    connect = AsyncMock(side_effect=asyncpg.ConnectionDoesNotExistError("connection reset by peer"))
    monkeypatch.setattr(verify_iam_schema.asyncpg, "connect", connect)
    monkeypatch.setattr(verify_iam_schema.asyncio, "sleep", AsyncMock())

    try:
        asyncio.run(verify_iam_schema._connect_with_retry())
    except RuntimeError as exc:
        assert "after 3 attempts" in str(exc)
        assert "ConnectionDoesNotExistError" in str(exc)
    else:
        raise AssertionError("expected retry exhaustion to fail")
    assert connect.await_count == 3
