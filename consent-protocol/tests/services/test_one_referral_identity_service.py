from unittest.mock import Mock

from hushh_mcp.services import one_referral_identity_service as identities


def test_names_use_viewer_scoped_directory_and_omit_private_or_unknown_fields(monkeypatch):
    read = Mock(
        return_value=[
            {"userId": "peer", "displayName": "Priya Rao", "maskedPhone": "private"},
            {"userId": "hidden", "displayName": "Hidden account"},
            {"userId": "technical", "displayName": "technical"},
        ]
    )
    monkeypatch.setattr(identities, "_directory_profiles", read)
    assert identities.get_leaderboard_display_names(
        ["peer", "technical"], viewer_user_id="viewer"
    ) == {"peer": "Priya Rao"}
    read.assert_called_once_with("viewer", ["peer", "technical"])


def test_own_name_is_read_separately_because_directory_excludes_the_viewer(monkeypatch):
    peers = Mock(return_value=[])
    monkeypatch.setattr(identities, "_directory_profiles", peers)
    monkeypatch.setattr(identities, "_own_profile", lambda uid: {"display_name": "Meera Shah"})
    assert identities.get_leaderboard_display_names(["viewer"], viewer_user_id="viewer") == {
        "viewer": "Meera Shah"
    }
    peers.assert_not_called()


def test_provider_failure_keeps_anonymity_without_email_fallback(monkeypatch):
    monkeypatch.setattr(
        identities, "_directory_profiles", Mock(side_effect=RuntimeError("offline"))
    )
    monkeypatch.setattr(identities, "_own_profile", lambda uid: {"email": "private@example.com"})
    assert (
        identities.get_leaderboard_display_names(["peer", "viewer"], viewer_user_id="viewer") == {}
    )


def test_without_a_viewer_no_identity_lookup_is_allowed(monkeypatch):
    read = Mock()
    monkeypatch.setattr(identities, "_directory_profiles", read)
    assert identities.get_leaderboard_display_names(["peer"], viewer_user_id=None) == {}
    read.assert_not_called()
