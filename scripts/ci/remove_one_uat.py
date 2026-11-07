#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Remove only the reviewed incarnation of the unused one-uat experiment."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from functools import partial
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlencode

SERVICE = "projects/hushh-pda-uat/locations/us-central1/services/one-uat"
EXPECTED_UID = "02f36253-d55c-4750-ada5-f0697d35fb16"
OPERATION = re.compile(
    r"projects/(hushh-pda-uat|745506018753)/locations/us-central1/operations/[a-zA-Z0-9_-]+"
)
WAIT_SECONDS = 300


class Refused(RuntimeError):
    """A fixed diagnostic code safe for the removal receipt."""


def request(method: str, name: str, *, token: str, etag: str | None = None):
    connection = http.client.HTTPSConnection("run.googleapis.com", timeout=30)
    query = "?" + urlencode({"etag": etag}) if etag is not None else ""
    try:
        connection.request(
            method, "/v2/" + name + query, headers={"Authorization": "Bearer " + token}
        )
        response = connection.getresponse()
        if method == "GET" and response.status == 404:
            return None
        if response.status != 200:
            raise Refused(f"cloud_run_http_{response.status}")
        payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise Refused("response_too_large")
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise Refused("invalid_response")
        return result
    finally:
        connection.close()


def remove_one_uat(call, *, execute: bool, record):
    report = {"service": SERVICE, "expected_uid": EXPECTED_UID, "status": "inspecting"}

    def update(status: str, **fields):
        report.update(status=status, **fields)
        record(report)

    try:
        update("inspecting")
        service = call("GET", SERVICE)
        if service is None:
            update("already_absent")
            return report
        if service.get("name") != SERVICE or service.get("uid") != EXPECTED_UID:
            raise Refused("service_identity_changed")
        if service.get("reconciling") or service.get("deleteTime"):
            raise Refused("service_reconciling")
        etag = service.get("etag")
        if not isinstance(etag, str) or not etag:
            raise Refused("service_etag_missing")
        update("inspected", uid=EXPECTED_UID, etag=etag)
        if not execute:
            return report

        # Persist intent before the only mutation. A lost response is uncertain.
        update("delete_submitting")
        operation = call("DELETE", SERVICE, etag=etag)
        name = operation.get("name", "") if isinstance(operation, dict) else ""
        if not isinstance(name, str) or not OPERATION.fullmatch(name):
            raise Refused("operation_identity_invalid")
        update("deleting", operation=name)
        deadline = time.monotonic() + WAIT_SECONDS
        while operation.get("done") is not True:
            if time.monotonic() >= deadline:
                raise Refused("operation_timeout")
            time.sleep(2)
            operation = call("GET", name)
            if not isinstance(operation, dict) or operation.get("name") != name:
                raise Refused("operation_unavailable")
        if operation.get("error"):
            update("failed", failure="operation_failed")
            raise Refused("operation_failed")

        while call("GET", SERVICE) is not None:
            if time.monotonic() >= deadline:
                raise Refused("absence_unconfirmed")
            time.sleep(2)
        update("deleted")
        return report
    except Exception as error:
        status = report["status"]
        if status != "failed":
            uncertain = status in {"delete_submitting", "deleting"}
            code = (
                str(error)
                if isinstance(error, Refused)
                else "transport_or_response_failure"
            )
            update("uncertain" if uncertain else "refused", failure=code)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation", choices=("inspect", "delete"), default="inspect")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    def record(report):
        receipt = {
            **report,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "workflow_sha": os.getenv("GITHUB_SHA"),
            "run_id": os.getenv("GITHUB_RUN_ID"),
            "run_attempt": os.getenv("GITHUB_RUN_ATTEMPT"),
            "actor": os.getenv("GITHUB_ACTOR"),
            "triggering_actor": os.getenv("GITHUB_TRIGGERING_ACTOR"),
            "expected_executor": "github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com",
        }
        args.report.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.report.with_suffix(".pending")
        temporary.write_text(json.dumps(receipt, indent=2) + "\n")
        temporary.replace(args.report)
        print("one_uat_removal status=" + report["status"], flush=True)

    token = ""
    try:
        record(
            {
                "service": SERVICE,
                "expected_uid": EXPECTED_UID,
                "status": "authenticating",
            }
        )
        token = subprocess.run(
            ["gcloud", "auth", "print-access-token"],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout.strip()
        if not token:
            raise Refused("access_token_unavailable")
        remove_one_uat(
            partial(request, token=token),
            execute=args.operation == "delete",
            record=record,
        )
    except Exception:
        if not token:
            record(
                {
                    "service": SERVICE,
                    "status": "refused",
                    "failure": "authentication_unavailable",
                }
            )
        print("one_uat_removal failed; inspect the removal receipt", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
