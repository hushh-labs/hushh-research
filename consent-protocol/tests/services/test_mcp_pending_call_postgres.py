"""Pending connector reviews against real PostgreSQL, in an isolated synthetic schema.

The regression this pins: a review issued on one backend instance was decided on
another, which held none of the issuing instance's memory and refused it.
"""

from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from google.adk.sessions import Session
from sqlalchemy import create_engine, text

from hushh_mcp.one_adk import mcp_pending_call, request_secrets
from hushh_mcp.one_adk.mcp_pending_call import capture_pending_call, pending_call_details
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from tests.helpers.chat_keys import static_chat_cipher
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATION = (
    Path(__file__).resolve().parents[2] / "db" / "migrations" / "281_one_mcp_pending_calls.sql"
)
TOOL = "mcp_" + "a" * 40


@pytest.fixture
def pending_db(connector_postgres_url, monkeypatch):  # noqa: F811 - imported shared pytest fixture
    schema = f"mcp_pending_test_{uuid4().hex}"
    admin = create_engine(connector_postgres_url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )

    def execute_raw(sql, params):
        # Each call is its own transaction, like another instance's connection.
        with engine.begin() as connection:
            result = connection.execute(text(sql), params)
            rows = [dict(row._mapping) for row in result] if result.returns_rows else []
        return SimpleNamespace(data=rows)

    try:
        with engine.connect() as connection:
            # Only the dependency of the real migration; no production data.
            connection.exec_driver_sql("CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY)")
            connection.exec_driver_sql("INSERT INTO actor_profiles(user_id) VALUES ('owner')")
            connection.commit()
            # The migration's format('%I') must reach the server untouched, so it
            # runs on the raw cursor with no parameter interpolation.
            cursor = connection.connection.cursor()
            cursor.execute(MIGRATION.read_text())
            cursor.close()
            connection.commit()
        monkeypatch.setattr(
            mcp_pending_call, "get_db", lambda: SimpleNamespace(execute_raw=execute_raw)
        )
        monkeypatch.setattr(mcp_pending_call, "ChatCipher", static_chat_cipher)
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


def context():
    return SimpleNamespace(
        user_id="owner",
        function_call_id="call",
        state={"hussh:user_id": "owner", "hussh:conversation_id": "thread"},
    )


def session():
    return Session(id="thread", user_id="owner", app_name="hussh_one")


def rows(engine):
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT handle, payload_ciphertext FROM one_mcp_pending_calls")
        ).all()


@pytest.mark.asyncio
async def test_review_opens_on_another_instance_and_is_sealed_at_rest(pending_db):
    handle = await capture_pending_call(
        context(),
        tool_name=TOOL,
        arguments={"q": "PRIVATE_REVIEW_ARGUMENT"},
        review={"expiresAt": "2099-01-01T00:00:00+00:00"},
    )
    request_secrets._values.clear()  # another instance has none of this process's memory
    pending = await pending_call_details(session(), handle)
    assert pending["arguments"] == {"q": "PRIVATE_REVIEW_ARGUMENT"}
    (row,) = rows(pending_db)
    assert row.handle == handle
    assert "PRIVATE_REVIEW_ARGUMENT" not in row.payload_ciphertext


@pytest.mark.asyncio
async def test_expired_review_does_not_open_and_is_purged_by_the_next_capture(pending_db):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    with pending_db.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE one_mcp_pending_calls SET expires_at = NOW() - INTERVAL '1 second'"
        )
    with pytest.raises(ActionDirectiveAuthorityError):
        await pending_call_details(session(), handle)
    fresh = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    assert [row.handle for row in rows(pending_db)] == [fresh]


@pytest.mark.asyncio
async def test_review_does_not_open_for_another_conversation_or_owner(pending_db):
    handle = await capture_pending_call(context(), tool_name=TOOL, arguments={})
    for other in (
        Session(id="other-thread", user_id="owner", app_name="hussh_one"),
        Session(id="thread", user_id="someone-else", app_name="hussh_one"),
    ):
        with pytest.raises(ActionDirectiveAuthorityError):
            await pending_call_details(other, handle)


@pytest.mark.asyncio
async def test_deleting_the_account_removes_its_pending_reviews(pending_db):
    await capture_pending_call(context(), tool_name=TOOL, arguments={})
    with pending_db.begin() as connection:
        connection.exec_driver_sql("DELETE FROM actor_profiles WHERE user_id = 'owner'")
    assert rows(pending_db) == []
