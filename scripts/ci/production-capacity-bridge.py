#!/usr/bin/env python3
"""Governed zero-traffic clone of a verified healthy production backend.

Called only by Capacity Maintenance under its production deployment lock. This
does not deploy a new application, migrate information or promote traffic. The
ordinary retention helper still owns tag cleanup and the full request drain.
"""

from __future__ import annotations

import base64
import concurrent.futures
import copy
from datetime import datetime
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

from production_capacity_bridge_contract import (
    LEGACY_PROFILE as LEGACY_PROFILE,
    PROFILE as PROFILE,
    RECOVERY_PROFILE as RECOVERY_PROFILE,
    FROZEN_IMAGE as FROZEN_IMAGE,
    RECOVERY_SOURCE as RECOVERY_SOURCE,
    RECOVERY_SOURCE_SPEC as RECOVERY_SOURCE_SPEC,
    RECOVERY_FAILED_REVISION as RECOVERY_FAILED_REVISION,
    RECOVERY_FAILED_SPEC as RECOVERY_FAILED_SPEC,
    RECOVERY_RECEIPT as RECOVERY_RECEIPT,
    SERVICE as SERVICE,
    PROJECT as PROJECT,
    REGION as REGION,
    POOLS as POOLS,
    BOOTSTRAP_POOLS as BOOTSTRAP_POOLS,
    fingerprint as fingerprint,
    traffic as traffic,
    bridge_revision_names as bridge_revision_names,
    verify_recovery_failure as verify_recovery_failure,
    recovery_capacity_inventory as recovery_capacity_inventory,
    validate_receipt_extension as validate_receipt_extension,
    retired_bridge_transition as retired_bridge_transition,
    configure_clone_launcher as configure_clone_launcher,
    receipt_extensions as receipt_extensions,
)

budget = importlib.import_module("runtime-capacity-budget")
retention = importlib.import_module("cloudrun-retention")


def timestamp(value):
    at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if at.tzinfo is None:
        raise retention.UnsafeState("Bridge source timestamp lacks timezone")
    return at


def receipt_state(value, *, predecessor=False):
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or value.get("project") != PROJECT
        or value.get("service") != SERVICE
        or value.get("status") not in {"intent", "verified"}
        or not re.fullmatch(
            r"consent-protocol-cap-[a-f0-9]{16}", str(value.get("revision", ""))
        )
        or not re.fullmatch(r"[a-f0-9]{64}", str(value.get("sourceFingerprint", "")))
        or not re.fullmatch(
            r"[a-f0-9]{64}", str(value.get("serviceControlsFingerprint", ""))
        )
        or not isinstance(value.get("pins"), dict)
        or not 1 <= len(value["pins"]) <= 100
        or not re.fullmatch(
            r"consent-protocol-[a-z0-9-]+", str(value.get("sourceRevision", ""))
        )
        or not re.fullmatch(
            r"consent-protocol-[a-z0-9-]+",
            str(value.get("displacedLatestRevision", "")),
        )
        or not isinstance(value.get("traffic"), list)
        or len(value["traffic"]) > 100
        or type(value.get("requested")) is not bool
        or value.get("profile", LEGACY_PROFILE)
        not in {LEGACY_PROFILE, PROFILE, RECOVERY_PROFILE}
    ):
        raise retention.UnsafeState("Invalid capacity bridge receipt")
    validate_receipt_extension(value, receipt_state)
    for pin in value["pins"].values():
        if (
            not isinstance(pin, dict)
            or not re.fullmatch(
                r"projects/(?:hushh-pda|[0-9]+)/secrets/[A-Za-z0-9_-]+/versions/[0-9]+",
                str(pin.get("version", "")),
            )
            or pin.get("unchangedSinceSource") is not True
        ):
            raise retention.UnsafeState("Invalid capacity bridge secret pin")
    prior = value.get("predecessor")
    if prior is not None:
        if predecessor or value.get("profile") != PROFILE:
            raise retention.UnsafeState("Invalid bridge supersession chain")
        receipt_state(prior, predecessor=True)
        if (
            prior.get("profile", LEGACY_PROFILE) != LEGACY_PROFILE
            or prior["status"] != "intent"
            or not prior["requested"]
            or value.get("predecessorObservation") != "provider_observed_unhealthy"
            or prior["revision"] != value["displacedLatestRevision"]
            or prior["sourceFingerprint"] != value["sourceFingerprint"]
            or prior["sourceRevision"] != value["sourceRevision"]
            or prior["serviceControlsFingerprint"]
            != value["serviceControlsFingerprint"]
            or prior["pins"] != value["pins"]
            or prior["revision"] == value["revision"]
        ):
            raise retention.UnsafeState("Invalid bridge predecessor evidence")
    return value


