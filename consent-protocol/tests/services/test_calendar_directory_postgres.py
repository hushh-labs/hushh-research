"""Real-Postgres proof for Calendar's exact Connect directory portrait lookup."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection

from tests.services.test_connect_directory_postgres import (
    OWNER,
    _connected,
    _Directory,
    _person,
)

pytest_plugins = ["tests.services.test_connect_directory_postgres"]


def test_calendar_exact_email_uses_connect_visibility_and_rejects_duplicate_claims(
    connection: Connection,
) -> None:
    _person(connection, OWNER, "Owen Owner")
    _person(connection, "manish", "Manish Sainani", email="manish@example.test")
    _person(
        connection,
        "private",
        "Private Person",
        email="private@example.test",
        discoverable=False,
    )
    _person(
        connection,
        "connected",
        "Connected Person",
        email="connected@example.test",
        discoverable=False,
    )
    _connected(connection, "connected")
    _person(connection, "duplicate-a", "Duplicate A", email="duplicate@example.test")
    _person(connection, "duplicate-b", "Duplicate B", email="duplicate@example.test")
    connection.execute(
        text("""
        UPDATE actor_identity_cache
        SET email_verified = TRUE, custom_photo_url = 'data:image/png;base64,aGVsbG8='
        WHERE user_id <> :owner
    """),
        {"owner": OWNER},
    )

    service = _Directory(connection)
    result = service.search_directory_candidates(
        owner_user_id=OWNER,
        verified_email_lookup=[
            "MANISH@example.test",
            "private@example.test",
            "connected@example.test",
            "duplicate@example.test",
        ],
    )

    assert {(item["email"], item["userId"]) for item in result["items"]} == {
        ("manish@example.test", "manish"),
        ("connected@example.test", "connected"),
    }
    assert all(item["photoUrl"] == "data:image/png;base64,aGVsbG8=" for item in result["items"])
    # Connections and strangers alike carry the profile name Connect shows.
    assert {item["email"]: item["displayName"] for item in result["items"]} == {
        "manish@example.test": "Manish Sainani",
        "connected@example.test": "Connected Person",
    }
    public_result = service.search_directory_candidates(owner_user_id=OWNER, query="manish")
    assert public_result["items"][0]["userId"] == "manish"
    assert "email" not in public_result["items"][0]
