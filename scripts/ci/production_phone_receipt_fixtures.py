"""Synthetic immutable production phone evidence for the owning receipt suite."""

import copy
import hashlib
import io
import json
import subprocess
import zipfile

import production_phone_lease as lease
import production_phone_receipt as phone


def _qualified_phone():
    source, image = "b" * 40, "gcr.io/hushh-pda/consent-protocol@sha256:" + "c" * 64
    probe = {
        "source": source,
        "image": image,
        "probe_sha256": "d" * 64,
        "probe_generation_admission": False,
        "phone_reader": phone._constant("qualify_image.py", "EXPECTED"),
        "source_sha256": {
            name.replace(".", "/") + ".py": "e" * 64
            for name in phone._constant("reader_probe.py", "SOURCE_MODULES")
        },
    }
    return {
        "schema_version": 1,
        "qualification": "passed",
        "project": "hushh-pda",
        "region": "us-central1",
        "run_id": "300",
        "revision": "consent-protocol-cold",
        "source": source,
        "image": image,
        "probe": probe,
        "health": "passed",
        "recovery": False,
        "sso": False,
    }


def phone_documents(fixture):
    fixture.run.update(conclusion="success", actor={"login": "kushaltrivedi5"})
    job = fixture.jobs["jobs"][0]
    job["conclusion"] = "success"
    job["steps"] = [
        {"name": name, "status": "completed", "conclusion": "success"}
        for name in phone.PHONE_STEPS
    ] + [fixture.upload]
    qualified = _qualified_phone()
    source, image, probe = (qualified[key] for key in ("source", "image", "probe"))
    paths = phone._constant("consumer_compatibility.py", "UNCHANGED") + phone._constant(
        "consumer_compatibility.py", "REVIEWED_EXCEPTIONS"
    )
    plan = {
        "schema_version": 1,
        "run_id": "300",
        "mode": "cold",
        "source": source,
        "image": image,
        "primary_sha": "f" * 40,
        "probe": copy.deepcopy(probe),
        "recovery_enabled": False,
        "consumer_compatibility": {
            "fallback": source,
            "primary": "f" * 40,
            "source_sha256": {path: "a" * 64 for path in paths},
        },
    }
    release = {
        "status": "healthy",
        "sha": "f" * 40,
        "scope": "all",
        "final": {
            "backend_revision": "consent-protocol-current",
            "frontend_revision": "hushh-webapp-current",
        },
        "predeploy": {"backend_revision": "consent-protocol-old"},
        "phone_rollback": {
            "revision": qualified["revision"],
            "qualification": "success",
        },
    }
    report = {
        "project": "hushh-pda",
        "configured": True,
        "enabled": False,
        "targetSha": release["sha"],
        "bootstrapEmpty": False,
        "readerAncestor": "a" * 40,
        "previous": {
            "consent-protocol": {
                key: qualified[key] for key in ("revision", "source", "image")
            }
        },
    }
    report["previous"]["consent-protocol"]["sha"] = report["previous"][
        "consent-protocol"
    ].pop("source")
    report["previous"]["consent-protocol"]["readerCompatible"] = True
    return {
        "prod-release-status.json": release,
        "phone-rollback/plan.json": plan,
        "phone-rollback/qualified.json": qualified,
        "prod-protected-document-release.json": {"configured": True, "enabled": False},
        "prod-document-reader-compatibility.json": report,
    }


def archive(fixture, documents):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        for name, value in documents.items():
            bundle.writestr(name, json.dumps(value))
    payload = output.getvalue()
    fixture.artifact.update(
        size_in_bytes=len(payload),
        digest="sha256:" + hashlib.sha256(payload).hexdigest(),
    )
    return payload


