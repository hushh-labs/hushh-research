"""Resilience tests for OneLocationAgentService.list_state.

These are hermetic: they stub the low-level DB executors so no database is
required. They lock in the guarantee that a single failing/drifted section query
degrades to an empty list instead of 500-ing the whole /api/one/location/state
endpoint (which previously cascaded into empty consent-center tabs and a broken
One Location page).
"""

from __future__ import annotations

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


class _PartialFailureService(OneLocationAgentService):
    """Service whose received_grants query raises, all others return empty."""

    def __init__(self) -> None:
        self.section_calls: list[str] = []

    # Housekeeping + recommendations are no-ops / empty in this harness.
    def _expire_stale_grants(self, user_id: str) -> None:  # noqa: ARG002
        return None

    def list_verified_recipients(self, *, owner_user_id: str, limit: int = 50):  # noqa: ARG002
        return []

    def _execute_many(self, sql: str, params=None):  # noqa: ARG002
        # The received_grants section selects "o.display_name AS owner_display_name".
        if "owner_display_name" in sql:
            raise RuntimeError("simulated schema drift on received_grants join")
        return []


class _RecipientsFailureService(OneLocationAgentService):
    """Service whose recipients lookup raises; sections return empty."""

    def _expire_stale_grants(self, user_id: str) -> None:  # noqa: ARG002
        return None

    def list_verified_recipients(self, *, owner_user_id: str, limit: int = 50):  # noqa: ARG002
        raise RuntimeError("simulated recipients failure")

    def _execute_many(self, sql: str, params=None):  # noqa: ARG002
        return []


def test_list_state_degrades_when_one_section_fails():
    state = _PartialFailureService().list_state(user_id="user_a")
    # The endpoint must still return a well-formed payload (no exception).
    assert isinstance(state, dict)
    # The failing section degrades to an empty list...
    assert state["receivedGrants"] == []
    # ...while the rest of the contract is intact.
    for key in (
        "recipients",
        "ownerGrants",
        "requests",
        "referrals",
        "publicInvites",
        "circleInvites",
        "networkConnections",
        "publicInviteSubmissions",
        "capabilityScopes",
    ):
        assert key in state


def test_list_state_degrades_when_recipients_fail():
    state = _RecipientsFailureService().list_state(user_id="user_a")
    assert isinstance(state, dict)
    assert state["recipients"] == []
    # Capability scopes are always present so the client can render.
    assert "capabilityScopes" in state


def test_list_state_raises_nothing_for_clean_empty_user():
    class _EmptyService(OneLocationAgentService):
        def _expire_stale_grants(self, user_id: str) -> None:  # noqa: ARG002
            return None

        def list_verified_recipients(self, *, owner_user_id: str, limit: int = 50):  # noqa: ARG002
            return []

        def _execute_many(self, sql: str, params=None):  # noqa: ARG002
            return []

    state = _EmptyService().list_state(user_id="user_a")
    assert state["ownerGrants"] == []
    assert state["receivedGrants"] == []
    assert state["requests"] == []


def test_list_state_network_connections_sourced_from_trusted():
    """networkConnections must be sourced from trusted_connections, not the legacy table."""

    class _TrustedConnectionsService(OneLocationAgentService):
        def _expire_stale_grants(self, user_id: str) -> None:  # noqa: ARG002
            return None

        def list_verified_recipients(self, *, owner_user_id: str, limit: int = 50):  # noqa: ARG002
            return []

        def _execute_many(self, sql: str, params=None):  # noqa: ARG002
            if "trusted_connections" in sql:
                return [
                    {
                        "id": "e1",
                        "owner_user_id": "owner",
                        "trusted_user_id": "friend",
                        "status": "active",
                        "created_at": None,
                        "updated_at": None,
                        "revoked_at": None,
                    }
                ]
            return []

    state = _TrustedConnectionsService().list_state(user_id="owner")
    conns = state["networkConnections"]
    assert conns, "networkConnections must be non-empty when trusted_connections returns a row"
    assert conns[0]["userAId"] == "owner"
    assert conns[0]["userBId"] == "friend"
    assert conns[0]["status"] == "active"
