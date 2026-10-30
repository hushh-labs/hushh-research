"""Skipped primary job identity regressions in the existing receipt suite."""

import copy
import hashlib
import importlib
import io
import json
import re
import subprocess
import tempfile
from pathlib import Path
from unittest import mock
import zipfile

import production_phone_lease as lease
from production_phone_receipt_fixtures import LeaseFixture

MAINTENANCE = importlib.import_module("uat-retention-maintenance")
RAW_PRIMARY_NAME = lease.nonproducer.LEGACY_PRIMARY_NAME
PINNED_PREDECESSOR_SOURCE_SHA = "629ec27cd28d2eeca4ff7fb017cb4389d8338fa8"
# Exact job-name excerpt from the pinned predecessor workflow. Keep this
# checkout-depth independent; the reader consumes only these source fields.
PINNED_PREDECESSOR_JOB_NAME_EXCERPT = """jobs:
  deploy:
    name: ${{ inputs.phone_phase == 'activate' && 'Ordinary production deploy (not selected)' || 'Deploy Production Scope' }}
  complete-phone-activation:
    name: ${{ inputs.phone_phase == 'activate' && 'Deploy Production Scope' || 'Activation continuation not selected' }}
"""
PINNED_PREDECESSOR_JOB_NAME_EXCERPT_SHA256 = (
    "89917672588150cd5099ecf3e03320ad139ebaa10fc0ae4a60dc59905414fbd9"
)


def legacy_workflow():
    source = (lease.phone.ROOT / lease.WORKFLOW).read_text()
    for job_id, label in lease.nonproducer.PRODUCTION_JOB_NAMES.items():
        block = lease.nonproducer._job_block(source, job_id)
        expression = lease.nonproducer.LEGACY_PRODUCTION_JOB_EXPRESSIONS[job_id]
        legacy = "    name: ${{ " + expression + " }}"
        updated, count = re.subn(
            rf"(?m)^    name: {re.escape(label)}$", lambda _: legacy, block, count=1
        )
        if count != 1:
            raise AssertionError(f"could not construct reviewed legacy job {job_id}")
        source = source.replace(block, updated, 1)
    return source


def apply_legacy_job_names(case, source_sha):
    source = legacy_workflow().encode()
    case.sources[source_sha] = source
    case.sources["e" * 40] = source
    case.use_legacy_job_names()


def production_release_document():
    release = {
        "status": "healthy",
        "final": {
            "backend_revision": "consent-protocol-00003-abc",
            "frontend_revision": "hushh-webapp-00003-abc",
        },
    }
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        bundle.writestr("prod-release-status.json", json.dumps(release))
    return release, stream.getvalue()


def production_release_alias_fixture(
    active_names, *, skipped_names=None, skipped_steps=None, sibling_defect=None
):
    release, archive = production_release_document()
    sha = "a" * 40
    run = {
        "id": 300,
        "path": ".github/workflows/deploy-production.yml",
        "head_branch": "main",
        "head_sha": sha,
        "run_attempt": 2,
        "event": "workflow_dispatch",
        "actor": {"login": "kushaltrivedi5"},
        "status": "completed",
        "conclusion": "success",
        "repository": {"id": 7, "full_name": "org/repo"},
        "head_repository": {"id": 7, "full_name": "org/repo"},
    }
    upload = {
        "name": "Upload production deploy artifacts",
        "status": "completed",
        "conclusion": "success",
        "started_at": "2026-10-21T03:19:03Z",
        "completed_at": "2026-10-21T03:19:04Z",
    }
    bound = {
        "run_id": run["id"],
        "run_attempt": run["run_attempt"],
        "head_sha": sha,
        "head_branch": "main",
        "status": "completed",
    }
    skipped_names = skipped_names or ("Deploy Production Scope",)
    jobs = [
        {
            **bound,
            "name": name,
            "conclusion": "skipped",
            "steps": [] if skipped_steps is None else skipped_steps,
        }
        for name in skipped_names
    ]
    jobs.extend(
        {
            **bound,
            "name": name,
            "conclusion": "success",
            "steps": [upload],
        }
        for name in active_names
    )
    if sibling_defect:
        jobs[0][sibling_defect[0]] = sibling_defect[1]
    artifact = {
        "id": 100,
        "name": "prod-release-300",
        "expired": False,
        "created_at": upload["started_at"],
        "size_in_bytes": len(archive),
        "digest": "sha256:" + hashlib.sha256(archive).hexdigest(),
        "workflow_run": {
            "id": run["id"],
            "head_sha": sha,
            "head_branch": "main",
            "repository_id": 7,
            "head_repository_id": 7,
        },
    }
    return {
        "run": run,
        "release": release,
        "artifact": artifact,
        "inventory": {"total_count": 1, "artifacts": [artifact]},
        "jobs": {"total_count": len(jobs), "jobs": jobs},
        "archive": archive,
        "upload": upload,
    }


