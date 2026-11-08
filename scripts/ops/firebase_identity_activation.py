# SPDX-License-Identifier: Apache-2.0
"""Activate only an owned disabled import, without replacing identity records.

Every dispatched UID is bound into the existing native fence checkpoint. A lost
acknowledgment permits observation only, including after local receipt rollback.
"""

from __future__ import annotations

import json
from uuid import uuid4

from scripts.ops.firebase_identity_migration_policy import (
    MARKER,
    SOURCE,
    TARGET,
    canonical,
    identity_hash,
    matches_staged,
    record,
    require,
    sha,
    unexpected_credentials,
)
from scripts.ops.firebase_identity_migration_fence import (
    FENCES,
    RELEASE_KEY,
    fences_absent,
    install_fences,
    owner_snapshot,
    remove_fences,
    trigger_comments,
    validate_operation,
    verify_fences,
)


def private_receipt(path):
    require(
        path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
        "PRIVATE_RECEIPT_REQUIRED",
    )
    return json.loads(path.read_text())


def workos_snapshot(conn, selected, manifest, *, lock=False):
    from sqlalchemy import text
    from hushh_mcp.services.enterprise_sso.membership import membership_hash

    bindings = {row["identityHash"]: row for row in manifest["owners"]}
    result = {}
    for uid, user in selected.items():
        claims = json.loads(user["customAttributes"])
        if not any(
            key in claims for key in ("workosOrgId", "workosUserId", "workosOrigin")
        ):
            continue
        require(
            all(
                claims.get(key)
                for key in ("workosOrgId", "workosUserId", "workosOrigin")
            ),
            "WORKOS_CLAIMS_INCOMPLETE",
        )
        profile = membership_hash(claims["workosOrgId"], claims["workosUserId"])
        digest = identity_hash(uid)
        binding = bindings[digest]
        rows = (
            conn.execute(
                text(
                    """SELECT to_jsonb(m)::text AS membership,
            g.owner_id,g.retired_at,g.identity_uid
            FROM public.account_workos_memberships m
            LEFT JOIN public.account_generations g ON g.identity_hash=m.identity_hash
             AND g.owner_hash=m.owner_hash AND g.generation=m.generation
            WHERE m.profile_hash=:profile"""
                    + (" FOR SHARE OF m" if lock else "")
                ),
                {"profile": profile},
            )
            .mappings()
            .all()
        )
        require(
            len(rows) <= 1 and binding["generation"] == 0, "WORKOS_ATTRIBUTION_CHANGED"
        )
        membership = None
        if rows:
            row = rows[0]
            membership = json.loads(row["membership"])
            require(
                membership["owner_hash"] == binding["ownerHash"]
                and membership["identity_hash"] == digest
                and membership["generation"] == binding["generation"]
                and membership["origin"] == claims["workosOrigin"]
                and membership["offboarded_at"] is None
                and row["retired_at"] is None
                and row["identity_uid"] == uid
                and identity_hash(row["owner_id"] or "") == binding["ownerHash"],
                "WORKOS_ATTRIBUTION_CHANGED",
            )
        result[digest] = {
            "profileHash": profile,
            "origin": claims["workosOrigin"],
            "membershipSha256": sha(membership),
        }
    return result


def activation_plan(staging, manifest, selected, actual, *, workos=None):
    require(
        staging.get("phase") == "staged_disabled_verified"
        and staging.get("fencesRemoved") is True
        and staging.get("manifestSha256") == sha(manifest),
        "QUALIFIED_STAGING_REQUIRED",
    )
    by_uid = {u["localId"]: u for u in actual}
    require(
        len(by_uid) == len(actual) and by_uid.keys() == selected.keys(),
        "TARGET_COHORT_CHANGED",
    )
    targets = {}
    for uid, wanted in selected.items():
        current = by_uid[uid]
        require(
            matches_staged(current, wanted, staging["operation"]),
            "STAGED_RECORD_CHANGED",
        )
        expected = record(wanted)
        if "validSince" in current:
            expected["validSince"] = current["validSince"]
        targets[identity_hash(uid)] = {
            "stagedSha256": sha(
                record({**current, "customAttributes": wanted["customAttributes"]})
            ),
            "postimageSha256": sha(expected),
            "validSince": expected.get("validSince"),
        }
    return {
        "schema": "hussh.dev-auth-activation.v1",
        "stagingReceiptSha256": sha(staging),
        "stagingOperation": staging["operation"],
        "ownerManifest": manifest,
        "targets": targets,
        "workos": workos or {},
    }


