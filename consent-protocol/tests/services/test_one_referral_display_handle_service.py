"""Opt-in referral display handles (migration 272).

Pins the privacy contract directly: a handle is never derived from or
compared against the real/account name, an invalid handle is rejected before
any write is attempted, and a taken handle surfaces as a distinct, named
error rather than a generic database failure.
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services import one_referral_display_handle_service as handle_service

USER = "user_handle_owner"


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@contextmanager
def _db(conn):
    yield conn


def test_get_display_handle_returns_none_when_unset():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        assert handle_service.get_display_handle(USER) is None


def test_set_display_handle_rejects_an_invalid_shape_before_any_write():
    conn = MagicMock()

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(handle_service.DisplayHandleError):
            handle_service.set_display_handle(USER, "ab")  # too short

    conn.execute.assert_not_called()


def test_set_display_handle_rejects_a_reserved_word():
    conn = MagicMock()

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(handle_service.DisplayHandleError):
            handle_service.set_display_handle(USER, "admin")

    conn.execute.assert_not_called()


def test_set_display_handle_writes_the_normalized_form():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = handle_service.set_display_handle(USER, "Top Referrer")

    params = conn.execute.call_args.args[1]
    assert params["normalized"] == "top-referrer"
    assert result == "Top Referrer"


def test_set_display_handle_surfaces_a_taken_handle_distinctly():
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError(
        'duplicate key value violates unique constraint "one_referral_display_handles_normalized_key"'
    )

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(handle_service.DisplayHandleTaken):
            handle_service.set_display_handle(USER, "popular-handle")


def test_set_display_handle_reraises_an_unrelated_database_error():
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError("connection reset")

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(RuntimeError, match="connection reset"):
            handle_service.set_display_handle(USER, "some-handle")


def test_get_display_handles_is_empty_for_an_empty_list_without_a_query():
    conn = MagicMock()

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        assert handle_service.get_display_handles([]) == {}

    conn.execute.assert_not_called()


def test_get_display_handles_bulk_resolves_a_page():
    from types import SimpleNamespace

    rows = [
        SimpleNamespace(user_id="user_a", handle="handle-a"),
        SimpleNamespace(user_id="user_b", handle="handle-b"),
    ]
    conn = MagicMock()
    conn.execute.return_value = _Result(rows)

    with patch.object(handle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        resolved = handle_service.get_display_handles(["user_a", "user_b", "user_c"])

    assert resolved == {"user_a": "handle-a", "user_b": "handle-b"}
