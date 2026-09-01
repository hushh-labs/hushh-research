from hushh_mcp.agents.location.tools import (
    V2_LOCATION_TOOLS,
    list_incoming_location_shares,
    list_public_links,
    propose_location_view,
    propose_public_link,
    refer_location_recipient,
    request_confirmation,
    request_device_location_permission,
    request_incoming_choice,
    revoke_public_link,
)


def test_location_tools_are_exactly_the_capabilities_with_no_generated_action():
    # Sharing, requesting, revoking, approving, denying, circles, SOS, and
    # check-in all run directly from One's own generated actions and never
    # reach this agent -- it only carries the tools nothing else can do.
    assert set(V2_LOCATION_TOOLS) == {
        list_incoming_location_shares,
        list_public_links,
        propose_public_link,
        propose_location_view,
        revoke_public_link,
        request_device_location_permission,
        refer_location_recipient,
        request_incoming_choice,
        request_confirmation,
    }
