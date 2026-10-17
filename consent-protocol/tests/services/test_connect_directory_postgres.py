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
  email_verified BOOLEAN DEFAULT FALSE,
  source TEXT DEFAULT 'test',
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
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
