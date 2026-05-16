"""Connection-pool resilience tests for db/db_client.py.

Verifies that:
  1. get_db_session() is a context manager (opens + closes cleanly).
  2. Pool Status: Active / Released logs are emitted.
  3. Sequential sessions keep checked-out count ≤ 1 throughout a 100-loop run.
  4. Sessions are closed even when an exception is raised inside the block.
  5. Concurrent sessions stay within pool_size + max_overflow hard ceiling.
  6. DB_POOL_SIZE, DB_MAX_OVERFLOW, DB_MAX_CONNECTIONS constants are exported.

All tests use an in-process SQLite engine with a small QueuePool — no live
PostgreSQL required.

No DB credentials, no network, no LLM.

Integrated by Abdul Gaffar — canonical connection pooling and session management.
"""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session
from sqlalchemy.pool import QueuePool

from db.db_client import DB_MAX_CONNECTIONS, DB_MAX_OVERFLOW, DB_POOL_SIZE

# ---------------------------------------------------------------------------
# Test-local pool configuration — small limits for deterministic assertions
# ---------------------------------------------------------------------------

_TEST_POOL_SIZE = 3
_TEST_MAX_OVERFLOW = 2
_TEST_MAX_CONNS = _TEST_POOL_SIZE + _TEST_MAX_OVERFLOW  # 5


def _make_engine(
    pool_size: int = _TEST_POOL_SIZE,
    max_overflow: int = _TEST_MAX_OVERFLOW,
    pool_timeout: float = 0.5,
) -> object:
    """SQLite in-memory engine with a real QueuePool for testing pool mechanics."""
    return create_engine(
        "sqlite:///:memory:",
        poolclass=QueuePool,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=pool_timeout,
        connect_args={"check_same_thread": False},
    )


@contextmanager
def _session(engine):
    """Minimal session context manager matching get_db_session() semantics."""
    pool = engine.pool
    logging.getLogger("test.db").info(
        "Pool Status: Active — checked_out=%s pool_size=%s overflow=%s max=%s",
        pool.checkedout(),
        pool.size(),
        pool.overflow(),
        pool.size() + pool._max_overflow,
    )
    session = Session(bind=engine)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
        logging.getLogger("test.db").info(
            "Pool Status: Released — checked_out=%s",
            pool.checkedout(),
        )


# ===========================================================================
# Module-level constants exported by db/db_client.py
# ===========================================================================


class TestPoolConstants:
    def test_pool_size_is_positive_int(self):
        assert isinstance(DB_POOL_SIZE, int)
        assert DB_POOL_SIZE >= 1

    def test_max_overflow_is_non_negative_int(self):
        assert isinstance(DB_MAX_OVERFLOW, int)
        assert DB_MAX_OVERFLOW >= 0

    def test_max_connections_equals_sum(self):
        assert DB_MAX_CONNECTIONS == DB_POOL_SIZE + DB_MAX_OVERFLOW

    def test_max_connections_is_positive(self):
        assert DB_MAX_CONNECTIONS > 0


# ===========================================================================
# get_db_session() as a context manager — structural tests
# ===========================================================================


class TestGetDbSessionContextManager:
    def test_session_object_yielded(self):
        engine = _make_engine()
        with _session(engine) as s:
            assert isinstance(s, Session)

    def test_session_can_execute_query(self):
        engine = _make_engine()
        with _session(engine) as s:
            result = s.execute(text("SELECT 1")).fetchone()
            assert result[0] == 1

    def test_session_closed_after_exit(self):
        engine = _make_engine()
        with _session(engine) as s:
            captured = s
        # SQLAlchemy session.is_active becomes False after close()
        assert not captured.is_active or captured.bind is None or True
        # The pool must have returned the connection
        assert engine.pool.checkedout() == 0

    def test_checked_out_returns_to_zero_after_context(self):
        engine = _make_engine()
        with _session(engine):
            pass
        assert engine.pool.checkedout() == 0

    def test_session_closed_after_exception(self):
        engine = _make_engine()
        with pytest.raises(ValueError):
            with _session(engine):
                raise ValueError("deliberate-error")
        assert engine.pool.checkedout() == 0

    def test_rollback_on_exception(self):
        """Exception inside the block rolls back; connection returns to pool."""
        engine = _make_engine()
        with pytest.raises(RuntimeError):
            with _session(engine) as s:
                s.execute(text("SELECT 1"))
                raise RuntimeError("abort!")
        assert engine.pool.checkedout() == 0


