from hushh_mcp.services.one_location_agent_service import (
    _classify_share_kind,
    _visible_share_message,
)


def test_drive_to_marker_classifies_as_drive_to():
    assert _classify_share_kind("drive_to") == "drive_to"


def test_drive_to_marker_is_not_shown_as_message():
    # The "drive_to" marker is plumbing, never a human message.
    assert _visible_share_message("drive_to") is None


def test_existing_kinds_unchanged():
    assert _classify_share_kind("sos_panic") == "sos"
    assert _classify_share_kind(None) == "share"
    assert _classify_share_kind("owner_approved") == "share"
    assert _classify_share_kind("On my way!") == "check_in"
