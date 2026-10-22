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


def test_portraits_follow_the_viewer_directory_gate_and_never_expose_other_fields(monkeypatch):
    read = Mock(
        return_value=[
            {
                "userId": "peer",
                "displayName": "Priya Rao",
                "photoUrl": "data:image/png;base64,YQ==",
                "maskedPhone": "private",
            },
            {
                "userId": "outside",
                "displayName": "Other person",
                "photoUrl": "https://example.test/private.png",
            },
            {
                "userId": "technical",
                "displayName": "technical",
                "photoUrl": "https://example.test/hidden.png",
            },
        ]
    )
    monkeypatch.setattr(identities, "_directory_profiles", read)
    assert identities.get_leaderboard_profiles(["peer", "technical"], viewer_user_id="viewer") == {
        "peer": {"display_name": "Priya Rao", "photo_url": "data:image/png;base64,YQ=="},
    }
    read.assert_called_once_with("viewer", ["peer", "technical"])


def test_own_portrait_uses_the_existing_owner_profile_projection(monkeypatch):
    monkeypatch.setattr(
        identities,
        "_own_profile",
        lambda uid: {
            "display_name": "Meera Shah",
            "photo_url": "https://example.test/me.png",
            "email": "private@example.test",
        },
    )
    assert identities.get_leaderboard_profiles(["viewer"], viewer_user_id="viewer") == {
        "viewer": {"display_name": "Meera Shah", "photo_url": "https://example.test/me.png"},
    }


def test_unavailable_or_oversized_portraits_are_omitted(monkeypatch):
    monkeypatch.setattr(
        identities,
        "_directory_profiles",
        lambda *args: [
            {"userId": "peer", "displayName": "Priya Rao", "photoUrl": "x" * 600_001},
        ],
    )
    assert identities.get_leaderboard_profiles(["peer"], viewer_user_id="viewer") == {
        "peer": {"display_name": "Priya Rao", "photo_url": None},
    }
