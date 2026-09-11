"""Hermetic tests for the WebAuthn credential repo + one-time challenge store.

This module is the **replay-protection boundary**: a WebAuthn challenge must be
spendable exactly once, and the credential rows it guards must round-trip
faithfully. The same in-memory fake Supabase client used by
``test_personal_agent_registry_repo`` stands in for the database (fluent
table/select/insert/update/delete/eq/limit/execute with real semantics), plus
column projection and an op log so the delete-on-consume can be asserted
directly rather than inferred.

Layering note, verified against the source: ``WebAuthnChallengeStore.consume``
is keyed by challenge **value only** (usernameless authentication has no user to
scope by). The row it returns carries ``user_id``, and the A-vs-B binding check
lives one layer up in ``WebAuthnService._consume_valid``
(``challenge_user_mismatch``). Both halves are covered below, the second through
the real repo wired into the real service.
"""

from __future__ import annotations

import base64
import json
import time
from types import SimpleNamespace

import pytest

from hushh_mcp.services.webauthn_repo import (
    WebAuthnChallengeStore,
    WebAuthnCredentialRepo,
    _is_expired,
)
from hushh_mcp.services.webauthn_service import WebAuthnService, WebAuthnSettings

_UID = "firebase_uid_test_123"
_OTHER_UID = "firebase_uid_test_456"
_RP = "one.hushh.ai"
_CHALLENGE = "Q0hBTExFTkdF"
_CREDENTIALS = "webauthn_credentials"
_CHALLENGES = "webauthn_challenges"


class _Query:
    def __init__(self, db, table):
        self._db = db
        self._table = table
        self._mode = None
        self._payload = None
        self._cols = "*"
        self._eq = None
        self._limit = None

    def insert(self, data):
        self._mode, self._payload = "insert", data
        return self

    def update(self, data):
        self._mode, self._payload = "update", data
        return self

    def select(self, cols="*"):
        self._mode, self._cols = "select", cols
        return self

    def delete(self):
        self._mode = "delete"
        return self

    def eq(self, col, val):
        self._eq = (col, val)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def _project(self, row):
        if self._cols == "*":
            return dict(row)
        return {c: row[c] for c in self._cols.split(",") if c in row}

    def execute(self):
        rows = self._db.tables.setdefault(self._table, [])
        self._db.ops.append((self._table, self._mode))
        if self._mode == "insert":
            rows.append(dict(self._payload))
            return SimpleNamespace(data=[dict(self._payload)])
        if self._mode == "update":
            hit = [r for r in rows if not self._eq or r.get(self._eq[0]) == self._eq[1]]
            for r in hit:
                r.update(self._payload)
            return SimpleNamespace(data=[dict(r) for r in hit])
        if self._mode == "select":
            out = [r for r in rows if not self._eq or r.get(self._eq[0]) == self._eq[1]]
            if self._limit is not None:
                out = out[: self._limit]
            return SimpleNamespace(data=[self._project(r) for r in out])
        if self._mode == "delete":
            if self._eq:
                rows[:] = [r for r in rows if r.get(self._eq[0]) != self._eq[1]]
            return SimpleNamespace(data=[])
        return SimpleNamespace(data=[])


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.ops: list[tuple] = []

    def table(self, name):
        return _Query(self, name)


def _challenges_and_db():
    db = FakeDB()
    return WebAuthnChallengeStore(client=db), db


def _creds_and_db():
    db = FakeDB()
    return WebAuthnCredentialRepo(client=db), db


def _credential_row(credential_id="cred-1", user_id=_UID, **over):
    row = {
        "user_id": user_id,
        "credential_id": credential_id,
        "public_key": "cHVibGljLWtleQ",  # gitleaks:allow -- base64url of "public-key", a fixture label
        "sign_count": 0,
        "aaguid": "ee882879-721c-4913-9775-3dfcce97072a",
        "device_type": "multi_device",
        "backed_up": True,
        "rp_id": _RP,
        "device_label": None,
    }
    row.update(over)
    return row


# --------------------------------------------------------------------------
# WebAuthnChallengeStore -- the replay-protection boundary
# --------------------------------------------------------------------------


async def test_save_then_consume_round_trips():
    store, db = _challenges_and_db()
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=300
    )
    assert len(db.tables[_CHALLENGES]) == 1
    row = await store.consume(_CHALLENGE)
    assert row is not None
    assert row["challenge"] == _CHALLENGE
    assert row["ceremony"] == "registration"
    assert row["rp_id"] == _RP
    assert row["user_id"] == _UID
    # save() writes the expiry in the exact format _is_expired() parses; a drift
    # between the two would silently disable TTL enforcement.
    assert not _is_expired(row["expires_at"])


async def test_challenge_is_single_use():
    """SECURITY: the replay-protection property. A challenge is spendable once."""
    store, db = _challenges_and_db()
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=300
    )
    first = await store.consume(_CHALLENGE)
    assert first is not None
    # The row is gone from storage, not merely flagged.
    assert db.tables[_CHALLENGES] == []
    # Every subsequent replay of the same challenge value fails closed.
    assert await store.consume(_CHALLENGE) is None
    assert await store.consume(_CHALLENGE) is None


