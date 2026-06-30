from hushh_mcp.agents.location.tools import (
    CONTROL_PLANE_LOCATION_TOOLS,
    V2_LOCATION_TOOLS,
    approve_location_request,
    create_location_share,
    deny_location_request,
    list_active_location_shares,
    list_incoming_location_shares,
    list_location_recipients,
    list_public_links,
    propose_location_view,
    propose_public_link,
    publish_location_envelope,
    refer_location_recipient,
    request_location_access,
    revoke_location_share,
    revoke_public_link,
    view_location_envelope,
)


def test_control_plane_is_exactly_the_safe_read_and_control_tools():
    assert set(CONTROL_PLANE_LOCATION_TOOLS) == {
        list_location_recipients,
        list_active_location_shares,
        revoke_location_share,
        request_location_access,
        deny_location_request,
        refer_location_recipient,
    }


def test_control_plane_excludes_crypto_handoff_tools():
    for tool in (
        create_location_share,
        publish_location_envelope,
        view_location_envelope,
        approve_location_request,
    ):
        assert tool not in CONTROL_PLANE_LOCATION_TOOLS


def test_v2_allowlist_adds_prep_and_handoff_tools_but_not_raw_envelope_tools():
    # prep-and-handoff + new read/intent/control tools are present
    for tool in (
        create_location_share,
        approve_location_request,
        list_incoming_location_shares,
        list_public_links,
        propose_public_link,
        propose_location_view,
        revoke_public_link,
    ):
        assert tool in V2_LOCATION_TOOLS

    # the impossible-server-side envelope tools are NEVER LLM-callable
    assert publish_location_envelope not in V2_LOCATION_TOOLS
    assert view_location_envelope not in V2_LOCATION_TOOLS
