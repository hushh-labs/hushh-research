"""Inert cloud and database fixtures for PLG qualification safety contracts."""

import base64
import copy
import hashlib
import importlib
import json
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile, ZipInfo


class ExistingSecret:
    project_number = "1234"

    def __init__(
        self,
        target,
        name,
        data,
        *,
        state="ENABLED",
        public=False,
        runtime_access=None,
        conditioned=False,
    ):
        self.target, self.name, self.data = target, name, data
        self.state, self.public, self.posts = state, public, []
        self.runtime_access = (
            not name.startswith("MIGRATOR_") if runtime_access is None else runtime_access
        )
        self.conditioned, self.policy_reads, self.value_reads = conditioned, 0, 0
        self.path = f"projects/1234/secrets/PLG_QUALIFICATION_{name}"

    def request(self, _api, path, *, method="GET", **kwargs):
        if method != "GET":
            self.posts.append((path, kwargs))
            return {}
        if path.endswith(":getIamPolicy"):
            self.policy_reads += 1
            if not self.public and not self.runtime_access:
                return {"bindings": []}
            member = "allUsers" if self.public else "serviceAccount:" + self.target.runtime_sa
            binding = {"role": "roles/secretmanager.secretAccessor", "members": [member]}
            if self.conditioned:
                binding["condition"] = {"title": "synthetic", "expression": "true"}
            return {"bindings": [binding]}
        if path.endswith(":access"):
            self.value_reads += 1
            return {
                "name": self.path + "/versions/7",
                "payload": {"data": base64.b64encode(self.data).decode()},
            }
        if path.endswith("/versions/latest"):
            if self.state == "MISSING":
                return None
            return {"name": self.path + "/versions/7", "state": self.state}
        return {"name": self.path, "labels": self.target.labels}


class SyntheticBaseline:
    def __init__(self, target, database, foundation, owner_rows):
        self.target, self.database, self.foundation = target, database, foundation
        self.owner_rows, self.query = owner_rows, ""

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, *_args):
        self.query = str(query)

    def fetchone(self):
        if self.query == "SELECT current_database()":
            return (self.target.DATABASE,)
        if self.query == "SHOW transaction_read_only":
            return ("on",)
        if "pg_get_userbyid" in self.query:
            return (self.target.MIGRATOR_ROLE, self.target.MARKER)
        if "SELECT to_regclass" in self.query:
            return (None,)
        if "SELECT to_regprocedure" in self.query:
            return ("account_provider_cleanup_contract_version()",)
        if self.query == "SELECT public.account_provider_cleanup_contract_version()":
            return (2,)
        if "FROM pg_trigger" in self.query:
            return (True,)
        return (self.owner_rows,)

    def fetchall(self):
        if self.query.startswith("SELECT tablename"):
            return [
                (name,)
                for name in sorted(
                    {"consent_audit", "pkm_events", "pkm_domain_commits", *self.foundation.CATALOGS}
                )
            ]
        for relation, definition in self.foundation.CATALOGS.items():
            if f"Identifier('{relation}')" in self.query:
                return definition["rows"]
        raise AssertionError("Unexpected synthetic catalog query")


