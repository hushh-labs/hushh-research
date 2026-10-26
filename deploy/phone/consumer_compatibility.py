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


def _source(sha: str, path: str) -> bytes:
    return run(["git", "show", f"{sha}:consent-protocol/{path}"])


def qualify_consumers(fallback: str, primary: str) -> dict:
    """Require identical 428 consumers; retain only the reviewed 425/427 exception.

    The exception pins whole files, including the changed functions. It never
    ignores arbitrary SSO additions or excludes an authority-bearing module.
    WorkOS non-activation remains an independent, live release requirement.
    """
    checked = {}
    for path in (*UNCHANGED, *REVIEWED_EXCEPTIONS):
        previous, current = _source(fallback, path), _source(primary, path)
        if previous != current and not (
            path in REVIEWED_EXCEPTIONS
            and previous == _source(BASELINE, path)
            and current == _source(REVIEWED, path)
        ):
            raise ValueError("phone_rollback_consumer_change_unqualified")
        checked[path] = hashlib.sha256(current).hexdigest()
    return {"fallback": fallback, "primary": primary, "source_sha256": checked}
