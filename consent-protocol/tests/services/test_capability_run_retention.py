from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services.capability_run_service import (
    MAX_CAPABILITY_RUN_RETENTION_PURGE,
    CapabilityRunStore,
)


class _RecordingDatabase:
    def __init__(self, rows: list[dict[str, str]]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, dict[str, object]]] = []

    def execute_raw(self, sql: str, params: dict[str, object]) -> SimpleNamespace:
        self.calls.append((sql, params))
        return SimpleNamespace(data=self.rows)


@pytest.mark.asyncio
async def test_purge_expired_removes_a_bounded_parent_batch_and_returns_deleted_count() -> None:
    database = _RecordingDatabase([{"run_id": "run_1"}, {"run_id": "run_2"}])
    store = CapabilityRunStore(db=database, hmac_key="test-key")

    deleted = await store.purge_expired(limit=7)

    assert deleted == 2
    assert len(database.calls) == 1
    sql, params = database.calls[0]
    normalized_sql = " ".join(sql.split())
    assert params == {"limit": 7}
    assert "WHERE expires_at <= NOW()" in normalized_sql
    assert "ORDER BY expires_at ASC, run_id ASC" in normalized_sql
    assert "LIMIT :limit" in normalized_sql
    assert "FOR UPDATE SKIP LOCKED" in normalized_sql
    assert "DELETE FROM one_capability_runs AS run" in normalized_sql
    assert "RETURNING run.run_id" in normalized_sql
    # Child rows are physically removed by their FK ON DELETE CASCADE rather
    # than by an application-side delete with a second retention authority.
    assert "one_location_" not in normalized_sql


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, -1, MAX_CAPABILITY_RUN_RETENTION_PURGE + 1, True])
async def test_purge_expired_rejects_unbounded_or_invalid_limits(limit: int | bool) -> None:
    database = _RecordingDatabase([])
    store = CapabilityRunStore(db=database, hmac_key="test-key")

    with pytest.raises(ValueError, match="retention purge limit"):
        await store.purge_expired(limit=limit)

    assert database.calls == []
