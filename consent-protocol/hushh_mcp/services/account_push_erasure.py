"""Erase both push-registration representations within the account transaction."""

from collections.abc import Callable, Mapping
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.sql.elements import TextClause


def push_registration_erasure_queries() -> dict[str, TextClause]:
    return {
        "user_push_tokens": text("DELETE FROM user_push_tokens WHERE user_id = :user_id"),
        "user_push_installations": text(
            "DELETE FROM user_push_installations WHERE user_id = :user_id"
        ),
    }


def erase_push_registrations(
    conn: Connection,
    params: Mapping[str, Any],
    table_exists: Callable[[Connection, str], bool],
) -> None:
    for table, query in push_registration_erasure_queries().items():
        if table_exists(conn, table):
            conn.execute(query, params)