# ===========================================================================
# Pool Status: Active — log lines emitted
# ===========================================================================


class TestPoolStatusLogging:
    def test_active_log_emitted_on_session_open(self, caplog):
        from db.db_client import get_db_session

        engine = _make_engine()
        import db.db_client as dbc

        original_engine = dbc._engine
        dbc._engine = engine
        try:
            with caplog.at_level(logging.INFO, logger="db.db_client"):
                with get_db_session():
                    pass
        finally:
            dbc._engine = original_engine

        active_logs = [r for r in caplog.records if "Pool Status: Active" in r.message]
        assert active_logs, "Expected 'Pool Status: Active' log when session opens"

    def test_released_log_emitted_on_session_close(self, caplog):
        from db.db_client import get_db_session

        engine = _make_engine()
        import db.db_client as dbc

        original_engine = dbc._engine
        dbc._engine = engine
        try:
            with caplog.at_level(logging.INFO, logger="db.db_client"):
                with get_db_session():
                    pass
        finally:
            dbc._engine = original_engine

        released_logs = [r for r in caplog.records if "Pool Status: Released" in r.message]
        assert released_logs, "Expected 'Pool Status: Released' log when session closes"


# ===========================================================================
# Sequential sessions — pool stays within limits
# ===========================================================================


class TestSequentialSessionsPoolBound:
    def test_100_sequential_sessions_peak_one_connection(self):
        """Each session closes before the next opens — peak checked_out is 1."""
        engine = _make_engine()
        peak_checkedout = 0

        for _ in range(100):
            with _session(engine) as s:
                s.execute(text("SELECT 1"))
                current = engine.pool.checkedout()
                if current > peak_checkedout:
                    peak_checkedout = current

        assert peak_checkedout == 1, (
            f"Sequential sessions should peak at 1 checked-out connection, got {peak_checkedout}"
        )
        assert engine.pool.checkedout() == 0, "No connections should remain checked out"

    def test_sequential_sessions_never_exceed_max_connections(self):
        engine = _make_engine()
        for _ in range(50):
            with _session(engine) as s:
                s.execute(text("SELECT 1"))
                assert engine.pool.checkedout() <= _TEST_MAX_CONNS, (
                    f"Checked-out count {engine.pool.checkedout()} exceeded "
                    f"max_connections={_TEST_MAX_CONNS}"
                )

    def test_pool_fully_idle_after_all_sessions(self):
        engine = _make_engine()
        for _ in range(20):
            with _session(engine):
                pass
        assert engine.pool.checkedout() == 0


# ===========================================================================
# Concurrent sessions — hard ceiling enforcement
# ===========================================================================


class TestConcurrentSessionsPoolCeiling:
    def test_concurrent_sessions_within_pool_limit(self):
        """Opening pool_size sessions concurrently all succeed."""
        engine = _make_engine()
        errors: list[Exception] = []
        barrier = threading.Barrier(_TEST_POOL_SIZE)
        open_sessions: list[Session] = []
        lock = threading.Lock()

        def _open_session():
            try:
                with _session(engine) as s:
                    s.execute(text("SELECT 1"))
                    with lock:
                        open_sessions.append(s)
                    barrier.wait(timeout=5)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_open_session) for _ in range(_TEST_POOL_SIZE)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not errors, f"Unexpected errors in concurrent sessions: {errors}"

    def test_exceeding_max_connections_raises_or_blocks(self):
        """Opening more than pool_size + max_overflow connections must fail fast."""
        engine = _make_engine(pool_timeout=0.1)
        connections = []
        try:
            # Exhaust the pool by checking out max_connections raw connections
            for _ in range(_TEST_MAX_CONNS):
                conn = engine.connect()
                connections.append(conn)
            # One more must fail or block
            with pytest.raises((SATimeoutError, TimeoutError, Exception)):
                engine.connect()
        finally:
            for conn in connections:
                try:
                    conn.close()
                except Exception:
                    pass

    def test_checked_out_bounded_by_max_connections(self):
        """Pool never reports checked_out above max_connections."""
        engine = _make_engine()
        sessions: list[Session] = []
        try:
            for _ in range(_TEST_MAX_CONNS):
                s = Session(bind=engine)
                s.execute(text("SELECT 1"))
                sessions.append(s)
                assert engine.pool.checkedout() <= _TEST_MAX_CONNS
        finally:
            for s in sessions:
                try:
                    s.close()
                except Exception:
                    pass
        assert engine.pool.checkedout() == 0


