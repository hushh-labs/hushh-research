# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Dev catalog activation contracts; application identity never follows pod source."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from copy import deepcopy

SERVICE = "projects/hushh-pda-dev/locations/us-central1/services/consent-protocol"
CATALOG_ENV = frozenset({"HUSSH_ONE_POD_IMAGE", "HUSSH_ONE_POD_RELEASE_B64"})
PUBLICATION_ANNOTATIONS = frozenset(
    {"hushh.ai/pod-publication-sha", "hushh.ai/pod-publication-run"}
)
SERVICE_FIELDS = (
    "description",
    "labels",
    "annotations",
    "ingress",
    "launchStage",
    "binaryAuthorization",
    "scaling",
    "invokerIamDisabled",
    "defaultUriDisabled",
    "iapEnabled",
    "customAudiences",
    "multiRegionSettings",
    "client",
    "clientVersion",
    "buildConfig",
    "sshEnabled",
)


def fingerprint(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def environment(template: dict) -> dict:
    containers = template.get("containers")
    if not isinstance(containers, list) or len(containers) != 1:
        raise ValueError("Publication requires one unambiguous application container")
    values = {}
    for item in containers[0].get("env", []):
        if not isinstance(item.get("name"), str) or item["name"] in values:
            raise ValueError("Application environment is ambiguous")
        values[item["name"]] = item
    return values


def configuration_fingerprint(service: dict) -> str:
    """Hash configuration in memory; never persist environment or secret values."""
    template = deepcopy(service["template"])
    environment(template)
    template.pop("revision", None)
    template["containers"][0]["env"] = [
        item
        for item in template["containers"][0].get("env", [])
        if item["name"] not in CATALOG_ENV
    ]
    template["annotations"] = {
        k: v
        for k, v in template.get("annotations", {}).items()
        if k not in PUBLICATION_ANNOTATIONS
    }
    return fingerprint(
        {"template": template, **{k: service.get(k) for k in SERVICE_FIELDS}}
    )


def baseline(service: dict) -> dict:
    if (
        service.get("name") != SERVICE
        or service.get("reconciling")
        or not service.get("etag")
    ):
        raise ValueError("Shared Dev identity or settlement is unverifiable")
    if service.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED":
        raise ValueError("Shared Dev is not healthy")
    targets = [t for t in service.get("trafficStatuses", []) if t.get("percent", 0)]
    if len(targets) != 1 or targets[0]["percent"] != 100:
        raise ValueError("Shared Dev traffic is ambiguous")
    revision = targets[0]["revision"]
    if service.get(
        "latestReadyRevision"
    ) != SERVICE + "/revisions/" + revision or service.get(
        "latestCreatedRevision"
    ) != service.get("latestReadyRevision"):
        raise ValueError("A newer or unfinished shared revision requires coordination")
    env = environment(service["template"])
    if (
        env.get("HUSHH_DEPLOY_ENV", {}).get("value") != "dev"
        or service["template"].get("serviceAccount")
        != "consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com"
    ):
        raise ValueError("Shared runtime environment or workload identity is wrong")
    source = env.get("HUSHH_DEPLOY_SHA", {}).get("value", "")
    image = service["template"]["containers"][0].get("image", "")
    if not re.fullmatch(r"[a-f0-9]{40}", source) or not re.fullmatch(
        r"gcr\.io/hushh-pda-dev/consent-protocol@sha256:[a-f0-9]{64}", image
    ):
        raise ValueError("Application image/source is not immutable")
    traffic = service.get("traffic", [])
    if not traffic or any(
        t.get("type") != "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
        or not t.get("revision")
        for t in traffic
    ):
        raise ValueError("Publication requires explicit revision traffic")
    return {
        "serviceUid": service["uid"],
        "revision": revision,
        "applicationSource": source,
        "applicationImage": image,
        "configurationSha256": configuration_fingerprint(service),
        "trafficSha256": fingerprint(traffic_targets(traffic)),
    }


def require_baseline(service: dict, expected: dict) -> None:
    if baseline(service) != expected:
        raise ValueError(
            "Shared Dev changed; wait for a coordinated release and requalify"
        )


def traffic_targets(values: list) -> list:
    return sorted(
        (
            {
                "type": t.get("type"),
                "revision": t.get("revision"),
                "percent": t.get("percent", 0),
                "tag": t.get("tag", ""),
            }
            for t in values
        ),
        key=lambda t: (t["revision"], t["tag"]),
    )


def already_active(service: dict, expected: dict, release: dict) -> bool:
    try:
        observed = baseline(service)
        if any(
            observed[k] != expected[k]
            for k in expected
            if k not in {"revision", "trafficSha256"}
        ):
            return False
        env = environment(service["template"])
        return (
            env["HUSSH_ONE_POD_IMAGE"].get("value") == release["image"]
            and json.loads(
                base64.b64decode(
                    env["HUSSH_ONE_POD_RELEASE_B64"]["value"], validate=True
                )
            )
            == release
        )
    except (ValueError, KeyError, TypeError):
        return False


def candidate_patch(service: dict, release: dict, *, sha: str, run: str) -> dict:
    baseline(service)
    if release.get("browserQualifications") and environment(service["template"]).get(
        "HUSSH_POD_BROWSER_ENABLED", {}
    ).get("value", "").lower() not in {"true", "1"}:
        raise ValueError(
            "Browser enablement needs a separate reviewed application configuration change"
        )
    if not re.fullmatch(r"[a-f0-9]{40}", sha) or not re.fullmatch(
        r"[1-9][0-9]{0,19}", run
    ):
        raise ValueError("Publication provenance is invalid")
    template = deepcopy(service["template"])
    template["revision"] = "consent-protocol-podpub-" + run
    template["annotations"] = {
        **template.get("annotations", {}),
        "hushh.ai/pod-publication-sha": sha,
        "hushh.ai/pod-publication-run": run,
    }
    raw = json.dumps(release, sort_keys=True, separators=(",", ":")).encode()
    container = template["containers"][0]
    container["env"] = [
        e for e in container.get("env", []) if e["name"] not in CATALOG_ENV
    ] + [
        {"name": "HUSSH_ONE_POD_IMAGE", "value": release["image"]},
        {"name": "HUSSH_ONE_POD_RELEASE_B64", "value": base64.b64encode(raw).decode()},
    ]
    proposed = {**service, "template": template}
    if configuration_fingerprint(proposed) != configuration_fingerprint(service):
        raise ValueError("Publication would change application configuration")
    return {
        "name": SERVICE,
        "etag": service["etag"],
        "template": template,
        "traffic": deepcopy(service["traffic"])
        + [
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": template["revision"],
                "percent": 0,
                "tag": "podpub-" + run,
            }
        ],
    }


