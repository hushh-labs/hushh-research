from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hushh_mcp.services import one_referral_identity_service as identities


@pytest.fixture(autouse=True)
def fresh_firebase_names(monkeypatch):
    monkeypatch.setattr(
        identities,
        "_firebase_profiles",
        lambda ids: {uid: {"display_name": "Priya Rao" if uid == "peer" else uid} for uid in ids},
    )


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
    assert read.call_count == 2
    read.assert_called_with("viewer", ["peer", "technical"])


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
    assert read.call_count == 2
    read.assert_called_with("viewer", ["peer", "technical"])


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


def test_firebase_name_is_current_and_lookup_is_limited_to_permitted_members(monkeypatch):
    monkeypatch.setattr(
        identities,
        "_directory_profiles",
        lambda *args: [
            {"userId": "peer", "displayName": "Stale cached name"},
            {"userId": "outside", "displayName": "Outside"},
        ],
    )
    fresh = Mock(return_value={"peer": {"display_name": "Current Firebase Name"}})
    monkeypatch.setattr(identities, "_firebase_profiles", fresh)
    assert identities.get_leaderboard_display_names(
        ["peer", "private"], viewer_user_id="viewer"
    ) == {"peer": "Current Firebase Name"}
    fresh.assert_called_once_with(["peer"])


def test_missing_firebase_name_does_not_use_cached_or_provider_names(monkeypatch):
    from hushh_mcp.services import directory_identity_service as directory

    monkeypatch.setattr(directory, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(directory, "firebase_uids_for_owner_reads", lambda ids: {"peer": "peer"})
    provider = SimpleNamespace(display_name="Provider Only", photo_url=None)
    record = SimpleNamespace(
        uid="peer", disabled=False, display_name=None, photo_url=None, provider_data=[provider]
    )
    monkeypatch.setattr(
        directory.auth, "get_users", lambda *args, **kwargs: SimpleNamespace(users=[record])
    )
    assert directory.directory_auth_profiles(["peer"], include_provider_names=False) == {}
    assert directory.directory_auth_profiles(["peer"])["peer"]["display_name"] == "Provider Only"


def test_permission_revoked_during_firebase_lookup_never_returns_the_name(monkeypatch):
    permitted = Mock(side_effect=[[{"userId": "peer", "displayName": "Cached Name"}], []])
    monkeypatch.setattr(identities, "_directory_profiles", permitted)
    monkeypatch.setattr(
        identities, "_firebase_profiles", lambda ids: {"peer": {"display_name": "Firebase Name"}}
    )
    assert identities.get_leaderboard_profiles(["peer"], viewer_user_id="viewer") == {}