async def test_consume_issues_delete_before_validity_is_judged():
    """The delete is unconditional -- an invalid challenge is burned too, so a
    caller cannot retry it after fixing whatever made it invalid."""
    store, db = _challenges_and_db()
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=-60
    )
    db.ops.clear()
    assert await store.consume(_CHALLENGE) is None  # expired
    assert (_CHALLENGES, "delete") in db.ops
    assert db.tables[_CHALLENGES] == []


async def test_expired_challenge_is_rejected():
    store, _ = _challenges_and_db()
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=-60
    )
    assert await store.consume(_CHALLENGE) is None


async def test_consume_unknown_challenge_returns_none():
    store, db = _challenges_and_db()
    assert await store.consume("never-minted") is None
    # Still fails closed rather than raising, and still issues the delete.
    assert (_CHALLENGES, "delete") in db.ops


async def test_consume_matches_the_exact_challenge_value():
    store, _ = _challenges_and_db()
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=300
    )
    assert await store.consume(_CHALLENGE + "x") is None
    assert await store.consume(_CHALLENGE.lower()) is None
    # The real challenge survives those near misses.
    assert await store.consume(_CHALLENGE) is not None


async def test_usernameless_challenge_stores_no_user_id():
    store, db = _challenges_and_db()
    await store.save(
        user_id=None, challenge=_CHALLENGE, ceremony="authentication", rp_id=_RP, ttl_s=300
    )
    # Discoverable-credential login has no user yet; the column is omitted, not "None".
    assert "user_id" not in db.tables[_CHALLENGES][0]
    row = await store.consume(_CHALLENGE)
    assert row is not None and row.get("user_id") is None


async def test_consume_returns_owner_so_caller_can_bind_the_user():
    """The store is keyed by challenge value only (usernameless auth needs that),
    so it hands back ``user_id`` for ``WebAuthnService._consume_valid`` to check."""
    store, _ = _challenges_and_db()
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=300
    )
    row = await store.consume(_CHALLENGE)
    assert row is not None and row["user_id"] == _UID
    assert row["user_id"] != _OTHER_UID


async def test_challenge_minted_for_user_a_is_rejected_for_user_b():
    """SECURITY, end to end: the real repo wired into the real service. User B
    cannot spend user A's challenge, and the failed attempt burns it, so A cannot
    reuse it either -- the ceremony fails closed for both parties."""
    db = FakeDB()
    store = WebAuthnChallengeStore(client=db)
    svc = WebAuthnService(
        credentials=WebAuthnCredentialRepo(client=db),
        challenges=store,
        settings=WebAuthnSettings(rp_id=_RP, rp_name="hussh", origins=(f"https://{_RP}",)),
    )
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=300
    )
    client_data = {"challenge": _CHALLENGE, "type": "webauthn.create", "origin": f"https://{_RP}"}
    raw = base64.urlsafe_b64encode(json.dumps(client_data).encode()).decode().rstrip("=")
    credential = {
        "id": "cred-1",
        "rawId": "cred-1",
        "response": {"clientDataJSON": raw},
        "type": "public-key",
    }
    with pytest.raises(ValueError, match="challenge_user_mismatch"):
        await svc.finish_registration(user_id=_OTHER_UID, credential=credential)
    assert db.tables[_CHALLENGES] == []
    assert await store.consume(_CHALLENGE) is None


def test_is_expired_parses_both_z_and_naive_timestamps():
    past = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 600))
    future = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 600))
    assert _is_expired(past) is True
    assert _is_expired(future) is False
    # A naive stamp is read as UTC rather than local time.
    assert _is_expired(past.rstrip("Z")) is True
    assert _is_expired(future.rstrip("Z")) is False


def test_is_expired_is_lenient_on_unparseable_timestamps():
    """Documented tradeoff: an empty/garbage expiry is NOT treated as expired --
    the unconditional delete in consume() is what bounds the blast radius to a
    single use. The column is TIMESTAMPTZ NOT NULL, so this is a defence in depth
    path, not the normal one."""
    assert _is_expired("") is False
    assert _is_expired("not-a-timestamp") is False


async def test_unparseable_expiry_row_is_still_single_use():
    store, db = _challenges_and_db()
    db.tables[_CHALLENGES] = [
        {"challenge": _CHALLENGE, "ceremony": "registration", "rp_id": _RP, "expires_at": ""}
    ]
    assert await store.consume(_CHALLENGE) is not None  # lenient on the timestamp
    assert await store.consume(_CHALLENGE) is None  # but never twice
    assert db.tables[_CHALLENGES] == []


async def test_concurrent_challenges_are_consumed_independently():
    store, db = _challenges_and_db()
    for value in ("ch-a", "ch-b"):
        await store.save(
            user_id=_UID, challenge=value, ceremony="authentication", rp_id=_RP, ttl_s=300
        )
    assert (await store.consume("ch-a"))["challenge"] == "ch-a"
    # Spending one leaves the other intact.
    assert len(db.tables[_CHALLENGES]) == 1
    assert (await store.consume("ch-b"))["challenge"] == "ch-b"


