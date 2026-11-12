"""Current auth-account eligibility for the public people directory."""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence

from firebase_admin import auth

from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.connection_graph_service import (
    publish_connection_account_visibility_changes,
)
from hushh_mcp.services.one_owner_admission import firebase_uids_for_owner_reads
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


def active_directory_user_ids(
    user_ids: Sequence[str], *, use_cache: bool = True, notify_connections: bool = True
) -> set[str]:
    """Return enabled Firebase accounts, without retaining their private records.

    A profile cache can outlive a Firebase account deleted and recreated before
    the tombstone contract shipped. Names, verified email and a database
    ``active`` status cannot prove that the old UID remains an account.
    Firebase's bounded batch lookup is the lifecycle authority; only its boolean
    result is cached, for at most one minute and within this app/project.
    Area consent/search passes use_cache=False to require a current batch read.
    """
    candidates = list(dict.fromkeys(uid for uid in user_ids if uid.strip() and len(uid) <= 128))
    if not candidates:
        return set()
    try:
        app = get_firebase_auth_app()
        if app is None:
            raise DirectoryIdentityUnavailableError()
        identities = firebase_uids_for_owner_reads(candidates)
        candidates = [owner for owner in candidates if owner in identities]
        scope = (str(app.project_id or ""), str(app.name))
        now = time.monotonic()
        status: dict[str, bool] = {}
        with _STATUS_CACHE_LOCK:
            for uid in candidates:
                cached = _STATUS_CACHE.get((*scope, uid))
                if use_cache and cached and cached[0] > now:
                    status[uid] = cached[1]
                    _STATUS_CACHE.move_to_end((*scope, uid))

        observed: dict[str, bool] = {}
        missing = [uid for uid in candidates if uid not in status]
        for offset in range(0, len(missing), 100):
            batch = missing[offset : offset + 100]
            result = auth.get_users(
                [
                    auth.UidIdentifier(uid)
                    for uid in dict.fromkeys(identities[owner] for owner in batch)
                ],
                app=app,
            )
            # Firebase does not preserve request order. Associate each record
            # with its own UID, never with a positional neighbour's name/photo.
            provider_status = {record.uid: not record.disabled for record in result.users}
            provider_status.update({identifier.uid: False for identifier in result.not_found})
            for uid in batch:
                identity = identities[uid]
                status[uid] = provider_status.get(identity, False)
                if identity in provider_status:
                    observed[uid] = provider_status[identity]

        changed: set[str] = set()
        expires_at = now + _STATUS_TTL_SECONDS
        with _STATUS_CACHE_LOCK:
            for uid, enabled in observed.items():
                key = (*scope, uid)
                previous = _STATUS_CACHE.get(key)
                if previous and previous[0] > expires_at:
                    status[uid] = previous[1]
                    continue
                if (previous is None and not enabled) or (previous and previous[1] != enabled):
                    changed.add(uid)
                _STATUS_CACHE[key] = (expires_at, enabled)
                _STATUS_CACHE.move_to_end(key)
            while len(_STATUS_CACHE) > _STATUS_CACHE_MAX_ENTRIES:
                _STATUS_CACHE.popitem(last=False)
        if changed and notify_connections:
            try:
                publish_connection_account_visibility_changes(changed)
            except Exception as exc:  # noqa: BLE001 - a lost hint cannot change provider authority
                logger.warning(
                    "directory.connection_visibility_event_failed error=%s", type(exc).__name__
                )
        return {uid for uid, enabled in status.items() if enabled}
    except DirectoryIdentityUnavailableError:
        raise
    except Exception as exc:
        # Provider errors may contain submitted UIDs. Log only the class and
        # never substitute cached/SQL eligibility after an unverified lookup.
        logger.warning("directory.identity_unavailable error=%s", type(exc).__name__)
        raise DirectoryIdentityUnavailableError() from None


def verified_directory_emails(user_ids: Sequence[str]) -> dict[str, str]:
    """Read current verified Firebase emails for exact event-to-person binding.

    The public directory can cache an account's enabled status, but a cached
    email can outlive an email change. Calendar must recheck the current record
    before attaching that person's portrait to an event attendee address.
    """
    candidates = list(dict.fromkeys(uid for uid in user_ids if uid.strip() and len(uid) <= 128))
    if not candidates:
        return {}
    if len(candidates) > 100:
        raise ValueError("Verified directory lookup is limited to 100 people")
    try:
        app = get_firebase_auth_app()
        if app is None:
            raise DirectoryIdentityUnavailableError()
        identities = firebase_uids_for_owner_reads(candidates)
        if not identities:
            return {}
        result = auth.get_users(
            [auth.UidIdentifier(uid) for uid in dict.fromkeys(identities.values())], app=app
        )
        verified = {
            record.uid: str(record.email).strip().lower()
            for record in result.users
            if not record.disabled and record.email_verified and record.email
        }
        return {
            owner: verified[identity_uid]
            for owner, identity_uid in identities.items()
            if identity_uid in verified
        }
    except DirectoryIdentityUnavailableError:
        raise
    except Exception as exc:
        logger.warning("directory.verified_email_unavailable error=%s", type(exc).__name__)
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
        identities = firebase_uids_for_owner_reads(candidates)
        candidates = [owner for owner in candidates if owner in identities]
        profiles: dict[str, dict[str, str]] = {}
        for offset in range(0, len(candidates), 100):
            batch = candidates[offset : offset + 100]
            result = auth.get_users(
                [
                    auth.UidIdentifier(uid)
                    for uid in dict.fromkeys(identities[owner] for owner in batch)
                ],
                app=app,
            )
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
                    for owner in batch:
                        if identities[owner] == record.uid:
                            profiles[owner] = {"display_name": name, "photo_url": photo}
        return profiles
    except DirectoryIdentityUnavailableError:
        raise
    except Exception as exc:
        logger.warning("directory.identity_unavailable error=%s", type(exc).__name__)
        raise DirectoryIdentityUnavailableError() from None
