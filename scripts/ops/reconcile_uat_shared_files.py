"""Verify an already-empty UAT erasure prefix without deleting any object.

Dry run is the default. The temporary retention query is protected by durable
enrollment and write barriers. Any uncertainty retains those barriers. No CI,
IAM, account-deletion claim, bucket incarnation or unrelated object is changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

PROJECT = "hushh-pda-uat"
RELEASE_KEY = "hushh.account-deletion.release.v1"
POLICY_SECONDS = "604800"
AUDIT_LOG = "projects/" + PROJECT + "/logs/cloudaudit.googleapis.com%2Factivity"
AUDIT_TYPE = "type.googleapis.com/google.cloud.audit.AuditLog"
PROTECTED_COLUMNS = ("bucket", "user_id", "library_id", "prefix", "bucket_admission")
QUALIFIED_FILES = tuple(
    "consent-protocol/hushh_mcp/services/shared_files/" + name
    for name in (
        "registry.py",
        "uploads.py",
        "writes.py",
        "write_receipts.py",
        "erasure.py",
        "erasure_objects.py",
        "reconciliation.py",
    )
) + (
    "consent-protocol/api/routes/one/shared_files.py",
    "consent-protocol/hushh_mcp/services/shared_files/bucket_admission.py",
    "consent-protocol/hushh_mcp/services/account_service.py",
    "consent-protocol/hushh_mcp/services/drive_owner_shared_files.py",
    "consent-protocol/hushh_mcp/services/pod_commit_log.py",
)


FUNCTION = "hushh_files_operator_maintenance"
TRIGGER = "trg_hushh_files_operator_maintenance"
PROTOCOL = "operator_bucket_maintenance.v1"
BODY = """
DECLARE scoped boolean;
BEGIN
  IF TG_OP='INSERT' THEN scoped := NEW.bucket=TG_ARGV[0];
  ELSIF TG_OP='DELETE' THEN scoped := OLD.bucket=TG_ARGV[0];
  ELSE scoped := OLD.bucket=TG_ARGV[0] OR NEW.bucket=TG_ARGV[0]; END IF;
  IF scoped THEN
    RAISE EXCEPTION USING ERRCODE='55000',
      MESSAGE='Files enrollment is paused for verified storage maintenance';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
