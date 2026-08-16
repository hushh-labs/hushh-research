from hushh_mcp.one_adk.specialist_availability import (
    resolve_specialist_availability,
    specialist_label,
)


def _resolve(agent_id: str, voice_context: dict | None = None, **overrides):
    defaults = {
        "agent_id": agent_id,
        "user_id": "u1",
        "consent_token": "t1",
        "voice_context": voice_context or {},
    }
    defaults.update(overrides)
    return resolve_specialist_availability(**defaults)


class TestDomainDisabled:
    def test_refuses_a_specialist_whose_domain_the_user_turned_off(self):
        availability = _resolve(
            "agent_location",
            {"voice_settings": {"disabled_domains": ["location"]}},
        )
        assert availability.state == "domain_disabled"
        assert availability.reason_code == "voice_domain_disabled_by_user"

    def test_allows_a_specialist_whose_domain_is_not_restricted(self):
        availability = _resolve(
            "agent_location",
            {"voice_settings": {"disabled_domains": ["kyc"]}},
        )
        assert availability.state == "ready"

    def test_allows_when_voice_settings_are_entirely_absent(self):
        # Fail open: no voice_settings key at all (a non-live caller, or an
        # older client) must never read as a restriction.
        availability = _resolve("agent_location", {})
        assert availability.state == "ready"

    def test_restriction_covers_every_domain_backed_specialist(self):
        for agent_id, domain in (
            ("agent_location", "location"),
            ("agent_email", "email"),
            ("agent_connected_systems", "connected_systems"),
            ("agent_nav", "consent"),
            ("agent_connections", "connections"),
        ):
            availability = _resolve(
                agent_id,
                {"voice_settings": {"disabled_domains": [domain]}},
                # agent_connected_systems and agent_connections would otherwise
                # resolve authority_required/route_not_admitted first; the
                # restriction must win regardless of what state would follow.
                user_id="",
                consent_token="",
            )
            assert availability.state == "domain_disabled", agent_id

    def test_malformed_voice_settings_never_restrict(self):
        availability = _resolve("agent_location", {"voice_settings": "not-a-dict"})
        assert availability.state == "ready"


def test_specialist_label_covers_every_domain_backed_specialist():
    for agent_id, expected in (
        ("agent_location", "Location"),
        ("agent_email", "Email"),
        ("agent_connected_systems", "Connected Systems"),
        ("agent_nav", "Consent Center"),
        ("agent_connections", "Connections"),
    ):
        assert specialist_label(agent_id) == expected
