#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Stage the reviewed Dev owner cohort without changing live sign-in.

One explicit, non-retrying provider request. Unknown outcomes are observed, never
replayed. Existing deletion fences and two temporary INSERT fences survive process
loss. Receipts contain hashes and operation coordinates, never exported users.
"""

from __future__ import annotations
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "consent-protocol"))
from scripts.ops.firebase_identity_migration_policy import (
    SOURCE,
    TARGET,
    MARKER as MARKER,
    Refused,
    canonical,
    identity_hash,
    record as record,
    hash_parameters,
    staged_record,
    staged_differences,
    matches_staged,
    require,
    sha,
)
from scripts.ops.firebase_identity_migration_fence import (
    RELEASE_KEY,
    FENCES,
    owner_snapshot,
    fence_sql as fence_sql,
    trigger_comments as trigger_comments,
    fences_absent,
    install_fences,
    verify_fences,
    remove_fences,
    validate_operation,
    drain,
)


def save_receipt(path, value):
    """Atomic replacement with data and parent-directory durability."""
    path = Path(path)
    require(path.parent.is_dir() and not path.is_symlink(), "RECEIPT_PATH_INVALID")
    fd, temporary = tempfile.mkstemp(prefix=".auth-import-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(canonical(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def receipt_lock(path):
    fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        raise Refused("OPERATOR_ALREADY_RUNNING") from None
    finally:
        os.close(fd)


def export_users(session, project):
    users, page = [], None
    while True:
        params = {"maxResults": 1000, **({"nextPageToken": page} if page else {})}
        response = session.get(
            f"https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:batchGet",
            params=params,
            timeout=25,
            allow_redirects=False,
        )
        require(response.status_code == 200, "NATIVE_INVENTORY_UNAVAILABLE")
        data = response.json()
        users.extend(data.get("users", []))
        page = data.get("nextPageToken")
        if not page:
            return users


def reconcile(receipt, wanted, actual):
    expected = {identity_hash(uid): user for uid, user in wanted.items()}
    observed = {identity_hash(user["localId"]): user for user in actual}
    require(
        len(observed) == len(actual) and not observed.keys() - expected.keys(),
        "FOREIGN_TARGET_IDENTITY",
    )
    states = {}
    for digest, user in expected.items():
        native = observed.get(digest)
        states[digest] = (
            "absent"
            if native is None
            else (
                "verified"
                if matches_staged(native, user, receipt["operation"])
                else "foreign"
            )
        )
    changed = sorted(
        {
            key
            for digest, user in expected.items()
            if states[digest] == "foreign"
            for key in staged_differences(observed[digest], user, receipt["operation"])
        }
    )
    require(not changed, "TARGET_RECORD_CHANGED:" + ",".join(changed))
    return states


def prepare_stage(conn, session, manifest, path, *, resume):
    manifest_hash = sha(manifest)
    if resume:
        require(
            path.is_file()
            and not path.is_symlink()
            and path.stat().st_mode & 0o077 == 0,
            "PRIVATE_RECEIPT_REQUIRED",
        )
        receipt = json.loads(path.read_text())
        require(receipt["manifestSha256"] == manifest_hash, "RECEIPT_MANIFEST_CHANGED")
        require(
            str(UUID(receipt["operation"])) == receipt["operation"], "OPERATION_INVALID"
        )
        require(
            type(receipt.get("requestDispatched")) is bool
            and receipt["requestDispatched"] == bool(receipt.get("requestSha256")),
            "RECEIPT_DISPATCH_STATE_INVALID",
        )
    else:
        require(not path.exists(), "RECEIPT_ALREADY_EXISTS")
        require(not export_users(session, TARGET), "TARGET_NOT_EMPTY")
        receipt = {
            "manifestSha256": manifest_hash,
            "operation": str(uuid4()),
            "phase": "fence_intent",
            "requestDispatched": False,
        }
        save_receipt(path, receipt)
    operation = {"operation": receipt["operation"], "manifestSha256": manifest_hash}
    if receipt.get("requestSha256"):
        operation["requestSha256"] = receipt["requestSha256"]
    validate_operation(operation)
    if receipt.get("fencesRemoved") is True or (
        receipt.get("phase") == "staged_disabled_verified" and fences_absent(conn)
    ):
        require(
            resume and receipt["phase"] == "staged_disabled_verified", "RECEIPT_INVALID"
        )
        require(fences_absent(conn), "FENCE_REMOVAL_UNCONFIRMED")
        fresh, selected = owner_snapshot(conn, export_users(session, SOURCE))
        require(fresh == manifest, "OWNER_OR_SOURCE_CHANGED")
        require(
            set(reconcile(receipt, selected, export_users(session, TARGET)).values())
            == {"verified"},
            "COMPLETED_TARGET_CHANGED",
        )
        receipt["fencesRemoved"] = True
        save_receipt(path, receipt)
        return receipt, operation, True
    return receipt, operation, False


def dispatch_stage(conn, session, selected, path, receipt, operation):
    require(not export_users(session, TARGET), "TARGET_CHANGED_BEFORE_DISPATCH")
    response = session.get(
        f"https://identitytoolkit.googleapis.com/admin/v2/projects/{SOURCE}/config",
        timeout=25,
        allow_redirects=False,
    )
    require(response.status_code == 200, "SOURCE_HASH_CONFIG_UNAVAILABLE")
    config = response.json()["signIn"]["hashConfig"]
    payload = hash_parameters(config)
    payload.update(
        hashAlgorithm="SCRYPT",
        allowOverwrite=False,
        sanityCheck=True,
        users=[
            staged_record(selected[uid], receipt["operation"])
            for uid in sorted(selected)
        ],
    )
    receipt.update(
        phase="dispatched_or_uncertain",
        requestDispatched=True,
        requestSha256=sha(payload),
        passwordConfigSha256=sha(config),
    )
    save_receipt(path, receipt)
    # Persist native dispatch evidence before the sole, non-retrying request.
    verify_fences(conn, operation)
    operation["requestSha256"] = receipt["requestSha256"]
    for table, name in FENCES.items():
        conn.exec_driver_sql(
            f"COMMENT ON TRIGGER {name} ON public.{table} IS '{canonical(operation)}'"
        )
    conn.commit()
    verify_fences(conn, operation)
    conn.commit()
    response = session.post(
        f"https://identitytoolkit.googleapis.com/v1/projects/{TARGET}/accounts:batchCreate",
        json=payload,
        timeout=30,
        allow_redirects=False,
    )
    receipt["httpStatus"] = response.status_code
    if response.status_code != 200:
        try:
            code = str(response.json().get("error", {}).get("message", "")).split(
                " : ", 1
            )[0]
            receipt["providerErrorCode"] = (
                code if re.fullmatch(r"[A-Z_]{2,80}", code) else "UNCLASSIFIED"
            )
        except (ValueError, AttributeError):
            receipt["providerErrorCode"] = "UNCLASSIFIED"
    save_receipt(path, receipt)


def settle_stage(conn, session, manifest, selected, path, receipt, operation):
    states = reconcile(receipt, selected, export_users(session, TARGET))
    receipt.update(phase="observed", identities=states)
    save_receipt(path, receipt)
    require(set(states.values()) == {"verified"}, "IMPORT_INCOMPLETE_OBSERVE_ONLY")
    final_manifest, _ = owner_snapshot(conn, export_users(session, SOURCE))
    require(final_manifest == manifest, "SOURCE_CHANGED_AFTER_IMPORT")
    verify_fences(conn, operation)
    conn.commit()
    receipt["phase"] = "staged_disabled_verified"
    save_receipt(path, receipt)
    with conn.begin():
        remove_fences(conn, operation)
    receipt["fencesRemoved"] = True
    save_receipt(path, receipt)
    return receipt


def stage(conn, session, manifest, path, *, resume):
    from sqlalchemy import text

    receipt, operation, completed = prepare_stage(
        conn, session, manifest, path, resume=resume
    )
    if completed:
        return receipt
    acquired = conn.execute(
        text("SELECT pg_try_advisory_lock(hashtextextended(:key,0))"),
        {"key": RELEASE_KEY},
    ).scalar_one()
    require(acquired is True, "RELEASE_OPERATOR_ACTIVE")
    conn.commit()
    try:
        with conn.begin():
            install_fences(conn, operation)
        fresh_manifest, fresh_selected = owner_snapshot(
            conn, export_users(session, SOURCE)
        )
        require(fresh_manifest == manifest, "OWNER_OR_SOURCE_CHANGED")
        conn.commit()
        verify_fences(conn, operation)
        conn.commit()
        if not receipt["requestDispatched"]:
            dispatch_stage(conn, session, fresh_selected, path, receipt, operation)
        return settle_stage(
            conn, session, manifest, fresh_selected, path, receipt, operation
        )
    finally:
        conn.rollback()
        conn.execute(
            text("SELECT pg_advisory_unlock(hashtextextended(:key,0))"),
            {"key": RELEASE_KEY},
        )
        conn.commit()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=(
            "plan",
            "stage",
            "observe",
            "activation-plan",
            "activate",
            "observe-activation",
        ),
        nargs="?",
        default="plan",
    )
    parser.add_argument("--environment", choices=("dev",), required=True)
    parser.add_argument("--database-port", type=int, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--staging-receipt", type=Path)
    parser.add_argument("--activation-manifest", type=Path)
    return parser.parse_args()


def operate(conn, session, source, args):
    from scripts.ops.firebase_identity_activation import (
        activation_plan,
        activate,
        private_receipt,
        workos_snapshot,
    )

    drain(conn)
    manifest, selected = owner_snapshot(conn, export_users(session, SOURCE))
    conn.rollback()
    if args.action == "plan":
        require(
            not args.apply and not export_users(session, TARGET), "TARGET_NOT_EMPTY"
        )
        manifest["liveSource"] = source
        save_receipt(args.manifest, manifest)
        return {
            "owners": len(selected),
            "manifestSha256": sha(manifest),
            "existingUsersChanged": 0,
        }
    reviewed = private_receipt(args.manifest)
    require(reviewed.pop("liveSource") == source, "LIVE_SOURCE_CHANGED")
    require(reviewed == manifest, "OWNER_OR_SOURCE_CHANGED")
    if args.action == "activation-plan":
        require(
            not args.apply and args.staging_receipt and args.activation_manifest,
            "ACTIVATION_PLAN_PATHS_REQUIRED",
        )
        require(fences_absent(conn), "STAGING_FENCES_PRESENT")
        plan = activation_plan(
            private_receipt(args.staging_receipt),
            manifest,
            selected,
            export_users(session, TARGET),
            workos=workos_snapshot(conn, selected, manifest),
        )
        plan["liveSource"] = source
        save_receipt(args.activation_manifest, plan)
        return {
            "owners": len(selected),
            "manifestSha256": sha(plan),
            "existingUsersChanged": 0,
        }
    require(args.apply and args.receipt is not None, "EXPLICIT_APPLY_REQUIRED")
    plan = {**reviewed, "liveSource": source}
    if args.action in {"activate", "observe-activation"}:
        require(
            args.activation_manifest and args.staging_receipt,
            "ACTIVATION_PLAN_PATHS_REQUIRED",
        )
        plan = private_receipt(args.activation_manifest)
        require(
            plan["ownerManifest"] == manifest and plan["liveSource"] == source,
            "ACTIVATION_PLAN_CHANGED",
        )
        require(
            plan["stagingReceiptSha256"] == sha(private_receipt(args.staging_receipt)),
            "STAGING_RECEIPT_CHANGED",
        )
    require(args.manifest_sha256 == sha(plan), "REVIEWED_MANIFEST_REQUIRED")
    with receipt_lock(args.receipt):
        if args.action in {"activate", "observe-activation"}:
            result = activate(
                conn,
                session,
                plan,
                args.receipt,
                resume=args.action == "observe-activation",
            )
        else:
            result = stage(
                conn, session, manifest, args.receipt, resume=args.action == "observe"
            )
    return {
        "owners": len(selected),
        "phase": result["phase"],
        "fencesRemoved": result.get("fencesRemoved", False),
    }


def main():
    args = arguments()
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    from requests.adapters import HTTPAdapter
    from scripts.ops.recover_dev_cloud_removal import dev_database

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
        quota_project_id=TARGET,
    )
    with AuthorizedSession(credentials, max_refresh_attempts=0) as session:
        session.trust_env = False
        session.mount("https://", HTTPAdapter(max_retries=0))
        with dev_database(
            args.database_port, readonly=args.action in {"plan", "activation-plan"}
        ) as (
            engine,
            source,
        ):
            with engine.connect() as conn:
                from db.firebase_erasure_adoption import qualification_sql
                from sqlalchemy import text

                conn.execute(text(qualification_sql(required=True)))
                conn.rollback()
                print(canonical(operate(conn, session, source, args)))


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        raise SystemExit(str(error)) from None
    except Exception as error:
        raise SystemExit("AUTH_IMPORT_UNCONFIRMED_" + type(error).__name__) from None
