"""Shared fixtures for exact runtime-grant and historical erasure contracts."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def install_erasure_schema(pg, *, notification_custody):
    recipe = (
        "parked/918_personal_agent_erasure_memory_binding.sql",
        "parked/919_personal_agent_compute_erasure.sql",
        "parked/920_personal_agent_substrate_inventory.sql",
        "parked/921_personal_agent_writer_revocation.sql",
        "parked/922_personal_agent_bucket_erasure.sql",
        "parked/923_personal_agent_mail_erasure.sql",
        "parked/924_personal_agent_kms_erasure.sql",
        "parked/925_personal_agent_secret_erasure.sql",
        "parked/926_personal_agent_runtime_account_erasure.sql",
        "parked/909_byoc_setup_jobs.sql",
        "parked/927_personal_agent_project_grant_fence.sql",
        "parked/928_byoc_authorization_receipts.sql",
        "parked/929_personal_agent_runtime_grant_erasure.sql",
        "rollback/929_personal_agent_runtime_grant_erasure.rollback.sql",
        "parked/929_personal_agent_runtime_grant_erasure.sql",
        "parked/930_personal_agent_repository_grant_erasure.sql",
        "rollback/930_personal_agent_repository_grant_erasure.rollback.sql",
        "parked/930_personal_agent_repository_grant_erasure.sql",
        "parked/931_personal_agent_repository_inventory.sql",
        "rollback/931_personal_agent_repository_inventory.rollback.sql",
        "parked/931_personal_agent_repository_inventory.sql",
        "parked/932_personal_agent_repository_retention.sql",
        "rollback/932_personal_agent_repository_retention.rollback.sql",
        "parked/932_personal_agent_repository_retention.sql",
        "parked/933_personal_agent_bootstrap_grant_erasure.sql",
        "rollback/933_personal_agent_bootstrap_grant_erasure.rollback.sql",
        "parked/933_personal_agent_bootstrap_grant_erasure.sql",
        "parked/934_personal_agent_erasure_resource_coverage.sql",
        "rollback/934_personal_agent_erasure_resource_coverage.rollback.sql",
        "parked/934_personal_agent_erasure_resource_coverage.sql",
        "parked/935_personal_agent_erasure_finalization.sql",
        "rollback/935_personal_agent_erasure_finalization.rollback.sql",
        "parked/935_personal_agent_erasure_finalization.sql",
        "parked/936_personal_agent_stale_erasure_recovery.sql",
        "parked/940_personal_agent_erasure_guard_composition.sql",
        "rollback/940_personal_agent_erasure_guard_composition.rollback.sql",
        "parked/940_personal_agent_erasure_guard_composition.sql",
        "parked/941_personal_agent_files_erasure.sql",
        "rollback/941_personal_agent_files_erasure.rollback.sql",
        "parked/941_personal_agent_files_erasure.sql",
        "parked/942_personal_agent_erasure_validation_cost.sql",
        "rollback/942_personal_agent_erasure_validation_cost.rollback.sql",
        "parked/942_personal_agent_erasure_validation_cost.sql",
    )
    for relative in recipe:
        pg.apply_file(ROOT / "db/migrations" / relative)
    if notification_custody:
        for path in sorted((ROOT / "db/migrations/parked").glob("*.sql")):
            number = int(path.name.split("_", 1)[0])
            if 943 <= number <= 956 and number not in (944, 945):
                if number == 954:
                    pg.execute(
                        "ALTER TABLE vault_keys ADD COLUMN IF NOT EXISTS setup_capability_ids TEXT"
                    )
                pg.apply_file(path)


def runtime_policy_fixture(case, role, step):
    email = "one-pod-owner@proj-x.iam.gserviceaccount.com"
    uid = "123456789012345678901"
    member = f"deleted:serviceAccount:{email}?uid={uid}"
    evidence = {
        "runtimeIdentity": {
            "name": f"projects/proj-x/serviceAccounts/{email}",
            "projectId": "proj-x",
            "email": email,
            "uniqueId": uid,
        },
        "bindingObservation": {
            "step": step,
            "policyResource": "https://cloudresourcemanager.googleapis.com/v1/projects/proj-x:getIamPolicy",
            "role": role,
            "member": f"serviceAccount:{email}",
            "disposition": "added",
            "beforeEtag": "before",
            "afterEtag": "after",
        },
    }
    action = {
        "type": "iam_binding",
        "id": "runtime-grant",
        "role": role,
        "member": member.replace(uid, "999999999999999999999") if case == "foreign_uid" else member,
    }
    other = member.replace(uid, "888888888888888888888")
    policy = {
        "version": 3,
        "etag": "current",
        "bindings": [
            {
                "role": role,
                "members": [member, other]
                + ([f"serviceAccount:{email}"] if case == "original" else []),
            }
        ],
    }
    absent = {"version": 3, "etag": "after", "bindings": [{"role": role, "members": [other]}]}
    return evidence, action, policy, absent, other


def grant_cleanup_fixture(owner, failure, repository, quota):
    identity = {
        "email": "runtime@synthetic-project.iam.gserviceaccount.com",
        "uniqueId": "123456789012345678901",
    }
    binding = {"step": "iam_pod_sa_vertex", "member": f"serviceAccount:{identity['email']}"}
    if quota:
        binding["step"] = "iam_pod_sa_quota"
        binding["role"] = "roles/serviceusage.serviceUsageConsumer"
    identity_key = "repositoryIdentity" if repository else "runtimeIdentity"
    state_key = "repositoryGrantErasure" if repository else "runtimeGrantErasure"
    method = "erase_repository_grant" if repository else "erase_runtime_grant"
    if repository:
        identity = {
            "name": "projects/synthetic-project/locations/us-central1/repositories/one-pod",
            "format": "DOCKER",
            "createTime": "2026-09-08T00:00:00Z",
        }
        binding["step"] = "artifact_repo_grant_copy_writer"
    reservation = {
        "ownerId": "foreign-owner" if failure == "foreign_owner" else owner,
        "attemptId": "erase-one",
        "registrySnapshot": {"user_id": owner, "user_cloud_project": "synthetic-project"},
        "substrateInventory": {"bindingObservations": [binding]},
        "writerDisabled": {"runtimeIdentity": identity},
    }
    if repository:
        reservation["substrateInventory"]["resourceObservations"] = [
            {
                "type": "artifact_repository",
                "id": "one-pod",
                "disposition": "created",
                "identity": identity,
            }
        ]
    return identity, binding, identity_key, state_key, method, reservation