class HostedAcceptance:
    """Inert hosted-attempt transport, not locally admissible cloud evidence."""

    def __init__(self, monkeypatch):
        root = Path(__file__).resolve().parents[3]
        monkeypatch.syspath_prepend(str(root / "deploy/plg"))
        self.module = importlib.import_module("qualification_acceptance")
        self.cache, self.responses, self.receipts, self.refreshes = {}, {}, {}, {}
        self.calls, self.source_calls = [], []
        self.runs, self.case = {"dev": 17, "uat": 18}, "valid"
        self.definitions = {"deploy/backend-image.cloudbuild.yaml": "b" * 64}
        self.source = {
            "status": "validated",
            "scope": "plg-only-source",
            "trafficAuthorized": False,
            "sourceSha": self.module.SOURCE,
            "workflowSha": "c" * 40,
            "recordSha256": "d" * 64,
            "runId": 31,
            "runAttempt": 1,
            "artifactId": 32,
            "artifactDigest": "sha256:" + "e" * 64,
        }
        monkeypatch.setattr(self.module, "reviewed_definitions", lambda *_: self.definitions)
        monkeypatch.setattr(self.module.foundation, "load_contract", lambda: ({}, "f" * 64))
        monkeypatch.setattr(self.module.validation.authority, "_git", lambda *_: b"a" * 40)
        monkeypatch.setattr(self.module.validation, "verify", self.validate_source)
        for environment in self.runs:
            self._add(environment)

    def validate_source(self, run_id, sha, *, github):
        assert (run_id, sha, github) == (31, self.module.SOURCE, self)
        self.source_calls.append(run_id)
        return copy.deepcopy(self.source)

    def _add(self, environment):
        m, run_id = self.module, self.runs[environment]
        target = m.Target(environment)
        run = {
            "id": run_id,
            "run_attempt": 1,
            "head_sha": "c" * 40,
            "path": f".github/workflows/deploy-{environment}.yml",
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
            "repository": {"full_name": m.validation.transport.REPOSITORY},
            "head_repository": {"full_name": m.validation.transport.REPOSITORY},
            "actor": {"login": "DamriaNeelesh"},
            "triggering_actor": {"login": "DamriaNeelesh"},
            "updated_at": "2026-10-28T02:00:00Z",
        }
        job = {
            "name": m.GATES[environment],
            "run_id": run_id,
            "head_sha": run["head_sha"],
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-10-28T01:00:00Z",
            "completed_at": run["updated_at"],
            "steps": [
                {"name": name, "status": "completed", "conclusion": "success"}
                for name in m.STEPS | {m.IMAGE_STEPS[environment]}
            ],
        }
        self.responses[f"runs/{run_id}"] = run
        self.responses[f"runs/{run_id}/attempts/1/jobs?per_page=100"] = {
            "total_count": 1,
            "jobs": [job],
        }
        image = f"gcr.io/{target.project}/consent-protocol@sha256:" + "a" * 64
        receipt = {
            "schemaVersion": 1,
            "kind": m.KIND,
            "status": "accepted-isolated",
            "target": m.TARGET,
            "environment": environment,
            "sourceSha": m.SOURCE,
            "baselineSha": m.BASELINE,
            "repository": m.validation.transport.REPOSITORY,
            "workflow": run["path"],
            "workflowSha": run["head_sha"],
            "runId": run_id,
            "runAttempt": 1,
            "authorityBlobs": self.definitions,
            "sharedEnvironmentAccepted": False,
            "productionTrafficAuthorized": False,
            "sourceValidation": copy.deepcopy(self.source),
            "image": self._image(target, run_id, image),
            "predecessor": None,
            **_runtime(m.proofs, target),
            **_candidate(m.proofs, target, run_id, image),
        }
        if environment == "uat":
            receipt["predecessor"] = self.pin("dev")
        for key in ("image", "schema", "iam", "capacity", "candidate", "health"):
            receipt[key]["observedAt"] = "2026-10-28T01:30:00Z"
        self.receipts[environment] = receipt

    def _image(self, target, run_id, reference):
        m = self.module
        if target.environment == "uat":
            return {
                "reference": reference,
                "sourceSha": m.SOURCE,
                "mode": "promoted-dev",
                "promotedFrom": self.receipts["dev"]["image"]["reference"],
            }
        return {
            "reference": reference,
            "sourceSha": m.SOURCE,
            "mode": "source-build",
            "build": {
                "project": target.project,
                "status": "SUCCESS",
                "sourceSha": m.SOURCE,
                "sourceTree": "a" * 40,
                "configSha256": self.definitions["deploy/backend-image.cloudbuild.yaml"],
                "imageTag": f"plg-qual-{m.SOURCE[:12]}-{run_id}-1",
                "executableReference": reference,
                "platform": "linux/amd64",
                "buildId": "12345678-1234-1234-1234-123456789abc",
                "sourceArchiveSha256": "2" * 64,
                "indexReference": reference,
                "storageSource": {"bucket": "synthetic", "object": "source.tgz", "generation": "1"},
            },
        }

    def _archive(self, environment):
        buffer = BytesIO()
        with ZipFile(buffer, "w") as bundle:
            bundle.writestr(
                ZipInfo("acceptance.json", (2026, 10, 28, 1, 30, 0)),
                json.dumps(self.receipts[environment]),
            )
        return buffer.getvalue()

    def pin(self, environment):
        run_id = self.runs[environment]
        return self.module.IsolatedAcceptance(
            environment,
            run_id,
            1,
            run_id + 100,
            "sha256:" + hashlib.sha256(self._archive(environment)).hexdigest(),
            "c" * 40,
            self.receipts[environment]["image"]["reference"],
        ).pin()

    def read(self, path, *, binary=False):
        self.calls.append(path)
        if path in self.cache:
            return self.cache[path]
        if path in self.responses:
            value = copy.deepcopy(self.responses[path])
            self.refreshes[path] = self.refreshes.get(path, 0) + 1
            if self.case == "rerun" and path == "runs/17" and self.refreshes[path] > 1:
                value["run_attempt"] = 2
        else:
            environment = "dev" if ("/17/" in path or "/117/" in path) else "uat"
            archive, run_id = self._archive(environment), self.runs[environment]
            if binary:
                value = archive + b"corrupted" if self.case == "digest" else archive
            else:
                value = {
                    "total_count": 1,
                    "artifacts": [
                        {
                            "name": f"plg-isolated-acceptance-{environment}-{run_id}-1",
                            "id": run_id + 100,
                            "expired": False,
                            "workflow_run": {"id": run_id},
                            "size_in_bytes": len(archive),
                            "digest": "sha256:" + hashlib.sha256(archive).hexdigest(),
                        }
                    ],
                }
                if self.case == "ordinary-artifact":
                    value["artifacts"][0]["name"] = f"release-acceptance-{environment}-{run_id}-1"
        self.cache[path] = value
        return value

    def break_evidence(self, case):
        self.case = case
        receipt = self.receipts["dev"]
        if case == "skipped":
            self.responses["runs/17/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][0][
                "conclusion"
            ] = "skipped"
        elif case == "fork":
            self.responses["runs/17"]["head_repository"] = {"full_name": "synthetic/fork"}
        elif case == "shared":
            receipt["kind"], receipt["target"] = "release-acceptance", "shared-dev"
        elif case == "source":
            receipt["sourceValidation"]["artifactDigest"] = "sha256:" + "0" * 64
        elif case == "authority":
            receipt["authorityBlobs"] = {"deploy/backend-image.cloudbuild.yaml": "0" * 64}
        elif case == "schema":
            receipt["schema"]["ownerRowsCopied"] = False
        elif case == "build":
            receipt["image"]["build"]["sourceTree"] = "0" * 40
        elif case == "iam":
            receipt["iam"]["migratorSecretAccess"] = True
        elif case == "capacity":
            receipt["capacity"]["report"].update(admission_limit=15, headroom_to_limit=0)
        elif case == "health":
            receipt["health"]["audience"] = "https://unrelated.a.run.app"
        elif case == "stale":
            receipt["schema"]["observedAt"] = "2026-10-27T01:30:00Z"
        elif case == "uat-rebuild":
            self.receipts["uat"]["image"]["mode"] = "source-build"
        elif case == "uat-image":
            self.receipts["uat"]["image"]["reference"] = (
                self.receipts["uat"]["image"]["reference"][:-1] + "b"
            )
        elif case == "uat-shared":
            self.receipts["uat"]["predecessor"]["kind"] = "release-acceptance"


