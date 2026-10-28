"""Fixed private frontend service operations with native optimistic locking.

The caller authenticates the Main workflow and publishes intent first. Every
write is one native request; an uncertain response is never retried here.
"""

from __future__ import annotations

import copy
import re
import time

import frontend_fixture_runtime as runtime
import frontend_release as release

LIMIT = 4 * 1024 * 1024
OUTPUT_ANNOTATIONS = frozenset(
    {
        "run.googleapis.com/operation-id",
        "run.googleapis.com/ingress-status",
        "run.googleapis.com/urls",
        "serving.knative.dev/creator",
        "serving.knative.dev/lastModifier",
    }
)


def writable_annotations(metadata):
    # Preserve semantic controls; provider status/operation metadata is output-only.
    return {
        key: copy.deepcopy(value)
        for key, value in metadata.get("annotations", {}).items()
        if key not in OUTPUT_ANNOTATIONS
    }


from frontend_fixture_cloud import Cloud  # noqa: E402, F401


def private(service, policy, project):
    metadata = service.get("metadata", {})
    annotations = metadata.get("annotations", {})
    release.require(
        metadata.get("name") == runtime.SERVICE
        and metadata.get("labels", {}).get("purpose") == "plg-qualification"
        and metadata.get("labels", {}).get("deploy-source") == "plg-frontend-fixture"
        and annotations.get("run.googleapis.com/invoker-iam-disabled", "false")
        == "false"
        and annotations.get("run.googleapis.com/maxScale") == "1"
        and not annotations.get("run.googleapis.com/secrets")
        and not service.get("spec", {})
        .get("template", {})
        .get("metadata", {})
        .get("annotations", {})
        .get("run.googleapis.com/cloudsql-instances")
        and not service.get("spec", {})
        .get("template", {})
        .get("metadata", {})
        .get("annotations", {})
        .get("run.googleapis.com/secrets")
        and all(
            not ({"allUsers", "allAuthenticatedUsers"} & set(row.get("members", [])))
            for row in policy.get("bindings", [])
        )
        and service.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("serviceAccountName")
        == f"plg-qualification-frontend@{project}.iam.gserviceaccount.com",
        "Fixture service unowned or public",
    )


def ready(value):
    conditions = value.get("status", {}).get("conditions", [])
    return sum(row.get("type") == "Ready" for row in conditions) == 1 and any(
        row.get("type") == "Ready" and row.get("status") == "True" for row in conditions
    )


def stable(service):
    metadata, status = service.get("metadata", {}), service.get("status", {})
    release.require(
        all(
            isinstance(metadata.get(key), str) and metadata[key]
            for key in ("uid", "resourceVersion")
        )
        and re.fullmatch(r"[1-9][0-9]*", str(metadata.get("generation", "")))
        and str(metadata["generation"]) == str(status.get("observedGeneration"))
        and ready(service),
        "Fixture service not settled",
    )
    return {key: metadata[key] for key in ("uid", "resourceVersion")}


def revision_matches(revision, document):
    expected = document["spec"]["template"]
    metadata, spec = revision.get("metadata", {}), revision.get("spec", {})
    wanted = expected["spec"]
    release.require(
        metadata.get("name") == expected["metadata"]["name"]
        and isinstance(metadata.get("uid"), str)
        and metadata["uid"]
        and metadata.get("labels", {}).get("serving.knative.dev/service")
        == runtime.SERVICE
        and all(
            metadata.get("labels", {}).get(key) == value
            for key, value in expected["metadata"]["labels"].items()
        )
        and all(
            metadata.get("annotations", {}).get(key) == value
            for key, value in expected["metadata"]["annotations"].items()
        )
        and all(
            spec.get(key) == value
            for key, value in wanted.items()
            if key != "containers"
        )
        and not spec.get("volumes")
        and len(spec.get("containers", [])) == 1
        and ready(revision),
        "Fixture revision identity changed",
    )
    release.require(
        not any(
            metadata.get("annotations", {}).get(key)
            for key in (
                "run.googleapis.com/secrets",
                "run.googleapis.com/cloudsql-instances",
            )
        ),
        "Fixture secret alias or SQL mount unexpected",
    )
    actual, container = spec["containers"][0], wanted["containers"][0]
    limits = actual.get("resources", {}).get("limits", {})
    ports = actual.get("ports", [])

    def env(rows):
        release.require(
            isinstance(rows, list)
            and len({row.get("name") for row in rows}) == len(rows),
            "Fixture environment ambiguous",
        )
        return sorted(rows, key=lambda row: row["name"])

    release.require(
        actual.get("image") == container["image"]
        and env(actual.get("env")) == env(container["env"])
        and limits.get("cpu") in {"1", "1000m"}
        and limits.get("memory") == "512Mi"
        and set(limits) == {"cpu", "memory"}
        and len(ports) == 1
        and ports[0].get("containerPort") == 8080
        and set(ports[0]) <= {"containerPort", "name"}
        and ports[0].get("name", "http1") == "http1"
        and not any(actual.get(key) for key in ("command", "args", "volumeMounts"))
        and revision.get("status", {}).get("imageDigest") == container["image"],
        "Fixture revision runtime changed",
    )
    return metadata["uid"]


