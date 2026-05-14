"""
Mobile-to-protocol consent state synchronisation engine.

Cross-Platform Sync Engine by Abdul Gaffar — Beast Mode initiative.

Enables a user's mobile device to push a batch of consent state updates
(GRANT / REVOKE) to the backend in a single authenticated call. Conflicts
are resolved with Last-Writer-Wins (LWW) semantics: the party with the
newer ``updated_at`` timestamp wins. Ties go to the server (conservative).

Architecture
------------
    Mobile device
        │  POST /sync/consent-state
        │  Headers: Authorization: Bearer <firebase-id-token>
        │           X-Pairing-Token: PAIR:<uid>:<device_id>:<ts>:<sig>
        ↓
    ConsentSyncRequest (Pydantic, validated)
        │
        ↓
    PairingTokenManager.validate_token()
        │  Verifies device-level HMAC pairing token (on top of Firebase auth)
        ↓
    ConsentSyncProcessor.process_batch()
        │  Resolves conflicts with resolve_conflict_lww()
        │  Returns ConsentSyncResponse with per-update outcomes
        ↓
    Caller applies updates to DB and returns response

Pairing Token
-------------
A pairing token is an HMAC-SHA256 MAC over ``"{uid}:{device_id}:{issued_at}"``
using the server's APP_SIGNING_KEY.  It binds a Firebase-authenticated user
to a specific device ID for a configurable validity window (default 24 h).

The token format is:
    PAIR:<firebase_uid>:<device_id>:<issued_at_unix_seconds>:<hex_signature>

Mobile clients obtain a pairing token by calling a dedicated issuance
endpoint (e.g. POST /auth/pair-device) after Firebase sign-in. They then
attach it as ``X-Pairing-Token`` on every sync call.

Last-Writer-Wins (LWW) conflict resolution
-------------------------------------------
For each incoming update:
1. Fetch the server's current record for the consent_id.
2. Compare ``mobile.updated_at`` (ms) with ``server.updated_at`` (ms).
3. If mobile is strictly newer: apply the update.
4. If server is newer or equal: skip (server state is authoritative).

This ensures that a consent revocation performed on the web dashboard
cannot be overwritten by a stale mobile sync that arrives late.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_LABEL = "Cross-Platform Sync Engine by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Enums and Models
# ---------------------------------------------------------------------------


class SyncAction(str, Enum):
    """Allowed consent state transitions from a mobile sync."""

    GRANT = "GRANT"
    REVOKE = "REVOKE"


class ConsentSyncUpdate(BaseModel):
    """A single consent state change from the mobile device."""

    consent_id: str = Field(..., min_length=1, max_length=256)
    brand_id: str = Field(..., min_length=1, max_length=256)
    action: SyncAction
    version_id: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="Opaque version token from mobile (e.g. a UUID or counter).",
    )
    updated_at: int = Field(
        ...,
        description="Unix epoch milliseconds when this state was set on device.",
    )
    metadata: Optional[dict[str, Any]] = Field(
        default=None,
        description="Optional additional context (scope hint, device model, etc.).",
    )


class ConsentSyncRequest(BaseModel):
    """
    Full sync payload from a mobile device.

    The ``pairing_token`` supplements the Firebase bearer token by binding
    the request to a specific device_id — preventing one authenticated user
    from spoofing sync updates on behalf of another device.
    """

    device_id: str = Field(..., min_length=1, max_length=256)
    pairing_token: str = Field(
        ...,
        description="PAIR:<uid>:<device_id>:<issued_at>:<hmac_sig>",
    )
    sync_at: int = Field(
        ...,
        description="Unix epoch milliseconds when the sync batch was assembled.",
    )
    updates: list[ConsentSyncUpdate] = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Ordered list of consent state changes to apply.",
    )


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


@dataclass
class SyncUpdateResult:
    """Outcome of processing a single ConsentSyncUpdate."""

    consent_id: str
    brand_id: str
    action: SyncAction
    applied: bool
    reason: str  # "applied", "skipped_stale", "error:<msg>"


@dataclass
class ConsentSyncResponse:
    """Aggregate result of a process_batch() call."""

    sync_id: str
    processed: int
    applied: int
    skipped: int
    results: list[SyncUpdateResult] = field(default_factory=list)
    engine: str = _LABEL

    def summary(self) -> str:
        return (
            f"[{self.engine}] sync_id={self.sync_id} "
            f"processed={self.processed} applied={self.applied} skipped={self.skipped}"
        )


# ---------------------------------------------------------------------------
# Pairing Token Manager
# ---------------------------------------------------------------------------


class PairingTokenError(ValueError):
    """Raised when a pairing token is invalid, expired, or tampered."""


class PairingTokenManager:
    """
    Issues and validates device-level HMAC-SHA256 pairing tokens.

    A pairing token is an additional layer on top of Firebase authentication.
    It binds a specific device_id to a Firebase UID, preventing authenticated
    users from submitting sync calls on behalf of arbitrary device IDs.

    Cross-Platform Sync Engine by Abdul Gaffar.
    """

    _PREFIX = "PAIR"

    def __init__(self, signing_key: bytes, max_age_seconds: int = 86_400) -> None:
        """
        Parameters
        ----------
        signing_key : bytes
            Secret key used for HMAC-SHA256 signing.  Use the server's
            APP_SIGNING_KEY; never a hardcoded value.
        max_age_seconds : int
            Token validity window in seconds (default 86400 = 24 h).
        """
        if not signing_key:
            raise ValueError("signing_key must not be empty")
        self._key = signing_key
        self._max_age = max_age_seconds

    # ------------------------------------------------------------------

    def _mac(self, firebase_uid: str, device_id: str, issued_at: int) -> str:
        message = f"{firebase_uid}:{device_id}:{issued_at}".encode()
        return hmac.new(self._key, message, hashlib.sha256).hexdigest()

    def issue_token(self, firebase_uid: str, device_id: str) -> str:
        """
        Issue a new pairing token for the given user/device combination.

        Returns
        -------
        str
            ``PAIR:<uid>:<device_id>:<issued_at>:<hmac_sig>``
        """
        issued_at = int(time.time())
        sig = self._mac(firebase_uid, device_id, issued_at)
        return f"{self._PREFIX}:{firebase_uid}:{device_id}:{issued_at}:{sig}"

    def validate_token(
        self,
        token: str,
        expected_uid: str,
        expected_device_id: str,
    ) -> None:
        """
        Validate a pairing token, raising PairingTokenError on any failure.

        Parameters
        ----------
        token : str
            The raw ``PAIR:...`` token string.
        expected_uid : str
            Firebase UID from the bearer-token auth layer.
        expected_device_id : str
            device_id from the sync request body.

        Raises
        ------
        PairingTokenError
            With a human-readable reason (does not leak timing information —
            the HMAC comparison uses ``hmac.compare_digest``).
        """
        try:
            parts = token.split(":")
            if len(parts) != 5 or parts[0] != self._PREFIX:
                raise PairingTokenError("Malformed pairing token")

            _, uid, device_id, issued_at_str, sig = parts

            if uid != expected_uid:
                raise PairingTokenError("Pairing token UID mismatch")

            if device_id != expected_device_id:
                raise PairingTokenError("Pairing token device_id mismatch")

            issued_at = int(issued_at_str)
            age = int(time.time()) - issued_at
            if age >= self._max_age:
                raise PairingTokenError(
                    f"Pairing token expired (age {age}s > max {self._max_age}s)"
                )
            if age < 0:
                raise PairingTokenError("Pairing token issued in the future")

            expected_sig = self._mac(uid, device_id, issued_at)
            if not hmac.compare_digest(sig, expected_sig):
                raise PairingTokenError("Pairing token signature invalid")

        except PairingTokenError:
            raise
        except Exception as exc:
            raise PairingTokenError(f"Pairing token parse error: {exc}") from exc


# ---------------------------------------------------------------------------
# LWW conflict resolution
# ---------------------------------------------------------------------------


def resolve_conflict_lww(
    mobile_updated_at: int,
    server_updated_at: Optional[int],
) -> bool:
    """
    Last-Writer-Wins: return True if the mobile update should be applied.

    Parameters
    ----------
    mobile_updated_at : int
        ``updated_at`` from the incoming ConsentSyncUpdate (ms).
    server_updated_at : int | None
        Server's current ``updated_at`` for this consent (ms), or None if
        the record does not exist yet.

    Returns
    -------
    bool
        True → apply the mobile update; False → skip (server is newer/equal).

    Notes
    -----
    Ties (equal timestamps) go to the server — a conservative policy that
    prevents accidental overwrites when clocks are poorly synchronised.
    """
    if server_updated_at is None:
        return True  # No server record — always create
    return mobile_updated_at > server_updated_at


# ---------------------------------------------------------------------------
# Batch processor
# ---------------------------------------------------------------------------


class ConsentSyncProcessor:
    """
    Processes a batch of ConsentSyncUpdate records with LWW conflict resolution.

    Cross-Platform Sync Engine by Abdul Gaffar — stateless and fully testable
    without a live database connection (all DB access is injected).
    """

    async def process_batch(
        self,
        updates: list[ConsentSyncUpdate],
        *,
        fetch_server_state: Callable[[str], Awaitable[Optional[int]]],
        apply_update: Callable[[ConsentSyncUpdate], Awaitable[None]],
    ) -> ConsentSyncResponse:
        """
        Apply LWW conflict resolution to each update and execute approved ones.

        Parameters
        ----------
        updates : list[ConsentSyncUpdate]
            The ordered list from the mobile sync request.
        fetch_server_state : async callable(consent_id) -> int | None
            Returns the server's current ``updated_at`` for a consent_id,
            or None if the record does not exist.
        apply_update : async callable(ConsentSyncUpdate) -> None
            Executes the consent state change in the database.

        Returns
        -------
        ConsentSyncResponse
        """
        sync_id = str(uuid.uuid4())
        results: list[SyncUpdateResult] = []
        applied_count = 0
        skipped_count = 0

        for update in updates:
            try:
                server_ts = await fetch_server_state(update.consent_id)
                should_apply = resolve_conflict_lww(update.updated_at, server_ts)

                if should_apply:
                    await apply_update(update)
                    results.append(
                        SyncUpdateResult(
                            consent_id=update.consent_id,
                            brand_id=update.brand_id,
                            action=update.action,
                            applied=True,
                            reason="applied",
                        )
                    )
                    applied_count += 1
                    logger.info(
                        "[%s] update applied consent_id=%s action=%s",
                        _LABEL,
                        update.consent_id,
                        update.action.value,
                    )
                else:
                    results.append(
                        SyncUpdateResult(
                            consent_id=update.consent_id,
                            brand_id=update.brand_id,
                            action=update.action,
                            applied=False,
                            reason="skipped_stale",
                        )
                    )
                    skipped_count += 1
                    logger.info(
                        "[%s] update skipped (stale) consent_id=%s mobile_ts=%d server_ts=%s",
                        _LABEL,
                        update.consent_id,
                        update.updated_at,
                        server_ts,
                    )

            except Exception as exc:
                results.append(
                    SyncUpdateResult(
                        consent_id=update.consent_id,
                        brand_id=update.brand_id,
                        action=update.action,
                        applied=False,
                        reason=f"error:{exc}",
                    )
                )
                skipped_count += 1
                logger.exception(
                    "[%s] update error consent_id=%s", _LABEL, update.consent_id
                )

        response = ConsentSyncResponse(
            sync_id=sync_id,
            processed=len(updates),
            applied=applied_count,
            skipped=skipped_count,
            results=results,
        )
        logger.info(response.summary())
        return response


# ---------------------------------------------------------------------------
# Module-level singletons
# ---------------------------------------------------------------------------

sync_processor = ConsentSyncProcessor()