def _runtime(m, target):
    versions = {m.PREFIX + name: "1" for name in m.RUNTIME_SECRETS}
    return {
        "schema": {
            "sourceSha": m.SOURCE,
            "foundationSha256": "f" * 64,
            "instance": target.instance,
            "database": m.DATABASE,
            "runtimeRole": m.RUNTIME_ROLE,
            "runtimeRoleConnectionLimit": 8,
            "systemIdentifier": m.foundation.CLUSTERS[target.environment]["systemIdentifier"],
            "providerContractVersion": 2,
            "requiredAbsentTables": list(m.ABSENT_TABLES),
            "sourceSchemaVerified": True,
            "sourceCatalogsVerified": True,
            "replacementAccounts": 0,
            "ownerRowsCopied": 0,
            "runtimeEmptyRead": True,
            "runtimeGrantsVerified": True,
            "memoryIndexDefinitionSha256": "3" * 64,
        },
        "iam": {
            "project": target.project,
            "service": m.SERVICE,
            "runtimePrincipal": target.runtime_sa,
            "invokerIamDisabled": False,
            "publicInvokerBindings": [],
            "ancestorPoliciesComplete": True,
            "runtimeCloudSqlClient": True,
            "runtimeSecretsOnly": True,
            "migratorSecretAccess": False,
            "additionalRuntimeAuthority": False,
            "runtimeSecretVersions": versions,
        },
        "capacity": {
            "inventoryComplete": True,
            "retainedRevisionsCounted": True,
            "runtimeRoleConnectionLimit": 8,
            "report": {
                "environment": target.environment,
                "phase": "pre-deploy",
                "project": target.project,
                "database": target.instance,
                "admitted": True,
                "administrative_reserve": 10,
                "projected_connections": 15,
                "admission_limit": 80,
                "verified_max_connections": 100,
                "headroom_to_limit": 65,
                "jobs": [],
                "services": [
                    {
                        "name": m.SERVICE + ":new-candidate",
                        "max_instances": 1,
                        "workers_per_instance": 1,
                        "connections_per_worker": 5,
                        "connections": 5,
                    }
                ],
            },
        },
    }