def observed_state(user, wanted, target, staging_operation):
    if matches_staged(user, wanted, staging_operation):
        cleaned = record({**user, "customAttributes": wanted["customAttributes"]})
        if sha(cleaned) == target["stagedSha256"]:
            return "staged"
    if MARKER not in json.loads(user.get("customAttributes") or "{}"):
        cleaned = record(user)
        if unexpected_credentials(cleaned, wanted):
            return "foreign"
        # Native informational defaults are not mutations of preserved fields.
        expected_keys = set(wanted) | (
            {"validSince"} if target["validSince"] is not None else set()
        )
        cleaned = {key: value for key, value in cleaned.items() if key in expected_keys}
        if sha(cleaned) == target["postimageSha256"]:
            return "active"
    return "foreign"


def observe_activation(conn, session, plan, history):
    from scripts.ops.firebase_identity_migration import export_users

    manifest, selected = owner_snapshot(conn, export_users(session, SOURCE))
    require(manifest == plan["ownerManifest"], "OWNER_OR_SOURCE_CHANGED")
    require(
        workos_snapshot(conn, selected, manifest) == plan.get("workos", {}),
        "WORKOS_ATTRIBUTION_CHANGED",
    )
    actual = export_users(session, TARGET)
    by_uid = {u["localId"]: u for u in actual}
    require(
        len(by_uid) == len(actual) and by_uid.keys() == selected.keys(),
        "TARGET_COHORT_CHANGED",
    )
    dispatched = {row["identityHash"] for row in history}
    require(
        len(dispatched) == len(history) and dispatched <= plan["targets"].keys(),
        "ACTIVATION_HISTORY_INVALID",
    )
    for uid, wanted in selected.items():
        digest = identity_hash(uid)
        state = observed_state(
            by_uid[uid], wanted, plan["targets"][digest], plan["stagingOperation"]
        )
        require(
            state == ("active" if digest in dispatched else "staged"),
            "ACTIVATION_OUTCOME_UNCONFIRMED",
        )
    return selected


def checkpoint_operation(receipt, history):
    operation = {
        "operation": receipt["operation"],
        "manifestSha256": receipt["manifestSha256"],
    }
    if history:
        operation["requestSha256"] = sha(history)
    validate_operation(operation)
    return operation


def publish_checkpoint(conn, previous, current):
    verify_fences(conn, previous)
    validate_operation(current)
    for table, name in FENCES.items():
        conn.exec_driver_sql(
            f"COMMENT ON TRIGGER {name} ON public.{table} IS '{canonical(current)}'"
        )
    conn.commit()
    verify_fences(conn, current)
    conn.commit()


def adopt_checkpoint(conn, receipt):
    operation = checkpoint_operation(receipt, receipt["history"])
    comments = trigger_comments(conn)
    if comments == dict.fromkeys(FENCES.values(), canonical(operation)):
        verify_fences(conn, operation)
    elif receipt["history"]:
        previous = checkpoint_operation(receipt, receipt["history"][:-1])
        # A fsynced intent can precede the native checkpoint. Adopt only that
        # exact predecessor; the request remains observation-only on resume.
        publish_checkpoint(conn, previous, operation)
    else:
        install_fences(conn, operation)
    return operation