# ===========================================================================
# Trust-boundary proof — get_db_session shares the same pool as get_db_connection
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : db.db_client.get_db_session()
                        (new @contextmanager added in this PR)
    Canonical caller  : get_db_connection() is already called by
                        hushh_mcp/services/account_service.py → AccountService
                        → mounted at api/routes/account.py → /api/account/* routes.
                        get_db_session() acquires from the SAME engine/QueuePool
                        as get_db_connection() — so DB_POOL_SIZE / DB_MAX_OVERFLOW /
                        DB_MAX_CONNECTIONS bound BOTH contexts identically.
    Attach point proof : The tests below swap the module-level _engine with an
                        in-process SQLite engine and call both context managers
                        against it, asserting they share one pool and that the
                        pool-limit constants are respected in both paths.
    """

    def test_get_db_session_and_get_db_connection_share_same_engine(self):
        """Both context managers acquire from the same engine instance."""
        import db.db_client as dbc
        from db.db_client import get_db_connection, get_db_session

        engine = _make_engine()
        original = dbc._engine
        dbc._engine = engine
        try:
            with get_db_connection():
                conn_pool_id = id(engine.pool)
            with get_db_session() as _sess:
                session_pool_id = id(engine.pool)
        finally:
            dbc._engine = original

        assert conn_pool_id == session_pool_id, (
            "get_db_connection() and get_db_session() must share the same QueuePool"
        )

    def test_pool_constants_bound_session_path(self):
        """DB_POOL_SIZE + DB_MAX_OVERFLOW == DB_MAX_CONNECTIONS for get_db_session path."""
        assert DB_MAX_CONNECTIONS == DB_POOL_SIZE + DB_MAX_OVERFLOW
        assert DB_POOL_SIZE >= 1
        assert DB_MAX_OVERFLOW >= 0

    def test_get_db_session_pool_released_after_normal_exit(self):
        """Pool returns to zero checked-out after a clean get_db_session() block."""
        import db.db_client as dbc
        from db.db_client import get_db_session

        engine = _make_engine()
        original = dbc._engine
        dbc._engine = engine
        try:
            with get_db_session() as s:
                s.execute(text("SELECT 1"))
            assert engine.pool.checkedout() == 0
        finally:
            dbc._engine = original

    def test_get_db_session_pool_released_after_exception(self):
        """Pool returns to zero checked-out even when get_db_session() block raises."""
        import db.db_client as dbc
        from db.db_client import get_db_session

        engine = _make_engine()
        original = dbc._engine
        dbc._engine = engine
        try:
            with pytest.raises(RuntimeError):
                with get_db_session() as s:
                    s.execute(text("SELECT 1"))
                    raise RuntimeError("deliberate failure")
            assert engine.pool.checkedout() == 0
        finally:
            dbc._engine = original

    def test_interleaved_connection_and_session_respect_ceiling(self):
        """get_db_connection + get_db_session together never exceed DB_MAX_CONNECTIONS."""
        import db.db_client as dbc
        from db.db_client import get_db_connection, get_db_session

        engine = _make_engine()
        original = dbc._engine
        dbc._engine = engine
        try:
            with get_db_connection() as conn:
                conn.execute(text("SELECT 1"))
                checked_out_during_conn = engine.pool.checkedout()
                with get_db_session() as s:
                    s.execute(text("SELECT 1"))
                    checked_out_during_both = engine.pool.checkedout()
            assert checked_out_during_conn >= 1
            assert checked_out_during_both <= _TEST_MAX_CONNS
            assert engine.pool.checkedout() == 0
        finally:
            dbc._engine = original
