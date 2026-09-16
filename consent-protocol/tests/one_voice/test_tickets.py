"""Voice tickets: HMAC, expiry, single use, fail-closed registry."""

from __future__ import annotations

import pytest

from hushh_mcp.one_voice import tickets

CONV = "11111111-2222-4333-8444-555555555555"


class _Registry:
    def __init__(self, *, fail: bool = False):
        self.seen: set[str] = set()
        self.fail = fail

    async def register(self, nonce, expires_at):
        if self.fail:
            raise RuntimeError("db down")
        if nonce in self.seen:
            return False
        self.seen.add(nonce)
        return True


def test_issue_and_parse_round_trip():
    ticket, expires_at = tickets.issue_ticket(user_id="u1", session_id="s1", conversation_id=CONV)
    claims = tickets.parse_ticket(ticket)
    assert claims.user_id == "u1" and claims.session_id == "s1" and claims.conversation_id == CONV
    assert claims.expires_at == expires_at
    assert ticket.startswith("v1.")


@pytest.mark.parametrize("bad", ["", "v1.abc", "v2.a.b", "v1.a.b.c"])
def test_malformed_tickets_are_rejected(bad):
    with pytest.raises(tickets.TicketError):
        tickets.parse_ticket(bad)


def test_tampered_signature_is_rejected():
    ticket, _ = tickets.issue_ticket(user_id="u1", session_id="s1", conversation_id=CONV)
    version, segment, signature = ticket.split(".")
    tampered = f"{version}.{segment}.{signature[:-2]}AA"
    with pytest.raises(tickets.TicketError, match="ticket_signature"):
        tickets.parse_ticket(tampered)


def test_expired_ticket_is_rejected(monkeypatch):
    ticket, _ = tickets.issue_ticket(user_id="u1", session_id="s1", conversation_id=CONV)
    monkeypatch.setattr(tickets, "_now", lambda: 9_999_999_999)
    with pytest.raises(tickets.TicketError, match="ticket_expired"):
        tickets.parse_ticket(ticket)


async def test_consume_is_single_use():
    ticket, _ = tickets.issue_ticket(user_id="u1", session_id="s1", conversation_id=CONV)
    registry = _Registry()
    claims = await tickets.consume_ticket(ticket, registry=registry)
    assert claims.user_id == "u1"
    with pytest.raises(tickets.TicketError, match="ticket_replayed"):
        await tickets.consume_ticket(ticket, registry=registry)


async def test_registry_outage_fails_closed():
    ticket, _ = tickets.issue_ticket(user_id="u1", session_id="s1", conversation_id=CONV)
    with pytest.raises(tickets.TicketError, match="ticket_registry_unavailable"):
        await tickets.consume_ticket(ticket, registry=_Registry(fail=True))


def test_missing_signing_key_refuses_to_mint(monkeypatch):
    monkeypatch.setattr(
        tickets,
        "_secret",
        lambda: (_ for _ in ()).throw(tickets.TicketError("APP_SIGNING_KEY is required")),
    )
    with pytest.raises(tickets.TicketError):
        tickets.issue_ticket(user_id="u1", session_id="s1", conversation_id=CONV)