class SecretMetadata:
    """Payloads are compared only in process memory; no payload/digest receipts."""

    def __init__(self):
        result = retention.run_command(
            ["gcloud", "auth", "print-access-token"], timeout=20
        )
        self.token = result.stdout.strip()

    def get(self, resource):
        remaining = (
            float(
                os.getenv(
                    "HUSSH_RETENTION_DEADLINE_MONOTONIC", str(time.monotonic() + 30)
                )
            )
            - time.monotonic()
        )
        if remaining < 2:
            raise retention.BudgetExpired(
                "Bridge secret inspection reached its maintenance deadline"
            )
        req = urllib.request.Request(
            "https://secretmanager.googleapis.com/v1/" + resource,
            headers={"Authorization": "Bearer " + self.token},
        )
        try:
            with urllib.request.urlopen(req, timeout=min(12, remaining)) as response:
                raw = response.read(256_001)
            if len(raw) > 256_000:
                raise ValueError("response bound")
            return json.loads(raw)
        except Exception:
            raise retention.UnsafeState("Bridge secret evidence unavailable") from None

    def pin(self, resource, created):
        latest = self.get(resource + "/versions/latest")
        if latest.get("state") != "ENABLED" or not re.fullmatch(
            re.escape(resource) + r"/versions/[0-9]+", latest.get("name", "")
        ):
            # Secret Manager can return a numeric project canonical name.
            if (
                latest.get("state") != "ENABLED"
                or latest.get("name", "")
                .split("/secrets/", 1)[-1]
                .split("/versions/", 1)[0]
                != resource.rsplit("/", 1)[-1]
                or not re.fullmatch(
                    r"projects/[0-9]+/secrets/[A-Za-z0-9_-]+/versions/[0-9]+",
                    latest.get("name", ""),
                )
            ):
                raise retention.UnsafeState(
                    "Bridge latest version is not enabled/numeric"
                )
        if timestamp(latest["createTime"]) <= created:
            return {"version": latest["name"], "unchangedSinceSource": True}
        versions, tokens, page = [], set(), ""
        while True:
            query = urllib.parse.urlencode(
                {"pageSize": 100, **({"pageToken": page} if page else {})}
            )
            result = self.get(resource + "/versions?" + query)
            versions.extend(result.get("versions", []))
            if len(versions) > 1000:
                raise retention.UnsafeState("Bridge secret history bound exceeded")
            page = result.get("nextPageToken")
            if not page:
                break
            if page in tokens:
                raise retention.UnsafeState("Bridge secret history repeated a page")
            tokens.add(page)
        before = [row for row in versions if timestamp(row["createTime"]) <= created]
        if not before:
            raise retention.UnsafeState(
                "Bridge historical secret version is unverified"
            )
        chain = [
            max(before, key=lambda row: timestamp(row["createTime"])),
            *[row for row in versions if timestamp(row["createTime"]) > created],
        ]
        if any(row.get("state") != "ENABLED" for row in chain):
            raise retention.UnsafeState(
                "Bridge historical secret version is unreadable"
            )
        digests = set()
        for row in chain:
            payload = bytearray(
                base64.b64decode(
                    self.get(row["name"] + ":access")["payload"]["data"], validate=True
                )
            )
            digests.add(hashlib.sha256(payload).digest())
            payload[:] = b"\0" * len(payload)
        if len(digests) != 1:
            raise retention.UnsafeState(
                "Source secret values changed; frozen bridge is not authorized"
            )
        # Recheck after history access: no new latest version may be overlooked.
        if self.get(resource + "/versions/latest").get("name") != latest["name"]:
            raise retention.UnsafeState(
                "Bridge secret version changed during inspection"
            )
        return {"version": latest["name"], "unchangedSinceSource": True}