def route(service, document):
    expected = document["spec"]["traffic"][0]
    wanted = (expected["revisionName"], expected["tag"])
    status_rows = service.get("status", {}).get("traffic", [])
    spec_rows = service.get("spec", {}).get("traffic", [])

    def normalized(rows):
        release.require(
            isinstance(rows, list) and 0 < len(rows) <= 100, "Fixture traffic invalid"
        )
        weights, tags = {}, {}
        for row in rows:
            release.require(
                isinstance(row, dict) and not row.get("latestRevision"),
                "Fixture traffic unresolved",
            )
            name, percent, tag = (
                row.get("revisionName"),
                row.get("percent", 0),
                row.get("tag"),
            )
            release.require(
                isinstance(name, str) and type(percent) is int and 0 <= percent <= 100,
                "Fixture traffic invalid",
            )
            if percent:
                weights[name] = weights.get(name, 0) + percent
            if tag:
                release.require(
                    isinstance(tag, str) and tag not in tags, "Fixture tags ambiguous"
                )
                tags[tag] = name
        return weights, tags

    release.require(
        normalized(status_rows)
        == normalized(spec_rows)
        == ({wanted[0]: 100}, {wanted[1]: wanted[0]}),
        "Fixture route changed",
    )
    matches = [row for row in status_rows if row.get("tag") == wanted[1]]
    service_url = service.get("status", {}).get("url")
    candidate_url = matches[0].get("url") if len(matches) == 1 else None
    from urllib.parse import urlsplit

    for value in (service_url, candidate_url):
        parsed = urlsplit(value if isinstance(value, str) else "")
        release.require(
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.hostname.endswith(".run.app")
            and parsed.netloc == parsed.hostname
            and not (parsed.path or parsed.query or parsed.fragment),
            "Fixture route origin invalid",
        )
    release.require(
        candidate_url != service_url
        and urlsplit(candidate_url).hostname.startswith(
            wanted[1] + "---" + runtime.SERVICE + "-"
        ),
        "Fixture route tag invalid",
    )
    return service_url, candidate_url


def observe(cloud, document):
    service = cloud.service()
    private(service, cloud.policy(), cloud.project)
    identity = stable(service)
    revision = cloud.revision(document["spec"]["template"]["metadata"]["name"])
    uid = revision_matches(revision, document)
    release.require(
        service.get("spec", {}).get("template", {}).get("metadata", {}).get("name")
        == revision["metadata"]["name"],
        "Fixture latest template changed",
    )
    service_url, candidate_url = route(service, document)
    release.require(
        cloud.service() == service, "Fixture service changed during observation"
    )
    return {
        "serviceUid": identity["uid"],
        "resourceVersion": identity["resourceVersion"],
        "revision": revision["metadata"]["name"],
        "revisionUid": uid,
        "imageReference": document["spec"]["template"]["spec"]["containers"][0][
            "image"
        ],
        "serviceUrl": service_url,
        "candidateUrl": candidate_url,
    }


