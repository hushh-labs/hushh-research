"""Real-Postgres proof of the Connect directory's vault eligibility rule.

Run with ONE_COMMAND_TEST_DATABASE_URL pointing to an isolated test database.

Founder ruling 2026-09-28: a stranger appears in the Connect directory only
after finishing sign-up in THIS environment, meaning a ``vault_keys`` row with
``vault_status = 'active'``. Someone the viewer already has a relationship with
(an active connection, a pending request, or an active trusted edge, either
direction) stays reachable, vault or not. The in-memory directory double can
only restate that rule; executing the production statement is the only way to
prove it runs inside the SQL, before ``LIMIT``, so pages stay full and
``hasMore`` stays true to the rows a reader can reach.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

OWNER = "owner"

# Only the columns the directory statement reads. vault_status keeps the
# CHECK that migration 019 put on the real table.
_SCHEMA = """
CREATE TABLE actor_profiles (
  user_id TEXT PRIMARY KEY,
  public_person_ref TEXT,
  public_profile_status TEXT NOT NULL DEFAULT 'active',
  contact_discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  contact_sync_consent_enabled_at TIMESTAMPTZ,
  contact_sync_consent_rule_version BIGINT NOT NULL DEFAULT 0,
  contact_sync_consent_contract_version TEXT
);
CREATE TABLE actor_identity_cache (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  email TEXT,
  phone_number TEXT,
  phone_verified BOOLEAN,
  photo_url TEXT,
  custom_photo_url TEXT
);
CREATE TABLE marketplace_public_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  is_discoverable BOOLEAN
);
CREATE TABLE ria_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  verification_status TEXT
);
CREATE TABLE connections (
  user_a_id TEXT NOT NULL,
  user_b_id TEXT NOT NULL,
  status TEXT NOT NULL,
  CHECK (user_a_id < user_b_id)
);
CREATE TABLE connection_requests (
  requester_user_id TEXT NOT NULL,
  addressee_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE trusted_connections (
  owner_user_id TEXT NOT NULL,
  trusted_user_id TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE one_location_recipient_keys (
  user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_jwk JSONB,
  algorithm TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE vault_keys (
  user_id TEXT PRIMARY KEY,
  vault_status TEXT NOT NULL DEFAULT 'active'
    CHECK (vault_status IN ('placeholder', 'active'))
);
"""


class _Directory(OneLocationAgentService):
    """The production statement on a real connection; Firebase and ranking stubbed."""

    def __init__(self, connection: Connection) -> None:
        self._key_writer_connection = connection

    def _active_directory_user_ids(self, user_ids: list[str]) -> set[str]:
        return set(user_ids)

    def _directory_auth_profiles(self, user_ids: list[str]) -> dict[str, dict[str, str]]:
        return {}

    def _apply_kai_circle_recommendations(self, **kwargs: Any) -> list[dict[str, Any]]:
        return list(kwargs["recipients"])


@pytest.fixture
def connection() -> Iterator[Connection]:
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    engine = create_engine(url)
    schema = f"connect_directory_{uuid4().hex}"
    try:
        with engine.connect() as conn:
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            conn.execute(text(f'SET search_path TO "{schema}"'))
            conn.execute(text(_SCHEMA))
            conn.commit()
            yield conn
            conn.rollback()
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            conn.commit()
    finally:
        engine.dispose()


def _person(
    conn: Connection,
    user_id: str,
    name: str,
    *,
    vault: str | None = "active",
    discoverable: bool | None = None,
    trusted_by_owner: bool = False,
) -> None:
    params = {"uid": user_id, "name": name, "discoverable": discoverable}
    conn.execute(text("INSERT INTO actor_profiles (user_id) VALUES (:uid)"), params)
    conn.execute(
        text("INSERT INTO actor_identity_cache (user_id, display_name) VALUES (:uid, :name)"),
        params,
    )
    if discoverable is not None:
        conn.execute(
            text(
                "INSERT INTO marketplace_public_profiles (user_id, is_discoverable)"
                " VALUES (:uid, :discoverable)"
            ),
            params,
        )
    if vault is not None:
        conn.execute(
            text("INSERT INTO vault_keys (user_id, vault_status) VALUES (:uid, :status)"),
            {"uid": user_id, "status": vault},
        )
    if trusted_by_owner:
        _trusted(conn, OWNER, user_id)


def _trusted(conn: Connection, owner: str, trusted: str) -> None:
    conn.execute(
        text(
            "INSERT INTO trusted_connections (owner_user_id, trusted_user_id, status)"
            " VALUES (:owner, :trusted, 'active')"
        ),
        {"owner": owner, "trusted": trusted},
    )


def _connected(conn: Connection, other: str, status: str = "active") -> None:
    user_a, user_b = sorted((OWNER, other))
    conn.execute(
        text("INSERT INTO connections (user_a_id, user_b_id, status) VALUES (:a, :b, :status)"),
        {"a": user_a, "b": user_b, "status": status},
    )


def _requested(conn: Connection, requester: str, addressee: str, status: str = "pending") -> None:
    conn.execute(
        text(
            "INSERT INTO connection_requests (requester_user_id, addressee_user_id, status)"
            " VALUES (:requester, :addressee, :status)"
        ),
        {"requester": requester, "addressee": addressee, "status": status},
    )


def test_directory_hides_only_strangers_without_an_active_vault_on_postgres(
    connection: Connection,
) -> None:
    _person(connection, OWNER, "Owen Owner")
    _person(connection, "active", "Alex Active")
    # Strangers who never finished sign-up.
    _person(connection, "placeholder", "Pat Placeholder", vault="placeholder")
    _person(connection, "no-vault", "Nora Novault", vault=None)
    # A resolved relationship is history, not a relationship.
    _person(connection, "revoked", "Rita Revoked", vault=None)
    _connected(connection, "revoked", status="revoked")
    _person(connection, "rejected", "Reed Rejected", vault=None)
    _requested(connection, OWNER, "rejected", status="rejected")
    # People the viewer already has a relationship with, none holding a vault.
    _person(connection, "connected", "Cora Connected", vault=None)
    _connected(connection, "connected")
    _person(connection, "asked-them", "Olly Outgoing", vault=None)
    _requested(connection, OWNER, "asked-them")
    _person(connection, "asked-me", "Ivy Incoming", vault="placeholder")
    _requested(connection, "asked-me", OWNER)
    _person(connection, "trusted-no-vault", "Tess Trusted", vault=None, trusted_by_owner=True)
    _person(connection, "trusts-me", "Uma Reverse", vault=None)
    _trusted(connection, "trusts-me", OWNER)
    # An opt-out hides a person from strangers. A trusted edge from the viewer
    # or an active connection to them lifts it: "My connections" already lists
    # that person, so a search that cannot find them contradicts the screen.
    # Circle and contact-sync connections never mirrored a trusted edge, so the
    # connection itself has to be enough (Abdul Rashid on UAT, 2026-10-03).
    _person(connection, "opted-out", "Olive Optout", discoverable=False)
    _person(connection, "trusted-hidden", "Hana Hidden", discoverable=False, trusted_by_owner=True)
    _person(connection, "connected-hidden", "Cody Hidden", discoverable=False)
    _connected(connection, "connected-hidden")
    # Negative control: a resolved connection is history, so the opt-out wins.
    _person(connection, "revoked-hidden", "Rhea Hidden", discoverable=False)
    _connected(connection, "revoked-hidden", status="revoked")
    # Negative control: an unanswered request is not a connection either.
    _person(connection, "asked-hidden", "Asa Hidden", discoverable=False, vault="active")
    _requested(connection, OWNER, "asked-hidden")
    service = _Directory(connection)

    listed = service.search_directory_candidates(owner_user_id=OWNER, limit=50)

    assert [item["userId"] for item in listed["items"]] == [
        "active",
        "connected-hidden",
        "connected",
        "trusted-hidden",
        "asked-me",
        "asked-them",
        "trusted-no-vault",
        "trusts-me",
    ]
    assert listed["hasMore"] is False
    # The single-person lookup behind person context, the scope catalog and
    # scope-bearing requests is the same statement, so it answers the same way.
    visible = {
        uid
        for uid in (
            "active",
            "placeholder",
            "no-vault",
            "revoked",
            "rejected",
            "connected",
            "asked-them",
            "asked-me",
            "opted-out",
            "connected-hidden",
            "revoked-hidden",
            "asked-hidden",
        )
        if service.is_directory_candidate(owner_user_id=OWNER, candidate_user_id=uid)
    }
    assert visible == {"active", "connected", "asked-them", "asked-me", "connected-hidden"}


@pytest.mark.parametrize("query", ["", "member"])
def test_directory_pages_stay_full_with_no_vault_rows_interleaved_on_postgres(
    connection: Connection, query: str
) -> None:
    """Negative control for placement: filtered after LIMIT, pages would come
    back short or carry unfinished sign-ups, and ``hasMore`` would lie."""
    _person(connection, OWNER, "Owen Owner")
    expected: list[str] = []
    # 230 people A-Z; every other one never finished sign-up, alternating
    # between no vault row and a placeholder row. Spans three 100-row scans.
    for index in range(230):
        uid = f"member-{index:03}"
        if index % 2 == 0:
            _person(connection, uid, f"Member {index:03}")
            expected.append(uid)
        else:
            _person(
                connection,
                uid,
                f"Member {index:03}",
                vault=None if index % 4 == 1 else "placeholder",
            )
    service = _Directory(connection)

    seen: list[str] = []
    pages: list[tuple[int, bool]] = []
    for page in range(1, 8):
        result = service.search_directory_candidates(
            owner_user_id=OWNER, query=query, page=page, limit=20
        )
        seen.extend(item["userId"] for item in result["items"])
        pages.append((len(result["items"]), result["hasMore"]))
        if not result["hasMore"]:
            break

    assert len(expected) == 115
    assert pages == [(20, True)] * 5 + [(15, False)]
    assert seen == expected


def test_mutuals_use_active_edges_in_both_directions_and_exclude_blocks(connection):
    from hushh_mcp.services.connection_mutuals import MUTUAL_CONNECTIONS_SQL

    edges = [
        ("a-peer", "owner", "active"),
        ("owner", "z-peer", "active"),
        ("a-peer", "candidate", "active"),
        ("candidate", "z-peer", "active"),
        ("candidate", "revoked-peer", "active"),
        ("owner", "revoked-peer", "revoked"),
        ("a-peer", "outside-page", "active"),
    ]
    for a, b, status in edges:
        connection.execute(
            text("INSERT INTO connections VALUES (:a, :b, :status)"),
            {"a": a, "b": b, "status": status},
        )
    params = {"user_id": "owner", "page_user_ids": ["candidate", "a-peer", "owner", "zero"]}
    rows = connection.execute(text(MUTUAL_CONNECTIONS_SQL), params).mappings().all()
    assert [dict(row) for row in rows] == [
        {"candidate_id": "candidate", "mutual_count": 2, "preview_user_id": "a-peer"}
    ]
    connection.execute(
        text(
            "INSERT INTO connection_requests VALUES ('candidate', 'a-peer', 'rejected', CAST(:metadata AS JSONB))"
        ),
        {"metadata": '{"blocked_by":"a-peer"}'},
    )
    rows = connection.execute(text(MUTUAL_CONNECTIONS_SQL), params).mappings().all()
    assert [dict(row) for row in rows] == [
        {"candidate_id": "candidate", "mutual_count": 1, "preview_user_id": "z-peer"}
    ]
    connection.execute(
        text(
            "UPDATE connections SET status='revoked' WHERE user_a_id='owner' AND user_b_id='z-peer'"
        )
    )
    assert connection.execute(text(MUTUAL_CONNECTIONS_SQL), params).mappings().all() == []


@pytest.mark.parametrize(
    ("viewer_status", "candidate_status", "expected_count"),
    [
        (None, "active", 0),
        ("active", None, 0),
        ("revoked", "active", 0),
        ("active", "revoked", 0),
        ("active", "active", 1),
    ],
)
def test_mutual_requires_both_active_connections(
    connection, viewer_status, candidate_status, expected_count
):
    from hushh_mcp.services.connection_mutuals import MUTUAL_CONNECTIONS_SQL

    for person, status in [("owner", viewer_status), ("candidate", candidate_status)]:
        if status is not None:
            connection.execute(
                text("INSERT INTO connections VALUES (:person, 'peer', :status)"),
                {"person": person, "status": status},
            )
        else:
            connection.execute(
                text(
                    "INSERT INTO connection_requests VALUES (:person, 'peer', 'pending', '{}'::jsonb)"
                ),
                {"person": person},
            )
    rows = (
        connection.execute(
            text(MUTUAL_CONNECTIONS_SQL),
            {"user_id": "owner", "page_user_ids": ["candidate"]},
        )
        .mappings()
        .all()
    )
    assert sum(row["mutual_count"] for row in rows) == expected_count
    if expected_count:
        assert rows[0]["preview_user_id"] == "peer"


def test_bounded_directory_profile_lookup_keeps_visibility_and_empty_list_boundary(connection):
    _person(connection, OWNER, "Owner")
    _person(connection, "visible", "Visible Peer")
    _person(connection, "hidden", "Hidden Peer", discoverable=False)
    _person(connection, "outside", "Outside Selection")
    service = _Directory(connection)
    result = service.search_directory_candidates(
        owner_user_id=OWNER,
        candidate_user_ids=["visible", "hidden"],
        limit=50,
    )
    assert [item["userId"] for item in result["items"]] == ["visible"]
    assert (
        service.search_directory_candidates(owner_user_id=OWNER, candidate_user_ids=[])["items"]
        == []
    )
