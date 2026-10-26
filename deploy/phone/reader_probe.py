# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Offline executable-image proof of the public retired-phone admission reader.

Run inside the pinned application image, with no network, secrets or database.
Only Firebase SDK and concrete database ports are replaced with synthetic ones.
"""

from __future__ import annotations

import json
import hashlib
import asyncio
import importlib
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

SOURCE_MODULES = (
    "api.utils.firebase_auth",
    "api.utils.account_principal_policy",
    "api.routes.account",
    "api.routes.account_phone_recovery",
    "api.routes.account_device_revocation",
    "hushh_mcp.services.phone_transfer_service",
    "hushh_mcp.services.phone_transfer_authority",
    "hushh_mcp.services.account_firebase_mutations",
    "hushh_mcp.services.account_deletion_lifecycle_service",
    "hushh_mcp.services.device_action_service",
    "hushh_mcp.services.device_action_proof",
    "hushh_mcp.services.phone_recovery_state",
    "hushh_mcp.services.phone_recovery_continuation",
    "hushh_mcp.runtime_settings",
)


_CASES = {
    "retired": (
        True,
        True,
        401,
        "AUTH_PHONE_ACCESS_REVOKED",
        ["installed", "fence"],
    ),
    "unfenced": (
        True,
        False,
        403,
        "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
        ["installed", "fence"],
    ),
    "uninstalled": (
        False,
        False,
        403,
        "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
        ["installed"],
    ),
    "unavailable": (
        None,
        False,
        503,
        "AUTH_SESSION_STATUS_UNAVAILABLE",
        ["installed"],
    ),
    "fence_unavailable": (
        True,
        None,
        503,
        "AUTH_SESSION_STATUS_UNAVAILABLE",
        ["installed", "fence"],
    ),
    "social": (
        True,
        False,
        200,
        "admitted",
        ["isolation", "timeouts", "barrier", "barrier", "tombstone"],
    ),
}


def _database_port(
    *,
    owner: str,
    expected_identity: str,
    expected_phone: str,
    installed: bool | None,
    fenced: bool | None,
    queries: list[str],
):
    class Connection:
        def execute(self, statement, params=None):
            sql = " ".join(str(statement).split())
            scalar, row = None, None
            if (
                sql
                == "SELECT to_regclass('public.account_phone_auth_fences') IS NOT NULL"
            ):
                assert params is None
                queries.append("installed")
                if installed is None:
                    raise RuntimeError("synthetic_database_unavailable")
                scalar = installed
            elif sql == (
                "SELECT EXISTS(SELECT 1 FROM account_phone_auth_fences "
                "WHERE identity_hash=:identity AND phone_digest=:phone)"
            ):
                assert params == {
                    "identity": expected_identity,
                    "phone": expected_phone,
                }
                queries.append("fence")
                if fenced is None:
                    raise RuntimeError("synthetic_fence_read_unavailable")
                scalar = fenced
            elif sql == "SET TRANSACTION ISOLATION LEVEL READ COMMITTED":
                assert params is None
                queries.append("isolation")
            elif sql == (
                "SELECT set_config('statement_timeout', '3500ms', TRUE), "
                "set_config('lock_timeout', '3000ms', TRUE)"
            ):
                assert params is None
                queries.append("timeouts")
            elif sql == (
                "SELECT pg_advisory_xact_lock_shared( "
                "hashtextextended(:user_id, :lock_namespace) )"
            ):
                assert params == {
                    "user_id": owner,
                    "lock_namespace": (171, 198)[queries.count("barrier")],
                }
                queries.append("barrier")
            elif sql == (
                "SELECT COALESCE(to_jsonb(tombstone)->>'erasure_phase','erased') "
                "FROM account_deletion_tombstones tombstone "
                "WHERE user_id_hash = :user_id_hash LIMIT 1"
            ):
                assert params == {"user_id_hash": expected_identity}
                queries.append("tombstone")
            else:
                raise AssertionError("unexpected_phone_probe_database_operation")
            return SimpleNamespace(scalar_one=lambda: scalar, first=lambda: row)

    @contextmanager
    def database():
        yield Connection()

    return database


def application_modules(app_root: Path) -> dict:
    modules = {
        name.replace(".", "/") + ".py": importlib.import_module(name)
        for name in SOURCE_MODULES
    }
    root = app_root.resolve()
    for path, module in modules.items():
        loaded = Path(module.__file__).resolve()
        if not loaded.is_relative_to(root) or loaded != (root / path).resolve():
            raise ValueError("phone_reader_module_origin_mismatch")
    if modules["hushh_mcp/services/phone_transfer_service.py"].mutations is not modules[
        "hushh_mcp/services/account_firebase_mutations.py"
    ]:
        raise ValueError("phone_reader_mutation_module_mismatch")
    return modules


def _qualify_device_action_reader(account) -> str:
    from fastapi import HTTPException

    async def missing_proof():
        try:
            await account.revoke_trusted_device(
                device_id="synthetic-phone-reader-device",
                firebase_uid="synthetic-phone-reader-owner",
                payload=None,
            )
        except HTTPException as exc:
            assert exc.status_code == 403
            assert exc.detail == {"code": "DEVICE_ACTION_PROOF_REQUIRED"}
        else:
            raise AssertionError("device_revocation_without_fresh_proof_admitted")

    def no_effect(*_args, **_kwargs):
        raise AssertionError("device_proof_probe_dispatched_a_mutation")

    with patch.object(account, "_revoke_trusted_device", no_effect):
        asyncio.run(missing_proof())
    return "DEVICE_ACTION_PROOF_REQUIRED"


def qualify(app_root: Path) -> dict[str, str]:
    if not __debug__:
        raise RuntimeError("phone_probe_requires_assertions")
    from fastapi import HTTPException
    from firebase_admin import auth as sdk

    modules = application_modules(app_root)
    firebase_auth = modules["api/utils/firebase_auth.py"]
    phone_transfer_service = modules["hushh_mcp/services/phone_transfer_service.py"]
    lifecycle = modules["hushh_mcp/services/account_deletion_lifecycle_service.py"]

    owner, phone = "synthetic-phone-reader-owner", "+16505550101"
    expected_identity = lifecycle.account_deletion_user_hash(owner)
    expected_phone = lifecycle.account_deletion_phone_digest(phone)
    results = {}
    for name, (installed, fenced, status, code, reads) in _CASES.items():
        queries, sdk_calls = [], []

        database = _database_port(
            owner=owner,
            expected_identity=expected_identity,
            expected_phone=expected_phone,
            installed=installed,
            fenced=fenced,
            queries=queries,
        )

        def verified(_token, *, app, check_revoked):
            assert app is application
            sdk_calls.append(check_revoked)
            return {
                "uid": owner,
                "phone_number": phone,
                "firebase": {
                    "sign_in_provider": "google.com" if name == "social" else "phone"
                },
            }

        application = object()
        with (
            patch.object(
                firebase_auth,
                "ensure_firebase_auth_admin",
                return_value=(True, "synthetic"),
            ),
            patch.object(
                firebase_auth, "get_firebase_auth_app", return_value=application
            ),
            patch.object(sdk, "verify_id_token", side_effect=verified),
            patch.object(phone_transfer_service, "get_db_connection", database),
            patch.object(lifecycle, "get_db_connection", database),
        ):
            try:
                principal = firebase_auth.verify_firebase_principal(
                    f"Bearer synthetic-phone-reader-{uuid4()}",
                    check_revoked=True,
                    require_independent_signin=False,
                )
            except HTTPException as exc:
                assert exc.status_code == status and isinstance(exc.detail, dict)
                assert exc.detail.get("code") == code
            else:
                assert status == 200 and principal.owner_id == owner
            assert queries == reads and sdk_calls == [False, True]
        results[name] = code
    results["device_revoke_missing_proof"] = _qualify_device_action_reader(
        modules["api/routes/account.py"]
    )
    return results


if __name__ == "__main__":
    import logging
    import os
    import sys

    logging.disable(logging.CRITICAL)
    required = {
        "ENVIRONMENT": "production",
        "AUTH_PHONE_RECOVERY_ENABLED": "false",
        "WORKOS_SSO_ENABLED": "false",
    }
    if any(os.environ.get(key) != value for key, value in required.items()):
        raise SystemExit("phone_probe_environment_refused")
    # Application import diagnostics cannot be confused with the JSON verdict.
    with redirect_stdout(sys.stderr):
        verdict = qualify(Path("/app"))
    if os.environ.get(
        "ACCOUNT_GENERATION_ADMISSION_ENABLED", ""
    ).strip().lower() not in {"", "false"}:
        raise SystemExit("phone_probe_generation_branch_refused")
    hashes = {
        name: hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
        for name, module in application_modules(Path("/app")).items()
    }
    print(
        json.dumps(
            {
                "schema_version": 1,
                "phone_reader": verdict,
                "source_sha256": hashes,
                "probe_generation_admission": False,
            },
            sort_keys=True,
        )
    )
