"""Relay ticket single-use enforcement (process-local and shared paths).

Covers api/routes/one/relay_auth.py: HMAC verification, expiry, and the
cross-instance nonce registry seam (Postgres table relay_ticket_nonces,
migration 084). The shared path is exercised with a stubbed registry so the
suite stays hermetic; shared-tier failure refuses consumption rather than
admitting a replay on another process.
"""

from __future__ import annotations

import pytest

from api.routes.one import relay_auth


@pytest.fixture(autouse=True)
def _clean_registries():
    relay_auth._RELAY_TICKETS.clear()
    relay_auth._RELAY_TICKET_NONCES.clear()
    yield
    relay_auth._RELAY_TICKETS.clear()
    relay_auth._RELAY_TICKET_NONCES.clear()


def _issue() -> str:
    ticket, _expires_at = relay_auth.issue_relay_ticket("uid_relay", "signed_locked")
    return ticket


def test_local_consume_accepts_then_rejects_replay() -> None:
    ticket = _issue()
    ok, uid, tier = relay_auth.consume_relay_ticket(ticket)
    assert ok is True
    assert uid == "uid_relay"
    assert tier == "signed_locked"

    replay_ok, _, _ = relay_auth.consume_relay_ticket(ticket)
    assert replay_ok is False


def test_local_consume_rejects_tampered_ticket() -> None:
    ticket = _issue()
    if ticket.startswith("v1."):
        tampered = ticket[:-4] + ("aaaa" if not ticket.endswith("aaaa") else "bbbb")
        ok, _, _ = relay_auth.consume_relay_ticket(tampered)
        assert ok is False


@pytest.mark.asyncio
async def test_shared_consume_registers_nonce_and_blocks_replay(monkeypatch) -> None:
    registry: dict[str, int] = {}

    async def _fake_register(nonce: str, expires_at: int) -> bool:
        if nonce in registry:
            return False
        registry[nonce] = expires_at
        return True

    monkeypatch.setattr(relay_auth, "_register_nonce_shared", _fake_register)

    ticket = _issue()
    ok, uid, _tier = await relay_auth.consume_relay_ticket_shared(ticket)
    assert ok is True
    assert uid == "uid_relay"
    assert len(registry) == 1

    # Simulate the same signed ticket arriving on ANOTHER process: local
    # registry empty, shared registry already holds the nonce.
    relay_auth._RELAY_TICKET_NONCES.clear()
    replay_ok, _, _ = await relay_auth.consume_relay_ticket_shared(ticket)
    assert replay_ok is False


@pytest.mark.asyncio
async def test_shared_consume_refuses_all_instances_when_registry_down(monkeypatch) -> None:
    from db import connection

    async def unavailable():
        raise RuntimeError("synthetic private provider error")

    monkeypatch.setattr(connection, "get_pool", unavailable)
    monkeypatch.setattr(relay_auth, "_relay_ticket_secret", lambda: "synthetic-signing-key")
    ticket = _issue()
    for _ in range(2):
        relay_auth._RELAY_TICKET_NONCES.clear()
        ok, uid, _ = await relay_auth.consume_relay_ticket_shared(ticket)
        assert not ok
        assert uid is None


async def test_expiry_during_shared_registration_does_not_admit(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace

    monkeypatch.setattr(relay_auth, "_relay_ticket_secret", lambda: "synthetic-signing-key")

    async def delayed(nonce, expires_at):
        monkeypatch.setattr(
            relay_auth,
            "datetime",
            SimpleNamespace(
                now=lambda **kwargs: datetime.fromtimestamp(expires_at + 1, tz=timezone.utc)
            ),
        )
        return True

    monkeypatch.setattr(relay_auth, "_register_nonce_shared", delayed)
    ticket = _issue()
    ok, uid, _ = await relay_auth.consume_relay_ticket_shared(ticket)
    assert not ok
    assert uid is None
    assert relay_auth._RELAY_TICKET_NONCES  # Acknowledged use stays consumed.


@pytest.mark.parametrize("failure", ["prune", "lost_insert_ack"])
async def test_committed_nonce_stays_unusable_after_database_failure(monkeypatch, failure):
    from contextlib import asynccontextmanager

    from db import connection

    committed = set()

    class Connection:
        async def execute(self, sql, *args):
            if sql.startswith("INSERT"):
                nonce = args[0]
                if nonce in committed:
                    return "INSERT 0 0"
                committed.add(nonce)
                if failure == "lost_insert_ack":
                    raise ConnectionError("synthetic lost acknowledgement")
                return "INSERT 0 1"
            if failure == "prune":
                raise ConnectionError("synthetic cleanup unavailable")
            return "DELETE 0"

    class Pool:
        @asynccontextmanager
        async def acquire(self):
            yield Connection()

    async def pool():
        return Pool()

    monkeypatch.setattr(connection, "get_pool", pool)
    monkeypatch.setattr(relay_auth, "_relay_ticket_secret", lambda: "synthetic-signing-key")
    ticket = _issue()
    for _ in range(2):
        relay_auth._RELAY_TICKET_NONCES.clear()  # Another worker has no local history.
        ok, uid, _ = await relay_auth.consume_relay_ticket_shared(ticket)
        assert not ok
        assert uid is None
    assert len(committed) == 1
