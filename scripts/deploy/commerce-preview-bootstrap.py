#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bootstrap only the fixed commerce preview; never configure the application.

Formal HTTP 404 alone admits creation. Every created lane is private, inert and
recorded before continuing so a partial first release can be quarantined.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from pathlib import Path
from runpy import run_path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

TARGET = run_path(str(Path(__file__).with_name("commerce-preview-target.py")))
BACKEND, FRONTEND, PROJECT, RUNTIME_SA, origin = (
    TARGET[key] for key in ("BACKEND", "FRONTEND", "PROJECT", "RUNTIME_SA", "origin")
)

REGION = "us-central1"
PARENT = f"projects/{PROJECT}/locations/{REGION}"
BASE = "https://run.googleapis.com/v2/"
BOOTSTRAP_REPOSITORY = f"gcr.io/{PROJECT}/scope-commerce-bootstrap"
PUBLIC = {"allUsers", "allAuthenticatedUsers"}
TEMPLATE_MASK = ",".join(
    "template." + field
    for field in (
        "labels",
        "serviceAccount",
        "timeout",
        "maxInstanceRequestConcurrency",
        "scaling",
        "containers",
        "volumes",
        "vpcAccess",
        "encryptionKey",
    )
)


class BootstrapError(ValueError):
    def __init__(self, code, *, stage="validation", http_status=None):
        super().__init__(code)
        self.stage = stage
        self.http_status = http_status


def request_stage(path):
    if path == f"projects/{PROJECT}:getIamPolicy":
        return "project_policy"
    if re.fullmatch(r"(?:folders|organizations)/[0-9]+:getIamPolicy", path):
        return "ancestor_policy"
    if path == f"projects/{PROJECT}" or re.fullmatch(r"folders/[0-9]+", path):
        return "ancestry"
    if path.endswith(":getIamPolicy"):
        return "service_policy"
    if "?serviceId=" in path:
        return "service_creation"
    return "service_request"


def safe_failure(error):
    stages = {
        "validation",
        "project_policy",
        "ancestor_policy",
        "ancestry",
        "service_policy",
        "service_creation",
        "service_request",
    }
    stage = getattr(error, "stage", None) if isinstance(error, BootstrapError) else None
    status = getattr(error, "http_status", None) if isinstance(error, BootstrapError) else None
    return {
        "error": "commerce_preview_bootstrap_unverified",
        "stage": stage if stage in stages else "validation",
        "http_status": status if type(status) is int and 100 <= status <= 599 else None,
    }


