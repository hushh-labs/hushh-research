from hushh_mcp.one_adk.voice_domain_policy import (
    VOICE_DOMAIN_ACTION_PREFIXES,
    VOICE_DOMAIN_SPECIALIST_IDS,
    is_voice_domain_disabled,
    resolve_voice_domain,
    resolve_voice_domain_for_specialist,
    voice_domain_label,
)


class TestResolveVoiceDomain:
    def test_maps_a_real_action_id_to_its_domain(self):
        assert resolve_voice_domain("location.pause_updates") == "location"
        assert resolve_voice_domain("kyc.draft.approve_send") == "kyc"

    def test_returns_none_for_a_domain_with_no_voice_toggle(self):
        # "connect" (Discovery) and "route" (navigation) are real prefixes but
        # neither is a voice-scoped domain -- never restrictable.
        assert resolve_voice_domain("connect.search_people") is None
        assert resolve_voice_domain("route.profile") is None
        assert resolve_voice_domain("analysis.start") is None

    def test_returns_none_for_finance_and_calendar(self):
        # Neither routes through a choke point this server can gate on.
        assert resolve_voice_domain("kai.setup.answer_horizon") is None
        assert resolve_voice_domain("setup.connect_calendar") is None

    def test_returns_none_for_empty_or_malformed_input(self):
        assert resolve_voice_domain("") is None
        assert resolve_voice_domain(None) is None
        assert resolve_voice_domain("no_dot_at_all") is None


class TestResolveVoiceDomainForSpecialist:
    def test_maps_a_real_specialist_agent_id(self):
        assert resolve_voice_domain_for_specialist("agent_location") == "location"
        assert resolve_voice_domain_for_specialist("agent_nav") == "consent"
        assert resolve_voice_domain_for_specialist("agent_connections") == "connections"

    def test_returns_none_for_an_unmapped_agent(self):
        assert resolve_voice_domain_for_specialist("agent_kai") is None
        assert resolve_voice_domain_for_specialist("agent_nonexistent") is None
        assert resolve_voice_domain_for_specialist(None) is None

    def test_kyc_has_no_conversational_specialist(self):
        # KYC is an in-app workflow, never a direct ask_* tool -- it is
        # action-gateway-only, so it must map no agent_id at all.
        assert VOICE_DOMAIN_SPECIALIST_IDS["kyc"] == frozenset()


class TestIsVoiceDomainDisabled:
    def test_true_only_when_the_domain_is_in_the_list(self):
        assert is_voice_domain_disabled("location", ["location", "kyc"]) is True
        assert is_voice_domain_disabled("email", ["location", "kyc"]) is False

    def test_false_when_domain_is_none(self):
        assert is_voice_domain_disabled(None, ["location"]) is False

    def test_false_when_disabled_domains_is_malformed(self):
        assert is_voice_domain_disabled("location", "location") is False
        assert is_voice_domain_disabled("location", None) is False
        assert is_voice_domain_disabled("location", 7) is False

    def test_true_with_a_set_or_tuple_too(self):
        assert is_voice_domain_disabled("location", {"location"}) is True
        assert is_voice_domain_disabled("location", ("location",)) is True


class TestVoiceDomainLabel:
    def test_known_domains_get_a_human_label(self):
        assert voice_domain_label("connected_systems") == "Connected Systems"
        assert voice_domain_label("consent") == "Consent Center"

    def test_unknown_domain_falls_back_to_the_raw_key(self):
        assert voice_domain_label("not_a_real_domain") == "not_a_real_domain"


def test_every_enforceable_domain_has_at_least_one_action_prefix():
    for domain, prefixes in VOICE_DOMAIN_ACTION_PREFIXES.items():
        assert prefixes, f"{domain} declares no action-id prefixes"
