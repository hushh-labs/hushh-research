"""
Firebase ID token verification helper.

Used by endpoints that require identity verification (Firebase Auth boundary).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Optional

from fastapi import HTTPException

from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app

logger = logging.getLogger(__name__)

_REVOCATION_CACHE_TTL_SECONDS = 60.0
_REVOCATION_CACHE_MAX_ENTRIES = 4096
_REVOCATION_REMOTE_DEADLINE_SECONDS = 5.0
_REVOCATION_REMOTE_WORKERS = 8
_REVOCATION_REMOTE_CAPACITY = 16
_revocation_state_lock = threading.RLock()
_revocation_positive_cache: OrderedDict[str, tuple[str, float]] = OrderedDict()
_revocation_flights: dict[str, Future[str]] = {}
_revocation_remote_capacity = threading.BoundedSemaphore(_REVOCATION_REMOTE_CAPACITY)
_revocation_executor = ThreadPoolExecutor(
    max_workers=_REVOCATION_REMOTE_WORKERS,
    thread_name_prefix="firebase-revocation",
)


class _FirebaseRevocationUnavailable(RuntimeError):
    """The bounded revocation verifier cannot currently establish token liveness."""


def _revocation_token_key(id_token: str) -> str:
    return hashlib.sha256(id_token.encode("utf-8")).hexdigest()


def _cached_revocation_uid(token_key: str, *, now: float) -> str | None:
    with _revocation_state_lock:
        cached = _revocation_positive_cache.get(token_key)
        if cached is None:
            return None
        cached_uid, expires_at = cached
        if expires_at <= now:
            _revocation_positive_cache.pop(token_key, None)
            return None
        _revocation_positive_cache.move_to_end(token_key)
        return cached_uid


def _finish_revocation_flight(token_key: str, future: Future[str]) -> None:
    try:
        verified_uid = future.result()
    except BaseException:
        # Failures are deliberately never cached. Concurrent callers share
        # only this currently-running Future and the next request retries.
        pass
    else:
        with _revocation_state_lock:
            _revocation_positive_cache[token_key] = (
                verified_uid,
                time.monotonic() + _REVOCATION_CACHE_TTL_SECONDS,
            )
            _revocation_positive_cache.move_to_end(token_key)
            while len(_revocation_positive_cache) > _REVOCATION_CACHE_MAX_ENTRIES:
                _revocation_positive_cache.popitem(last=False)
    finally:
        with _revocation_state_lock:
            if _revocation_flights.get(token_key) is future:
                _revocation_flights.pop(token_key, None)
        _revocation_remote_capacity.release()


def _verify_revocation_remotely(
    firebase_auth,
    *,
    id_token: str,
    firebase_app,
    expected_uid: str,
) -> str:
    verified_claims = firebase_auth.verify_id_token(
        id_token,
        app=firebase_app,
        check_revoked=True,
    )
    verified_uid = str(verified_claims.get("uid") or "").strip()
    if not verified_uid or verified_uid != expected_uid:
        raise ValueError("Firebase token UID changed during revocation verification")
    return verified_uid


def _verify_revocation_with_cache(
    firebase_auth,
    *,
    id_token: str,
    firebase_app,
    expected_uid: str,
) -> None:
    """Verify revocation with an exact-token positive cache and single-flight."""
    token_key = _revocation_token_key(id_token)
    cached_uid = _cached_revocation_uid(token_key, now=time.monotonic())
    if cached_uid is not None:
        if cached_uid != expected_uid:
            raise ValueError("Firebase revocation cache UID mismatch")
        return

    with _revocation_state_lock:
        # Recheck after joining the coordinator so two first requests cannot
        # both submit a remote Firebase lookup.
        cached_uid = _cached_revocation_uid(token_key, now=time.monotonic())
        if cached_uid is not None:
            if cached_uid != expected_uid:
                raise ValueError("Firebase revocation cache UID mismatch")
            return
        future = _revocation_flights.get(token_key)
        if future is None:
            if not _revocation_remote_capacity.acquire(blocking=False):
                raise _FirebaseRevocationUnavailable("Firebase revocation verifier is at capacity")
            try:
                future = _revocation_executor.submit(
                    _verify_revocation_remotely,
                    firebase_auth,
                    id_token=id_token,
                    firebase_app=firebase_app,
                    expected_uid=expected_uid,
                )
            except BaseException:
                _revocation_remote_capacity.release()
                raise
            _revocation_flights[token_key] = future
            future.add_done_callback(
                lambda completed, key=token_key: _finish_revocation_flight(key, completed)
            )

    try:
        verified_uid = future.result(timeout=_REVOCATION_REMOTE_DEADLINE_SECONDS)
    except FutureTimeoutError:
        # The bounded executor retains the still-running single flight, so a
        # slow SDK call cannot spawn an unbounded thread/task pile. Callers
        # fail closed at the deadline; no failure result enters the cache.
        raise _FirebaseRevocationUnavailable(
            "Firebase revocation verification deadline exceeded"
        ) from None
    except BaseException:
        # The completed failure is shared with callers that were already
        # waiting on this flight, but it is not a negative cache entry. Make
        # the next request eligible to perform a fresh bounded check.
        with _revocation_state_lock:
            if future.done() and _revocation_flights.get(token_key) is future:
                _revocation_flights.pop(token_key, None)
        raise
    if verified_uid != expected_uid:
        raise ValueError("Firebase revocation result UID mismatch")


def _clear_revocation_cache_for_tests() -> None:
    with _revocation_state_lock:
        _revocation_positive_cache.clear()


def _account_not_found_error() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={
            "code": "AUTH_ACCOUNT_NOT_FOUND",
            "message": "Account not found",
        },
        headers={"Cache-Control": "private, no-store"},
    )


def _assert_account_not_deleted(uid: str) -> None:
    """Fail closed before any authenticated handler can bootstrap user state."""
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionInProgressError,
        AccountDeletionLifecycleService,
    )

    try:
        deleted = AccountDeletionLifecycleService.is_tombstoned(uid)
    except AccountDeletionInProgressError:
        raise HTTPException(
            status_code=423,
            detail={
                "code": "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
                "message": "Account deletion is in progress.",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "2"},
        ) from None
    except Exception as exc:
        logger.error(
            "firebase.account_deletion_status_unavailable error=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "AUTH_SESSION_STATUS_UNAVAILABLE",
                "message": "Authentication status is temporarily unavailable",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "3"},
        ) from None
    if deleted:
        raise _account_not_found_error()


def verify_firebase_bearer(
    authorization: Optional[str],
    *,
    check_revoked: bool = True,
) -> str:
    """
    Verify `Authorization: Bearer <firebaseIdToken>` and return UID.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    configured, _ = ensure_firebase_auth_admin()
    if not configured:
        # Backend misconfiguration (common in local dev)
        raise HTTPException(status_code=500, detail="Firebase Admin not configured")

    id_token = authorization.removeprefix("Bearer ").strip()
    if not id_token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    from firebase_admin import auth as firebase_auth
    from firebase_admin import exceptions as firebase_exceptions

    uid: str | None = None
    try:
        firebase_app = get_firebase_auth_app()
        # Always do signature/issuer/audience/expiry verification. The global
        # default also preserves revoked/disabled-token enforcement; an exact
        # token+UID positive cache bounds its remote Firebase lookup load. The
        # durable account-deletion tombstone below remains universal.
        decoded = firebase_auth.verify_id_token(
            id_token,
            app=firebase_app,
            check_revoked=False,
        )
        uid = decoded.get("uid")
        if not isinstance(uid, str) or not uid:
            raise HTTPException(status_code=401, detail="Invalid Firebase ID token")

        if check_revoked:
            _verify_revocation_with_cache(
                firebase_auth,
                id_token=id_token,
                firebase_app=firebase_app,
                expected_uid=uid,
            )

        _assert_account_not_deleted(uid)

        device_id = str(decoded.get("trusted_device_id") or "").strip()
        if device_id:
            # A trusted-device Firebase session remains valid only while its
            # server-side device registration is active. This check is
            # independent of rollout flags so disabling enrollment cannot
            # accidentally preserve a revoked device session.
            from hushh_mcp.services.trusted_device_service import TrustedDeviceService

            try:
                active = TrustedDeviceService().is_active_device(
                    user_id=uid,
                    device_id=device_id,
                )
            except Exception:
                logger.exception(
                    "firebase.trusted_device_status_unavailable uid=%s device_id=%s",
                    uid,
                    device_id,
                )
                raise HTTPException(
                    status_code=503,
                    detail="Trusted-device status temporarily unavailable",
                ) from None
            if not active:
                raise HTTPException(
                    status_code=401,
                    detail="Trusted-device session is no longer active",
                )
        return uid
    except HTTPException:
        raise
    except ValueError as exc:
        logger.warning("firebase.verify_id_token value_error: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from None
    except firebase_auth.UserNotFoundError:
        # This is the one 401 that has a definitive account-lifecycle meaning.
        # Keep it machine-readable so web and native clients can leave any
        # cached vault/setup surface immediately instead of presenting a retry
        # loop. Other invalid-token cases remain generic below because they may
        # be recoverable with a fresh Firebase token.
        raise _account_not_found_error() from None
    except (firebase_auth.RevokedIdTokenError, firebase_auth.UserDisabledError):
        # Firebase intentionally maps remote deletion/quarantine to generic
        # token errors. A second signature+expiry verification (without the
        # revocation lookup) safely recovers the signed UID so our durable
        # tombstone can return the definitive account-lifecycle machine code.
        try:
            decoded_without_revocation = firebase_auth.verify_id_token(
                id_token,
                app=firebase_app,
                check_revoked=False,
            )
            uid = decoded_without_revocation.get("uid")
            if isinstance(uid, str) and uid:
                _assert_account_not_deleted(uid)
        except HTTPException:
            raise
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from None
    except (
        firebase_auth.InvalidIdTokenError,
        firebase_auth.ExpiredIdTokenError,
    ):
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from None
    except firebase_auth.CertificateFetchError as exc:
        logger.error("firebase.verify_id_token certificate_fetch_failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Authentication service temporarily unavailable",
        ) from None
    except firebase_exceptions.FirebaseError as exc:
        # In particular, the opt-in revocation lookup can surface deadline,
        # unavailable, quota, and upstream 5xx errors. These are operational
        # failures, not malformed credentials or application bugs.
        # If local verification already established a UID, consult the
        # tombstone before returning an outage. Deleted accounts must still
        # receive the terminal machine code when Firebase is unavailable.
        if uid is not None:
            _assert_account_not_deleted(uid)
        logger.error(
            "firebase.verify_id_token service_unavailable error=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "AUTH_SESSION_STATUS_UNAVAILABLE",
                "message": "Authentication status is temporarily unavailable",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "3"},
        ) from None
    except _FirebaseRevocationUnavailable as exc:
        if uid is not None:
            _assert_account_not_deleted(uid)
        logger.error(
            "firebase.verify_id_token revocation_unavailable error=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "AUTH_SESSION_STATUS_UNAVAILABLE",
                "message": "Authentication status is temporarily unavailable",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "3"},
        ) from None
    except Exception as exc:
        logger.exception("firebase.verify_id_token unexpected_error: %s", exc)
        raise HTTPException(status_code=500, detail="Internal server error") from None