def dispatch_activation(conn, session, plan, path, receipt, selected, operation):
    from scripts.ops.firebase_identity_migration import export_users, save_receipt

    attempted = {row["identityHash"] for row in receipt["history"]}
    for uid in sorted(selected):
        digest = identity_hash(uid)
        if digest in attempted:
            continue
        # An administrator update cannot recreate a missing UID, and only these
        # two attributes are changed. Password/provider/MFA/cutoff are untouched.
        users = {u["localId"]: u for u in export_users(session, TARGET)}
        require(uid in users, "ACTIVATION_IDENTITY_MISSING")
        require(
            observed_state(
                users[uid],
                selected[uid],
                plan["targets"][digest],
                plan["stagingOperation"],
            )
            == "staged",
            "STAGED_RECORD_CHANGED",
        )
        payload = {
            "localId": uid,
            "disableUser": selected[uid]["disabled"],
            "customAttributes": selected[uid]["customAttributes"],
        }
        receipt["history"].append(
            {"identityHash": digest, "requestSha256": sha(payload)}
        )
        receipt["phase"] = "dispatched_or_uncertain"
        save_receipt(path, receipt)
        current = checkpoint_operation(receipt, receipt["history"])
        publish_checkpoint(conn, operation, current)
        operation = current
        # Offboarding does not use the global release lease. Hold its existing
        # attribution rows across HTTP; a lost session still cannot authorize
        # replay or settlement against a changed membership. Absent bindings
        # cannot be captured while the generation INSERT fence is installed.
        require(
            workos_snapshot(conn, selected, plan["ownerManifest"], lock=True)
            == plan.get("workos", {}),
            "WORKOS_ATTRIBUTION_CHANGED",
        )
        response = session.post(
            f"https://identitytoolkit.googleapis.com/v1/projects/{TARGET}/accounts:update",
            json=payload,
            timeout=25,
            allow_redirects=False,
        )
        receipt["lastHttpStatus"] = response.status_code
        save_receipt(path, receipt)
        require(response.status_code == 200, "ACTIVATION_OUTCOME_UNCONFIRMED")
        # Full mixed-cohort readback settles this UID before the next request.
        observe_activation(conn, session, plan, receipt["history"])
        conn.commit()
    return operation


def activate(conn, session, plan, path, *, resume):
    from sqlalchemy import text
    from scripts.ops.firebase_identity_migration import save_receipt

    if resume:
        receipt = private_receipt(path)
        require(receipt["manifestSha256"] == sha(plan), "RECEIPT_MANIFEST_CHANGED")
    else:
        require(not path.exists(), "RECEIPT_ALREADY_EXISTS")
        receipt = {
            "operation": str(uuid4()),
            "manifestSha256": sha(plan),
            "phase": "fence_intent",
            "history": [],
        }
        save_receipt(path, receipt)
    require(
        conn.execute(
            text("SELECT pg_try_advisory_lock(hashtextextended(:key,0))"),
            {"key": RELEASE_KEY},
        ).scalar_one()
        is True,
        "RELEASE_OPERATOR_ACTIVE",
    )
    conn.commit()
    try:
        selected = observe_activation(conn, session, plan, receipt["history"])
        conn.commit()
        if receipt["phase"] == "activated_verified" and fences_absent(conn):
            require(len(receipt["history"]) == len(selected), "ACTIVATION_INCOMPLETE")
            receipt["fencesRemoved"] = True
            save_receipt(path, receipt)
            return receipt
        operation = adopt_checkpoint(conn, receipt)
        conn.commit()
        observe_activation(conn, session, plan, receipt["history"])
        conn.commit()
        operation = dispatch_activation(
            conn, session, plan, path, receipt, selected, operation
        )
        observe_activation(conn, session, plan, receipt["history"])
        conn.commit()
        receipt["phase"] = "activated_verified"
        save_receipt(path, receipt)
        with conn.begin():
            remove_fences(conn, operation)
        receipt["fencesRemoved"] = True
        save_receipt(path, receipt)
        return receipt
    finally:
        conn.rollback()
        conn.execute(
            text("SELECT pg_advisory_unlock(hashtextextended(:key,0))"),
            {"key": RELEASE_KEY},
        )
        conn.commit()
