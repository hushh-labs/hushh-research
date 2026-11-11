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
import re
from collections.abc import Iterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection

from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)

OWNER = "owner"

# Only the columns the directory statement reads. vault_status keeps the
# CHECK that migration 019 put on the real table.
_SCHEMA = """
CREATE TABLE actor_profiles (
  user_id TEXT PRIMARY KEY,
  public_person_ref TEXT,
  public_profile_status TEXT NOT NULL DEFAULT 'active',
  directory_listed BOOLEAN,
  connection_list_shared BOOLEAN NOT NULL DEFAULT FALSE,
  role_label TEXT,
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
  email_verified BOOLEAN DEFAULT FALSE,
  source TEXT DEFAULT 'test',
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  photo_url TEXT,
  custom_photo_url TEXT
);
CREATE TABLE marketplace_public_profiles (
  user_id TEXT PRIMARY KEY, display_name TEXT, is_discoverable BOOLEAN
);
CREATE TABLE ria_profiles (
  user_id TEXT PRIMARY KEY, display_name TEXT, verification_status TEXT
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
    CHECK (vault_status IN ('placeholder', 'active')),
  environment_enrolled_at TIMESTAMPTZ
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
    enrolled: bool = True,
    email: str | None = None,
    phone: str | None = None,
    phone_verified: bool = False,
) -> None:
    params = {
        "uid": user_id,
        "name": name,
        "discoverable": discoverable,
        "email": email,
        "phone": phone,
        "phone_verified": phone_verified,
    }
    conn.execute(text("INSERT INTO actor_profiles (user_id) VALUES (:uid)"), params)
    conn.execute(
        text(
            "INSERT INTO actor_identity_cache"
            " (user_id, display_name, email, phone_number, phone_verified)"
            " VALUES (:uid, :name, :email, :phone, :phone_verified)"
        ),
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
            text(
                "INSERT INTO vault_keys (user_id, vault_status, environment_enrolled_at)"
                " VALUES (:uid, :status, CASE WHEN :enrolled THEN NOW() END)"
            ),
            {"uid": user_id, "status": vault, "enrolled": enrolled},
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


def test_deleted_people_are_excluded_before_connections_pagination(connection, monkeypatch):
    connection.execute(
        text("""
        ALTER TABLE actor_profiles ALTER COLUMN public_person_ref TYPE UUID
            USING public_person_ref::UUID;
        ALTER TABLE connections ADD COLUMN id TEXT DEFAULT gen_random_uuid()::text;
        ALTER TABLE connections ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
        CREATE TABLE connection_origins (
            connection_id TEXT, status TEXT, origin_kind TEXT, source_ref TEXT
        );
        CREATE TABLE account_deletion_tombstones (user_id_hash TEXT PRIMARY KEY);
    """)
    )
    for owner, name in [("retired", "Aardvark Person"), ("active", "Zebra Person")]:
        _person(connection, owner, name)
        _connected(connection, owner)
    retired_ref = str(uuid4())
    active_ref = str(uuid4())
    for owner, person_ref in [("retired", retired_ref), ("active", active_ref)]:
        connection.execute(
            text(
                "UPDATE actor_profiles SET public_person_ref=CAST(:ref AS UUID) WHERE user_id=:owner"
            ),
            {"ref": person_ref, "owner": owner},
        )

    def execute_many(sql, params):
        return [dict(row) for row in connection.execute(text(sql), params).mappings()]

    graph = ConnectionsService()
    monkeypatch.setattr(graph, "_execute_many", execute_many)
    profile = PersonProfileService(connections=graph, consent_db=object())
    monkeypatch.setattr(
        profile, "_execute_one", lambda sql, params: next(iter(execute_many(sql, params)), None)
    )
    monkeypatch.setattr(
        "hushh_mcp.services.person_profile_service.active_directory_user_ids",
        lambda owners, **_: set(owners),
    )

    # An active control proves the same rows and pagination really were eligible.
    assert graph.list_connections_page(OWNER, limit=1)["items"][0]["userId"] == "retired"
    assert profile.get_public_profile(retired_ref)["displayName"] == "Aardvark Person"
    connection.execute(
        text("INSERT INTO account_deletion_tombstones (user_id_hash) VALUES (:hash)"),
        {"hash": account_deletion_user_hash("retired")},
    )

    page = graph.list_connections_page(OWNER, limit=1)
    assert [row["userId"] for row in page["items"]] == ["active"]
    assert page["totalCount"] == 1
    assert page["hasMore"] is False
    assert [row["userId"] for row in graph.list_connections(OWNER)] == ["active"]
    with pytest.raises(PersonProfileNotFoundError):
        profile.get_public_profile(retired_ref)
    assert profile.get_public_profile(active_ref)["displayName"] == "Zebra Person"


def _network(connection: Connection):
    from hushh_mcp.services.connection_network_service import ConnectionNetworkService
    from hushh_mcp.services.connections_service import ConnectionsService

    service = ConnectionsService.__new__(ConnectionsService)
    service._transaction_connection = connection
    directory = _Directory(connection)
    network = ConnectionNetworkService(service)
    network._directory = directory
    return network


def _network_edge(connection: Connection, a: str, b: str, status: str = "active") -> None:
    a, b = sorted((a, b))
    connection.execute(
        text("INSERT INTO connections VALUES (:a, :b, :status)"), {"a": a, "b": b, "status": status}
    )


@pytest.mark.parametrize(
    "change", [None, "disconnect", "block", "disabled", "reference", "unlisted"]
)
def test_row_metadata_has_two_public_previews_and_rejects_mid_read_revocation(connection, change):
    from hushh_mcp.services.connection_row_metadata import ConnectionRowMetadata
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    for uid in (OWNER, "target", "mutual-a", "mutual-b", "mutual-c"):
        _person(connection, uid, f"Person {uid}")
    connection.execute(
        text("UPDATE actor_profiles SET public_person_ref = gen_random_uuid()::text")
    )
    for peer in ("mutual-a", "mutual-b", "mutual-c"):
        _network_edge(connection, OWNER, peer)
        _network_edge(connection, "target", peer)
    people = network.profiles(OWNER, ["target"])
    calls = []

    def profiles(viewer, ids):
        calls.append(ids)
        result = network.profiles(viewer, ids)
        if change == "disconnect":
            connection.execute(
                text(
                    "UPDATE connections SET status='revoked' WHERE user_a_id='mutual-b' AND user_b_id='target'"
                )
            )
        elif change == "block":
            connection.execute(
                text(
                    "INSERT INTO connection_requests VALUES ('target','mutual-b','rejected','{\"blocked_by\":\"target\"}')"
                )
            )
        elif change == "disabled":
            connection.execute(
                text(
                    "UPDATE actor_profiles SET public_profile_status='disabled' WHERE user_id='mutual-b'"
                )
            )
        elif change == "reference":
            connection.execute(
                text(
                    "UPDATE actor_profiles SET public_person_ref=gen_random_uuid()::text WHERE user_id='mutual-b'"
                )
            )
        elif change == "unlisted":
            connection.execute(
                text("UPDATE actor_profiles SET directory_listed=FALSE WHERE user_id='target'")
            )
        return result

    projection = ConnectionRowMetadata(network.connections, OWNER, people, profiles)
    assert calls == [["mutual-a", "mutual-b"]]
    if change:
        with pytest.raises(ConnectionsError) as failure:
            projection.settle()
        assert failure.value.status_code == 503
    else:
        item = projection.settle()["target"]
        assert item["relationship"] == "none"
        assert item["mutualConnectionCount"] == 3
        assert len(item["mutualConnectionPreviews"]) == 2
        assert all(
            set(peer) == {"publicPersonRef", "displayName", "photoUrl"}
            for peer in item["mutualConnectionPreviews"]
        )
        # Relationship metadata settles from the current graph, not an old read.
        connection.execute(
            text("INSERT INTO connection_requests VALUES ('target',:viewer,'pending','{}')"),
            {"viewer": OWNER},
        )
        assert projection.settle()["target"]["relationship"] == "pending_incoming"
        connection.execute(
            text("INSERT INTO connection_requests VALUES (:viewer,'target','pending','{}')"),
            {"viewer": OWNER},
        )
        assert projection.settle()["target"]["relationship"] == "pending_outgoing"
        _network_edge(connection, OWNER, "target")
        assert projection.settle()["target"]["relationship"] == "connected"


def test_directory_excludes_blocked_people_before_pagination(connection):
    _person(connection, "blocked", "Aaron Blocked")
    _person(connection, "visible", "Bella Visible")
    connection.execute(
        text(
            "INSERT INTO connection_requests VALUES (:viewer,'blocked','rejected','{\"blocked_by\":\"owner\"}')"
        ),
        {"viewer": OWNER},
    )
    result = _Directory(connection).search_directory_candidates(owner_user_id=OWNER, limit=1)
    assert [person["userId"] for person in result["items"]] == ["visible"]
    assert result["hasMore"] is False


@pytest.mark.parametrize("empty", [False, True])
def test_mutual_list_settles_target_authority_even_on_empty_pages(connection, monkeypatch, empty):
    from hushh_mcp.services import one_location_agent_service
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    for uid in (OWNER, "target", "peer-a", "peer-b"):
        _person(connection, uid, f"Person {uid}")
    connection.execute(text("UPDATE actor_profiles SET public_person_ref=gen_random_uuid()::text"))
    connection.execute(
        text(
            "ALTER TABLE actor_profiles ALTER COLUMN public_person_ref TYPE UUID USING public_person_ref::uuid"
        )
    )
    for peer in ("peer-a", "peer-b"):
        _network_edge(connection, OWNER, peer)
        _network_edge(connection, "target", peer)
    target_ref = str(
        connection.execute(
            text("SELECT public_person_ref FROM actor_profiles WHERE user_id='target'")
        ).scalar_one()
    )
    directory = network.directory()
    network.connections._directory_profiles = network.profiles
    monkeypatch.setattr(one_location_agent_service, "OneLocationAgentService", lambda: directory)
    # Page beyond the end still returns a current count and validates the target.
    page = 3 if empty else 1
    result = network.connections.list_mutual_connections_page(
        OWNER, person_ref=target_ref, page=page, limit=1
    )
    assert result["totalCount"] == 2
    assert len(result["items"]) == (0 if empty else 1)
    original = directory.search_directory_candidates

    def read_then_unlist(**kwargs):
        result = original(**kwargs)
        if "mutual_target_user_id" in kwargs:
            connection.execute(
                text("UPDATE actor_profiles SET directory_listed=FALSE WHERE user_id='target'")
            )
        return result

    monkeypatch.setattr(directory, "search_directory_candidates", read_then_unlist)
    with pytest.raises(ConnectionsError) as failure:
        network.connections.list_mutual_connections_page(
            OWNER, person_ref=target_ref, page=page, limit=1
        )
    assert failure.value.status_code == 503


def test_extended_network_shortest_degrees_require_shared_paths_and_live_accounts(connection):
    network = _network(connection)
    for uid in (OWNER, "alice", "bob", "carol", "dave", "hidden", "disabled", "stranger"):
        _person(connection, uid, uid.title())
    for a, b in (
        (OWNER, "alice"),
        ("alice", "bob"),
        ("bob", "carol"),
        ("carol", "dave"),
        (OWNER, "bob"),
        ("bob", "hidden"),
        ("hidden", "stranger"),
        ("alice", "disabled"),
        ("disabled", "dave"),
    ):
        _network_edge(connection, a, b)
    _network_edge(connection, OWNER, "stranger", "revoked")
    _requested(connection, OWNER, "dave")  # pending is not a graph edge
    connection.execute(
        text("UPDATE actor_profiles SET public_profile_status='disabled' WHERE user_id='hidden'")
    )
    directory = _Directory(connection)
    directory._active_directory_user_ids = lambda ids: set(ids) - {"disabled"}
    network._directory = directory
    assert network.preference(OWNER) == {"shareConnectionList": False}
    # Mutual existence is retained even when full lists are private.
    assert network.degrees(OWNER) == {"alice": 1, "bob": 1, "carol": 2}
    for uid in ("bob", "carol"):
        network.set_preference(uid, True)
    assert network.degrees(OWNER) == {"alice": 1, "bob": 1, "carol": 2, "dave": 3}
    network.set_preference("carol", False)
    assert "dave" not in network.degrees(OWNER)
    network.set_preference("carol", True)
    # Any blocked path segment is excluded in either direction.
    connection.execute(
        text(
            "INSERT INTO connection_requests VALUES ('carol','dave','rejected', '{\"blocked_by\":\"carol\"}')"
        )
    )
    assert "dave" not in network.degrees(OWNER)


def test_extended_network_suggests_eligible_people_without_exposing_contact_or_path(connection):
    network = _network(connection)
    for uid, name in (
        (OWNER, "Viewer"),
        ("alice", "A First"),
        ("bob", "A Second"),
        ("carol", "A Third"),
        ("advisor", "Z Advisor"),
        ("blocked", "A Blocked"),
        ("ordinary", "Z Ordinary"),
    ):
        _person(connection, uid, name, email=f"{uid}@example.test")
    connection.execute(
        text("UPDATE actor_profiles SET public_person_ref = gen_random_uuid()::text")
    )
    connection.execute(
        text("""
            INSERT INTO ria_profiles (user_id, verification_status)
            VALUES ('advisor', 'verified'), ('blocked', 'verified'), ('carol', 'verified')
        """)
    )
    connection.execute(
        text("""INSERT INTO connection_requests
                VALUES ('blocked', 'owner', 'rejected', '{"blocked_by":"blocked"}')""")
    )
    fresh = network.browse(OWNER, degree=3, include_suggestions=True)
    assert fresh["items"] == []
    assert [p["displayName"] for p in fresh["suggestions"]] == ["A Third", "Z Advisor"]
    assert all(p["suggestionReason"] == "verified_advisor" for p in fresh["suggestions"])
    for a, b in ((OWNER, "alice"), ("alice", "bob"), ("bob", "carol")):
        _network_edge(connection, a, b)
    network.set_preference("alice", True)
    network.set_preference("bob", True)
    _requested(connection, OWNER, "advisor")
    established = network.browse(OWNER, degree=3, include_suggestions=True)
    assert [(p["displayName"], p["networkDegree"]) for p in established["items"]] == [
        ("A Third", 3)
    ]
    [suggested] = established["suggestions"]
    assert suggested == {
        "publicPersonRef": fresh["suggestions"][1]["publicPersonRef"],
        "displayName": "Z Advisor",
        "photoUrl": None,
        "relationship": "pending_outgoing",
        "suggestionReason": "verified_advisor",
    }
    assert "suggestions" not in network.browse(OWNER, degree=3, page=2, include_suggestions=True)
    assert "suggestions" not in network.browse(OWNER, degree=2, include_suggestions=True)
    private_search = network.browse(
        OWNER, degree=3, query="ordinary@example.test", include_suggestions=True
    )
    assert private_search["suggestions"] == []
    [name_match] = network.browse(OWNER, degree=3, query="Ordinary", include_suggestions=True)[
        "suggestions"
    ]
    assert (name_match["displayName"], name_match["suggestionReason"]) == (
        "Z Ordinary",
        "name_match",
    )
    _network_edge(connection, OWNER, "advisor")
    assert network.browse(OWNER, degree=3, include_suggestions=True)["suggestions"] == []


def test_network_cycles_do_not_extend_degrees_or_include_viewer(connection):
    network = _network(connection)
    for uid in (OWNER, "a", "b", "c", "d"):
        _person(connection, uid, f"Person {uid}")
        network.set_preference(uid, True)
    for a, b in ((OWNER, "a"), ("a", "b"), ("b", "c"), ("c", "a"), ("c", "d")):
        _network_edge(connection, a, b)
    assert network.degrees(OWNER) == {"a": 1, "b": 2, "c": 2, "d": 3}


def test_network_directory_filter_applies_before_pagination(connection):
    ids = []
    for index in range(125):
        uid = f"network-{index:03}"
        _person(connection, uid, f"Network {index:03}")
        ids.append(uid)
    _person(connection, "stranger", "A Stranger")
    directory = _Directory(connection)
    result = directory.search_directory_candidates(
        owner_user_id=OWNER, network_user_ids=ids, page=2, limit=20
    )
    assert [p["userId"] for p in result["items"]] == ids[20:40]
    assert result["hasMore"] is True
    assert (
        directory.search_directory_candidates(owner_user_id=OWNER, network_user_ids=[], limit=20)[
            "items"
        ]
        == []
    )


@pytest.mark.parametrize(
    "change", ["opt_out", "disconnect", "block", "peer_disconnect", "peer_block"]
)
def test_shared_network_rechecks_permission_after_directory_work(connection, change):
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    for uid in (OWNER, "target", "peer"):
        _person(connection, uid, f"Person {uid}")
    connection.execute(
        text(
            "ALTER TABLE actor_profiles ALTER COLUMN public_person_ref TYPE UUID USING public_person_ref::uuid"
        )
    )
    target_ref = str(uuid4())
    connection.execute(
        text(
            "UPDATE actor_profiles SET public_person_ref = CAST(:ref AS UUID) WHERE user_id='target'"
        ),
        {"ref": target_ref},
    )
    connection.execute(
        text(
            "UPDATE actor_profiles SET public_person_ref = gen_random_uuid() WHERE public_person_ref IS NULL"
        )
    )
    _network_edge(connection, OWNER, "target")
    _network_edge(connection, "target", "peer")
    assert network.preference("target") == {"shareConnectionList": False}
    with pytest.raises(ConnectionsError) as private:
        network.browse(OWNER, person_ref=target_ref)
    assert private.value.status_code == 404
    network.set_preference("target", True)
    page = network.browse(OWNER, person_ref=target_ref)
    assert len(page["items"]) == 1
    assert page["items"][0]["networkDegree"] == 2
    assert set(page["items"][0]) == {
        "publicPersonRef",
        "displayName",
        "photoUrl",
        "networkDegree",
        "relationship",
        "mutualConnectionCount",
        "mutualConnectionPreview",
        "mutualConnectionPreviews",
    }
    original = network.directory().search_directory_candidates

    def read_then_revoke(**kwargs):
        result = original(**kwargs)
        if "network_user_ids" in kwargs:
            if change == "opt_out":
                network.set_preference("target", False)
            elif change in ("disconnect", "peer_disconnect"):
                a, b = sorted((OWNER if change == "disconnect" else "peer", "target"))
                connection.execute(
                    text(
                        "UPDATE connections SET status='revoked' WHERE user_a_id=:a AND user_b_id=:b"
                    ),
                    {"a": a, "b": b},
                )
            else:
                a, b = (OWNER, "target") if change == "block" else ("peer", "target")
                connection.execute(
                    text(
                        "INSERT INTO connection_requests VALUES (:a,:b,'rejected','{\"blocked_by\":\"test\"}')"
                    ),
                    {"a": a, "b": b},
                )
        return result

    network.directory().search_directory_candidates = read_then_revoke
    with pytest.raises(ConnectionsError) as caught:
        network.browse(OWNER, person_ref=target_ref)
    assert caught.value.status_code in (404, 503)


def test_extended_discovery_rechecks_third_hop_opt_out_after_page_read(connection):
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    for uid in (OWNER, "alice", "bob", "carol"):
        _person(connection, uid, uid.title())
        network.set_preference(uid, True)
    for a, b in ((OWNER, "alice"), ("alice", "bob"), ("bob", "carol")):
        _network_edge(connection, a, b)
    original = network.directory().search_directory_candidates

    def read_then_revoke(**kwargs):
        result = original(**kwargs)
        if "network_user_ids" in kwargs:
            network.set_preference("bob", False)
        return result

    network.directory().search_directory_candidates = read_then_revoke
    with pytest.raises(ConnectionsError) as caught:
        network.browse(OWNER, degree=3)
    assert caught.value.status_code == 503


def test_network_budget_refuses_partial_or_invented_degrees(connection, monkeypatch):
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    for uid in (OWNER, "a", "b", "c"):
        _person(connection, uid, f"Person {uid}")
    for uid in ("a", "b", "c"):
        _network_edge(connection, OWNER, uid)
    monkeypatch.setattr("hushh_mcp.services.connection_network_service.MAX_NETWORK_NODES", 2)
    with pytest.raises(ConnectionsError) as caught:
        network.degrees(OWNER)
    assert caught.value.status_code == 503


@pytest.mark.parametrize(
    "change", ["disconnect", "block", "disable", "preview_disconnect", "preview_disable"]
)
def test_network_summary_rechecks_authority_after_preview_read(connection, change):
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    for uid in (OWNER, "target", "preview"):
        _person(connection, uid, f"Person {uid}")
    connection.execute(
        text(
            "ALTER TABLE actor_profiles ALTER COLUMN public_person_ref TYPE UUID USING public_person_ref::uuid"
        )
    )
    connection.execute(text("UPDATE actor_profiles SET public_person_ref=gen_random_uuid()"))
    target_ref = str(
        connection.execute(
            text("SELECT public_person_ref FROM actor_profiles WHERE user_id='target'")
        ).scalar_one()
    )
    for a, b in ((OWNER, "target"), (OWNER, "preview"), ("preview", "target")):
        _network_edge(connection, a, b)
    assert network.summary(OWNER, target_ref)["networkDegree"] == 1
    original = network.profiles

    def read_then_revoke(viewer, ids):
        people = original(viewer, ids)
        if ids == ["preview"]:
            if change == "block":
                connection.execute(
                    text(
                        "INSERT INTO connection_requests VALUES (:owner,'target','rejected','{\"blocked_by\":\"target\"}')"
                    ),
                    {"owner": OWNER},
                )
            elif change in ("disable", "preview_disable"):
                connection.execute(
                    text(
                        "UPDATE actor_profiles SET public_profile_status='disabled' WHERE user_id=:uid"
                    ),
                    {"uid": "target" if change == "disable" else "preview"},
                )
            else:
                a, b = sorted((OWNER if change == "disconnect" else "preview", "target"))
                connection.execute(
                    text(
                        "UPDATE connections SET status='revoked' WHERE user_a_id=:a AND user_b_id=:b"
                    ),
                    {"a": a, "b": b},
                )
        return people

    network.profiles = read_then_revoke
    with pytest.raises(ConnectionsError) as caught:
        network.summary(OWNER, target_ref)
    assert caught.value.status_code in (404, 503)


def test_final_network_qualification_enforces_edge_budget_on_unexpanded_leaves(
    connection, monkeypatch
):
    from hushh_mcp.services.connections_service import ConnectionsError

    network = _network(connection)
    ids = [OWNER, "a", "b", "c", "d"]
    for uid in ids:
        _person(connection, uid, f"Person {uid}")
        network.set_preference(uid, True)
    for a, b in ((OWNER, "a"), ("a", "b"), ("b", "c"), ("b", "d"), ("c", "d")):
        _network_edge(connection, a, b)
    # Five undirected edges become nine eligible directed edges. Qualification
    # must refuse an overflow instead of returning paths from a truncated graph.
    network._admitted = ids
    monkeypatch.setattr("hushh_mcp.services.connection_network_service.MAX_NETWORK_EDGES", 8)
    with pytest.raises(ConnectionsError) as caught:
        network.qualify_degrees(OWNER, ["c", "d"])
    assert caught.value.status_code == 503


def test_mutual_directory_pages_all_eligible_shared_peers_on_postgres(
    connection: Connection,
) -> None:
    _person(connection, OWNER, "Viewer")
    _person(connection, "target", "Target")
    for index in range(25):
        uid = f"peer-{index:02}"
        _person(connection, uid, f"Mutual {index:02}", vault=None)
        _connected(connection, uid)
        a, b = sorted(("target", uid))
        connection.execute(
            text("INSERT INTO connections VALUES (:a, :b, 'active')"), {"a": a, "b": b}
        )
    _person(connection, "stranger", "A Stranger")
    _person(connection, "revoked", "A Revoked")
    _connected(connection, "revoked")
    connection.execute(text("INSERT INTO connections VALUES ('revoked', 'target', 'revoked')"))
    connection.execute(
        text("UPDATE actor_profiles SET public_profile_status='inactive' WHERE user_id='peer-00'")
    )
    connection.execute(
        text("UPDATE actor_profiles SET directory_listed=FALSE WHERE user_id='peer-03'")
    )
    connection.execute(
        text(
            "INSERT INTO connection_requests VALUES ('peer-01', 'target', 'rejected', '{\"blocked_by\":\"target\"}')"
        )
    )

    class ActiveDirectory(_Directory):
        def _active_directory_user_ids(self, user_ids: list[str]) -> set[str]:
            return set(user_ids) - {"peer-02"}

    service = ActiveDirectory(connection)
    first = service.search_directory_candidates(
        owner_user_id=OWNER, mutual_target_user_id="target", limit=20
    )
    last = service.search_directory_candidates(
        owner_user_id=OWNER, mutual_target_user_id="target", limit=20, page=2
    )
    assert len(first["items"]) == 20
    assert first["hasMore"] is True
    assert last["hasMore"] is False
    assert [person["userId"] for person in first["items"] + last["items"]] == [
        f"peer-{index:02}" for index in range(3, 25)
    ]
    # Negative control: the unfiltered directory includes the unrelated stranger.
    assert any(
        person["userId"] == "stranger"
        for person in service.search_directory_candidates(owner_user_id=OWNER, limit=50)["items"]
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
    # A marketplace opt-out is not a request to leave the Connect directory, so
    # it hides nobody by name -- stranger, connected, trusted or otherwise. It
    # only keeps a person out of email and phone lookups (tested below).
    _person(connection, "opted-out", "Olive Optout", discoverable=False)
    _person(connection, "trusted-hidden", "Hana Hidden", discoverable=False, trusted_by_owner=True)
    _person(connection, "connected-hidden", "Cody Hidden", discoverable=False)
    _connected(connection, "connected-hidden")
    _person(connection, "revoked-hidden", "Rhea Hidden", discoverable=False)
    _connected(connection, "revoked-hidden", status="revoked")
    _person(connection, "asked-hidden", "Asa Hidden", discoverable=False, vault="active")
    _requested(connection, OWNER, "asked-hidden")
    service = _Directory(connection)

    listed = service.search_directory_candidates(owner_user_id=OWNER, limit=50)

    assert [item["userId"] for item in listed["items"]] == [
        "active",
        "asked-hidden",
        "connected-hidden",
        "connected",
        "trusted-hidden",
        "asked-me",
        "opted-out",
        "asked-them",
        "revoked-hidden",
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
    assert visible == {
        "active",
        "connected",
        "asked-them",
        "asked-me",
        "opted-out",
        "connected-hidden",
        "revoked-hidden",
        "asked-hidden",
    }


def test_a_vault_copied_from_another_environment_does_not_list_a_stranger(
    connection: Connection,
) -> None:
    """Dev began as a UAT copy (2026-07-10), production as a UAT restore (2026-07-28).

    Their active vaults look like real sign-ups; only a first unlock in THIS
    environment stamps ``environment_enrolled_at``. People the viewer already
    knows stay listed either way.
    """
    _person(connection, OWNER, "Owen Owner")
    _person(connection, "used-here", "Una Usedhere")
    _person(connection, "copied-in", "Cole Copied", enrolled=False)
    _person(connection, "copied-friend", "Faye Friend", enrolled=False)
    _connected(connection, "copied-friend")
    service = _Directory(connection)

    listed = service.search_directory_candidates(owner_user_id=OWNER, limit=50)

    assert {item["userId"] for item in listed["items"]} == {"used-here", "copied-friend"}
    assert not service.is_directory_candidate(owner_user_id=OWNER, candidate_user_id="copied-in")
    # The first unlock here makes them discoverable with no other change.
    connection.execute(
        text("UPDATE vault_keys SET environment_enrolled_at = NOW() WHERE user_id = 'copied-in'")
    )
    assert service.is_directory_candidate(owner_user_id=OWNER, candidate_user_id="copied-in")


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
    # Names are not gated by the marketplace flag; the lookup stays bounded to
    # the ids asked for.
    assert [item["userId"] for item in result["items"]] == ["hidden", "visible"]
    assert (
        service.search_directory_candidates(owner_user_id=OWNER, candidate_user_ids=[])["items"]
        == []
    )


def test_typed_directory_search_matches_spacing_variants_before_paging(connection, monkeypatch):
    names = ["Sharu Khan", "Sharukhan", "Sharu  Khan", "SHARUKHAN", "Sharu\u00a0Khan"]
    for index, name in enumerate(names):
        _person(connection, f"match-{index}", name)
    _person(connection, "contact-only", "Other Person", email="sharukhan@example.test")
    _person(connection, "unlisted", "Sharukhan", vault=None)
    _person(connection, "recovered", "")
    service = _Directory(connection)
    monkeypatch.setattr(
        service,
        "_directory_auth_profiles",
        lambda ids: (
            {"recovered": {"display_name": "Sharu Khan", "photo_url": None}}
            if "recovered" in ids
            else {}
        ),
    )

    previous_ids = None
    for query in ("Sharu", "Sharu K", "Sharu Khan", "Sharukhan", "SHARUKHA", "  Sharu\t Khan  "):
        ids = []
        for page in range(1, 4):
            result = service.search_directory_candidates(
                owner_user_id=OWNER, query=query, typed_search=True, page=page, limit=2
            )
            assert result["hasMore"] == (page < 3)
            ids.extend(row["userId"] for row in result["items"])
        assert len(ids) == 6
        assert set(ids) == {*(f"match-{index}" for index in range(5)), "recovered"}
        if previous_ids is not None:
            assert ids == previous_ids
        previous_ids = ids


def test_typed_directory_search_uses_literal_short_name_matches_and_explicit_contacts(connection):
    _person(connection, "prefix", "Neelesh Meena")
    _person(connection, "substring", "Dinesh Kumar")
    _person(connection, "joined-only", "John Ellis")
    _person(
        connection,
        "contact-only",
        "Other Person",
        email="ne@example.test",
        phone="+14155550100",
        phone_verified=True,
    )
    _person(
        connection, "private-contact", "Hidden Person", email="ne@example.test", discoverable=False
    )
    service = _Directory(connection)

    def search(query):
        return service.search_directory_candidates(
            owner_user_id=OWNER, query=query, typed_search=True
        )

    assert [row["userId"] for row in search("NE")["items"]] == ["prefix", "substring"]
    assert [row["userId"] for row in search("n")["items"]] == ["prefix"]
    assert [row["userId"] for row in search("ne@")["items"]] == ["contact-only"]
    assert [row["userId"] for row in search("415 555")["items"]] == ["contact-only"]
    assert search("%")["items"] == []


def test_directory_email_typeahead_ranks_names_and_pages_contact_matches(connection, monkeypatch):
    email = "mailbox.alias+tag@example.test"
    _person(connection, OWNER, "Owner", email=email)
    _person(connection, "target", "Zoe Peer", email=email)
    _person(connection, "second", "Aaron Peer", email="mailbox.other@example.test")
    _person(connection, "name", "Mailbox Person", email="unrelated@elsewhere.test")
    _person(connection, "hidden", "Hidden Peer", email=email, discoverable=False)
    _person(connection, "unfinished", "Unfinished Peer", email=email, vault=None)
    _person(connection, "disabled", "Disabled Peer", email=email)
    service = _Directory(connection)
    monkeypatch.setattr(service, "_active_directory_user_ids", lambda ids: set(ids) - {"disabled"})

    for length in range(1, len(email) + 1):
        result = service.search_directory_candidates(owner_user_id=OWNER, query=email[:length])
        ids = [item["userId"] for item in result["items"]]
        assert "target" in ids, email[:length]
        assert not {OWNER, "hidden", "unfinished", "disabled"}.intersection(ids)
        assert all("phoneNumber" not in item and not item.get("email") for item in result["items"])

    for query in ("MAILBOX.ALIAS@", "  ALIAS+TAG@EXAMPLE  ", "@example.test"):
        result = service.search_directory_candidates(owner_user_id=OWNER, query=query)
        expected = [] if query == "MAILBOX.ALIAS@" else ["target"]
        if query == "@example.test":
            expected = ["second", "target"]
        assert [item["userId"] for item in result["items"]] == expected

    pages = [
        service.search_directory_candidates(
            owner_user_id=OWNER, query="mailbox", page=page, limit=1
        )
        for page in range(1, 4)
    ]
    assert [page["items"][0]["userId"] for page in pages] == ["name", "second", "target"]
    assert [page["hasMore"] for page in pages] == [True, True, False]
    names = service.search_directory_candidates(
        owner_user_id=OWNER, query="mailbox", limit=1, name_only=True
    )
    assert [item["userId"] for item in names["items"]] == ["name"]
    assert names["hasMore"] is False


def test_directory_contact_search_recovers_provider_names_before_paging(connection, monkeypatch):
    _person(connection, "recovered", "", email="match@example.test")
    _person(connection, "cached", "Zoe Peer", email="match@example.test")
    service = _Directory(connection)
    monkeypatch.setattr(
        service,
        "_directory_auth_profiles",
        lambda ids: {"recovered": {"display_name": "Aaron Peer", "photo_url": None}},
    )
    first = service.search_directory_candidates(owner_user_id=OWNER, query="match@", limit=1)
    second = service.search_directory_candidates(
        owner_user_id=OWNER, query="match@", limit=1, page=2
    )
    assert [item["userId"] for item in first["items"]] == ["recovered"]
    assert first["hasMore"] is True
    assert [item["userId"] for item in second["items"]] == ["cached"]
    assert second["hasMore"] is False


@pytest.mark.parametrize(
    ("phone", "national"),
    [
        ("+91 98765-43210", "9876543210"),
        ("+1 (415) 555-0123", "4155550123"),
        ("+44 7700 900123", "7700900123"),
        ("+358 40 1234567", "401234567"),
        ("+39 06 6982", "066982"),
    ],
)
def test_directory_phone_typeahead_with_and_without_country_code(connection, phone, national):
    _person(connection, "target", "Zoe Peer", phone=phone, phone_verified=True)
    _person(connection, "unverified", "Unverified Peer", phone=phone, phone_verified=False)
    _person(
        connection, "hidden", "Hidden Peer", phone=phone, phone_verified=True, discoverable=False
    )
    _person(connection, "other", "Other Peer", phone="+33 612 345678", phone_verified=True)
    service = _Directory(connection)
    international = "".join(char for char in phone if char.isdigit())
    for query in [
        phone,
        international,
        national,
        "00" + international,
        f"{national[:3]} {national[3:6]}-{national[6:]}",
    ]:
        result = service.search_directory_candidates(owner_user_id=OWNER, query=query)
        assert [item["userId"] for item in result["items"]] == ["target"], query
        assert national not in str(result)
        assert (
            result["items"][0]["maskedPhone"]
            == national[:2] + "*" * (len(national) - 4) + national[-2:]
        )
    for digits in (national, international):
        for length in range(1, len(digits) + 1):
            result = service.search_directory_candidates(owner_user_id=OWNER, query=digits[:length])
            ids = [item["userId"] for item in result["items"]]
            assert "target" in ids, digits[:length]
            assert not {"unverified", "hidden"}.intersection(ids)
    for query in ("+999" + national, "call " + national, "+", "()"):
        assert service.search_directory_candidates(owner_user_id=OWNER, query=query)["items"] == []


@pytest.mark.parametrize(
    "query",
    [
        "09876543210",
        "0091 (0) 98765",
        "+91 (0) 98765",
        "+९१ ९८७६५ ४३२१०",
        "＋９１ ９８７６５ ４３２１０",
        "+91\u200e 98765\u201143210",
    ],
)
def test_directory_normalized_phone_variants_run_before_sql_pagination(connection, query):
    _person(connection, "target", "Zoe Peer", phone="+919876543210", phone_verified=True)
    _person(
        connection, "unverified", "Unverified Peer", phone="+919876543210", phone_verified=False
    )
    _person(connection, "decoy", "Aaron Peer", phone="+14155550123", phone_verified=True)
    result = _Directory(connection).search_directory_candidates(
        owner_user_id=OWNER, query=query, limit=1
    )
    assert [item["userId"] for item in result["items"]] == ["target"]
    assert result["hasMore"] is False
    assert result["items"][0]["maskedPhone"] == "98******10"


def test_directory_email_punctuation_is_literal(connection):
    _person(connection, "target", "Target Peer", email="odd_%!+tag@example.test")
    _person(connection, "decoy", "Other Peer", email="oddABtag@example.test")
    service = _Directory(connection)
    for query in ("_", "%", "%!", "odd_%!+", "odd_%!+tag@example.test"):
        result = service.search_directory_candidates(owner_user_id=OWNER, query=query)
        assert [item["userId"] for item in result["items"]] == ["target"], query


@pytest.mark.parametrize("concurrent_claim", [False, True])
async def test_missing_provider_phone_repair_becomes_searchable_without_replacing_claims(
    connection, monkeypatch, concurrent_claim
):
    import hushh_mcp.services.actor_identity_service as identities

    _person(connection, "target", "Zoe Peer", phone_verified=False)

    class Adapter:
        def statement(self, sql, args):
            return connection.execute(
                text(re.sub(r"\$(\d+)", lambda match: f":arg_{match[1]}", sql)),
                {f"arg_{index}": value for index, value in enumerate(args, 1)},
            )

        async def execute(self, sql, *args):
            self.statement(sql, args)

        async def fetch(self, sql, *args):
            return [dict(row) for row in self.statement(sql, args).mappings()]

        async def fetchrow(self, sql, *args):
            row = self.statement(sql, args).mappings().first()
            return dict(row) if row else None

        @asynccontextmanager
        async def transaction(self):
            with connection.begin_nested():
                yield

    @asynccontextmanager
    async def acquire():
        yield Adapter()

    monkeypatch.setattr(
        identities, "get_pool", AsyncMock(return_value=SimpleNamespace(acquire=acquire))
    )
    service = identities.ActorIdentityService()
    monkeypatch.setattr(service, "_ensure_actor_spine", AsyncMock())
    monkeypatch.setattr(service, "_sync_referral_qualification_best_effort", AsyncMock())
    monkeypatch.setattr(
        service, "get_many", AsyncMock(return_value={"target": {"phone_verified": False}})
    )

    async def provider(*args, **kwargs):
        if concurrent_claim:
            connection.execute(
                text(
                    "UPDATE actor_identity_cache SET phone_number='+14155550199', phone_verified=TRUE WHERE user_id='target'"
                )
            )
        return SimpleNamespace(phone_number="+919876543210", disabled=False)

    monkeypatch.setattr(service, "_get_firebase_user_record", provider)
    await service.sync_verified_phone_from_firebase("target", missing_only=True)
    phone = "+14155550199" if concurrent_claim else "+919876543210"
    assert (
        connection.execute(
            text("SELECT phone_number FROM actor_identity_cache WHERE user_id='target'")
        ).scalar_one()
        == phone
    )
    result = _Directory(connection).search_directory_candidates(owner_user_id=OWNER, query=phone)
    assert [item["userId"] for item in result["items"]] == ["target"]
