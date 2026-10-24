"""Frozen recovery retains authority, conservative capacity and unresolved intent."""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
import copy
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from test_production_capacity_bridge import IMAGE, SHA, bridge, inventory, pins

import production_capacity_bridge_contract as contract


def failed_inventory():
    native = inventory()
    rows = native["services"][bridge.SERVICE]["revisions"]
    failed = copy.deepcopy(rows[0])
    failed["metadata"]["name"] = contract.RECOVERY_FAILED_REVISION
    failed["spec"]["containers"][0].update(
        command=["gunicorn"], args=["server:app", "-w", "1"]
    )
    rows.append(failed)
    native["services"][bridge.SERVICE]["service"]["status"].update(
        latestCreatedRevisionName=contract.RECOVERY_FAILED_REVISION,
        latestReadyRevisionName=contract.RECOVERY_FAILED_REVISION,
    )
    return native, failed


def run_metadata():
    repository = {"id": 1, "full_name": "hushh-labs/hushh-research"}
    return {
        "id": 40050081063,
        "run_attempt": 2,
        "head_branch": "main",
        "head_sha": "dcc4f611e39c80a0001df0ada3f47e85b445421e",
        "path": ".github/workflows/deploy-production.yml",
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "failure",
        "repository": repository,
        "head_repository": repository,
    }


def artifact_metadata(run):
    return {
        "id": 12546383890,
        "name": "prod-release-40050081063",
        "digest": contract.RECOVERY_RECEIPT["artifact_digest"],
        "expired": False,
        "created_at": "2026-10-24T03:41:24Z",
        "workflow_run": {
            "id": run["id"],
            "head_sha": run["head_sha"],
            "head_branch": "main",
            "repository_id": 1,
            "head_repository_id": 1,
        },
    }


def rollback_status():
    return {
        "status": "rolled_back",
        "sha": "ca83c0bf5ac85589dc376f31769314bfb8e78d0d",
        "predeploy": {"backend_revision": contract.RECOVERY_SOURCE},
        "final": {"backend_revision": contract.RECOVERY_SOURCE},
        "candidate": {"backend_revision": contract.RECOVERY_FAILED_REVISION},
        "rollback": {"backend": "success"},
    }


def read_claim(run, artifact, command, **_):
    endpoint = command[-1]
    value = run
    if "artifacts?" in endpoint:
        earlier = {**artifact, "id": 12543168064, "created_at": "2026-10-24T01:50:40Z"}
        value = {"total_count": 2, "artifacts": [earlier, artifact]}
    if "/jobs?" in endpoint:
        value = {
            "total_count": 1,
            "jobs": [
                {
                    "name": "Deploy Production Scope",
                    "run_id": run["id"],
                    "run_attempt": 2,
                    "head_sha": run["head_sha"],
                    "head_branch": "main",
                    "status": "completed",
                    "steps": [
                        {
                            "name": "Upload production deploy artifacts",
                            "status": "completed",
                            "conclusion": "success",
                            "started_at": "2026-10-24T03:41:24Z",
                            "completed_at": "2026-10-24T03:41:25Z",
                        }
                    ],
                }
            ],
        }
    return subprocess.CompletedProcess(command, 0, json.dumps(value), "")


def changed_claims(change):
    run = run_metadata()
    artifact, release = artifact_metadata(run), rollback_status()
    if change == "run":
        run["conclusion"] = "success"
    if change == "attempt":
        run["run_attempt"] = 3
    if change == "digest":
        artifact["digest"] = "sha256:" + "0" * 64
    if change == "rollback":
        release["rollback"]["backend"] = "failure"
    if change == "final":
        release["final"]["backend_revision"] = contract.RECOVERY_FAILED_REVISION
    return run, artifact, release


def recovery_source():
    observed = inventory()
    row = observed["services"][bridge.SERVICE]["revisions"][0]
    row["metadata"]["name"] = contract.RECOVERY_SOURCE
    row["spec"]["containers"][0].update(
        command=["gunicorn"], args=["server:app", "-w", "1"]
    )
    row["spec"]["containers"][0]["env"] = [
        e for e in row["spec"]["containers"][0]["env"] if e["name"] != "WEB_CONCURRENCY"
    ]
    observed["services"][bridge.SERVICE]["service"]["status"]["traffic"][0][
        "revisionName"
    ] = contract.RECOVERY_SOURCE
    return observed, row