def require_candidate(service: dict, original: dict, patch: dict, *, etag: str) -> None:
    if (
        service.get("uid") != original["uid"]
        or service.get("etag") != etag
        or service.get("reconciling")
    ):
        raise ValueError("Concurrent shared mutation; publication must not follow it")
    if configuration_fingerprint(service) != configuration_fingerprint(
        original
    ) or traffic_targets(service.get("traffic", [])) != traffic_targets(
        patch["traffic"]
    ):
        raise ValueError("Shared configuration or traffic changed")
    observed_template, expected_template = (
        deepcopy(service["template"]),
        deepcopy(patch["template"]),
    )
    revision = expected_template.pop("revision")
    if observed_template.pop("revision", None) not in {
        None,
        revision,
        SERVICE + "/revisions/" + revision,
    }:
        raise ValueError("Candidate revision hint changed")
    if observed_template != expected_template:
        raise ValueError("Candidate configuration differs from the approved patch")
    if (
        service.get("latestReadyRevision")
        != SERVICE + "/revisions/" + patch["template"]["revision"]
    ):
        raise ValueError("Catalog candidate is not ready")
    if (
        service.get("latestCreatedRevision") != service.get("latestReadyRevision")
        or service.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED"
    ):
        raise ValueError("Catalog revision settlement is unproven")
    expected = sorted(
        (t["revision"], t["percent"]) for t in patch["traffic"] if t.get("percent", 0)
    )
    observed = sorted(
        (t["revision"], t["percent"])
        for t in service.get("trafficStatuses", [])
        if t.get("percent", 0)
    )
    if observed != expected:
        raise ValueError(
            "Observed traffic does not match the requested publication stage"
        )


def require_native_revision(revision: dict, template: dict) -> None:
    if revision.get("name") != SERVICE + "/revisions/" + template["revision"]:
        raise ValueError("Native candidate identity differs")
    for field in (
        "serviceAccount",
        "timeout",
        "volumes",
        "vpcAccess",
        "executionEnvironment",
        "maxInstanceRequestConcurrency",
    ):
        if field in template and revision.get(field) != template[field]:
            raise ValueError("Native revision configuration differs")
    env = environment(revision)
    if (
        env != environment(template)
        or revision["containers"][0].get("image") != template["containers"][0]["image"]
    ):
        raise ValueError("Native application image or environment differs")
