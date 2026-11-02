"""A decline travels with the owner's own words as Google's RSVP comment."""

from hushh_mcp.services.calendar_schedule_service import _patch_with_comment


def test_decline_reason_rides_along_as_the_attendees_rsvp_comment():
    patch = {
        "attendeesOmitted": True,
        "attendees": [{"email": "me@example.com", "responseStatus": "declined"}],
    }
    assert (
        _patch_with_comment(patch, "  other important meeting ")["attendees"][0]["comment"]
        == "other important meeting"
    )
    assert _patch_with_comment(patch, "") is patch
    assert "comment" not in patch["attendees"][0]