def old_verified_receipt():
    return {
        "version": 1,
        "profile": bridge.PROFILE,
        "project": bridge.PROJECT,
        "service": bridge.SERVICE,
        "sourceFingerprint": "a" * 64,
        "serviceControlsFingerprint": "c" * 64,
        "sourceRevision": "consent-protocol-old",
        "revision": "consent-protocol-cap-" + "d" * 16,
        "pins": pins(),
        "displacedLatestRevision": "consent-protocol-older",
        "traffic": [["consent-protocol-old", 100, "healthy"]],
        "status": "verified",
        "requested": True,
    }


def create_revision(observed, command, **_):
    body = json.loads(Path(command[4]).read_text())
    revision = copy.deepcopy(body["spec"]["template"])
    revision["status"] = {
        "imageDigest": IMAGE,
        "conditions": [{"type": "Ready", "status": "True"}],
    }
    observed["services"][bridge.SERVICE]["revisions"].append(revision)
    service = observed["services"][bridge.SERVICE]["service"]
    service["spec"] = body["spec"]
    service["status"].update(
        latestCreatedRevisionName=revision["metadata"]["name"],
        latestReadyRevisionName=revision["metadata"]["name"],
    )
    service["status"]["traffic"] = copy.deepcopy(body["spec"]["traffic"])
    service["status"]["traffic"][-1]["url"] = "https://capacity-example.a.run.app"


