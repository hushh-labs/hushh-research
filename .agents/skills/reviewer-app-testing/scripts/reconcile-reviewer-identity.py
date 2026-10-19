#!/usr/bin/env python3
"""Audit or repoint the canonical reviewer UID without exposing credentials."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import firebase_admin
from dotenv import dotenv_values
from firebase_admin import auth, credentials


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[4]
PROTOCOL_DIR = REPO_ROOT / "consent-protocol"
sys.path.insert(0, str(PROTOCOL_DIR))

from db.db_client import get_db  # noqa: E402
from scripts.audit_active_pkm_shape_readonly import _unwrap_vault_key  # noqa: E402


def _secret(project: str, name: str) -> str:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={name}",
            f"--project={project}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError(f"Secret Manager returned an empty {name} value.")
    return value


def _target_uid(email: str) -> str:
    config = dotenv_values(PROTOCOL_DIR / ".env")
    service_account = str(config.get("FIREBASE_ADMIN_CREDENTIALS_JSON") or "").strip()
    if not service_account:
        raise RuntimeError("Local backend environment has no Firebase Admin credential.")
    if not firebase_admin._apps:  # type: ignore[attr-defined]
        firebase_admin.initialize_app(credentials.Certificate(json.loads(service_account)))
    return auth.get_user_by_email(email).uid


def _passphrase_unlocks_target(user_id: str, passphrase: str) -> bool:
    result = get_db().execute_raw(
        """SELECT encrypted_vault_key, salt, iv, method, created_at
           FROM vault_key_wrappers
           WHERE user_id = :user_id AND method = 'passphrase'
           ORDER BY created_at DESC LIMIT 1""",
        {"user_id": user_id},
    )
    if not result.data:
        return False
    try:
        _unwrap_vault_key(passphrase, dict(result.data[0]))
        return True
    except Exception:
        return False


def _add_uid_version(project: str, user_id: str) -> None:
    subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "add",
            "REVIEWER_UID",
            f"--project={project}",
            "--data-file=-",
        ],
        input=user_id,
        check=True,
        capture_output=True,
        text=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Verify that the Secret Manager reviewer passphrase unlocks a selected "
            "Firebase account before optionally repointing REVIEWER_UID."
        )
    )
    parser.add_argument("--email", required=True)
    parser.add_argument("--secret-project", default="hushh-pda-uat")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-email", default="")
    args = parser.parse_args()

    target_uid = _target_uid(args.email)
    current_uid = _secret(args.secret_project, "REVIEWER_UID")
    passphrase = _secret(args.secret_project, "REVIEWER_VAULT_PASSPHRASE")
    unlock_ok = _passphrase_unlocks_target(target_uid, passphrase)

    print(f"reviewer_identity_matches_target={str(current_uid == target_uid).lower()}")
    print(f"secret_manager_passphrase_unlocks_target={str(unlock_ok).lower()}")

    if not args.execute:
        print("mode=audit_only")
        return 0 if unlock_ok else 1
    if args.confirm_email != args.email:
        raise RuntimeError("--confirm-email must exactly match --email for execution.")
    if not unlock_ok:
        raise RuntimeError(
            "Refusing to repoint REVIEWER_UID because the canonical passphrase cannot unlock the target vault."
        )

    _add_uid_version(args.secret_project, target_uid)
    if _secret(args.secret_project, "REVIEWER_UID") != target_uid:
        raise RuntimeError("Secret Manager reviewer UID readback did not match the target.")
    print("reviewer_uid_secret_repointed=true")
    print("secret_version_readback_verified=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