class CloudRun:
    def __init__(self):
        # Workload Identity supplied by the workflow, never an SDK/payment key.
        result = subprocess.run(  # noqa: S603 - fixed command, token never emitted.
            ["gcloud", "auth", "print-access-token"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self._token = result.stdout.strip()
        if not self._token:
            raise BootstrapError("bootstrap_cloud_identity_missing")

    def request(self, path, *, method="GET", body=None, missing=False):
        data = None if body is None else json.dumps(body).encode()
        if path == f"projects/{PROJECT}:getIamPolicy":
            url = f"https://cloudresourcemanager.googleapis.com/v3/projects/{PROJECT}:getIamPolicy"
            method, data = "POST", b"{}"
        elif path == f"projects/{PROJECT}" or re.fullmatch(
            r"(?:folders|organizations)/[0-9]+(?::getIamPolicy)?", path
        ):
            url = "https://cloudresourcemanager.googleapis.com/v3/" + path
            if path.endswith(":getIamPolicy"):
                method, data = "POST", b"{}"
        else:
            url = BASE + path
        request = Request(  # noqa: S310 - only fixed Google APIs.
            url,
            data=data,
            method=method,
            headers={
                "Authorization": "Bearer " + self._token,
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=45) as response:  # noqa: S310 - fixed Google API.
                result = json.load(response)
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            raise BootstrapError(
                "bootstrap_cloud_request_failed", stage=request_stage(path), http_status=error.code
            ) from None
        if not isinstance(result, dict):
            raise BootstrapError("bootstrap_cloud_receipt_invalid")
        return result

    def finish(self, operation):
        name = operation.get("name", "")
        if not name.startswith(PARENT + "/operations/"):
            raise BootstrapError("bootstrap_operation_unverified")
        deadline = time.monotonic() + 600
        while not operation.get("done"):
            if time.monotonic() >= deadline:
                raise BootstrapError("bootstrap_operation_timeout")
            time.sleep(3)
            operation = self.request(name)
        if "error" in operation:
            raise BootstrapError("bootstrap_operation_failed")


def image_reference(value):
    if not re.fullmatch(re.escape(BOOTSTRAP_REPOSITORY) + r"@sha256:[0-9a-f]{64}", value):
        raise BootstrapError("bootstrap_image_unverified")
    return value


def bootstrap_template(image, sha):
    return {
        "labels": {"hussh-bootstrap": "commerce-preview", "deploy-sha": sha},
        "serviceAccount": RUNTIME_SA,
        "timeout": "60s",
        "maxInstanceRequestConcurrency": 20,
        "scaling": {"minInstanceCount": 0, "maxInstanceCount": 1},
        "volumes": [],
        "containers": [
            {
                "image": image_reference(image),
                "ports": [{"containerPort": 8080}],
                "resources": {"limits": {"cpu": "1", "memory": "256Mi"}, "cpuIdle": True},
                "startupProbe": {
                    "tcpSocket": {"port": 8080},
                    "periodSeconds": 5,
                    "failureThreshold": 24,
                },
            }
        ],
    }


def public_invoker(policy):
    return any(
        PUBLIC.intersection(binding.get("members", [])) for binding in policy.get("bindings", [])
    )


def assert_private(api, name, service):
    if service.get("invokerIamDisabled", False):
        raise BootstrapError("bootstrap_invoker_check_disabled")
    if public_invoker(api.request(name + ":getIamPolicy")):
        raise BootstrapError("bootstrap_public_service")
    assert_parent_private(api)


def assert_parent_private(api):
    if public_invoker(api.request(f"projects/{PROJECT}:getIamPolicy")):
        raise BootstrapError("bootstrap_public_project")
    project = api.request(f"projects/{PROJECT}")
    if project.get("projectId") != PROJECT:
        raise BootstrapError("bootstrap_project_ancestry_unverified")
    parent, seen = project.get("parent", ""), set()
    while parent:
        if (
            not re.fullmatch(r"(?:folders|organizations)/[0-9]+", parent)
            or parent in seen
            or len(seen) >= 12
        ):
            raise BootstrapError("bootstrap_project_ancestry_unverified")
        seen.add(parent)
        if public_invoker(api.request(parent + ":getIamPolicy")):
            raise BootstrapError("bootstrap_public_ancestor")
        if parent.startswith("organizations/"):
            break
        folder = api.request(parent)
        if folder.get("name") != parent or not folder.get("parent"):
            raise BootstrapError("bootstrap_project_ancestry_unverified")
        parent = folder["parent"]


def inspect(api, name, service, expected_image=None, expected_sha=None):
    application_repository = {
        f"{PARENT}/services/{BACKEND}": "consent-protocol",
        f"{PARENT}/services/{FRONTEND}": "hushh-webapp",
    }.get(name)
    if application_repository is None:
        raise BootstrapError("bootstrap_service_unverified")
    if service.get("name") != name or service.get("reconciling"):
        raise BootstrapError("bootstrap_service_unverified")
    template = service.get("template", {})
    if template.get("serviceAccount") != RUNTIME_SA:
        raise BootstrapError("bootstrap_runtime_identity_mismatch")
    service_origin = origin(service.get("uri", ""))
    if not service_origin.endswith(".run.app"):
        raise BootstrapError("bootstrap_origin_unverified")
    statuses = service.get("trafficStatuses", [])
    serving = [item for item in statuses if item.get("percent", 0) > 0]
    if len(serving) != 1 or serving[0].get("percent") != 100:
        raise BootstrapError("bootstrap_serving_revision_unverified")
    revision_name = serving[0].get("revision", "")
    if "/" not in revision_name:
        identifier = name.rsplit("/", 1)[-1]
        if len(revision_name) > 63 or not re.fullmatch(
            re.escape(identifier) + r"-[a-z0-9]+(?:-[a-z0-9]+)*", revision_name
        ):
            raise BootstrapError("bootstrap_serving_revision_unverified")
        # Cloud Run v2 trafficStatuses emits the short revision identifier;
        # the revision GET still uses this exact service's resource path.
        revision_name = name + "/revisions/" + revision_name
    if not revision_name.startswith(name + "/revisions/"):
        raise BootstrapError("bootstrap_serving_revision_unverified")
    revision_id = revision_name.removeprefix(name + "/revisions/")
    if len(revision_id) > 63 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", revision_id):
        raise BootstrapError("bootstrap_serving_revision_unverified")
    revision = api.request(revision_name)
    if revision.get("name") != revision_name or revision.get("serviceAccount") != RUNTIME_SA:
        raise BootstrapError("bootstrap_revision_identity_mismatch")
    labels = revision.get("labels", {})
    containers = revision.get("containers", [])
    if len(containers) != 1:
        raise BootstrapError("bootstrap_container_unverified")
    image = containers[0].get("image", "")
    bootstrap = image.startswith(BOOTSTRAP_REPOSITORY + "@")
    if bootstrap:
        if service.get("latestReadyRevision") != revision_name:
            raise BootstrapError("bootstrap_serving_revision_unverified")
        if labels.get("hussh-bootstrap") != "commerce-preview":
            raise BootstrapError("bootstrap_provenance_unverified")
        image_reference(image)
        sha = labels.get("deploy-sha", "")
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise BootstrapError("bootstrap_provenance_unverified")
        if (expected_image and image != expected_image) or (expected_sha and sha != expected_sha):
            raise BootstrapError("bootstrap_provenance_mismatch")
        container = containers[0]
        if (
            revision.get("volumes")
            or revision.get("vpcAccess")
            or container.get("env")
            or container.get("volumeMounts")
            or container.get("command")
            or container.get("args")
            or not container.get("startupProbe", {}).get("tcpSocket")
            or any(item.get("tag") for item in statuses)
        ):
            raise BootstrapError("bootstrap_capabilities_present")
        assert_private(api, name, service)
    elif not re.fullmatch(
        rf"gcr\.io/{re.escape(PROJECT)}/{application_repository}@sha256:[0-9a-f]{{64}}",
        image,
    ):
        raise BootstrapError("preview_application_image_unverified")
    return {
        "kind": "bootstrap" if bootstrap else "application",
        "origin": service_origin,
        "revision": revision_name,
        "image": image,
        "sha": labels.get("deploy-sha", ""),
    }


def write_report(path, report):
    path.write_text(json.dumps(report, indent=2) + "\n")


def ensure(api, image, sha, path):
    image_reference(image)
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise BootstrapError("bootstrap_source_unverified")
    report = {"target": "scope-commerce-sandbox", "status": "provisioning", "lanes": {}}
    write_report(path, report)
    assert_parent_private(api)
    for lane, identifier in (("backend", BACKEND), ("frontend", FRONTEND)):
        name = f"{PARENT}/services/{identifier}"
        service = api.request(name, missing=True)
        if service is None:
            operation = api.request(
                PARENT + "/services?serviceId=" + identifier,
                method="POST",
                body={
                    "template": bootstrap_template(image, sha),
                    "invokerIamDisabled": False,
                    "labels": {"hussh-bootstrap": "commerce-preview"},
                },
            )
            # Record admission before awaiting creation, including partial failure.
            report["lanes"][lane] = {
                "kind": "bootstrap",
                "admitted": True,
                "image": image,
                "sha": sha,
                "service": name,
            }
            write_report(path, report)
            api.finish(operation)
            service = api.request(name)
        baseline = inspect(api, name, service)
        if baseline["kind"] == "bootstrap" and (
            baseline["image"] != image or baseline["sha"] != sha
        ):
            # A retry may use a new CI-green source. Replace only a verified
            # private inert baseline, never an application service.
            report["lanes"][lane] = {**baseline, "service": name}
            write_report(path, report)
            api.finish(
                api.request(
                    name + "?updateMask=" + TEMPLATE_MASK + ",traffic",
                    method="PATCH",
                    body={
                        "name": name,
                        "etag": service["etag"],
                        "template": bootstrap_template(image, sha),
                        "traffic": [
                            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}
                        ],
                    },
                )
            )
            baseline = inspect(api, name, api.request(name), expected_image=image, expected_sha=sha)
        report["lanes"][lane] = {**baseline, "service": name}
        write_report(path, report)
    report["status"] = "ready_for_configuration"
    write_report(path, report)
    return report


def quarantine(api, path):
    report = json.loads(path.read_text())
    if report.get("target") != "scope-commerce-sandbox":
        raise BootstrapError("bootstrap_report_unverified")
    if not any(lane.get("kind") == "bootstrap" for lane in report.get("lanes", {}).values()):
        return  # Subsequent application releases retain their ordinary rollback.
    for lane, identifier in (("backend", BACKEND), ("frontend", FRONTEND)):
        baseline = report.get("lanes", {}).get(lane, {})
        if baseline.get("kind") != "bootstrap":
            continue
        name = f"{PARENT}/services/{identifier}"
        if baseline.get("service") != name:
            raise BootstrapError("bootstrap_report_unverified")
        service = api.request(name)
        policy = api.request(name + ":getIamPolicy")
        for binding in policy.get("bindings", []):
            binding["members"] = [
                member for member in binding.get("members", []) if member not in PUBLIC
            ]
        policy["bindings"] = [
            binding for binding in policy.get("bindings", []) if binding.get("members")
        ]
        api.request(name + ":setIamPolicy", method="POST", body={"policy": policy})
        body = {
            "name": name,
            "etag": service["etag"],
            "invokerIamDisabled": False,
            "template": bootstrap_template(baseline["image"], baseline["sha"]),
            "traffic": [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}],
        }
        api.finish(
            api.request(
                name + "?updateMask=" + TEMPLATE_MASK + ",traffic,invokerIamDisabled",
                method="PATCH",
                body=body,
            )
        )
        inspect(
            api,
            name,
            api.request(name),
            expected_image=baseline["image"],
            expected_sha=baseline["sha"],
        )
    report["status"] = "quarantined"
    write_report(path, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("ensure", "quarantine"), required=True)
    parser.add_argument("--image")
    parser.add_argument("--sha")
    parser.add_argument("--report-path", required=True, type=Path)
    args = parser.parse_args()
    try:
        api = CloudRun()
        if args.phase == "ensure":
            ensure(api, args.image or "", args.sha or "", args.report_path)
        else:
            quarantine(api, args.report_path)
    except Exception as error:
        if args.report_path.is_file():
            report = json.loads(args.report_path.read_text())
            if report.get("target") == "scope-commerce-sandbox":
                write_report(args.report_path, report | {"failure": safe_failure(error)})
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(json.dumps(safe_failure(error))) from None
