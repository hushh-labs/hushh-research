from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from hushh_mcp.services.renaissance_service import RenaissanceService


class _FakeQuery:
    def __init__(self, rows: list[dict], execute_thread_ids: list[int]):
        self._rows = rows
        self._execute_thread_ids = execute_thread_ids

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def execute(self):
        self._execute_thread_ids.append(threading.get_ident())
        return SimpleNamespace(data=self._rows)


class _FakeDb:
    def __init__(self):
        self.execute_thread_ids: list[int] = []

    def table(self, _table_name: str):
        return _FakeQuery(
            [
                {
                    "ticker": "AAPL",
                    "company_name": "Apple",
                    "sector": "Technology",
                    "tier": "ACE",
                    "fcf_billions": 100.0,
                    "investment_thesis": "Synthetic test row",
                    "tier_rank": 1,
                }
            ],
            self.execute_thread_ids,
        )


@pytest.mark.asyncio
async def test_renaissance_query_does_not_block_event_loop(monkeypatch):
    fake_db = _FakeDb()
    service = RenaissanceService()
    service._db = fake_db
    monkeypatch.setattr(service, "_is_supported_symbol", lambda _ticker: True)

    event_loop_thread = threading.get_ident()
    is_investable, stock = await service.is_investable("AAPL")

    assert is_investable is True
    assert stock is not None
    assert fake_db.execute_thread_ids
    assert all(thread_id != event_loop_thread for thread_id in fake_db.execute_thread_ids)
