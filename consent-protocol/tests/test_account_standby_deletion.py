"""Account deletion treats a standby agent exactly like the primary (STANDBY-SYNC.md E10).

The real Postgres proof of the plain refusal lives in
``tests/test_personal_agent_standby_store_postgres.py``. These drive the decision
branches a disposable database cannot reach cheaply: a FINISHED primary erasure does
not cover a standby in another cloud, and a schema without 950 never consults it.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from hushh_mcp.services.account_service import (
    AccountService,
    PersonalAgentDeprovisioningRequiredError,
)

STANDBY = "personal_agent_standby_placements"


def _conn(*, registry: dict | None, standby: bool, erasure_complete: bool = True) -> MagicMock:
    """A connection answering each guard statement by what it asks."""
    conn = MagicMock()

    def execute(statement, params=None):
        sql = " ".join(str(statement).split())
        result = MagicMock()
        result.first.return_value = None
        result.mappings.return_value.first.return_value = None
        result.scalar.return_value = None
        if "FROM personal_agent_registry AS registry" in sql:
            result.mappings.return_value.first.return_value = (
                {"registry": registry} if registry else None
            )
        elif "FROM personal_agent_standby_placements" in sql and sql.startswith("SELECT"):
            result.first.return_value = (True,) if standby else None
        elif "to_regprocedure" in sql:
            result.scalar.return_value = True
        elif "personal_agent_erasure_complete" in sql or "finalize_personal_agent_erasure" in sql:
            result.scalar.return_value = erasure_complete
        return result

    conn.execute.side_effect = execute
    return conn


def _service(monkeypatch, present: set[str]) -> AccountService:
    service = AccountService()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, table: table in present)
    return service


def _statements(conn: MagicMock) -> list[str]:
    return [" ".join(str(call.args[0]).split()) for call in conn.execute.call_args_list]


_TABLES = {"personal_agent_registry", "pod_lifecycle_events", "byoc_setup_jobs", STANDBY}
_ERASED = {"hushh_id": "ha1_x", "status": "suspended", "backend_metadata": {"erasure": {"a": 1}}}
_EMPTY = {"hushh_id": "ha1_x", "status": "unprovisioned"}


def test_a_finished_primary_erasure_does_not_cover_a_standby(monkeypatch):
    service = _service(monkeypatch, _TABLES)
    conn = _conn(registry=_ERASED, standby=True)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        service._delete_personal_agent_state(conn, params={"user_id": "u"}, results={})
    executed = _statements(conn)
    assert not any("finalize_personal_agent_erasure" in sql for sql in executed)
    assert not any(sql.startswith("DELETE") for sql in executed)


def test_a_finished_primary_erasure_without_a_standby_still_finalizes(monkeypatch):
    service = _service(monkeypatch, _TABLES)
    conn = _conn(registry=_ERASED, standby=False)
    results: dict[str, bool] = {}
    service._delete_personal_agent_state(conn, params={"user_id": "u"}, results=results)
    executed = _statements(conn)
    assert any("finalize_personal_agent_erasure" in sql for sql in executed)
    assert any(sql.startswith("DELETE FROM personal_agent_standby_placements") for sql in executed)
    assert results[STANDBY] is True


def test_an_unprovisioned_primary_with_a_standby_is_refused(monkeypatch):
    service = _service(monkeypatch, _TABLES)
    conn = _conn(registry=_EMPTY, standby=True)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        service._delete_personal_agent_state(conn, params={"user_id": "u"}, results={})
    assert not any(sql.startswith("DELETE") for sql in _statements(conn))


def test_without_950_the_standby_is_never_consulted(monkeypatch):
    service = _service(monkeypatch, _TABLES - {STANDBY})
    conn = _conn(registry=_EMPTY, standby=True)
    results: dict[str, bool] = {}
    service._delete_personal_agent_state(conn, params={"user_id": "u"}, results=results)
    assert not any(STANDBY in sql for sql in _statements(conn))
    assert STANDBY not in results
