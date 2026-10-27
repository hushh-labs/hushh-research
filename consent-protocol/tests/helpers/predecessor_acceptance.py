# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Standard-library receipt fixtures for both governance and protocol tests."""

import hashlib
import importlib.util
import json
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[3]
SHA = "f" * 40


def _serving_receipt(module, env, run_id):
    expected = {
        "HUSHH_DEPLOY_ENV": env,
        "HUSHH_DEPLOY_SOURCE": f"deploy-{env}",
        "HUSHH_DEPLOY_SHA": SHA,
        "HUSHH_DEPLOY_RUN_ID": str(run_id),
    }
    release = {
        "status": "healthy",
        "sha": SHA,
        "scope": "all",
        "final": {},
        "current": {},
        "verification": {
            "parity_success": "true",
            "semantic_success": "true",
            "provenance_success": "true",
            "backend_provenance": "success",
            "frontend_provenance": "success",
            "db_contract": "success",
        },
    }
    receipt = {
        "schema_version": 1,
        "repository": module.REPOSITORY,
        "environment": env,
        "workflow": f".github/workflows/deploy-{env}.yml",
        "target": "shared-dev" if env == "dev" else "uat",
        "run_id": run_id,
        "run_attempt": 2,
        "resolved_services": ["backend", "frontend"],
        "release": release,
        "provenance": {},
        "classification": {
            "status": "healthy",
            "release_failed": False,
            "blocking_classifications": [],
            "semantic": {"success": True, "report_present": True, "blocking_failures": []},
        },
        "required_checks": {
            "pkm": {"required": True, "outcome": "success"},
            "reviewer": {"required": True, "outcome": "success"},
        },
    }
    for service, name in module.SERVICES.items():
        revision = name + "-00042-abc"
        release["final"].update({f"{service}_revision": revision, f"{service}_sha": SHA})
        release["current"][f"{service}_candidate_revision"] = revision
        receipt["provenance"][service] = {
            "project": module.LANES[env],
            "region": "us-central1",
            "service": name,
            "status": "healthy",
            "ok": True,
            "mode": "live_traffic",
            "expected": expected,
            "failures": [],
            "checked_revisions": [
                {
                    "revision": revision,
                    "traffic_percent": 100,
                    "env": expected,
                    "ok": True,
                    "mismatches": [],
                },
            ],
        }
    return receipt


def _acceptance_fixture():
    path = ROOT / "scripts/ci/verify-predecessor-acceptance.py"
    spec = importlib.util.spec_from_file_location("predecessor_acceptance", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    receipts, responses, pins = {}, {}, {}
    for env, run_id in (("dev", 10), ("uat", 20)):
        receipt = _serving_receipt(module, env, run_id)
        if env == "uat":
            receipt["predecessor"] = {
                "status": "accepted",
                "environment": "dev",
                "sha": SHA,
                "services": {name: pins["dev"] for name in module.SERVICES},
            }
        archive = BytesIO()
        with ZipFile(archive, "w") as bundle:
            bundle.writestr("acceptance.json", json.dumps(receipt))
        digest = "sha256:" + hashlib.sha256(archive.getvalue()).hexdigest()
        pin = {
            "run_id": run_id,
            "run_attempt": 2,
            "artifact_id": run_id + 1,
            "artifact_digest": digest,
        }
        pins[env], receipts[env] = pin, receipt
        responses[f"runs/{run_id}/attempts/2"] = {
            "id": run_id,
            "run_attempt": 2,
            "path": receipt["workflow"],
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
            "repository": {"full_name": module.REPOSITORY},
            "head_repository": {"full_name": module.REPOSITORY},
            # Dispatch source differs from accepted application source.
            "head_sha": "a" * 40,
        }
        responses[f"artifacts/{run_id + 1}"] = {
            "id": run_id + 1,
            "name": f"release-acceptance-{env}-{run_id}-2",
            "expired": False,
            "workflow_run": {"id": run_id},
            "digest": digest,
            "size_in_bytes": len(archive.getvalue()),
        }
        responses[f"artifacts/{run_id + 1}/zip"] = archive.getvalue()
    client = module.GitHub()
    client.read = lambda path, **_: responses[path]
    return module, client, receipts, responses, pins