def stage(cloud, document, *, checkpoint, previous):
    current = cloud.service(missing=True)
    release.require(current == previous, "Fixture baseline changed")
    wanted = copy.deepcopy(document)
    revision_name = wanted["spec"]["template"]["metadata"]["name"]
    release.require(
        cloud.revision(revision_name, missing=True) is None,
        "Fixture attempt revision already exists",
    )
    if current is not None:
        initial_policy = cloud.policy()
        private(current, initial_policy, cloud.project)
        identity = stable(current)
        wanted["metadata"]["uid"] = identity["uid"]
        wanted["metadata"]["resourceVersion"] = identity["resourceVersion"]
        wanted["metadata"]["namespace"] = current["metadata"]["namespace"]
        wanted["metadata"]["labels"] = (
            current["metadata"].get("labels", {}) | wanted["metadata"]["labels"]
        )
        # Preserve all provider service controls/metadata. Only this fixture's
        # reviewed template and subsequent explicit route are replaced.
        wanted["metadata"]["annotations"] = writable_annotations(current["metadata"])
        wanted["spec"]["traffic"] = copy.deepcopy(current["spec"]["traffic"])
    else:
        wanted["spec"]["traffic"] = [{"latestRevision": True, "percent": 100}]
    if current is not None:
        release.require(cloud.policy() == initial_policy, "Fixture stage IAM changed")
    checkpoint(
        {
            "status": "fixture-template-needs-reconciliation",
            "before": None if current is None else stable(current),
        }
    )
    cloud.request(
        "POST" if current is None else "PUT",
        "services" if current is None else "services/" + runtime.SERVICE,
        wanted,
    )
    deadline = time.monotonic() + 300
    while True:
        observed = cloud.service()
        if current is not None:
            release.require(
                observed.get("metadata", {}).get("uid") == current["metadata"]["uid"],
                "Fixture service replaced during stage",
            )
        revision = cloud.revision(revision_name, missing=True)
        if (
            revision is not None
            and ready(revision)
            and ready(observed)
            and str(observed.get("metadata", {}).get("generation"))
            == str(observed.get("status", {}).get("observedGeneration"))
        ):
            stable(observed)
            revision_matches(revision, document)
            break
        release.require(
            time.monotonic() < deadline, "Fixture candidate needs reconciliation"
        )
        time.sleep(2)
    finish_route(cloud, document, observed, checkpoint=checkpoint)
    return observe(cloud, document)


def continuity(service, intent):
    previous = intent.get("previous")
    if previous is not None:
        release.require(
            service.get("metadata", {}).get("uid") == previous.get("uid"),
            "Fixture reused service UID changed",
        )


def partial_owned(service, intent):
    """Only the known post-template/pre-route state may be completed."""
    expected = intent["serviceDocument"]["spec"]["template"]["metadata"]["name"]
    release.require(
        service.get("spec", {}).get("template", {}).get("metadata", {}).get("name")
        == expected,
        "Fixture recovery candidate template changed",
    )
    previous = intent.get("beforeTraffic")
    spec_rows = service.get("spec", {}).get("traffic")
    actual = service.get("status", {}).get("traffic", [])
    if previous is None:
        release.require(
            spec_rows == [{"latestRevision": True, "percent": 100}]
            and len(actual) == 1
            and actual[0].get("revisionName") == expected
            and actual[0].get("percent") == 100
            and not actual[0].get("tag"),
            "Fixture fresh recovery traffic drifted",
        )
    else:
        release.require(
            spec_rows == previous, "Fixture recovery desired traffic drifted"
        )

        def rows(value):
            return sorted(
                (row.get("revisionName"), row.get("percent", 0), row.get("tag", ""))
                for row in value
            )

        release.require(
            rows(actual) == rows(previous), "Fixture recovery observed traffic drifted"
        )


def finish_route(cloud, document, current, *, checkpoint):
    policy = cloud.policy()
    private(current, policy, cloud.project)
    identity = stable(current)
    release.require(
        current.get("spec", {}).get("template", {}).get("metadata", {}).get("name")
        == document["spec"]["template"]["metadata"]["name"],
        "Fixture recovery template changed",
    )
    revision_matches(
        cloud.revision(document["spec"]["template"]["metadata"]["name"]), document
    )
    release.require(cloud.service() == current, "Fixture recovery state changed")
    updated = copy.deepcopy(current)
    updated.pop("status", None)
    updated["metadata"] = {
        key: copy.deepcopy(current["metadata"][key])
        for key in (
            "name",
            "namespace",
            "uid",
            "resourceVersion",
            "labels",
            "annotations",
        )
        if key in current["metadata"]
    }
    updated["spec"]["traffic"] = copy.deepcopy(document["spec"]["traffic"])
    updated["metadata"]["annotations"] = writable_annotations(current["metadata"])
    release.require(cloud.policy() == policy, "Fixture route IAM changed")
    checkpoint({"status": "fixture-route-needs-reconciliation", "before": identity})
    cloud.request("PUT", "services/" + runtime.SERVICE, updated)
    deadline = time.monotonic() + 180
    while True:
        after = cloud.service()
        release.require(
            after.get("metadata", {}).get("uid") == identity["uid"],
            "Fixture service replaced",
        )
        if ready(after) and str(after["metadata"].get("generation")) == str(
            after.get("status", {}).get("observedGeneration")
        ):
            route(after, document)
            return
        release.require(
            time.monotonic() < deadline, "Fixture route needs reconciliation"
        )
        time.sleep(2)


from frontend_fixture_probes import Http, probes  # noqa: E402, F401