# --------------------------------------------------------------------------
# WebAuthnCredentialRepo
# --------------------------------------------------------------------------


async def test_add_then_get_by_credential_id_round_trips():
    repo, db = _creds_and_db()
    await repo.add(_credential_row())
    row = await repo.get_by_credential_id("cred-1")
    assert row is not None
    assert row["user_id"] == _UID
    assert row["public_key"] == "cHVibGljLWtleQ"
    assert row["sign_count"] == 0
    assert row["rp_id"] == _RP
    assert len(db.tables[_CREDENTIALS]) == 1


async def test_add_drops_none_columns():
    repo, db = _creds_and_db()
    await repo.add(_credential_row(aaguid=None))
    stored = db.tables[_CREDENTIALS][0]
    # None is omitted so the DB default / NULL applies instead of a literal None.
    assert "device_label" not in stored
    assert "aaguid" not in stored
    assert stored["backed_up"] is True  # falsy-but-not-None values survive
    await repo.add(_credential_row(credential_id="cred-2", backed_up=False, sign_count=0))
    assert db.tables[_CREDENTIALS][1]["backed_up"] is False
    assert db.tables[_CREDENTIALS][1]["sign_count"] == 0


async def test_get_by_credential_id_missing_returns_none():
    repo, _ = _creds_and_db()
    assert await repo.get_by_credential_id("ghost") is None
    await repo.add(_credential_row())
    assert await repo.get_by_credential_id("ghost") is None


async def test_list_by_user_is_scoped_and_omits_the_public_key():
    repo, _ = _creds_and_db()
    await repo.add(_credential_row(credential_id="cred-1"))
    await repo.add(_credential_row(credential_id="cred-2", device_label="Titan"))
    await repo.add(_credential_row(credential_id="cred-3", user_id=_OTHER_UID))
    rows = await repo.list_by_user(_UID)
    assert {r["credential_id"] for r in rows} == {"cred-1", "cred-2"}
    # Projected column list -- exclude_credentials only needs the ids/metadata.
    assert all("public_key" not in r for r in rows)
    assert all("user_id" not in r for r in rows)
    assert await repo.list_by_user("nobody") == []


async def test_update_sign_count_advances_only_the_target_credential():
    repo, db = _creds_and_db()
    await repo.add(_credential_row(credential_id="cred-1", sign_count=4))
    await repo.add(_credential_row(credential_id="cred-2", sign_count=9))
    await repo.update_sign_count("cred-1", sign_count=5, last_used_at="2026-08-03T00:00:00Z")
    updated = await repo.get_by_credential_id("cred-1")
    assert updated is not None
    assert updated["sign_count"] == 5
    assert updated["last_used_at"] == "2026-08-03T00:00:00Z"
    untouched = await repo.get_by_credential_id("cred-2")
    assert untouched is not None
    assert untouched["sign_count"] == 9
    assert "last_used_at" not in untouched
    assert len(db.tables[_CREDENTIALS]) == 2


async def test_update_sign_count_persists_what_it_is_given():
    """The repo is a writer, not a judge: cloned-authenticator detection (sign_count
    regression) happens in py_webauthn via ``credential_current_sign_count`` before
    this is ever called, so the store must record the verified value verbatim --
    including the legitimate 0/0 case authenticators that do not count report."""
    repo, _ = _creds_and_db()
    await repo.add(_credential_row(sign_count=0))
    await repo.update_sign_count("cred-1", sign_count=0, last_used_at="2026-08-03T00:00:00Z")
    row = await repo.get_by_credential_id("cred-1")
    assert row is not None and row["sign_count"] == 0
    await repo.update_sign_count("cred-1", sign_count=12, last_used_at="2026-08-03T00:01:00Z")
    row = await repo.get_by_credential_id("cred-1")
    assert row is not None and row["sign_count"] == 12


async def test_update_sign_count_for_unknown_credential_is_a_noop():
    repo, db = _creds_and_db()
    await repo.add(_credential_row(sign_count=4))
    await repo.update_sign_count("ghost", sign_count=99, last_used_at="2026-08-03T00:00:00Z")
    row = await repo.get_by_credential_id("cred-1")
    assert row is not None and row["sign_count"] == 4
    assert len(db.tables[_CREDENTIALS]) == 1


async def test_repos_share_no_state_between_tables():
    db = FakeDB()
    creds = WebAuthnCredentialRepo(client=db)
    store = WebAuthnChallengeStore(client=db)
    await creds.add(_credential_row())
    await store.save(
        user_id=_UID, challenge=_CHALLENGE, ceremony="registration", rp_id=_RP, ttl_s=300
    )
    # Consuming a challenge never disturbs the credential store.
    assert await store.consume(_CHALLENGE) is not None
    assert db.tables[_CHALLENGES] == []
    assert len(db.tables[_CREDENTIALS]) == 1
    assert await creds.get_by_credential_id("cred-1") is not None
