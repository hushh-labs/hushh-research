"""Real-Postgres proof of migration 433 on the Connect directory statement.

Reuses the schema, people and viewer helpers of ``test_connect_directory_postgres``
whose schema carries the two presence columns the migration adds.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection

from tests.services.test_connect_directory_postgres import (  # noqa: F401 - fixture reuse
    OWNER,
    _connected,
    _Directory,
    _person,
    _requested,
    connection,
)


def _presence(
    conn: Connection, user_id: str, *, listed: bool | None, role: str | None = None
) -> None:
    conn.execute(
        text(
            "UPDATE actor_profiles SET directory_listed = :listed, role_label = :role WHERE user_id = :uid"
        ),
        {"uid": user_id, "listed": listed, "role": role},
    )


def test_an_explicit_presence_choice_outranks_the_vault_rule_on_postgres(
    connection: Connection,  # noqa: F811 - the imported fixture, by design
) -> None:
    """A website-only account (no vault) that switched "show me in people search"
    on is listed by name; an enrolled account that switched it off is hidden from
    strangers but not from people it already knows; NULL keeps the vault rule.
    """
    _person(connection, OWNER, "Owen Owner")
    _person(connection, "web-listed", "Wes Website", vault=None)
    _presence(connection, "web-listed", listed=True, role="Plumber")
    _person(connection, "placeholder-listed", "Pia Placeholder", vault="placeholder")
    _presence(connection, "placeholder-listed", listed=True)
    _person(connection, "web-unchosen", "Nora Novault", vault=None)
    _person(connection, "hidden", "Hugo Hidden")
    _presence(connection, "hidden", listed=False, role="Pediatric nurse")
    _person(connection, "hidden-friend", "Fern Friend")
    _presence(connection, "hidden-friend", listed=False)
    _connected(connection, "hidden-friend")
    _person(connection, "hidden-asked-me", "Ira Incoming")
    _presence(connection, "hidden-asked-me", listed=False)
    _requested(connection, "hidden-asked-me", OWNER)
    _person(connection, "enrolled", "Eve Enrolled")
    _presence(connection, "enrolled", listed=None, role="Retired teacher")
    service = _Directory(connection)

    listed = service.search_directory_candidates(owner_user_id=OWNER, limit=50)

    assert [item["userId"] for item in listed["items"]] == [
        "enrolled",
        "hidden-friend",
        "hidden-asked-me",
        "placeholder-listed",
        "web-listed",
    ]
    assert {item["userId"]: item["roleLabel"] for item in listed["items"]} == {
        "enrolled": "Retired teacher",
        "hidden-friend": None,
        "hidden-asked-me": None,
        "placeholder-listed": None,
        "web-listed": "Plumber",
    }
    assert listed["hasMore"] is False
    for uid, visible in {
        "web-listed": True,
        "web-unchosen": False,
        "hidden": False,
        "hidden-friend": True,
        "enrolled": True,
    }.items():
        assert (
            service.is_directory_candidate(owner_user_id=OWNER, candidate_user_id=uid) is visible
        ), uid
    # Returning to "never chose" puts the person back under the vault rule.
    _presence(connection, "hidden", listed=None, role="Pediatric nurse")
    _presence(connection, "web-listed", listed=None, role="Plumber")
    assert service.is_directory_candidate(owner_user_id=OWNER, candidate_user_id="hidden")
    assert not service.is_directory_candidate(owner_user_id=OWNER, candidate_user_id="web-listed")
