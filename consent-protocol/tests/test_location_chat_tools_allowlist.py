from hushh_mcp.agents.location.tools import (
    CONTROL_PLANE_LOCATION_TOOLS,
    approve_location_request,
    create_location_share,
    deny_location_request,
    list_active_location_shares,
    list_location_recipients,
    publish_location_envelope,
    refer_location_recipient,
    request_location_access,
    revoke_location_share,
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