"""


class RecoveryRefused(RuntimeError):
    """Fixed reason only; never include owner information or provider bodies."""


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise RecoveryRefused(reason)


def decoded(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def owner_prefix(owner: str) -> str:
    return (
        "shared-files/v1/"
        + hashlib.sha256(("hussh/shared-files/v1/" + owner).encode()).hexdigest()
    )


def library_prefix(row: dict) -> str:
    require(row["prefix"] == owner_prefix(row["user_id"]), "owner_prefix_mismatch")
    return row["prefix"] + "/" + str(row["library_id"]) + "/"


def identity(metadata: dict) -> dict:
    keys = ("name", "generation", "timeCreated", "projectNumber")
    require(
        all(isinstance(metadata.get(key), str) and metadata[key] for key in keys),
        "bucket_identity_missing",
    )
    return {key: metadata[key] for key in keys}


def writable_policy(metadata: dict) -> dict:
    policy = metadata.get("softDeletePolicy") or {"retentionDurationSeconds": "0"}
    require(
        isinstance(policy, dict)
        and set(policy) <= {"retentionDurationSeconds", "effectiveTime"},
        "policy_schema_unknown",
    )
    return {"retentionDurationSeconds": policy.get("retentionDurationSeconds", "0")}


def validate_bucket(row: dict, metadata: dict) -> None:
    admission = decoded(row["bucket_admission"])
    require(
        isinstance(admission, dict)
        and set(admission) == {"identity", "noSoftDeleteHistory"},
        "bucket_admission_invalid",
    )
    require(admission["identity"] == identity(metadata), "bucket_incarnation_changed")
    iam = metadata.get("iamConfiguration", {})
    require(
        iam.get("publicAccessPrevention") == "enforced"
        and iam.get("uniformBucketLevelAccess", {}).get("enabled") is True,
        "bucket_access_changed",
    )


def select_target(rows: list[dict], owner_hash: str) -> dict:
    targets = [
        row
        for row in rows
        if hashlib.sha256(row["user_id"].encode()).hexdigest().startswith(owner_hash)
    ]
    require(len(owner_hash) >= 16 and len(targets) == 1, "target_not_unique")
    target = targets[0]
    require(target["state"] == "erasing", "target_not_erasing")
    require(
        all(row["state"] == "active" or row is target for row in rows),
        "other_erasure_outstanding",
    )
    for row in rows:
        library_prefix(row)
    return target


def validate_initial(rows: list[dict]) -> None:
    require(bool(rows), "empty_cohort")
    require(
        all(
            not decoded(row["writes"])
            and row["lease_id"] is None
            and row["lease_until"] is None
            for row in rows
        ),
        "writer_not_quiescent",
    )


def validate_claim(target: dict, claims: list[dict]) -> None:
    require(len(claims) == 1, "deletion_intent_not_unique")
    claim = claims[0]
    receipt = decoded(claim["provider_cleanup_receipt"])
    require(
        claim.get("provider_qualified") is True,
        "canonical_deletion_qualification_failed",
    )
    require(
        claim["account_owner_id"] == target["user_id"]
        and claim["erasure_phase"] == "provider_cleanup"
        and claim["cleanup_intent_kind"] == "full_account",
        "deletion_intent_changed",
    )
    require(
        isinstance(receipt, dict)
        and receipt.get("version") in {1, 2}
        and receipt.get("cleanupId") == str(claim["provider_cleanup_id"])
        and receipt.get("localErasureAccepted") is True,
        "deletion_acceptance_unqualified",
    )
    require(
        receipt.get("ownerHash")
        == "sha256:" + hashlib.sha256(target["user_id"].strip().encode()).hexdigest(),
        "deletion_owner_mismatch",
    )
    items = receipt.get("items")
    require(isinstance(items, dict) and bool(items), "deletion_inventory_missing")
    require(
        all(
            isinstance(item, dict)
            and item.get("revocation")
            in {"revoked", "covered_by_group", "local_erasure_approved"}
            for item in items.values()
        ),
        "provider_effects_unsettled",
    )


def claim_fingerprint(claims: list[dict]) -> str:
    return hashlib.sha256(
        json.dumps(claims, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def target_fingerprint(target: dict) -> str:
    return hashlib.sha256(
        (target["user_id"] + "/" + str(target["library_id"])).encode()
    ).hexdigest()


def inventory_digest(objects: list[dict], rows: list[dict]) -> str:
    active = [library_prefix(row) for row in rows if row["state"] == "active"]
    inventory = []
    for item in objects:
        name, generation = item.get("name"), item.get("generation")
        require(
            isinstance(name, str)
            and isinstance(generation, str)
            and generation.isdigit(),
            "object_inventory_invalid",
        )
        require(
            any(name.startswith(prefix) for prefix in active),
            "object_outside_active_library",
        )
        inventory.append((name, generation))
    return hashlib.sha256(
        json.dumps(sorted(inventory), separators=(",", ":")).encode()
    ).hexdigest()


def validate_markers(rows: list[dict], key: str, marker: dict) -> None:
    require(
        marker.get("protocol") == PROTOCOL
        and marker.get("state") == "maintenance"
        and marker.get("originalPolicy") == {"retentionDurationSeconds": "0"},
        "maintenance_contract_changed",
    )
    require(len(rows) == marker["cohortSize"], "maintenance_cohort_changed")
    for row in rows:
        require(
            decoded(row["writes"]) == {key: marker}
            and str(row["lease_id"]) == marker["operation"],
            "maintenance_ownership_changed",
        )
        require(row["bucket"] == marker["bucket"], "maintenance_bucket_changed")


def absence_receipt(target: dict, metadata: dict) -> dict:
    validate_bucket(target, metadata)
    return {
        "version": 1,
        "libraryId": str(target["library_id"]),
        "bucket": target["bucket"],
        "prefix": library_prefix(target),
        "complete": True,
        "writesFenced": True,
        "activeAndRetainedObjectsAbsent": True,
        "bucketIdentityVerified": True,
        "bucketIdentity": identity(metadata),
    }


class Provider:
    def __init__(self, session, bucket: str, operation: str):
        self.session = session
        self.base = "https://storage.googleapis.com/storage/v1/b/" + quote(
            bucket, safe=""
        )
        self.reason = "hushh-uat-files-recovery/" + operation

    def metadata(self) -> dict:
        response = self.session.get(self.base, timeout=20, allow_redirects=False)
        require(response.status_code == 200, "bucket_metadata_unconfirmed")
        return response.json()

    def objects(self, *, prefix: str = "", retained: bool = False) -> list[dict]:
        objects, token = [], ""
        for _ in range(20):
            params = {
                "prefix": prefix,
                "maxResults": "100",
                "fields": "items(name,generation),nextPageToken",
                "softDeleted" if retained else "versions": "true",
            }
            if token:
                params["pageToken"] = token
            response = self.session.get(
                self.base + "/o", params=params, timeout=20, allow_redirects=False
            )
            require(
                response.status_code == 200,
                "retained_listing_unconfirmed"
                if retained
                else "versions_listing_unconfirmed",
            )
            body = response.json()
            page = body.get("items", [])
            require(isinstance(page, list) and len(page) <= 100, "object_page_invalid")
            objects.extend(page)
            token = body.get("nextPageToken", "")
            if not token:
                return objects
            require(bool(page), "empty_paginated_listing")
        raise RecoveryRefused("object_inventory_limit")

    def policy(self, before: dict, seconds: str) -> dict:
        response = self.session.patch(
            self.base,
            params={"ifMetagenerationMatch": before["metageneration"]},
            json={"softDeletePolicy": {"retentionDurationSeconds": seconds}},
            headers={"User-Agent": self.reason, "X-Goog-Request-Reason": self.reason},
            timeout=20,
            allow_redirects=False,
        )
        require(response.status_code == 200, "policy_mutation_unconfirmed")
        after = response.json()
        require(identity(after) == identity(before), "bucket_incarnation_changed")
        require(
            str(after.get("softDeletePolicy", {}).get("retentionDurationSeconds"))
            == seconds,
            "policy_response_mismatch",
        )
        return after

    def reconcile_policy_intent(self, marker: dict, current: dict) -> str:
        intent = marker.get("policyIntent", {})
        require(
            intent.get("reason") == self.reason
            and intent.get("principal") == marker["operator"]
            and intent.get("seconds") == POLICY_SECONDS,
            "policy_intent_missing",
        )
        require(
            identity(current) == marker["identity"]
            and writable_policy(current)
            == {"retentionDurationSeconds": POLICY_SECONDS},
            "policy_intent_mismatch",
        )
        require(
            str(int(intent["metageneration"]) + 1) == current["metageneration"],
            "policy_revision_unowned",
        )
        bucket = marker["bucket"]
        user_agent_pattern = "^" + re.escape(self.reason) + r"(,gzip\(gfe\))*$"
        # The unique caller marker plus authenticated principal proves the
        # successful CAS was ours, including a lost PATCH response/checkpoint.
        log_filter = " AND ".join(
            [
                "logName=" + json.dumps(AUDIT_LOG),
                "protoPayload.@type=" + json.dumps(AUDIT_TYPE),
                'resource.type="gcs_bucket"',
                f'resource.labels.bucket_name="{bucket}"',
                'protoPayload.serviceName="storage.googleapis.com"',
                'protoPayload.methodName="storage.buckets.update"',
                f'protoPayload.authenticationInfo.principalEmail="{marker["operator"]}"',
                "protoPayload.requestMetadata.callerSuppliedUserAgent=~"
                + json.dumps(user_agent_pattern),
                f'timestamp>="{intent["dispatchedAt"]}"',
            ]
        )
        response = self.session.post(
            "https://logging.googleapis.com/v2/entries:list",
            json={
                "resourceNames": ["projects/" + PROJECT],
                "filter": log_filter,
                "pageSize": 20,
                "orderBy": "timestamp desc",
            },
            timeout=20,
        )
        require(response.status_code == 200, "policy_audit_unconfirmed")
        body = response.json()
        entries = body.get("entries", [])
        require(
            not body.get("nextPageToken") and isinstance(entries, list),
            "policy_audit_incomplete",
        )
        successful = [
            entry
            for entry in entries
            if entry.get("logName") == AUDIT_LOG
            and entry.get("protoPayload", {}).get("@type") == AUDIT_TYPE
            and entry.get("resource", {}).get("type") == "gcs_bucket"
            and entry.get("resource", {}).get("labels", {}).get("bucket_name") == bucket
            and entry.get("protoPayload", {}).get("serviceName")
            == "storage.googleapis.com"
            and entry.get("protoPayload", {})
            .get("authenticationInfo", {})
            .get("principalEmail")
            == marker["operator"]
            and re.fullmatch(
                user_agent_pattern,
                entry.get("protoPayload", {})
                .get("requestMetadata", {})
                .get("callerSuppliedUserAgent", ""),
            )
            and datetime.fromisoformat(entry.get("timestamp", ""))
            >= datetime.fromisoformat(intent["dispatchedAt"])
            and entry.get("protoPayload", {}).get("methodName")
            == "storage.buckets.update"
            and entry.get("protoPayload", {}).get("status", {}).get("code", 0) == 0
        ]
        require(len(successful) == 1, "policy_ownership_uncertain")
        return current["metageneration"]


class Database:
    def __init__(self, connection, bucket: str):
        self.connection, self.bucket = connection, bucket
        self.cursor = connection.cursor()

    def execute(self, sql, parameters=()):
        self.cursor.execute(sql, parameters)
        return self.cursor

    def table_lock(self):
        self.execute("SET LOCAL lock_timeout='5s'")
        self.execute("SET LOCAL statement_timeout='15s'")
        self.execute(
            "LOCK TABLE public.shared_files_storage IN SHARE ROW EXCLUSIVE MODE"
        )

    def rows(self):
        cursor = self.execute(
            "SELECT user_id,library_id,bucket,prefix,bucket_admission,state,lease_id,lease_until,writes,receipt FROM public.shared_files_storage WHERE bucket=%s ORDER BY user_id",
            (self.bucket,),
        )
        return [
            dict(zip((column[0] for column in cursor.description), values))
            for values in cursor.fetchall()
        ]

    def claim(self, target):
        cursor = self.execute(
            "SELECT account_owner_id,erasure_phase,cleanup_intent_kind,provider_cleanup_id,provider_cleanup_receipt,provider_cleanup_inventory,user_id_hash,cleanup_status,public.account_provider_cleanup_qualified(provider_cleanup_receipt,provider_cleanup_inventory,user_id_hash,provider_cleanup_id) AS provider_qualified FROM public.account_deletion_tombstones WHERE account_owner_id=%s FOR UPDATE",
            (target["user_id"],),
        )
        return [
            dict(zip((column[0] for column in cursor.description), values))
            for values in cursor.fetchall()
        ]

    def guard_absent(self):
        require(
            self.execute(
                "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.shared_files_storage'::regclass AND tgname=%s",
                (TRIGGER,),
            ).fetchone()[0]
            == 0,
            "existing_maintenance_guard",
        )
        require(
            self.execute(
                "SELECT to_regprocedure(%s)", ("public." + FUNCTION + "()",)
            ).fetchone()[0]
            is None,
            "existing_maintenance_function",
        )

    def install(self, marker, key):
        self.guard_absent()
        self.execute(
            "CREATE FUNCTION public."
            + FUNCTION
            + "() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$"
            + BODY
            + "$body$"
        )
        literals = self.execute(
            "SELECT quote_literal(%s),quote_literal(%s)",
            (self.bucket, marker["operation"]),
        ).fetchone()
        self.execute(
            "CREATE TRIGGER "
            + TRIGGER
            + " BEFORE INSERT OR DELETE OR UPDATE OF "
            + ",".join(PROTECTED_COLUMNS)
            + " ON public.shared_files_storage FOR EACH ROW EXECUTE FUNCTION public."
            + FUNCTION
            + "("
            + ",".join(literals)
            + ")"
        )
        cursor = self.execute(
            "UPDATE public.shared_files_storage SET writes=jsonb_build_object(%s::text,%s::jsonb),lease_id=%s::uuid,lease_until=now()+interval '30 seconds',updated_at=now() WHERE bucket=%s AND writes='{}'::jsonb AND lease_id IS NULL AND lease_until IS NULL",
            (key, json.dumps(marker), marker["operation"], self.bucket),
        )
        require(cursor.rowcount == marker["cohortSize"], "cohort_reservation_failed")
        self.verify_guard(marker)
        self.connection.commit()

    def verify_guard(self, marker):
        row = self.execute(
            "SELECT p.prosrc,p.prosecdef,t.tgenabled,t.tgtype,t.tgargs,t.tgnargs,ARRAY(SELECT a.attname FROM unnest(t.tgattr::smallint[]) n JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=n ORDER BY a.attname),l.lanname,p.proconfig,p.pronargs,p.prorettype='trigger'::regtype,t.tgqual IS NULL,t.tgisinternal FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE t.tgrelid='public.shared_files_storage'::regclass AND t.tgname=%s AND n.nspname='public' AND p.proname=%s",
            (TRIGGER, FUNCTION),
        ).fetchone()
        expected = (self.bucket + "\0" + marker["operation"] + "\0").encode()
        require(
            row is not None
            and row[0].strip() == BODY.strip()
            and row[1] is False
            and row[2] == "O"
            and row[3] == 31
            and bytes(row[4]) == expected
            and row[5] == 2
            and sorted(row[6]) == sorted(PROTECTED_COLUMNS)
            and row[7] == "plpgsql"
            and [item.replace(" ", "") for item in (row[8] or [])]
            == ["search_path=pg_catalog,public"]
            and row[9] == 0
            and row[10] is True
            and row[11] is True
            and row[12] is False,
            "maintenance_guard_changed",
        )

    def save_marker(self, old, new, key):
        cursor = self.execute(
            "UPDATE public.shared_files_storage SET writes=jsonb_build_object(%s::text,%s::jsonb),updated_at=now() WHERE bucket=%s AND lease_id=%s::uuid AND writes=%s::jsonb",
            (
                key,
                json.dumps(new),
                self.bucket,
                old["operation"],
                json.dumps({key: old}),
            ),
        )
        require(cursor.rowcount == old["cohortSize"], "maintenance_checkpoint_failed")
        self.connection.commit()

    def verify_session(self):
        require(
            self.execute(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND mode='ExclusiveLock' AND granted AND objsubid=1 AND classid=((hashtextextended(%s,0)>>32)&4294967295)::oid AND objid=(hashtextextended(%s,0)&4294967295)::oid)",
                (RELEASE_KEY, RELEASE_KEY),
            ).fetchone()[0]
            is True,
            "release_lock_lost",
        )

    def finish(self, marker, key, target, receipt):
        self.table_lock()
        self.verify_session()
        self.verify_guard(marker)
        rows = self.rows()
        validate_markers(rows, key, marker)
        current_claims = self.claim(target)
        validate_claim(target, current_claims)
        require(
            claim_fingerprint(current_claims) == marker["claimFingerprint"],
            "deletion_intent_changed",
        )
        require(
            target_fingerprint(target) == marker["targetLibrary"],
            "target_incarnation_changed",
        )
        matches = [
            row
            for row in rows
            if row["user_id"] == target["user_id"]
            and row["library_id"] == target["library_id"]
        ]
        require(
            len(matches) == 1
            and matches[0]["state"] == "erasing"
            and matches[0]["prefix"] == target["prefix"]
            and decoded(matches[0]["bucket_admission"])
            == decoded(target["bucket_admission"]),
            "target_incarnation_changed",
        )
        cursor = self.execute(
            "UPDATE public.shared_files_storage SET writes=writes-%s::text,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE bucket=%s AND lease_id=%s::uuid AND writes=%s::jsonb",
            (key, self.bucket, marker["operation"], json.dumps({key: marker})),
        )
        require(cursor.rowcount == marker["cohortSize"], "maintenance_release_failed")
        # Same owner/library/state/empty-writes CAS and receipt as registry.erased.
        cursor = self.execute(
            "UPDATE public.shared_files_storage SET state='erased',receipt=%s::jsonb,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE user_id=%s AND library_id=%s::uuid AND bucket=%s AND prefix=%s AND state='erasing' AND writes='{}'::jsonb",
            (
                json.dumps(receipt),
                target["user_id"],
                str(target["library_id"]),
                self.bucket,
                target["prefix"],
            ),
        )
        require(cursor.rowcount == 1, "erasure_receipt_not_committed")
        self.execute("DROP TRIGGER " + TRIGGER + " ON public.shared_files_storage")
        self.execute("DROP FUNCTION public." + FUNCTION + "()")
        self.connection.commit()


def qualify_sources(ops, root):
    revisions = json.loads(
        ops._cloud(
            "run",
            "revisions",
            "list",
            "--service=consent-protocol",
            "--region=us-central1",
            "--format=json",
        ).stdout
    )
    require(bool(revisions), "writer_inventory_empty")
    for revision in revisions:
        labels = revision["metadata"].get("labels", {})
        sha = labels.get("deploy-sha") or labels.get("commit-sha")
        require(bool(sha), "writer_source_unknown")
        for relative in QUALIFIED_FILES:
            source = subprocess.run(
                ["git", "show", sha + ":" + relative],
                cwd=root,
                capture_output=True,
                check=False,
            )
            require(
                source.returncode == 0
                and source.stdout
                == (root / relative).read_bytes().replace(b"\r\n", b"\n"),
                "writer_source_unqualified",
            )


def run(args):
    import urllib.request

    import google.auth
    from google.auth.transport.requests import AuthorizedSession, Request

    import configure_referral_uat as ops

    require(
        re.fullmatch(r"[a-f0-9]{16,64}", args.owner_hash) is not None,
        "owner_hash_invalid",
    )
    require(
        re.fullmatch(r"hussh-uat-shared-files-[a-z0-9-]+", args.bucket) is not None,
        "non_uat_bucket",
    )
    root = Path(__file__).resolve().parents[2]
    if args.apply:
        for relative in (
            "scripts/ops/reconcile_uat_shared_files.py",
            "scripts/ops/configure_referral_uat.py",
            "scripts/ops/sync_backend_runtime_secrets.py",
        ):
            source = subprocess.run(
                ["git", "show", "HEAD:" + relative], cwd=root, capture_output=True
            )
            require(
                source.returncode == 0
                and source.stdout
                == (root / relative).read_bytes().replace(b"\r\n", b"\n"),
                "operator_source_modified",
            )
        require(
            subprocess.run(
                ["git", "merge-base", "--is-ancestor", "HEAD", "origin/uat"], cwd=root
            ).returncode
            == 0,
            "operator_source_not_protected",
        )
    credentials, _ = google.auth.default(
        scopes=[
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/userinfo.email",
        ]
    )
    credentials.refresh(Request())
    request = urllib.request.Request(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": "Bearer " + credentials.token},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        who = json.load(response)
    require(
        who.get("email") == args.expected_principal
        and who.get("email_verified") is True,
        "operator_identity_mismatch",
    )
    os.environ["CLOUDSDK_AUTH_ACCESS_TOKEN"] = credentials.token
    original_cloud = ops._cloud

    def cloud(*values, **kwargs):
        if values[:2] == ("auth", "print-access-token"):
            return subprocess.CompletedProcess(values, 0, credentials.token, "")
        return original_cloud(*values, **kwargs)

    ops._cloud = cloud
    qualify_sources(ops, root)
    operation = args.resume or str(uuid4())
    require(str(UUID(operation)) == operation, "operation_invalid")
    key = "operator-maintenance-v1:" + operation
    with AuthorizedSession(credentials) as session, ops.uat_database() as connection:
        db = Database(connection, args.bucket)
        require(
            db.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s,0))", (RELEASE_KEY,)
            ).fetchone()[0]
            is True,
            "release_busy",
        )
        require(
            db.execute(
                "SELECT count(*) FROM pg_trigger WHERE tgname='trg_block_account_deletion_during_release' AND NOT tgisinternal AND tgenabled='O'"
            ).fetchone()[0]
            == 0,
            "release_fence_installed",
        )
        db.table_lock()
        rows = db.rows()
        # A concurrent owner reset must never be changed back to active.
        target = (
            next(
                (
                    row
                    for row in rows
                    if hashlib.sha256(row["user_id"].encode())
                    .hexdigest()
                    .startswith(args.owner_hash)
                ),
                None,
            )
            if args.resume
            else select_target(rows, args.owner_hash)
        )
        require(
            target is not None and target["state"] == "erasing", "target_not_erasing"
        )
        claims = db.claim(target)
        validate_claim(target, claims)
        provider = Provider(session, args.bucket, operation)
        before = provider.metadata()
        for row in rows:
            validate_bucket(row, before)
        current = provider.objects()
        if args.resume:
            marker = decoded(target["writes"]).get(key)
            require(
                isinstance(marker, dict)
                and marker.get("protocol") == PROTOCOL
                and marker.get("operator") == args.expected_principal
                and marker.get("targetHash") == args.owner_hash
                and marker.get("targetLibrary") == target_fingerprint(target)
                and marker.get("claimFingerprint") == claim_fingerprint(claims),
                "maintenance_resume_unqualified",
            )
            validate_markers(rows, key, marker)
            db.verify_guard(marker)
        else:
            validate_initial(rows)
            require(
                writable_policy(before) == {"retentionDurationSeconds": "0"},
                "policy_not_disabled",
            )
            marker = {
                "protocol": PROTOCOL,
                "state": "maintenance",
                "operation": operation,
                "operator": args.expected_principal,
                "targetHash": args.owner_hash,
                "targetLibrary": target_fingerprint(target),
                "claimFingerprint": claim_fingerprint(claims),
                "bucket": args.bucket,
                "identity": identity(before),
                "cohortSize": len(rows),
                "inventoryDigest": inventory_digest(current, rows),
                "originalPolicy": {"retentionDurationSeconds": "0"},
            }
            if not args.apply:
                print(
                    json.dumps(
                        {
                            "eligible": True,
                            "apply": False,
                            "libraries": len(rows),
                            "live_versions": len(current),
                            "target_empty": True,
                        }
                    )
                )
                return
            db.install(marker, key)
        require(args.apply, "resume_requires_apply")
        db.verify_session()
        db.verify_guard(marker)
        validate_markers(db.rows(), key, marker)
        before = provider.metadata()
        require(identity(before) == marker["identity"], "bucket_incarnation_changed")
        policy = before.get("softDeletePolicy", {}).get("retentionDurationSeconds")
        try:
            if policy == "0":
                db.verify_session()
                db.verify_guard(marker)
                validate_markers(db.rows(), key, marker)
                dispatch = {
                    **marker,
                    "policyIntent": {
                        "metageneration": before["metageneration"],
                        "reason": provider.reason,
                        "principal": args.expected_principal,
                        "seconds": POLICY_SECONDS,
                        "dispatchedAt": datetime.now(UTC)
                        .isoformat()
                        .replace("+00:00", "Z"),
                    },
                }
                db.save_marker(marker, dispatch, key)
                marker = dispatch
                enabled = provider.policy(before, POLICY_SECONDS)
                updated = {**marker, "enabledMetageneration": enabled["metageneration"]}
                db.save_marker(marker, updated, key)
                marker = updated
            else:
                require(policy == POLICY_SECONDS, "policy_ownership_uncertain")
                if before["metageneration"] != marker.get("enabledMetageneration"):
                    recovered = provider.reconcile_policy_intent(marker, before)
                    updated = {**marker, "enabledMetageneration": recovered}
                    db.save_marker(marker, updated, key)
                    marker = updated
                enabled = before
            time.sleep(31)
            db.verify_session()
            db.verify_guard(marker)
            validate_markers(db.rows(), key, marker)
            require(
                not provider.objects(prefix=library_prefix(target), retained=True),
                "retained_objects_remaining",
            )
            require(
                not provider.objects(prefix=library_prefix(target)),
                "target_objects_remaining",
            )
            observed = provider.metadata()
            require(
                identity(observed) == marker["identity"]
                and observed["metageneration"] == enabled["metageneration"],
                "policy_changed_during_verification",
            )
            db.verify_session()
            db.verify_guard(marker)
            validate_markers(db.rows(), key, marker)
            restored = provider.policy(observed, "0")
            time.sleep(31)
            after = provider.metadata()
            require(
                identity(after) == marker["identity"]
                and writable_policy(after) == marker["originalPolicy"]
                and after["metageneration"] == restored["metageneration"],
                "policy_restoration_unconfirmed",
            )
            inventory = provider.objects()
            raw_digest = hashlib.sha256(
                json.dumps(
                    sorted((item["name"], item["generation"]) for item in inventory),
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            require(raw_digest == marker["inventoryDigest"], "other_objects_changed")
            require(
                not provider.objects(prefix=library_prefix(target)),
                "target_objects_remaining",
            )
            db.finish(marker, key, target, absence_receipt(target, after))
            print(
                json.dumps(
                    {
                        "complete": True,
                        "operation": operation,
                        "policy_restored": True,
                        "objects_deleted": 0,
                        "other_live_versions_unchanged": len(inventory),
                    }
                )
            )
        except BaseException:
            # Durable guards survive loss of this connection. Never publish a
            # receipt or release writers from a partial provider operation.
            connection.rollback()
            print(
                json.dumps(
                    {"complete": False, "operation": operation, "guards_retained": True}
                ),
                flush=True,
            )
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-principal", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--owner-hash", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--resume")
    args = parser.parse_args()
    try:
        run(args)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "complete": False,
                    "reason": str(exc)
                    if isinstance(exc, RecoveryRefused)
                    else type(exc).__name__,
                }
            )
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