def secret_pins(source, secrets):
    created = timestamp(source["metadata"]["creationTimestamp"])
    aliases = dict(
        part.split(":", 1)
        for part in source["metadata"]
        .get("annotations", {})
        .get("run.googleapis.com/secrets", "")
        .split(",")
        if ":" in part
    )
    refs = [
        row["valueFrom"]["secretKeyRef"]
        for row in source["spec"]["containers"][0].get("env", [])
        if "secretKeyRef" in row.get("valueFrom", {})
    ]
    if any(ref.get("key") != "latest" for ref in refs):
        raise retention.UnsafeState(
            "Fixed bridge v1 supports only the historically verified latest-selector source"
        )
    names = {ref["name"] for ref in refs}
    if not 1 <= len(names) <= 100:
        raise retention.UnsafeState("Bridge secret reference bound exceeded")
    namespace = source["metadata"]["namespace"]

    def inspect(name):
        resource = aliases.get(name, f"projects/{PROJECT}/secrets/{name}")
        if not re.fullmatch(
            rf"projects/(?:{PROJECT}|{re.escape(namespace)})/secrets/[A-Za-z0-9_-]+",
            resource,
        ):
            raise retention.UnsafeState("Bridge source secret project is unverified")
        return name, secrets.pin(resource, created)

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        return dict(executor.map(inspect, sorted(names)))


def source_revision(inventory, release):
    service = inventory["services"][SERVICE]["service"]
    expected = release["final"]["backend_revision"]
    if [(name, percent) for name, percent, _ in traffic(service) if percent] != [
        (expected, 100)
    ]:
        raise retention.UnsafeState(
            "Bridge source is not the verified healthy serving revision"
        )
    sources = [
        row
        for row in inventory["services"][SERVICE]["revisions"]
        if row["metadata"]["name"] == expected
    ]
    if len(sources) != 1 or len(sources[0]["spec"].get("containers", [])) != 1:
        raise retention.UnsafeState("Bridge source revision is unavailable")
    source = sources[0]
    if not re.fullmatch(
        r".+@sha256:[a-f0-9]{64}", source.get("status", {}).get("imageDigest", "")
    ):
        raise retention.UnsafeState("Bridge source image digest is unverified")
    if source["metadata"].get("labels", {}).get("deploy-sha") != release["sha"]:
        raise retention.UnsafeState("Bridge source deploy provenance changed")
    return service, source


def clone_template(source, pins, displaced_latest, maintenance_profile=LEGACY_PROFILE):
    template = {
        "metadata": {
            "annotations": copy.deepcopy(source["metadata"].get("annotations", {})),
            "labels": {
                key: value
                for key, value in source["metadata"].get("labels", {}).items()
                if not key.startswith(("serving.knative.dev/", "cloud.googleapis.com/"))
            },
        },
        "spec": copy.deepcopy(source["spec"]),
    }
    annotations = template["metadata"]["annotations"]
    for key in (
        "run.googleapis.com/operation-id",
        "run.googleapis.com/client-name",
        "run.googleapis.com/client-version",
        "serving.knative.dev/creator",
        "serving.knative.dev/lastModifier",
    ):
        annotations.pop(key, None)
    annotations["autoscaling.knative.dev/maxScale"] = "1"
    if int(annotations.get("autoscaling.knative.dev/minScale", "0")) > 1:
        raise retention.UnsafeState(
            "Bridge source minimum instances exceeds the fixed profile"
        )
    container = template["spec"]["containers"][0]
    container["image"] = source["status"]["imageDigest"]
    env = container.get("env", [])
    if len({row["name"] for row in env}) != len(env):
        raise retention.UnsafeState(
            "Bridge source contains duplicate environment entries"
        )
    for row in env:
        ref = row.get("valueFrom", {}).get("secretKeyRef")
        if ref:
            ref["key"] = pins[ref["name"]]["version"].rsplit("/", 1)[-1]
    env, pools = configure_clone_launcher(source, container, env, maintenance_profile)
    container["env"] = [row for row in env if row["name"] not in pools] + [
        {"name": key, "value": value} for key, value in pools.items()
    ]
    name = (
        SERVICE
        + "-cap-"
        + fingerprint(
            [
                source["metadata"]["name"],
                template,
                maintenance_profile,
                displaced_latest,
            ]
        )[:16]
    )
    template["metadata"]["name"] = name
    template["metadata"]["labels"]["capacity-bridge"] = maintenance_profile.rsplit(
        "_", 1
    )[-1]
    return template


def service_controls(service):
    ignored = {
        "run.googleapis.com/operation-id",
        "run.googleapis.com/client-name",
        "run.googleapis.com/client-version",
        "serving.knative.dev/creator",
        "serving.knative.dev/lastModifier",
    }
    return fingerprint(
        {
            "spec": {
                key: value
                for key, value in service.get("spec", {}).items()
                if key not in {"template", "traffic"}
            },
            "annotations": {
                key: value
                for key, value in service.get("metadata", {})
                .get("annotations", {})
                .items()
                if key not in ignored
            },
            "labels": service.get("metadata", {}).get("labels", {}),
        }
    )


