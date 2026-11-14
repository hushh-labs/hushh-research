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
    TARGET,
    UAT_TARGET,
    manifest_target,
    canonical,
    identity_hash,
    matches_staged,
    record,
    require,
    sha,
    unexpected_credentials,
)
from scripts.ops.firebase_identity_migration_fence import (
    operation_fences,
    RELEASE_KEY,
    fences_absent,
    install_fences,
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
        replacement = binding["generation"] > 0
        if replacement:
            # Preserve independent sign-in and historical provenance, without
            # enrolling a replacement in its deleted generation's WorkOS access.
            require(
                manifest_target(manifest) == UAT_TARGET
                and not claims.get("workosDeprovisionedAt")
                and any(
                    p.get("providerId") == "google.com" and p.get("rawId")
                    for p in user.get("providerUserInfo", [])
                ),
                "WORKOS_ATTRIBUTION_CHANGED",
            )
        predicate = "m.profile_hash=:profile"
        if replacement:
            predicate = (
                "("
                + predicate
                + " OR m.identity_hash=:identity OR m.owner_hash=:owner)"
            )
        rows = (
            conn.execute(
                text(
                    """SELECT to_jsonb(m)::text AS membership,
            g.owner_id,g.retired_at,g.identity_uid
            FROM public.account_workos_memberships m
            LEFT JOIN public.account_generations g ON g.identity_hash=m.identity_hash
             AND g.owner_hash=m.owner_hash AND g.generation=m.generation
            WHERE """
                    + predicate
                    + (" FOR SHARE OF m" if lock else "")
                ),
                {"profile": profile, "identity": digest, "owner": binding["ownerHash"]},
            )
            .mappings()
            .all()
        )
        require(
            len(rows) <= 1 and (not replacement or not rows),
            "WORKOS_ATTRIBUTION_CHANGED",
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
        if replacement:
            result[digest]["preservedReplacementGeneration"] = binding["generation"]
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
    target_project = manifest_target(manifest)
    retained = manifest.get("retainedTargets", {})
    targets = {}
    for uid, wanted in selected.items():
        current = by_uid[uid]
        if identity_hash(uid) in retained:
            require(
                sha(record(current)) == retained[identity_hash(uid)]["recordSha256"],
                "RETAINED_TARGET_CHANGED",
            )
            continue
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
        "schema": "hussh.dev-auth-activation.v1"
        if target_project == TARGET
        else "hussh.uat-auth-activation.v2",
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
    from scripts.ops.firebase_identity_migration import (
        export_users,
        snapshot_for_manifest,
    )

    manifest, selected = snapshot_for_manifest(conn, session, plan["ownerManifest"])
    require(manifest == plan["ownerManifest"], "OWNER_OR_SOURCE_CHANGED")
    require(
        workos_snapshot(conn, selected, manifest) == plan.get("workos", {}),
        "WORKOS_ATTRIBUTION_CHANGED",
    )
    actual = export_users(session, manifest_target(manifest))
    by_uid = {u["localId"]: u for u in actual}
    require(
        len(by_uid) == len(actual) and by_uid.keys() == selected.keys(),
        "TARGET_COHORT_CHANGED",
    )
    by_hash = {identity_hash(uid): user for uid, user in selected.items()}
    require(
        all(
            set(row) == {"identityHash", "requestSha256"}
            and row["identityHash"] in plan["targets"]
            and row["requestSha256"]
            == sha(
                {
                    "localId": by_hash[row["identityHash"]]["localId"],
                    "disableUser": by_hash[row["identityHash"]]["disabled"],
                    "customAttributes": by_hash[row["identityHash"]][
                        "customAttributes"
                    ],
                }
            )
            for row in history
        ),
        "ACTIVATION_HISTORY_INVALID",
    )
    dispatched = {row["identityHash"] for row in history}
    require(
        len(dispatched) == len(history) and dispatched <= plan["targets"].keys(),
        "ACTIVATION_HISTORY_INVALID",
    )
    for uid, wanted in selected.items():
        digest = identity_hash(uid)
        if digest in manifest.get("retainedTargets", {}):
            require(
                sha(record(by_uid[uid]))
                == manifest["retainedTargets"][digest]["recordSha256"],
                "RETAINED_TARGET_CHANGED",
            )
            continue
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
    if receipt.get("version") == 2:
        operation.update(version=2, targetProject=UAT_TARGET)
    if history:
        operation["requestSha256"] = sha(history)
    validate_operation(operation)
    return operation


def publish_checkpoint(conn, previous, current):
    verify_fences(conn, previous)
    validate_operation(current)
    for table, name in operation_fences(current).items():
        conn.exec_driver_sql(
            f"COMMENT ON TRIGGER {name} ON public.{table} IS '{canonical(current)}'"
        )
    conn.commit()
    verify_fences(conn, current)
    conn.commit()


def adopt_checkpoint(conn, receipt):
    operation = checkpoint_operation(receipt, receipt["history"])
    comments = trigger_comments(conn, operation)
    if comments == dict.fromkeys(
        operation_fences(operation).values(), canonical(operation)
    ):
        verify_fences(conn, operation)
    elif receipt["history"]:
        previous = checkpoint_operation(receipt, receipt["history"][:-1])
        # A fsynced intent can precede the native checkpoint. Adopt only that
        # exact predecessor; the request remains observation-only on resume.
        publish_checkpoint(conn, previous, operation)
    else:
        install_fences(conn, operation)
    return operation


def activation_user(session, target_project, uid, *, password_record):
    from scripts.ops.firebase_identity_migration import export_users

    if password_record:
        # accounts:lookup redacts passwordHash/salt even for an administrator.
        # Only the native export can establish these preserved fields.
        users = [
            u for u in export_users(session, target_project) if u["localId"] == uid
        ]
    else:
        response = session.post(
            f"https://identitytoolkit.googleapis.com/v1/projects/{target_project}/accounts:lookup",
            json={"localId": [uid]},
            timeout=25,
            allow_redirects=False,
        )
        require(response.status_code == 200, "NATIVE_INVENTORY_UNAVAILABLE")
        users = response.json().get("users", [])
    require(
        len(users) == 1 and users[0]["localId"] == uid, "ACTIVATION_IDENTITY_MISSING"
    )
    return users[0]


def dispatch_activation(conn, session, plan, path, receipt, selected, operation):
    from scripts.ops.firebase_identity_migration import export_users, save_receipt

    attempted = {row["identityHash"] for row in receipt["history"]}
    for uid in sorted(selected):
        digest = identity_hash(uid)
        if digest not in plan["targets"] or digest in attempted:
            continue
        # An administrator update cannot recreate a missing UID, and only these
        # two attributes are changed. Password/provider/MFA/cutoff are untouched.
        target_project = manifest_target(plan["ownerManifest"])
        password_record = bool(
            selected[uid].get("passwordHash") or selected[uid].get("salt")
        )
        if target_project == UAT_TARGET:
            users = {
                uid: activation_user(
                    session, target_project, uid, password_record=password_record
                )
            }
        else:
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
        scoped_selected = (
            {uid: selected[uid]} if target_project == UAT_TARGET else selected
        )
        expected_workos = (
            (
                {digest: plan["workos"][digest]}
                if digest in plan.get("workos", {})
                else {}
            )
            if target_project == UAT_TARGET
            else plan.get("workos", {})
        )
        require(
            workos_snapshot(conn, scoped_selected, plan["ownerManifest"], lock=True)
            == expected_workos,
            "WORKOS_ATTRIBUTION_CHANGED",
        )
        response = session.post(
            f"https://identitytoolkit.googleapis.com/v1/projects/{target_project}/accounts:update",
            json=payload,
            timeout=25,
            allow_redirects=False,
        )
        receipt["lastHttpStatus"] = response.status_code
        save_receipt(path, receipt)
        require(response.status_code == 200, "ACTIVATION_OUTCOME_UNCONFIRMED")
        if target_project == UAT_TARGET:
            native = activation_user(
                session, target_project, uid, password_record=password_record
            )
            require(
                observed_state(
                    native,
                    selected[uid],
                    plan["targets"][digest],
                    plan["stagingOperation"],
                )
                == "active",
                "ACTIVATION_OUTCOME_UNCONFIRMED",
            )
        else:
            observe_activation(conn, session, plan, receipt["history"])
        conn.commit()
    return operation


def activate(conn, session, plan, path, *, resume, observe_only=False):
    from sqlalchemy import text
    from scripts.ops.firebase_identity_migration import save_receipt

    target_project = manifest_target(plan["ownerManifest"])
    if resume:
        receipt = private_receipt(path)
        require(
            (type(receipt.get("version")) is int and receipt["version"] == 2)
            if target_project == UAT_TARGET
            else "version" not in receipt,
            "RECEIPT_CONTEXT_CHANGED",
        )
        require(receipt["manifestSha256"] == sha(plan), "RECEIPT_MANIFEST_CHANGED")
    else:
        require(not path.exists(), "RECEIPT_ALREADY_EXISTS")
        receipt = {
            "operation": str(uuid4()),
            "manifestSha256": sha(plan),
            "phase": "fence_intent",
            "history": [],
        }
        if target_project == UAT_TARGET:
            receipt["version"] = 2
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
        if receipt["phase"] == "activated_verified" and fences_absent(
            conn, target_project=target_project
        ):
            require(
                len(receipt["history"]) == len(plan["targets"]), "ACTIVATION_INCOMPLETE"
            )
            receipt["fencesRemoved"] = True
            save_receipt(path, receipt)
            return receipt
        operation = adopt_checkpoint(conn, receipt)
        conn.commit()
        observe_activation(conn, session, plan, receipt["history"])
        conn.commit()
        if observe_only and len(receipt["history"]) != len(plan["targets"]):
            return receipt
        if not observe_only:
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
