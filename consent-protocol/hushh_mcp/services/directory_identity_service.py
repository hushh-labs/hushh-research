"""Current auth-account eligibility for the public people directory."""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence

from firebase_admin import auth

from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.requester_identity import label_from_identity_row

logger = logging.getLogger(__name__)

_STATUS_TTL_SECONDS = 60.0
_STATUS_CACHE_MAX_ENTRIES = 4096
_STATUS_CACHE: OrderedDict[tuple[str, str, str], tuple[float, bool]] = OrderedDict()
_STATUS_CACHE_LOCK = threading.Lock()


class DirectoryIdentityUnavailableError(RuntimeError):
    """The directory cannot verify whether an account still exists."""

    code = "DIRECTORY_IDENTITY_UNAVAILABLE"
    message = "People search is temporarily unavailable. Try again."
    status_code = 503

    def __init__(self) -> None:
        super().__init__(self.message)


def active_directory_user_ids(user_ids: Sequence[str]) -> set[str]:
    """Return enabled Firebase accounts, without retaining their private records.

    A profile cache can outlive a Firebase account deleted and recreated before
    the tombstone contract shipped. Names, verified email and a database
    ``active`` status cannot prove that the old UID remains an account.
    Firebase's bounded batch lookup is the lifecycle authority; only its boolean
    result is cached, for at most one minute and within this app/project.
    """
    candidates = list(dict.fromkeys(uid for uid in user_ids if uid.strip() and len(uid) <= 128))
    if not candidates:
        return set()
    try:
        app = get_firebase_auth_app()
        if app is None:
            raise DirectoryIdentityUnavailableError()
        scope = (str(app.project_id or ""), str(app.name))
        now = time.monotonic()
        status: dict[str, bool] = {}
        with _STATUS_CACHE_LOCK:
            for uid in candidates:
                cached = _STATUS_CACHE.get((*scope, uid))
                if cached and cached[0] > now:
                    status[uid] = cached[1]
                    _STATUS_CACHE.move_to_end((*scope, uid))
                elif cached:
                    del _STATUS_CACHE[(*scope, uid)]

        missing = [uid for uid in candidates if uid not in status]
        for offset in range(0, len(missing), 100):
            batch = missing[offset : offset + 100]
            result = auth.get_users([auth.UidIdentifier(uid) for uid in batch], app=app)
            # Firebase does not preserve request order. Associate each record
            # with its own UID, never with a positional neighbour's name/photo.
            enabled = {record.uid for record in result.users if not record.disabled}
            expires_at = time.monotonic() + _STATUS_TTL_SECONDS
            with _STATUS_CACHE_LOCK:
                for uid in batch:
                    status[uid] = uid in enabled
                    _STATUS_CACHE[(*scope, uid)] = (expires_at, status[uid])
                    _STATUS_CACHE.move_to_end((*scope, uid))
                while len(_STATUS_CACHE) > _STATUS_CACHE_MAX_ENTRIES:
                    _STATUS_CACHE.popitem(last=False)
        return {uid for uid, enabled in status.items() if enabled}
    except DirectoryIdentityUnavailableError:
        raise
    except Exception as exc:
        # Provider errors may contain submitted UIDs. Log only the class and
        # never substitute cached/SQL eligibility after an unverified lookup.
        logger.warning("directory.identity_unavailable error=%s", type(exc).__name__)
        raise DirectoryIdentityUnavailableError() from None


def directory_auth_profiles(user_ids: Sequence[str]) -> dict[str, dict[str, str]]:
    """Read public names/photos missing from legacy cache rows, by their UID.

    No provider record, email or phone is cached or returned. The projection is
    only a fallback for an otherwise unnamed profile, and never replaces a
    person's custom profile photo.
    """
    candidates = list(dict.fromkeys(uid for uid in user_ids if uid.strip() and len(uid) <= 128))
    if not candidates:
        return {}
    try:
        app = get_firebase_auth_app()
        if app is None:
            raise DirectoryIdentityUnavailableError()
        profiles: dict[str, dict[str, str]] = {}
        for offset in range(0, len(candidates), 100):
            batch = candidates[offset : offset + 100]
            result = auth.get_users([auth.UidIdentifier(uid) for uid in batch], app=app)
            for record in result.users:
                if record.disabled:
                    continue
                sources = [record, *(record.provider_data or [])]
                name = next(
                    (
                        label
                        for source in sources
                        if (
                            label := label_from_identity_row(
                                {"user_id": record.uid, "display_name": source.display_name},
                                allow_email_handle=False,
                            )
                        )
                    ),
                    "",
                )
                if name:
                    photo = next(
                        (str(source.photo_url).strip() for source in sources if source.photo_url),
                        "",
                    )
                    profiles[record.uid] = {"display_name": name, "photo_url": photo}
        return profiles
    except DirectoryIdentityUnavailableError:
        raise
    except Exception as exc:
        logger.warning("directory.identity_unavailable error=%s", type(exc).__name__)
        raise DirectoryIdentityUnavailableError() from None