def verify_profile(revision, profile, maintenance_profile=LEGACY_PROFILE):
    config = profile["environments"]["production"]
    capacity = budget.revision_connections(
        revision,
        SERVICE,
        config["services"][SERVICE],
        f"{PROJECT}:{REGION}:{config['database_instance']}",
    )
    expected = (6, 1) if maintenance_profile in {PROFILE, RECOVERY_PROFILE} else (8, 2)
    if (capacity["connections"], capacity["workers_per_instance"]) != expected:
        raise retention.UnsafeState(
            "Bridge exceeds the fixed connection/worker profile"
        )


def verify_clone(
    revision,
    template,
    service,
    original_traffic,
    profile,
    controls,
    *,
    previously_verified=False,
    maintenance_profile=LEGACY_PROFILE,
    probe_health=True,
):
    expected_name = template["metadata"]["name"]
    if (
        revision["metadata"]["name"] != expected_name
        or revision["spec"] != template["spec"]
        or revision.get("status", {}).get("imageDigest")
        != template["spec"]["containers"][0]["image"]
    ):
        raise retention.UnsafeState(
            "Bridge revision differs from frozen source/profile"
        )
    for key, value in template["metadata"]["annotations"].items():
        if revision["metadata"].get("annotations", {}).get(key) != value:
            raise retention.UnsafeState("Bridge revision annotations changed")
    verify_profile(revision, profile, maintenance_profile)
    if service_controls(service) != controls:
        raise retention.UnsafeState(
            "Bridge changed preserved service-level configuration"
        )
    current = [
        (name, percent, tag)
        for name, percent, tag in traffic(service)
        if name != expected_name
    ]
    permitted = current == original_traffic
    if previously_verified:
        permitted = [row for row in current if row[1]] == [
            row for row in original_traffic if row[1]
        ] and set(current) <= set(original_traffic)
    if not permitted or any(
        name == expected_name and percent for name, percent, _ in traffic(service)
    ):
        raise retention.UnsafeState("Bridge changed existing traffic")
    status = service.get("status", {})
    if status.get("latestCreatedRevisionName") != expected_name:
        raise retention.MutationUncertain("Bridge readiness is not yet reconciled")
    if not probe_health:
        # Observing an exact, zero-traffic failed predecessor does not prove
        # readiness. Cloud Run may retain the serving revision as latest-ready.
        return
    if status.get("latestReadyRevisionName") != expected_name:
        raise retention.MutationUncertain("Bridge readiness is not yet reconciled")
    if not any(
        row.get("type") == "Ready" and row.get("status") == "True"
        for row in revision.get("status", {}).get("conditions", [])
    ):
        raise retention.MutationUncertain("Bridge is not ready")
    if previously_verified:
        return  # Ordinary retention may have removed the verified health tag.
    targets = [
        row
        for row in service["status"]["traffic"]
        if row.get("revisionName") == expected_name
        and row.get("tag") == "capacity-" + expected_name.rsplit("-", 1)[-1]
    ]
    if len(targets) != 1 or not re.fullmatch(
        r"https://[a-z0-9-]+\.a\.run\.app", targets[0].get("url", "")
    ):
        raise retention.MutationUncertain("Bridge health address is unverified")
    try:
        with urllib.request.urlopen(
            targets[0]["url"] + "/health", timeout=15
        ) as response:
            raw = response.read(64_001)
        if len(raw) > 64_000 or json.loads(raw).get("status") != "healthy":
            raise ValueError("unhealthy")
    except Exception:
        raise retention.MutationUncertain("Bridge health probe did not pass") from None


def verify_superseded_predecessor(previous, source, inventory, service, profile):
    """Observe the old provider outcome without claiming the predecessor healthy."""
    expected = clone_template(
        source,
        previous["pins"],
        previous["displacedLatestRevision"],
        LEGACY_PROFILE,
    )
    prior_rows = [
        row
        for row in inventory["services"][SERVICE]["revisions"]
        if row["metadata"]["name"] == previous["revision"]
    ]
    if expected["metadata"]["name"] != previous["revision"] or len(prior_rows) != 1:
        raise retention.MutationUncertain(
            "Predecessor creation remains unobserved; supersession forbidden"
        )
    verify_clone(
        prior_rows[0],
        expected,
        service,
        [tuple(row) for row in previous["traffic"]],
        profile,
        previous["serviceControlsFingerprint"],
        probe_health=False,
    )
    secrets = SecretMetadata()
    for pin in previous["pins"].values():
        metadata = secrets.get(pin["version"])
        if metadata.get("state") != "ENABLED" or metadata.get("name") != pin["version"]:
            raise retention.UnsafeState("Predecessor secret pin is no longer enabled")