@contextmanager
def recovery_ports(observed, row):
    with ExitStack() as stack:
        ports = [
            mock.patch.dict(
                bridge.os.environ,
                {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main"},
            ),
            mock.patch.object(
                contract,
                "RECOVERY_SOURCE_SPEC",
                bridge.fingerprint([row["spec"], IMAGE]),
            ),
            mock.patch.object(
                bridge.budget, "collect", side_effect=lambda *a: copy.deepcopy(observed)
            ),
            mock.patch.object(
                bridge.budget, "evaluate", return_value={"admitted": True}
            ),
            mock.patch.object(bridge, "SecretMetadata"),
            mock.patch.object(bridge, "secret_pins", return_value=pins()),
            mock.patch.object(
                bridge.urllib.request,
                "urlopen",
                return_value=BytesIO(b'{"status":"healthy"}'),
            ),
        ]
        for port in ports:
            stack.enter_context(port)
        yield stack.enter_context(
            mock.patch.object(
                bridge.retention,
                "run_command",
                side_effect=lambda *a, **kw: create_revision(observed, *a, **kw),
            )
        )


class RecoveryTests(unittest.TestCase):
    def test_attested_reservation_is_conservative_immutable_and_narrow(self):
        native, failed = failed_inventory()
        before = copy.deepcopy(native)
        settings = json.loads(bridge.budget.DEFAULT_PROFILE.read_text())[
            "environments"
        ]["production"]["services"][bridge.SERVICE]
        connection = "hushh-pda:us-central1:hushh-vault-db"
        with self.assertRaisesRegex(bridge.budget.BudgetError, "conflicting worker"):
            bridge.budget.revision_connections(
                failed, bridge.SERVICE, settings, connection
            )
        with (
            mock.patch.object(
                contract,
                "RECOVERY_FAILED_SPEC",
                bridge.fingerprint([failed["spec"], IMAGE]),
            ),
            mock.patch.object(contract, "verify_recovery_failure") as authority,
        ):
            reserved = contract.recovery_capacity_inventory(
                native, contract.RECOVERY_PROFILE
            )
            capacity = bridge.budget.revision_connections(
                reserved["services"][bridge.SERVICE]["revisions"][-1],
                bridge.SERVICE,
                settings,
                connection,
            )
            self.assertEqual(
                (capacity["workers_per_instance"], capacity["connections"]), (2, 80)
            )
            self.assertEqual(native, before)
            authority.assert_called_once()
            drift = copy.deepcopy(native)
            drift["services"][bridge.SERVICE]["revisions"][-1]["spec"]["containers"][0][
                "env"
            ].append({"name": "UNREVIEWED", "value": "1"})
            with self.assertRaisesRegex(
                bridge.retention.UnsafeState, "changed or is serving"
            ):
                contract.recovery_capacity_inventory(drift, contract.RECOVERY_PROFILE)
            serving = copy.deepcopy(native)
            serving["services"][bridge.SERVICE]["service"]["status"]["traffic"][0][
                "percent"
            ] = 99
            serving["services"][bridge.SERVICE]["service"]["status"]["traffic"].append(
                {"revisionName": contract.RECOVERY_FAILED_REVISION, "percent": 1}
            )
            with self.assertRaisesRegex(
                bridge.retention.UnsafeState, "changed or is serving"
            ):
                contract.recovery_capacity_inventory(serving, contract.RECOVERY_PROFILE)
            other = copy.deepcopy(failed)
            other["metadata"]["name"] = "consent-protocol-unreviewed"
            reserved["services"][bridge.SERVICE]["revisions"].append(other)
            with self.assertRaisesRegex(
                bridge.budget.BudgetError, "conflicting worker"
            ):
                bridge.budget.service_budget(
                    bridge.SERVICE,
                    settings,
                    reserved["services"][bridge.SERVICE]["service"],
                    reserved["services"][bridge.SERVICE]["revisions"],
                    connection,
                )
        self.assertIs(
            contract.recovery_capacity_inventory(native, bridge.PROFILE), native
        )

    def test_failed_recovery_requires_exact_attempt_artifact_and_rollback(self):
        for change in ("none", "run", "attempt", "digest", "rollback", "final"):
            with self.subTest(change=change):
                run, artifact, release = changed_claims(change)

                def download(_repo, selected, directory, name, **_):
                    self.assertEqual(
                        selected["digest"], contract.RECOVERY_RECEIPT["artifact_digest"]
                    )
                    (directory / name).write_text(json.dumps(release))

                with (
                    mock.patch.object(
                        bridge.retention,
                        "run_command",
                        side_effect=lambda *a, **kw: read_claim(
                            run, artifact, *a, **kw
                        ),
                    ),
                    mock.patch.object(
                        contract.release_artifact_receipts,
                        "download_replayed_artifact",
                        side_effect=download,
                    ),
                ):
                    if change == "none":
                        contract.verify_recovery_failure()
                    else:
                        with self.assertRaises(bridge.retention.UnsafeState):
                            contract.verify_recovery_failure()

    def test_only_verified_absent_bridge_is_archived_and_reconciled_once(self):
        observed, row = recovery_source()
        release = {"sha": SHA, "final": {"backend_revision": contract.RECOVERY_SOURCE}}
        prior = old_verified_receipt()
        with (
            tempfile.TemporaryDirectory() as directory,
            recovery_ports(observed, row) as mutate,
        ):
            checkpoint = Path(directory) / "completed.json"
            uncertain = {**prior, "status": "intent"}
            checkpoint.write_text(json.dumps({"capacity_bridge": uncertain}))
            with self.assertRaisesRegex(
                bridge.retention.UnsafeState, "proven completed retirement"
            ):
                bridge.maintain(release, checkpoint, create=True)
            mutate.assert_not_called()
            self.assertEqual(
                json.loads(checkpoint.read_text())["capacity_bridge"], uncertain
            )
            checkpoint.write_text(json.dumps({"capacity_bridge": prior}))
            still_present = copy.deepcopy(row)
            still_present["metadata"]["name"] = prior["revision"]
            observed["services"][bridge.SERVICE]["revisions"].append(still_present)
            with self.assertRaisesRegex(
                bridge.retention.UnsafeState, "proven completed retirement"
            ):
                bridge.maintain(release, checkpoint, create=True)
            mutate.assert_not_called()
            observed["services"][bridge.SERVICE]["revisions"].pop()
            bridge.maintain(release, checkpoint, create=True)
            receipt = json.loads(checkpoint.read_text())["capacity_bridge"]
            self.assertEqual(receipt["profile"], contract.RECOVERY_PROFILE)
            self.assertEqual(receipt["retiredPredecessor"], prior)
            self.assertEqual(
                receipt["retiredPredecessorFingerprint"], bridge.fingerprint(prior)
            )
            self.assertEqual(receipt["status"], "verified")
            self.assertEqual(
                observed["services"][bridge.SERVICE]["revisions"][-1]["metadata"][
                    "labels"
                ]["capacity-bridge"],
                "v3",
            )
            bridge.maintain(release, checkpoint, create=True)
            self.assertEqual(mutate.call_count, 1)
            tampered = copy.deepcopy(receipt)
            tampered["retiredPredecessor"]["status"] = "intent"
            with self.assertRaisesRegex(
                bridge.retention.UnsafeState, "retired bridge evidence"
            ):
                bridge.receipt_state(tampered)


if __name__ == "__main__":
    unittest.main()
