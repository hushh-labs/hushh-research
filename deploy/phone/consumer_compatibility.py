# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Reject unreviewed changes in consumers shared with a retained phone reader."""

from __future__ import annotations

import hashlib

from qualify_image import run

BASELINE = "c2a56386064f101799669a8d27a8d6af8198edec"
REVIEWED = "25759339d32e2b5b1f8f84c0d922db8abbf9f956"
UNCHANGED = (
    "api/routes/account.py",
    "api/routes/account_phone_recovery.py",
    "api/routes/account_device_revocation.py",
    "api/middlewares/auth_reliability_trace.py",
    "api/utils/firebase_auth.py",
    "api/utils/phone_claim_proof.py",
    "hushh_mcp/services/phone_recovery_state.py",
    "hushh_mcp/services/phone_recovery_continuation.py",
    "hushh_mcp/services/device_action_service.py",
    "hushh_mcp/services/device_action_proof.py",
    "hushh_mcp/services/phone_test_transport.py",
    "db/migrations/431_phone_recovery_actions.sql",
    "db/contracts/prod_core_schema.json",
    "hushh_mcp/services/phone_transfer_service.py",
    "hushh_mcp/services/account_cleanup_runtime.py",
    "hushh_mcp/services/support_email_service.py",
    "hushh_mcp/services/account_deletion_lifecycle_service.py",
    "hushh_mcp/services/account_generation_service.py",
    "hushh_mcp/services/actor_phone_claim.py",
    "api/utils/firebase_admin.py",
    "db/db_client.py",
    "db/connection.py",
    "hushh_mcp/runtime_settings.py",
    "hushh_mcp/config.py",
    "pyproject.toml",
    "uv.lock",
)
REVIEWED_EXCEPTIONS = (
    "hushh_mcp/services/account_firebase_mutations.py",
    "hushh_mcp/services/phone_transfer_authority.py",
)
ERASURE_REPORTING_BASELINE = "0c32dc1cba0e5a0a4d7a3f9c257baf32e2e4b14b"
ERASURE_REPORTING_REVIEWED = "d5f5175957cecbfa1ba0394d5dcf7621cb6385b2"
ERASURE_REPORTING_EXCEPTIONS = (
    "api/routes/account.py",
    "hushh_mcp/services/account_deletion_lifecycle_service.py",
)
CLEANUP_UPGRADE_BASELINE = "84b80bcab6b5b7a4de21a5a992d3c969dacba5b9"
CLEANUP_UPGRADE_REVIEWED = "49dafdc2f1b6e1dcd87e7badd7cf850a6e1494fc"
CLEANUP_UPGRADE_PATHS = (
    "api/routes/account.py",
    "db/contracts/prod_core_schema.json",
    "hushh_mcp/services/account_cleanup_runtime.py",
    "hushh_mcp/services/support_email_service.py",
    "hushh_mcp/services/account_deletion_lifecycle_service.py",
    "uv.lock",
)
SETTLEMENT_MIGRATION = "db/migrations/437_account_legacy_generation_settlement.sql"


def _source(sha: str, path: str) -> bytes:
    return run(["git", "show", f"{sha}:consent-protocol/{path}"])


def _reviewed_change(path: str, previous: bytes, current: bytes) -> bool:
    if path in REVIEWED_EXCEPTIONS:
        before, after = BASELINE, REVIEWED
    elif path in ERASURE_REPORTING_EXCEPTIONS:
        before, after = ERASURE_REPORTING_BASELINE, ERASURE_REPORTING_REVIEWED
    else:
        return False
    return previous == _source(before, path) and current == _source(after, path)


def _reviewed_cleanup_upgrade(fallback: str, primary: str) -> bool:
    """Require the complete reviewed upgrade; partial combinations stay unqualified."""
    for path in CLEANUP_UPGRADE_PATHS:
        previous, current = _source(fallback, path), _source(primary, path)
        if (
            previous == current
            or previous != _source(CLEANUP_UPGRADE_BASELINE, path)
            or current != _source(CLEANUP_UPGRADE_REVIEWED, path)
        ):
            return False
    return True


def qualify_consumers(fallback: str, primary: str) -> dict:
    """Require identical consumers or an ordered, reviewed whole-file change.

    The reporting pair preserves deletion/phone authority and the integer drain
    facade. It does not qualify old migration replay or a frontend rollback.
    No authority-bearing module is excluded from the hash inventory.
    WorkOS non-activation remains an independent, live release requirement.

    The coupled cleanup upgrade preserves phone admission while moving the same
    guarded drain, adding wake/notice support and the dormant 437 capability.
    Its migration must match the reviewed source too; the release manifest seals
    the installed migration independently. This qualifies neither replay of the old
    migration adapter nor automatic production legacy settlement.
    """
    cleanup_upgrade = _reviewed_cleanup_upgrade(fallback, primary)
    checked = {}
    for path in (*UNCHANGED, *REVIEWED_EXCEPTIONS):
        previous, current = _source(fallback, path), _source(primary, path)
        if previous != current and not (
            (cleanup_upgrade and path in CLEANUP_UPGRADE_PATHS)
            or _reviewed_change(path, previous, current)
        ):
            raise ValueError("phone_rollback_consumer_change_unqualified")
        checked[path] = hashlib.sha256(current).hexdigest()
    if cleanup_upgrade:
        migration = _source(primary, SETTLEMENT_MIGRATION)
        if migration != _source(CLEANUP_UPGRADE_REVIEWED, SETTLEMENT_MIGRATION):
            raise ValueError("phone_rollback_consumer_change_unqualified")
    return {"fallback": fallback, "primary": primary, "source_sha256": checked}
