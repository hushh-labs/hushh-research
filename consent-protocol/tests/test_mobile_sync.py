"""
Tests for utils/sync_engine.py — mobile consent state synchronisation.

Cross-Platform Sync Engine by Abdul Gaffar — verifies that:
  1. Mobile device can revoke Brand A and grant Brand B in a single sync batch
  2. Last-Writer-Wins correctly applies newer updates and skips stale ones
  3. PairingTokenManager issues and validates HMAC tokens correctly
  4. Tampered, expired, and mismatched tokens are rejected
  5. process_batch handles DB errors gracefully per-update
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from utils.sync_engine import (
    ConsentSyncProcessor,
    ConsentSyncUpdate,
    PairingTokenError,
    PairingTokenManager,
    SyncAction,
    resolve_conflict_lww,
    sync_processor,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_KEY = b"test-signing-key-32-bytes-padded!"
_UID = "firebase_user_abc"
_DEVICE = "iphone-xyz-001"
_NOW_MS = int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _update(
    consent_id: str,
    brand_id: str,
    action: SyncAction,
    updated_at: int = _NOW_MS,
) -> ConsentSyncUpdate:
    return ConsentSyncUpdate(
        consent_id=consent_id,
        brand_id=brand_id,
        action=action,
        version_id=f"v-{consent_id}",
        updated_at=updated_at,
    )


# ---------------------------------------------------------------------------
# Mobile sync scenario: Brand A revoke + Brand B grant
# ---------------------------------------------------------------------------


class TestMobileSyncScenario:
    """
    Simulates a mobile device:
    - Revoking consent for Brand A (consent_id=c_brand_a)
    - Granting consent for Brand B (consent_id=c_brand_b)
    Both updates are newer than the server state → both should be applied.
    """

    async def test_brand_a_revoke_applied(self):
        updates = [
            _update("c_brand_a", "brand_a", SyncAction.REVOKE),
            _update("c_brand_b", "brand_b", SyncAction.GRANT),
        ]
        apply_mock = AsyncMock()
        processor = ConsentSyncProcessor()
        response = await processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=apply_mock,
        )
        results_by_id = {r.consent_id: r for r in response.results}
        assert results_by_id["c_brand_a"].applied is True
        assert results_by_id["c_brand_a"].action == SyncAction.REVOKE

    async def test_brand_b_grant_applied(self):
        updates = [
            _update("c_brand_a", "brand_a", SyncAction.REVOKE),
            _update("c_brand_b", "brand_b", SyncAction.GRANT),
        ]
        apply_mock = AsyncMock()
        processor = ConsentSyncProcessor()
        response = await processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=apply_mock,
        )
        results_by_id = {r.consent_id: r for r in response.results}
        assert results_by_id["c_brand_b"].applied is True
        assert results_by_id["c_brand_b"].action == SyncAction.GRANT

    async def test_both_updates_applied_in_one_batch(self):
        updates = [
            _update("c_brand_a", "brand_a", SyncAction.REVOKE),
            _update("c_brand_b", "brand_b", SyncAction.GRANT),
        ]
        apply_mock = AsyncMock()
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=apply_mock,
        )
        assert response.applied == 2
        assert response.skipped == 0
        assert apply_mock.call_count == 2

    async def test_response_carries_engine_label(self):
        updates = [_update("c1", "b1", SyncAction.REVOKE)]
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=AsyncMock(),
        )
        assert "Abdul Gaffar" in response.engine
        assert "Cross-Platform Sync Engine" in response.engine

    async def test_summary_contains_counts(self):
        updates = [_update("c1", "b1", SyncAction.REVOKE)]
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=AsyncMock(),
        )
        summary = response.summary()
        assert "applied=1" in summary
        assert "skipped=0" in summary


# ---------------------------------------------------------------------------
# Last-Writer-Wins conflict resolution
# ---------------------------------------------------------------------------


class TestLastWriterWins:
    def test_mobile_newer_wins(self):
        assert resolve_conflict_lww(mobile_updated_at=1000, server_updated_at=900) is True

    def test_server_newer_wins(self):
        assert resolve_conflict_lww(mobile_updated_at=900, server_updated_at=1000) is False

    def test_tie_goes_to_server(self):
        assert resolve_conflict_lww(mobile_updated_at=1000, server_updated_at=1000) is False

    def test_no_server_record_always_applies(self):
        assert resolve_conflict_lww(mobile_updated_at=1, server_updated_at=None) is True

    async def test_stale_update_skipped_in_batch(self):
        old_ts = _NOW_MS - 10_000  # 10 seconds ago
        server_ts = _NOW_MS - 5_000  # server updated 5 seconds ago (newer)
        updates = [_update("c_stale", "brand_x", SyncAction.REVOKE, updated_at=old_ts)]
        apply_mock = AsyncMock()
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=server_ts),
            apply_update=apply_mock,
        )
        assert response.applied == 0
        assert response.skipped == 1
        apply_mock.assert_not_called()
        assert response.results[0].reason == "skipped_stale"

    async def test_newer_update_applied_in_batch(self):
        newer_ts = _NOW_MS
        server_ts = _NOW_MS - 10_000  # mobile is newer
        updates = [_update("c_new", "brand_y", SyncAction.GRANT, updated_at=newer_ts)]
        apply_mock = AsyncMock()
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=server_ts),
            apply_update=apply_mock,
        )
        assert response.applied == 1
        assert response.results[0].applied is True

    async def test_mixed_batch_lww(self):
        """One stale update + one fresh update in the same batch."""
        updates = [
            _update("c_stale", "b1", SyncAction.REVOKE, updated_at=_NOW_MS - 20_000),
            _update("c_fresh", "b2", SyncAction.GRANT, updated_at=_NOW_MS),
        ]

        async def fetch(cid: str) -> int:
            return _NOW_MS - 10_000  # server updated 10s ago

        apply_mock = AsyncMock()
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=fetch,
            apply_update=apply_mock,
        )
        assert response.applied == 1
        assert response.skipped == 1
        results_by_id = {r.consent_id: r for r in response.results}
        assert results_by_id["c_stale"].applied is False
        assert results_by_id["c_fresh"].applied is True


# ---------------------------------------------------------------------------
# PairingTokenManager
# ---------------------------------------------------------------------------


class TestPairingTokenManager:
    def setup_method(self):
        self.mgr = PairingTokenManager(signing_key=_KEY)

    def test_issue_and_validate_ok(self):
        token = self.mgr.issue_token(_UID, _DEVICE)
        self.mgr.validate_token(token, expected_uid=_UID, expected_device_id=_DEVICE)

    def test_token_format_starts_with_pair(self):
        token = self.mgr.issue_token(_UID, _DEVICE)
        assert token.startswith("PAIR:")

    def test_token_has_five_parts(self):
        token = self.mgr.issue_token(_UID, _DEVICE)
        assert len(token.split(":")) == 5

    def test_wrong_uid_rejected(self):
        token = self.mgr.issue_token(_UID, _DEVICE)
        with pytest.raises(PairingTokenError, match="UID"):
            self.mgr.validate_token(token, expected_uid="other_user", expected_device_id=_DEVICE)

    def test_wrong_device_id_rejected(self):
        token = self.mgr.issue_token(_UID, _DEVICE)
        with pytest.raises(PairingTokenError, match="device_id"):
            self.mgr.validate_token(token, expected_uid=_UID, expected_device_id="android-999")

    def test_tampered_signature_rejected(self):
        token = self.mgr.issue_token(_UID, _DEVICE)
        tampered = token[:-4] + "XXXX"
        with pytest.raises(PairingTokenError, match="signature"):
            self.mgr.validate_token(tampered, expected_uid=_UID, expected_device_id=_DEVICE)

    def test_malformed_token_rejected(self):
        with pytest.raises(PairingTokenError, match="Malformed"):
            self.mgr.validate_token("not-a-valid-token", _UID, _DEVICE)

    def test_expired_token_rejected(self):
        mgr_short = PairingTokenManager(signing_key=_KEY, max_age_seconds=0)
        token = mgr_short.issue_token(_UID, _DEVICE)
        with pytest.raises(PairingTokenError, match="expired"):
            mgr_short.validate_token(token, expected_uid=_UID, expected_device_id=_DEVICE)

    def test_different_keys_reject_token(self):
        mgr_other = PairingTokenManager(signing_key=b"different-key-entirely-!!!")
        token = self.mgr.issue_token(_UID, _DEVICE)
        with pytest.raises(PairingTokenError, match="signature"):
            mgr_other.validate_token(token, expected_uid=_UID, expected_device_id=_DEVICE)

    def test_empty_signing_key_raises(self):
        with pytest.raises(ValueError, match="signing_key"):
            PairingTokenManager(signing_key=b"")

    def test_pairing_token_error_is_value_error(self):
        err = PairingTokenError("test")
        assert isinstance(err, ValueError)


# ---------------------------------------------------------------------------
# process_batch error resilience
# ---------------------------------------------------------------------------


class TestProcessBatchErrorResilience:
    async def test_apply_error_counted_as_skipped(self):
        updates = [_update("c_err", "brand_z", SyncAction.REVOKE)]
        apply_mock = AsyncMock(side_effect=RuntimeError("db failure"))
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=apply_mock,
        )
        assert response.applied == 0
        assert response.skipped == 1
        assert "error:" in response.results[0].reason

    async def test_fetch_error_counted_as_skipped(self):
        updates = [_update("c_fetch_err", "brand_z", SyncAction.GRANT)]
        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(side_effect=ConnectionError("db down")),
            apply_update=AsyncMock(),
        )
        assert response.applied == 0
        assert response.skipped == 1

    async def test_single_error_does_not_abort_batch(self):
        updates = [
            _update("c_err", "b1", SyncAction.REVOKE),
            _update("c_ok", "b2", SyncAction.GRANT),
        ]
        call_count = 0

        async def flaky_apply(u: ConsentSyncUpdate) -> None:
            nonlocal call_count
            call_count += 1
            if u.consent_id == "c_err":
                raise RuntimeError("oops")

        response = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=flaky_apply,
        )
        assert response.applied == 1
        assert response.skipped == 1

    async def test_sync_id_is_unique(self):
        updates = [_update("c1", "b1", SyncAction.REVOKE)]
        r1 = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=AsyncMock(),
        )
        r2 = await sync_processor.process_batch(
            updates,
            fetch_server_state=AsyncMock(return_value=None),
            apply_update=AsyncMock(),
        )
        assert r1.sync_id != r2.sync_id