def _candidate(m, target, run_id, image):
    revision = m.SERVICE + "-00001-abc"
    origin = "https://" + m.SERVICE + "-synthetic.a.run.app"
    expected = {
        "HUSHH_DEPLOY_ENV": target.environment,
        "HUSHH_DEPLOY_SOURCE": m.TARGET,
        "HUSHH_DEPLOY_SHA": m.SOURCE,
        "HUSHH_DEPLOY_RUN_ID": str(run_id),
    }
    report = {
        "service": m.SERVICE,
        "project": target.project,
        "region": "us-central1",
        "mode": "candidate",
        "status": "healthy",
        "ok": True,
        "expected": expected,
        "failures": [],
        "classifications": [],
        "candidate_url": origin,
        "checked_revisions": [
            {
                "revision": revision,
                "env": expected,
                "ok": True,
                "mismatches": [],
                "image_reference": image,
                "image_digest": "sha256:" + "a" * 64,
                "image_verified": True,
                "labels": {
                    "deploy-env": target.environment,
                    "deploy-source": m.TARGET,
                    "deploy-sha": m.SOURCE,
                    "github-run-id": str(run_id),
                },
            }
        ],
    }
    return {
        "candidate": {
            "revision": revision,
            "serviceUrl": origin,
            "provenance": report,
            "runtimePrincipal": target.runtime_sa,
            "runtimeSecretVersions": {m.PREFIX + name: "1" for name in m.RUNTIME_SECRETS},
            "cloudSqlInstance": target.instance,
            "database": m.DATABASE,
        },
        "health": {
            "candidateUrl": origin,
            "audience": origin,
            "revision": revision,
            "imageReference": image,
            "authenticated": True,
            "redirects": 0,
            "provenanceRechecked": True,
            "unauthenticatedStatus": 403,
            "passes": [{"httpStatus": 200, "bodyStatus": "healthy"}] * 2,
        },
    }