def maintain(release, checkpoint_path: Path, *, create: bool):
    state = json.loads(checkpoint_path.read_text())
    previous = receipt_state(state.get("capacity_bridge"))
    if not create and (previous is None or previous["status"] == "verified"):
        return
    if create and (
        os.getenv("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or os.getenv("GITHUB_REF_NAME") != "main"
    ):
        raise retention.UnsafeState(
            "Capacity bridge creation requires a manual main maintenance pass"
        )
    profile = json.loads(budget.DEFAULT_PROFILE.read_text())
    inventory = budget.collect(profile, "production")
    service, source = source_revision(inventory, release)
    source_hash = fingerprint(
        [source["metadata"]["name"], source["spec"], source["status"]["imageDigest"]]
    )
    existing_names = {
        row["metadata"]["name"] for row in inventory["services"][SERVICE]["revisions"]
    }
    previous, retired_predecessor = retired_bridge_transition(
        previous, service, source, source_hash, existing_names, create
    )
    supersede = bool(
        create
        and previous
        and previous.get("profile", LEGACY_PROFILE) == LEGACY_PROFILE
        and previous["status"] == "intent"
        and previous["requested"]
    )
    maintenance_profile = (
        previous.get("profile", LEGACY_PROFILE)
        if previous and not supersede
        else RECOVERY_PROFILE
        if source["metadata"]["name"] == RECOVERY_SOURCE
        else PROFILE
    )
    if previous and (
        previous["sourceFingerprint"] != source_hash
        or previous["sourceRevision"] != source["metadata"]["name"]
    ):
        raise retention.UnsafeState(
            "Bridge source changed during an uncertain operation"
        )
    if previous is None and any(
        row["metadata"].get("labels", {}).get("capacity-bridge")
        for row in inventory["services"][SERVICE]["revisions"]
    ):
        raise retention.UnsafeState("Existing bridge has no trusted checkpoint")
    reuse = (
        previous
        and not supersede
        and (
            previous["status"] == "intent"
            or service.get("status", {}).get("latestCreatedRevisionName")
            == previous["revision"]
        )
    )
    if (
        previous
        and not supersede
        and previous["status"] == "verified"
        and not reuse
        and previous["revision"] in existing_names
    ):
        raise retention.UnsafeState(
            "Retire the previous bridge through ordinary drain maintenance before another bridge"
        )
    predecessor = copy.deepcopy(previous.get("predecessor")) if reuse else None
    if supersede:
        # Resolve only the provider's creation outcome; never claim this failed
        # predecessor healthy. The successor intent keeps deployments blocked.
        verify_superseded_predecessor(previous, source, inventory, service, profile)
        predecessor = copy.deepcopy(previous)
        pins = previous["pins"]
        displaced = previous["revision"]
    elif reuse:
        if (
            previous["sourceFingerprint"] != source_hash
            or previous["sourceRevision"] != source["metadata"]["name"]
        ):
            raise retention.UnsafeState(
                "Bridge source changed during an uncertain operation"
            )
        pins = previous["pins"]
        displaced = previous["displacedLatestRevision"]
    else:
        if not create:
            return
        pins = secret_pins(source, SecretMetadata())
        displaced = service["status"]["latestCreatedRevisionName"]
    template = clone_template(source, pins, displaced, maintenance_profile)
    # Admission must reserve the actual source launcher, not merely the fixed
    # candidate profile. A changed source worker count must fail before creation.
    verify_profile(template, profile, maintenance_profile)
    name = template["metadata"]["name"]
    old_traffic = (
        previous["traffic"]
        if previous and previous["revision"] == name
        else traffic(service)
    )
    old_traffic = [tuple(row) for row in old_traffic]
    revisions = [
        row
        for row in inventory["services"][SERVICE]["revisions"]
        if row["metadata"]["name"] == name
    ]
    receipt = {
        "version": 1,
        "profile": maintenance_profile,
        "project": PROJECT,
        "service": SERVICE,
        "sourceFingerprint": source_hash,
        "serviceControlsFingerprint": previous["serviceControlsFingerprint"]
        if reuse
        else service_controls(service),
        "sourceRevision": source["metadata"]["name"],
        "revision": name,
        "pins": pins,
        "displacedLatestRevision": displaced,
        "traffic": old_traffic,
        "status": "intent",
        "requested": bool(reuse and previous.get("requested")),
        **receipt_extensions(maintenance_profile, retired_predecessor),
        **(
            {
                "predecessor": predecessor,
                "predecessorObservation": "provider_observed_unhealthy",
            }
            if predecessor
            else {}
        ),
    }

    def save():
        state["capacity_bridge"] = receipt
        retention.atomic_state(checkpoint_path, state)

    if not revisions:
        if receipt["requested"]:
            raise retention.MutationUncertain(
                "Bridge creation outcome is unknown; automatic duplicate creation is forbidden"
            )
        if not create:
            raise retention.MutationUncertain(
                "Bridge creation requires manual reconciliation"
            )
        # Secret inspection can take time. Re-read the entire admission inventory
        # and reject a generation/source/traffic change before requesting mutation.
        fresh = budget.collect(profile, "production")
        fresh_service, fresh_source = source_revision(fresh, release)
        if fingerprint(fresh_service) != fingerprint(service) or fingerprint(
            fresh_source
        ) != fingerprint(source):
            raise retention.UnsafeState(
                "Bridge source/service changed during preflight"
            )
        report = budget.evaluate(
            profile,
            "production",
            recovery_capacity_inventory(fresh, maintenance_profile),
            maintenance_profile=maintenance_profile,
        )
        if not report["admitted"]:
            raise retention.UnsafeState(
                "Fixed capacity bridge exceeds the unchanged global connection budget"
            )
        # Optimistic provider precondition plus existing deployment lock. Never
        # carry a latestRevision traffic pointer into a new zero-traffic spec.
        body = {
            "apiVersion": "serving.knative.dev/v1",
            "kind": "Service",
            "metadata": {
                key: copy.deepcopy(service["metadata"][key])
                for key in (
                    "name",
                    "namespace",
                    "resourceVersion",
                    "annotations",
                    "labels",
                )
                if key in service["metadata"]
            },
            "spec": {
                **copy.deepcopy(service["spec"]),
                "template": template,
                "traffic": [
                    {
                        "revisionName": row[0],
                        "percent": row[1],
                        **({"tag": row[2]} if row[2] else {}),
                    }
                    for row in old_traffic
                ]
                + [
                    {
                        "revisionName": name,
                        "percent": 0,
                        "tag": "capacity-" + name.rsplit("-", 1)[-1],
                    }
                ],
            },
        }
        receipt["requested"] = True
        save()  # Durable intent BEFORE the possibly successful provider call.
        with tempfile.TemporaryDirectory() as temporary:
            spec_file = Path(temporary) / "service.json"
            spec_file.write_text(json.dumps(body))
            try:
                retention.run_command(
                    [
                        "gcloud",
                        "run",
                        "services",
                        "replace",
                        str(spec_file),
                        f"--project={PROJECT}",
                        f"--region={REGION}",
                        "--quiet",
                    ],
                    timeout=150,
                )
            except (
                subprocess.CalledProcessError,
                subprocess.TimeoutExpired,
                retention.BudgetExpired,
            ):
                raise retention.MutationUncertain(
                    "Bridge provider outcome requires reconciliation"
                ) from None
        inventory = budget.collect(profile, "production")
        service = inventory["services"][SERVICE]["service"]
        revisions = [
            row
            for row in inventory["services"][SERVICE]["revisions"]
            if row["metadata"]["name"] == name
        ]
    if len(revisions) != 1:
        raise retention.MutationUncertain("Bridge revision is absent or ambiguous")
    verify_clone(
        revisions[0],
        template,
        service,
        old_traffic,
        profile,
        receipt["serviceControlsFingerprint"],
        previously_verified=bool(reuse and previous["status"] == "verified"),
        maintenance_profile=maintenance_profile,
    )
    ordinary = profile["environments"]["production"]["services"]
    remaining = budget.evaluate(
        profile,
        "production",
        recovery_capacity_inventory(inventory, maintenance_profile),
        candidate_services=frozenset()
        if maintenance_profile in {PROFILE, RECOVERY_PROFILE}
        else frozenset(ordinary) - {SERVICE},
    )
    if not remaining["admitted"]:
        raise retention.UnsafeState(
            "Bridge/worker/job/reserve capacity is not admitted"
        )
    # The normal retention pass removes the temporary zero-traffic health tag.
    # Zero traffic never implies no background work in this existing runtime.
    receipt["status"] = "verified"
    save()
