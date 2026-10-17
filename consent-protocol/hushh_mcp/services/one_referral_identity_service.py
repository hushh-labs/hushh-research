"""Viewer-permitted profile names and portraits for referral standings.

Chosen public aliases retain priority. Other names use Connect's existing
visibility and account-lifecycle checks. Display names are not verified legal names.
"""

import logging
from typing import TypedDict

from hushh_mcp.services.requester_identity import label_from_identity_row

logger = logging.getLogger(__name__)


def _directory_profiles(viewer_user_id: str, user_ids: list[str]) -> list[dict]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().search_directory_candidates(
        owner_user_id=viewer_user_id,
        candidate_user_ids=user_ids,
        limit=len(user_ids),
    )["items"]


def _own_profile(user_id: str) -> dict:
    from hushh_mcp.services.directory_identity_service import directory_auth_profiles

    return directory_auth_profiles([user_id]).get(user_id, {})


class LeaderboardProfile(TypedDict):
    display_name: str
    photo_url: str | None


def _portrait(value: object) -> str | None:
    # The existing directory/account photo contract permits HTTPS and complete
    # uploaded raster data URLs. Preserve that representation without truncation.
    if not isinstance(value, str) or len(value) > 600_000:
        return None
    return value.strip() or None


def get_leaderboard_profiles(
    user_ids: list[str], *, viewer_user_id: str | None
) -> dict[str, LeaderboardProfile]:
    """Resolve this page only; unavailable identities stay anonymous."""
    if not viewer_user_id or not user_ids:
        return {}
    candidates = set(user_ids)
    peers = sorted(candidates - {viewer_user_id})
    profiles: dict[str, LeaderboardProfile] = {}
    try:
        for offset in range(0, len(peers), 100):
            for profile in _directory_profiles(viewer_user_id, peers[offset : offset + 100]):
                uid = str(profile.get("userId") or "")
                if uid in candidates and uid != viewer_user_id:
                    label = label_from_identity_row(
                        {"user_id": uid, "display_name": profile.get("displayName")},
                        allow_email_handle=False,
                    )
                    if label:
                        profiles[uid] = {
                            "display_name": label,
                            "photo_url": _portrait(profile.get("photoUrl")),
                        }
    except Exception as exc:
        # A failed visibility/provider lookup never authorizes a private fallback.
        logger.warning("referral.directory_names_unavailable error=%s", type(exc).__name__)
    if viewer_user_id in candidates:
        try:
            own = _own_profile(viewer_user_id)
            label = label_from_identity_row(
                {**own, "user_id": viewer_user_id}, allow_email_handle=False
            )
            if label:
                profiles[viewer_user_id] = {
                    "display_name": label,
                    "photo_url": _portrait(own.get("photo_url")),
                }
        except Exception as exc:
            logger.warning("referral.own_name_unavailable error=%s", type(exc).__name__)
    return profiles


def get_leaderboard_display_names(
    user_ids: list[str], *, viewer_user_id: str | None
) -> dict[str, str]:
    """Compatibility projection for existing names-only callers."""
    return {
        uid: profile["display_name"]
        for uid, profile in get_leaderboard_profiles(
            user_ids, viewer_user_id=viewer_user_id
        ).items()
    }
