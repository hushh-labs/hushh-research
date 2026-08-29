"""The feed metadata allowlist is a privacy boundary, so it gets a test.

`_safe_feed_metadata` decides what crosses from a domain event into the Feed
payload a browser receives. Everything not named is dropped. That default is
the right one -- but it means a genuinely needed field fails *silently*, with
no error anywhere, and the surface simply renders as if the fact did not
exist.

That is exactly what happened to `share_kind`: an emergency SOS reached the
Feed indistinguishable from an ordinary share, and narrated as "shared
location, then stopped", because the one field separating the two lanes was
being filtered out.
"""

from hushh_mcp.services.feed_service import _safe_feed_metadata


class TestFeedMetadataAllowlist:
    def test_share_kind_survives_so_an_sos_can_be_told_from_a_share(self):
        safe = _safe_feed_metadata({"share_kind": "sos"})
        assert safe.get("share_kind") == "sos"

    def test_unknown_keys_are_still_dropped(self):
        # The allowlist earns its keeping only if it still refuses everything
        # it was not asked for -- widening it by one field must not widen the
        # shape.
        safe = _safe_feed_metadata(
            {
                "share_kind": "sos",
                "precise_latitude": 19.076,
                "recipient_email": "someone@example.com",
                "raw_note": "a user-typed sentence",
            }
        )
        assert safe == {"share_kind": "sos"}

    def test_non_dict_input_is_empty_rather_than_an_error(self):
        assert _safe_feed_metadata(None) == {}
        assert _safe_feed_metadata("share_kind=sos") == {}

    def test_values_stay_bounded(self):
        # A domain event is not a trusted length. An over-long string is
        # truncated rather than passed through to every Feed reader.
        safe = _safe_feed_metadata({"counterpart_label": "x" * 5000})
        assert len(safe["counterpart_label"]) < 5000
