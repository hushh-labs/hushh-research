"""Tests for the flag-gated One session-service selection (M2).

Default OFF -> ``InMemorySessionService`` (today's behavior). With
``ONE_DB_SESSIONS_ENABLED`` on, One's runners resolve a durable
``DatabaseSessionService`` on the existing Postgres -- with a fail-safe fallback
to in-memory if it cannot be built, so the live runtime never fails to start.

These test the selection logic in ``_build_one_session_service`` with monkeypatched
fakes (ADK's DatabaseSessionService needs a real Postgres engine, so we do not
construct a live one here).
"""

from __future__ import annotations

from google.adk.sessions.in_memory_session_service import InMemorySessionService

from hushh_mcp.one_adk.agent_tree import _build_one_session_service

_DB_SERVICE_PATH = "google.adk.sessions.database_session_service.DatabaseSessionService"
_URL_PATH = "db.connection.get_database_url"


def test_flag_off_returns_in_memory(monkeypatch):
    monkeypatch.delenv("ONE_DB_SESSIONS_ENABLED", raising=False)
    assert isinstance(_build_one_session_service(), InMemorySessionService)


def test_flag_explicit_false_returns_in_memory(monkeypatch):
    monkeypatch.setenv("ONE_DB_SESSIONS_ENABLED", "false")
    assert isinstance(_build_one_session_service(), InMemorySessionService)


def test_flag_on_builds_database_service(monkeypatch):
    monkeypatch.setenv("ONE_DB_SESSIONS_ENABLED", "1")
    monkeypatch.setattr(_URL_PATH, lambda: "postgresql://u:p@h:5432/db")

    class _FakeDBService:
        def __init__(self, *, db_url=None, **kw):
            self.db_url = db_url

    monkeypatch.setattr(_DB_SERVICE_PATH, _FakeDBService)
    svc = _build_one_session_service()
    assert isinstance(svc, _FakeDBService)
    assert svc.db_url == "postgresql://u:p@h:5432/db"


def test_flag_on_falls_back_when_url_resolution_raises(monkeypatch):
    monkeypatch.setenv("ONE_DB_SESSIONS_ENABLED", "1")

    def _boom():
        raise RuntimeError("no db url in this env")

    monkeypatch.setattr(_URL_PATH, _boom)
    # Fail-safe: a DB-URL error must degrade to in-memory, never crash the runner.
    assert isinstance(_build_one_session_service(), InMemorySessionService)


def test_flag_on_falls_back_when_db_service_construction_raises(monkeypatch):
    monkeypatch.setenv("ONE_DB_SESSIONS_ENABLED", "1")
    monkeypatch.setattr(_URL_PATH, lambda: "postgresql://u:p@h:5432/db")

    class _BoomService:
        def __init__(self, *a, **k):
            raise ValueError("bad engine")

    monkeypatch.setattr(_DB_SERVICE_PATH, _BoomService)
    assert isinstance(_build_one_session_service(), InMemorySessionService)
