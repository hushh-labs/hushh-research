"""Scripted pool and identity service for the Calendar organizer-resolution tests.

They stand in for Postgres and Firebase so the decision logic can be proven
without either; the Postgres flow suite proves the real SQL separately.
"""

import asyncio

ORGANIZER = "organizer@example.test"


class Script:
    def __init__(
        self, *, organizer=(), refresh=(), alias_verified=False, fail_fetch=None, pending=()
    ):
        self.organizer = list(organizer)  # one result per organizer query, in order
        self.refresh = refresh
        self.pending = list(pending)  # one verdict per pending-request lookup, in order
        self.pending_refresh = ()
        self.pending_queries = 0
        self.alias_verified = alias_verified
        self.fail_fetch = fail_fetch
        self.organizer_queries = 0
        self.refresh_args = None
        self.refresh_rounds = 0
        self.evidence = {"active_peers": 0, "unproven_peers": 0, "same_mailbox_other_domain": 0}


class FakeConnection:
    def __init__(self, script):
        self.script = script

    async def fetch(self, sql, *args, timeout=None):
        if self.script.fail_fetch:
            raise self.script.fail_fetch
        if "make_interval" in sql:
            # The real query skips peers already tried in this resolution ($4).
            tried, limit = set(args[3]), args[2]
            if "connection_requests" in sql:
                pending = [p for p in self.script.pending_refresh if p not in tried]
                return [{"peer": peer} for peer in pending[:limit]]
            self.script.refresh_args = args
            self.script.refresh_rounds += 1
            fresh = [p for p in self.script.refresh if p not in tried]
            return [{"peer": peer} for peer in fresh[:limit]]
        if "active_peers" in sql:
            return [self.script.evidence]
        self.script.organizer_queries += 1
        index = min(self.script.organizer_queries, len(self.script.organizer)) - 1
        return [{"peer": peer} for peer in self.script.organizer[index]]

    async def fetchval(self, sql, *args, timeout=None):
        if "connection_requests" in sql:
            self.script.pending_queries += 1
            index = min(self.script.pending_queries, len(self.script.pending)) - 1
            return bool(self.script.pending[index]) if self.script.pending else False
        return self.script.alias_verified


class FakePool:
    def __init__(self, script):
        self.script = script

    def acquire(self):
        script = self.script

        class Context:
            async def __aenter__(self):
                return FakeConnection(script)

            async def __aexit__(self, *exc):
                return False

        return Context()


class FakeIdentity:
    """Scripted Firebase refresh keyed by peer; an Exception value is raised."""

    results: dict = {}
    calls: list = []
    hang = False

    async def sync_from_firebase(self, peer, *, force=False, require_success=False):
        assert force is True and require_success is True
        type(self).calls.append(peer)
        if type(self).hang and peer.startswith("stale"):
            await asyncio.sleep(10)
        value = type(self).results.get(peer, {"email": ORGANIZER, "email_verified": True})
        if isinstance(value, Exception):
            raise value
        return value