def cold_revision(qualified):
    settings = {
        "HUSHH_DEPLOY_ENV": "production",
        "ENVIRONMENT": "production",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda",
        "HUSHH_DEPLOY_SOURCE": "deploy-production-phone-rollback",
        "HUSHH_DEPLOY_SHA": qualified["source"],
        "HUSHH_DEPLOY_RUN_ID": "300",
        "AUTH_PHONE_RECOVERY_ENABLED": "false",
        "WORKOS_SSO_ENABLED": "false",
    }
    return {
        "metadata": {
            "name": qualified["revision"],
            "labels": {
                "serving.knative.dev/service": "consent-protocol",
                "deploy-env": "production",
                "deploy-source": settings["HUSHH_DEPLOY_SOURCE"],
                "deploy-sha": qualified["source"],
                "github-run-id": "300",
                "account-deletion-contract": "v201",
            },
        },
        "spec": {
            "serviceAccountName": "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com",
            "containers": [
                {
                    "image": qualified["image"],
                    "env": [{"name": k, "value": v} for k, v in settings.items()],
                }
            ],
        },
        "status": {
            "imageDigest": qualified["image"],
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }


class LeaseFixture:
    """Explicit API, source and archive ports; no Git or provider commands."""

    def __init__(self, fixture):
        run = copy.deepcopy(fixture.run)
        run.update(
            conclusion="success",
            actor={"login": "kushaltrivedi5"},
            created_at="2026-10-21T03:00:00Z",
        )
        legacy = {
            **copy.deepcopy(run),
            "id": 200,
            "head_sha": "0" * 40,
            "run_attempt": 1,
            "created_at": "2026-10-20T03:00:00Z",
        }
        self.runs, self.attempts, self.jobs, self.artifacts, self.documents = (
            [run, legacy],
            {},
            {},
            [],
            {},
        )
        self.sources = {
            run["head_sha"]: "\n".join(
                (lease.MARKER, lease.BEGIN, lease.CLEANUP, lease.UPLOAD, "bootstrap.py")
            ).encode(),
            legacy[
                "head_sha"
            ]: b"name: legacy production deployment\non: workflow_dispatch\n",
        }
        self.calls, self.source_calls, self.source_error, self.reverted = (
            [],
            [],
            False,
            False,
        )
        self.total_count = 2
        for number in (1, 2):
            self._add_attempt(fixture, run, number)

    def _add_attempt(self, fixture, run, number):
        attempt = {**copy.deepcopy(run), "run_attempt": number}
        self.attempts[(300, number)] = attempt
        steps = [
            {"name": name, "status": "completed", "conclusion": "success"}
            for name in (lease.BEGIN, lease.DEPLOY, lease.CLEANUP, lease.UPLOAD)
        ]
        steps[-1].update(
            started_at="2026-10-21T03:19:03Z", completed_at="2026-10-21T03:19:04Z"
        )
        self.jobs[(300, number)] = {
            "total_count": 1,
            "jobs": [
                {
                    "name": lease.JOB,
                    "run_id": 300,
                    "run_attempt": number,
                    "head_sha": run["head_sha"],
                    "head_branch": "main",
                    "status": "completed",
                    "conclusion": "success",
                    "steps": steps,
                }
            ],
        }
        artifact = copy.deepcopy(fixture.artifact)
        artifact.update(id=900 + number, name=f"{lease.MARKER}300-{number}")
        self.artifacts.append(artifact)
        self.documents[number] = {
            "schema_version": 1,
            "kind": "phone-cold-health-lease",
            "status": "retired",
            "project": "hushh-pda",
            "region": "us-central1",
            "service": "consent-protocol",
            "origin": {"run_id": "300", "run_attempt": number},
            "workflow_sha": run["head_sha"],
            "tag": "phone-rollback-300",
            "source": "b" * 40,
            "image": "gcr.io/hushh-pda/consent-protocol@sha256:" + "c" * 64,
            "service_uid": "synthetic-service",
            "controls": "d" * 64,
            "iam": "e" * 64,
            "serving": [["consent-protocol-serving", 100]],
            "traffic": [[["consent-protocol-serving", 100, ""]], "[]"],
            "pending_mutation": None,
            "revision": "consent-protocol-cold",
        }

    def source(self, args):
        self.source_calls.append(args)
        if self.source_error:
            raise subprocess.CalledProcessError(1, ["synthetic-source"])
        if args[1] == "show":
            return self.sources[args[2].split(":", 1)[0]]
        if args[1] == "log":
            return b"f" * 40 if self.reverted else b""
        if args[1] == "merge-base":
            return b""
        raise AssertionError("unexpected synthetic source port")

    def active_guard(self):
        self.runs[0].update(status="in_progress", conclusion=None)
        self.attempts[(300, 2)].update(status="in_progress", conclusion=None)
        self.jobs[(300, 2)]["jobs"][0].update(
            status="in_progress",
            conclusion=None,
            steps=[{"name": lease.GUARD, "status": "in_progress", "conclusion": None}],
        )
        return {
            "GITHUB_RUN_ID": "300",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_JOB": "deploy",
            "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
            "GITHUB_REF_NAME": "main",
        }

    def pack(self):
        self.archives = {}
        for artifact in self.artifacts:
            number = int(artifact["name"].rsplit("-", 1)[1])
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w") as bundle:
                bundle.writestr(
                    "initial-lease.json", json.dumps(self.documents[number])
                )
            payload = output.getvalue()
            artifact.update(
                size_in_bytes=len(payload),
                digest="sha256:" + hashlib.sha256(payload).hexdigest(),
            )
            self.archives[artifact["id"]] = payload

    def fetch(self, args, **_kwargs):
        identity = int(args[-1].split("/")[-2])
        return subprocess.CompletedProcess([], 0, self.archives[identity], b"")

    def api(self, _repository, endpoint):
        self.calls.append(endpoint)
        if endpoint.startswith("workflows/deploy-production.yml/runs?"):
            return {"workflow_runs": self.runs, "total_count": self.total_count}
        if endpoint.startswith("workflows/capacity-maintenance.yml/runs?"):
            return {"workflow_runs": []}
        parts = endpoint.split("?", 1)[0].split("/")
        if parts[:1] != ["runs"]:
            raise AssertionError("unexpected synthetic lease lookup: " + endpoint)
        identity = int(parts[1])
        if len(parts) == 2:
            return next(row for row in self.runs if row["id"] == identity)
        if parts[2] == "artifacts":
            return {"artifacts": self.artifacts, "total_count": len(self.artifacts)}
        if parts[2] == "attempts":
            key = identity, int(parts[3])
            return self.jobs[key] if len(parts) == 5 else self.attempts[key]
        raise AssertionError("unexpected synthetic lease lookup: " + endpoint)
