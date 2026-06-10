import time

from hushh_mcp.trust.link import create_trust_link, verify_trust_link
from hushh_mcp.types import ConsentScope, TrustLink


class TestSessionBoundHMAC:
    def test_valid_link_verifies(self):
        link = create_trust_link(
            from_agent="agent-a",
            to_agent="agent-b",
            scope=ConsentScope.WORLD_MODEL_READ,
            signed_by_user="user-1",
            session_id="session-stream-a",
        )
        assert verify_trust_link(link) is True

    def test_cross_stream_replay_rejected(self):
        link_a = create_trust_link(
            from_agent="agent-a",
            to_agent="agent-b",
            scope=ConsentScope.WORLD_MODEL_READ,
            signed_by_user="user-1",
            session_id="session-stream-a",
        )
        replayed = TrustLink(
            from_agent=link_a.from_agent,
            to_agent=link_a.to_agent,
            scope=link_a.scope,
            created_at=link_a.created_at,
            expires_at=link_a.expires_at,
            signed_by_user=link_a.signed_by_user,
            signature=link_a.signature,
            session_id="session-stream-b",
        )
        assert verify_trust_link(replayed) is False

    def test_different_sessions_produce_different_signatures(self):
        link_a = create_trust_link(
            from_agent="agent-x",
            to_agent="agent-y",
            scope=ConsentScope.WORLD_MODEL_READ,
            signed_by_user="user-2",
            session_id="session-111",
        )
        link_b = create_trust_link(
            from_agent="agent-x",
            to_agent="agent-y",
            scope=ConsentScope.WORLD_MODEL_READ,
            signed_by_user="user-2",
            session_id="session-222",
        )
        assert link_a.signature != link_b.signature

    def test_expired_link_rejected(self):
        link = create_trust_link(
            from_agent="agent-a",
            to_agent="agent-b",
            scope=ConsentScope.WORLD_MODEL_READ,
            signed_by_user="user-1",
            session_id="session-abc",
            expires_in_ms=1,
        )
        link.expires_at = int(time.time() * 1000) - 10000
        assert verify_trust_link(link) is False

    def test_empty_session_id_backward_compatible(self):
        link = create_trust_link(
            from_agent="agent-a",
            to_agent="agent-b",
            scope=ConsentScope.WORLD_MODEL_READ,
            signed_by_user="user-1",
            session_id="",
        )
        assert verify_trust_link(link) is True
