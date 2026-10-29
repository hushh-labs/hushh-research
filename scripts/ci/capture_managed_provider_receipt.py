#!/usr/bin/env python3
"""Capture the exact successful UAT build's provider receipt from Cloud Logging.

This is evidence collection only. The existing aggregate owns provider policy;
no probe, provider selection, revision or traffic mutation is performed here.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import UUID


class ReceiptError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise ReceiptError(reason)


def cloud_json(arguments, deadline):
    remaining = deadline - time.monotonic()
    require(remaining > 0, "collection_deadline")
    result = subprocess.run(
        ["gcloud", *arguments, "--format=json"],
        capture_output=True,
        text=True,
        timeout=min(30, remaining),
        check=False,
    )
    require(result.returncode == 0, "cloud_evidence_unavailable")
    return json.loads(result.stdout)


def check_build(build, expected):
    require(
        build.get("id") == expected["build_id"]
        and build.get("projectId") == expected["project"]
        and build.get("status") == "SUCCESS",
        "build_not_exact_success",
    )
    substitutions = build.get("substitutions", {})
    bindings = {
        "_DEPLOY_SHA": "source_sha",
        "_GITHUB_RUN_ID": "github_run",
        "_IMAGE_REFERENCE": "image",
        "_RUNTIME_SERVICE_ACCOUNT": "runtime_account",
        "_DEPLOY_ENV": "environment",
        "_REGION": "region",
    }
    require(
        all(
            substitutions.get(key) == expected[value] for key, value in bindings.items()
        )
        and substitutions.get("_BACKEND_SERVICE") == "consent-protocol"
        and substitutions.get("_CLOUD_RUN_TAG")
        == "account-deletion-" + expected["github_run"]
        and substitutions.get("_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE")
        == str(expected["legacy_exception"]).lower(),
        "build_context_mismatch",
    )
    steps = [
        (index, step)
        for index, step in enumerate(build.get("steps", []))
        if step.get("id") == "verify-managed-provider-readiness"
    ]
    require(
        len(steps) == 1 and steps[0][1].get("status") == "SUCCESS",
        "aggregate_step_not_successful",
    )
    require(
        steps[0][1].get("waitFor")
        == [
            "deploy-backend",
            "verify-azure-pwm-runtime",
            "verify-managed-vertex-runtime",
        ],
        "aggregate_dependencies_mismatch",
    )
    for key in ("startTime", "finishTime"):
        require(
            isinstance(build.get(key), str) and bool(build[key]), "build_window_missing"
        )
    return f'Step #{steps[0][0]} - "verify-managed-provider-readiness"'


def from_entries(entries, expected, document, step_label):
    readiness = importlib.import_module("managed_provider_readiness")
    require(
        isinstance(entries, list) and len(entries) < 101, "receipt_inventory_truncated"
    )
    aggregates, selections, origins = {}, {}, []
    for entry in entries:
        resource = entry.get("resource", {})
        require(
            resource.get("type") == "build"
            and resource.get("labels", {}).get("build_id") == expected["build_id"]
            and resource.get("labels", {}).get("project_id") == expected["project"]
            and entry.get("labels", {}).get("build_step") == step_label,
            "receipt_origin_mismatch",
        )
        value = entry.get("jsonPayload")
        if not isinstance(value, dict):
            text = entry.get("textPayload", "")
            prefix = step_label + ": "
            require(
                isinstance(text, str) and text.startswith(prefix),
                "receipt_payload_invalid",
            )
            value = json.loads(text[len(prefix) :])
        if set(value) == {"managed_provider_readiness"}:
            row = value["managed_provider_readiness"]
            aggregates[json.dumps(row, sort_keys=True)] = row
        elif set(value) == {"managed_provider_selection", "context"}:
            selections[json.dumps(value, sort_keys=True)] = value
        else:
            raise ReceiptError("unexpected_receipt")
        require(
            entry.get("insertId") and entry.get("timestamp"),
            "receipt_log_identity_missing",
        )
        origins.append(
            {"insert_id": entry["insertId"], "timestamp": entry["timestamp"]}
        )
    require(len(aggregates) <= 1 and len(selections) <= 1, "conflicting_receipts")
    if not aggregates or not selections:
        return None
    aggregate, selection = (
        next(iter(aggregates.values())),
        next(iter(selections.values())),
    )
    require(
        aggregate.get("schema") == "managed_provider_readiness.v1"
        and aggregate.get("context") == expected
        and selection.get("context") == expected,
        "receipt_context_mismatch",
    )
    providers = aggregate.get("providers", {})
    require(
        set(providers) == readiness.PROVIDERS
        and all(type(providers[p].get("ready")) is bool for p in providers),
        "provider_flags_invalid",
    )
    if hasattr(readiness, "configured_provider"):
        configured = readiness.configured_provider(document)
        preferred = configured if providers[configured]["ready"] else None
    else:
        # Historical candidate tooling had an Azure-only release contract.
        preferred = "azure_openai" if providers["azure_openai"]["ready"] else None
    require(
        preferred is not None
        and aggregate.get("ready") is True
        and aggregate.get("selected_provider") == preferred
        and aggregate.get("pwm_trust") != "failed"
        and aggregate.get("required_scopes") == sorted(readiness.SCOPES)
        and aggregate.get("required_capabilities")
        == sorted(document["managed_runtime_uat"]["required_capabilities"]),
        "provider_readiness_unverified",
    )
    chosen = selection.get("managed_provider_selection", {})
    require(
        chosen.get("status") == "verified"
        and chosen.get("provider") == preferred
        and chosen.get("image") == expected["image"]
        and re.fullmatch(
            r"consent-protocol-[a-z0-9-]+", str(chosen.get("revision", ""))
        )
        and type(chosen.get("traffic_percent")) is int
        and chosen["traffic_percent"] == 0,
        "provider_selection_unverified",
    )
    return captured_receipt(aggregate, expected, chosen, origins, step_label, readiness)


def captured_receipt(aggregate, expected, chosen, origins, step_label, readiness):
    providers = aggregate["providers"]
    # Reproduce only the producer's bounded receipt fields, never arbitrary logs,
    # error bodies, source substitutions or runtime secrets.
    result = {
        key: aggregate[key]
        for key in (
            "schema",
            "context",
            "ready",
            "selected_provider",
            "pwm_trust",
            "required_scopes",
            "required_capabilities",
        )
    }
    result["providers"] = {
        p: {
            "ready": providers[p]["ready"],
            **(
                readiness._capability_proof().verified_diagnostics(
                    providers[p], provider=p
                )
                if "probe_history" in providers[p]
                else {}
            ),
        }
        for p in sorted(readiness.PROVIDERS)
    }
    return {
        "readiness": result,
        "selection": {
            "context": expected,
            "managed_provider_selection": {
                key: chosen[key]
                for key in (
                    "status",
                    "provider",
                    "image",
                    "revision",
                    "traffic_percent",
                )
            },
        },
        "selection_verified": True,
        "collection": {
            "source": "cloud_logging",
            "build_id": expected["build_id"],
            "aggregate_step": step_label,
            "aggregate_status": "SUCCESS",
            "logs": origins,
        },
    }


def collect(
    expected, document, *, read=cloud_json, sleep=time.sleep, monotonic=time.monotonic
):
    deadline = monotonic() + 120
    build = read(
        [
            "builds",
            "describe",
            expected["build_id"],
            "--project=" + expected["project"],
        ],
        deadline,
    )
    label = check_build(build, expected)
    query = (
        'resource.type="build" AND resource.labels.build_id="'
        + expected["build_id"]
        + '" AND timestamp>="'
        + build["startTime"]
        + '" AND timestamp<="'
        + build["finishTime"]
        + '" AND (jsonPayload.managed_provider_readiness:* OR jsonPayload.managed_provider_selection:*'
        + " OR textPayload:managed_provider_readiness OR textPayload:managed_provider_selection)"
    )
    for attempt in range(1, 7):
        require(monotonic() < deadline, "collection_deadline")
        entries = read(
            [
                "logging",
                "read",
                query,
                "--project=" + expected["project"],
                "--limit=101",
                "--order=asc",
            ],
            deadline,
        )
        result = from_entries(entries, expected, document, label)
        if result:
            result["collection"]["attempts"] = attempt
            return result
        if attempt < 6:
            require(monotonic() + 5 < deadline, "collection_deadline")
            sleep(5)
    raise ReceiptError("receipt_logs_not_visible")


def atomic_write(path, result):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, prefix=path.name + ".", delete=False
        ) as output:
            temporary = Path(output.name)
            json.dump(result, output, indent=2, sort_keys=True)
            output.write("\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    code, report = 1, {"selection_verified": False, "collection": {"status": "failed"}}
    try:
        readiness = importlib.import_module("managed_provider_readiness")
        expected = readiness.context(os.environ)
        require(
            str(UUID(expected["build_id"])) == expected["build_id"], "build_id_invalid"
        )
        require(
            expected["project"] == "hushh-pda-uat"
            and expected["region"] == "us-central1"
            and expected["environment"] == "uat"
            and expected["runtime_account"]
            == "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "uat_authority_mismatch",
        )
        document = json.loads(
            (
                readiness.ROOT / "consent-protocol/config/managed-ai-runtime.json"
            ).read_text()
        )
        report = collect(expected, document)
        code = 0
    except Exception as error:
        report["collection"]["reason"] = (
            str(error)
            if isinstance(error, ReceiptError)
            else "receipt_collection_unavailable"
        )
    atomic_write(args.output, report)
    print(json.dumps({"managed_provider_receipt_captured": code == 0}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