def read_production_alias_receipt(case):
    def api(_repository, endpoint):
        if endpoint == "runs/300":
            return case["run"]
        if endpoint == "runs/300/artifacts?per_page=100":
            return case["inventory"]
        if endpoint == "runs/300/attempts/2/jobs?per_page=100":
            return case["jobs"]
        raise AssertionError("unexpected production receipt lookup: " + endpoint)

    receipts = MAINTENANCE.release_artifact_receipts
    with (
        mock.patch.dict(
            "os.environ", {receipts.PRODUCTION_EVIDENCE_REPAIR_FLAG: "true"}
        ),
        mock.patch.object(MAINTENANCE, "api", side_effect=api),
        mock.patch.object(
            MAINTENANCE.retention,
            "run_command",
            return_value=subprocess.CompletedProcess([], 0, case["archive"], b""),
        ),
        mock.patch.object(MAINTENANCE.production_retention_context, "healthy_phone"),
        tempfile.TemporaryDirectory() as temporary,
    ):
        found = MAINTENANCE.find_release(
            "org/repo",
            "300",
            Path(temporary),
            require_live=False,
            environment="production",
        )
        selected, job = receipts.current_attempt_artifact(
            "org/repo",
            case["run"],
            MAINTENANCE.LANES["production"],
            api=api,
            timestamp=MAINTENANCE._github_timestamp,
        )
    return found, selected, job


class ProductionReleaseAliasReceiptCases:
    def test_current_and_historical_activation_aliases_supply_release_receipts(self):
        aliases = lease.nonproducer.PRODUCTION_JOB_NAMES
        cases = [
            production_release_alias_fixture((aliases["complete-phone-activation"],)),
            production_release_alias_fixture((aliases[lease.nonproducer.JOB_ID],)),
        ]
        legacy = lease.nonproducer.LEGACY_PRODUCTION_JOB_EXPRESSIONS
        for skipped in (
            (legacy["deploy"], legacy[lease.nonproducer.JOB_ID]),
            (legacy["deploy"], legacy["complete-phone-activation"]),
        ):
            cases.append(
                production_release_alias_fixture(
                    ("Deploy Production Scope",), skipped_names=skipped
                )
            )
        for case in cases:
            with self.subTest(job_names=[job["name"] for job in case["jobs"]["jobs"]]):
                found, artifact, job = read_production_alias_receipt(case)
                self.assertEqual(found, (300, case["release"]))
                self.assertEqual(artifact["id"], case["artifact"]["id"])
                self.assertEqual(job["conclusion"], "success")

    def test_activation_alias_receipt_refuses_duplicate_or_unbound_siblings(self):
        aliases = lease.nonproducer.PRODUCTION_JOB_NAMES
        cases = [
            production_release_alias_fixture(
                (
                    aliases["complete-phone-activation"],
                    aliases[lease.nonproducer.JOB_ID],
                )
            ),
            production_release_alias_fixture(
                (aliases["complete-phone-activation"],),
                skipped_steps=[{"name": "Upload production deploy artifacts"}],
            ),
        ]
        for key, value in (
            ("run_attempt", 1),
            ("head_sha", "b" * 40),
            ("head_branch", "dev"),
        ):
            cases.append(
                production_release_alias_fixture(
                    (aliases[lease.nonproducer.JOB_ID],), sibling_defect=(key, value)
                )
            )
        for case in cases:
            with self.subTest(job_names=[job["name"] for job in case["jobs"]["jobs"]]):
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    read_production_alias_receipt(case)


