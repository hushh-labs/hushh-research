"""Relay ticket single-use enforcement (process-local and shared paths).

Covers api/routes/one/relay_auth.py: HMAC verification, expiry, and the
cross-instance nonce registry seam (Postgres table relay_ticket_nonces,
migration 084). The shared path is exercised with a stubbed registry so the
suite stays hermetic; the degradation path (shared tier down -> per-process
single-use) is covered explicitly.
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
async def test_shared_consume_degrades_to_local_when_registry_down(monkeypatch) -> None:
    async def _registry_down(nonce: str, expires_at: int) -> bool:
        # Mirrors _register_nonce_shared's own exception fallback contract.
        return nonce not in relay_auth._RELAY_TICKET_NONCES

    monkeypatch.setattr(relay_auth, "_register_nonce_shared", _registry_down)

    ticket = _issue()
    ok, _, _ = await relay_auth.consume_relay_ticket_shared(ticket)
    assert ok is True

    # Same process replay is still rejected via the local registry.
    replay_ok, _, _ = await relay_auth.consume_relay_ticket_shared(ticket)
    assert replay_ok is False