class ProductionPhoneSkippedNameCases:
    def skipped_primary_case(self, raw):
        case = LeaseFixture(self)
        if raw:
            case.intent_protocol()
            case.sources[case.runs[0]["head_sha"]] = legacy_workflow().encode()
            case.use_legacy_job_names()
            case.runs[0].update(status="in_progress", conclusion=None)
            case.attempts[(300, 2)].update(status="in_progress", conclusion=None)
        case.jobs[(300, 2)]["jobs"][0].update(
            name=RAW_PRIMARY_NAME if raw else lease.JOB,
            status="completed",
            conclusion="skipped",
            steps=[],
        )
        return case

    def test_only_completed_skipped_empty_job_is_nonexecuted_and_prior_attempt_still_fences(
        self,
    ):
        self.setUp()
        for raw in (False, True):
            with self.subTest(raw=raw):
                case = self.skipped_primary_case(raw)
                self.assertIsNone(self.lease_check(case))
                self.assertIn("runs/300/attempts/1/jobs?per_page=100", case.calls)
                self.lease_defect(case, "older_pending")
                with self.assertRaises(lease.retention.UnsafeState):
                    self.lease_check(case)
            for defect in (
                "failed",
                "cancelled",
                "active",
                "missing_steps",
                "started_step",
                "missing_job",
                "ambiguous_job",
                "ambiguous_active",
                "run_id",
                "run_attempt",
                "head_sha",
                "head_branch",
                "changed_name",
                "changed_source",
            ):
                with self.subTest(raw=raw, defect=defect):
                    case = self.skipped_primary_case(raw)
                    inventory = case.jobs[(300, 2)]
                    job = inventory["jobs"][0]
                    if defect in {"failed", "cancelled"}:
                        job["conclusion"] = (
                            "failure" if defect == "failed" else "cancelled"
                        )
                    elif defect == "active":
                        job["status"] = "in_progress"
                    elif defect == "missing_steps":
                        del job["steps"]
                    elif defect == "started_step":
                        job["steps"] = [
                            {
                                "name": lease.BEGIN,
                                "status": "completed",
                                "conclusion": "success",
                            }
                        ]
                    elif defect == "missing_job":
                        inventory.update(total_count=0, jobs=[])
                    elif defect in {"ambiguous_job", "ambiguous_active"}:
                        duplicate = copy.deepcopy(job)
                        if defect == "ambiguous_active":
                            duplicate.update(
                                status="in_progress",
                                conclusion=None,
                                steps=[{"name": lease.BEGIN}],
                            )
                        inventory["jobs"].append(duplicate)
                        inventory["total_count"] = len(inventory["jobs"])
                    elif defect in {"run_id", "run_attempt", "head_sha", "head_branch"}:
                        job[defect] = {
                            "run_id": 400,
                            "run_attempt": 1,
                            "head_sha": "f" * 40,
                            "head_branch": "dev",
                        }[defect]
                    elif defect == "changed_name":
                        job["name"] += " altered"
                    elif defect == "changed_source":
                        if not raw:
                            continue
                        sha = case.runs[0]["head_sha"]
                        case.sources[sha] = case.sources[sha].replace(
                            RAW_PRIMARY_NAME.encode(), b"'different primary job'"
                        )
                    with self.assertRaises(lease.retention.UnsafeState):
                        self.lease_check(case)

    def test_source_defined_job_ids_require_a_complete_bound_api_inventory(self):
        self.setUp()
        case = LeaseFixture(self)
        result = case.jobs[(300, 2)]
        source = case.sources[case.runs[0]["head_sha"]].decode()
        result["jobs"].pop()
        result["total_count"] = len(result["jobs"])
        with self.assertRaisesRegex(ValueError, "inventory is incomplete"):
            lease.nonproducer.attempt_producer_job(
                result["jobs"], case.runs[0], case.attempts[(300, 2)], source
            )

    def test_pinned_predecessor_source_accepts_only_its_two_production_jobs(self):
        source_sha = PINNED_PREDECESSOR_SOURCE_SHA
        source = PINNED_PREDECESSOR_JOB_NAME_EXCERPT
        self.assertEqual(
            hashlib.sha256(source.encode()).hexdigest(),
            PINNED_PREDECESSOR_JOB_NAME_EXCERPT_SHA256,
        )
        old_deploy_expression = (
            "inputs.phone_phase == 'activate' && "
            "'Ordinary production deploy (not selected)' || 'Deploy Production Scope'"
        )
        old_phone_expression = (
            "inputs.phone_phase == 'activate' && 'Deploy Production Scope' "
            "|| 'Activation continuation not selected'"
        )
        old_deploy = "${{ " + old_deploy_expression + " }}"
        old_phone = "${{ " + old_phone_expression + " }}"
        names = {
            job_id: re.search(
                r"^    name: (.+)$",
                lease.nonproducer._job_block(source, job_id),
                re.M,
            )[1]
            for job_id in ("deploy", "complete-phone-activation")
        }
        self.assertEqual(
            names, {"deploy": old_deploy, "complete-phone-activation": old_phone}
        )
        self.assertEqual(
            set(lease.nonproducer._production_job_name_contract(source)),
            {"deploy", "complete-phone-activation"},
        )

        run = {"id": 300, "head_sha": source_sha}
        attempt = {"run_attempt": 2, "status": "completed"}
        bound = {
            "run_id": run["id"],
            "run_attempt": attempt["run_attempt"],
            "head_sha": source_sha,
            "head_branch": "main",
        }
        skipped_primary = {
            **bound,
            "name": old_deploy_expression,
            "status": "completed",
            "conclusion": "skipped",
            "steps": [],
        }
        phone_producer = {
            **bound,
            "name": "Deploy Production Scope",
            "status": "completed",
            "conclusion": "success",
            "steps": [{"name": lease.nonproducer.ADMISSION_STEP}],
        }
        selected = lease.nonproducer.attempt_producer_job(
            [skipped_primary, phone_producer], run, attempt, source
        )
        self.assertIs(selected, phone_producer)
        with self.assertRaisesRegex(ValueError, "inventory is incomplete"):
            lease.nonproducer.attempt_producer_job(
                [phone_producer], run, attempt, source
            )

        altered = source.replace(
            "Ordinary production deploy (not selected)", "modified", 1
        )
        with self.assertRaisesRegex(ValueError, "source is ambiguous"):
            lease.nonproducer.attempt_producer_job(
                [skipped_primary, phone_producer], run, attempt, altered
            )

    def test_selected_producer_precedes_skipped_raw_primary_without_hiding_lease(self):
        self.setUp()
        for historical in (False, True):
            with self.subTest(historical=historical):
                case = LeaseFixture(self)
                case.intent_protocol()
                source = case.sources[case.runs[0]["head_sha"]]
                if historical:
                    source = legacy_workflow().encode()
                    case.sources[case.runs[0]["head_sha"]] = source
                    case.use_legacy_job_names()
                environment = case.active_guard()
                inventory = case.jobs[(300, 2)]
                active = inventory["jobs"][0]
                active["name"] = (
                    lease.nonproducer.PRODUCTION_JOB_NAMES["complete-phone-activation"]
                    if not historical
                    else lease.JOB
                )
                environment["GITHUB_JOB"] = "complete-phone-activation"
                ordinary = copy.deepcopy(active)
                ordinary.update(
                    name=RAW_PRIMARY_NAME if historical else lease.JOB,
                    status="completed",
                    conclusion="skipped",
                    steps=[],
                )
                restoration_skip = inventory["jobs"][2]
                inventory["jobs"] = [ordinary, active, restoration_skip]
                inventory["total_count"] = len(inventory["jobs"])
                if historical:
                    self.assertEqual(
                        lease.nonproducer.skipped_primary_name(source.decode()),
                        RAW_PRIMARY_NAME,
                    )
                attempt, _, selected = lease._attempt(
                    self.repo, case.runs[0], 2, case.api, source.decode()
                )
                self.assertIs(selected, active)
                with mock.patch.dict("os.environ", environment):
                    self.assertTrue(lease._current(self.repo, attempt, selected, True))
                    self.assertIsNone(lease._steps(selected, current=True))
