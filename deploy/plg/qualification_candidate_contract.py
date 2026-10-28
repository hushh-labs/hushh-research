"""Pure fixed-target candidate observations; never proof admission or cloud transport."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from qualification_target import SERVICE, Target
from qualification_target import require as target_require


def require(condition, reason):
    target_require(condition, "qualification_candidate_" + reason)


def traffic(service: dict) -> dict:
    weights, tags = {}, {}
    for entry in service.get("status", {}).get("traffic", []):
        revision, percent, tag = (
            entry.get("revisionName", ""),
            entry.get("percent", 0),
            entry.get("tag"),
        )
        require(
            isinstance(revision, str)
            and re.fullmatch(re.escape(SERVICE) + r"-[a-z0-9-]+", revision)
            and type(percent) is int
            and 0 <= percent <= 100,
            "traffic_unresolved",
        )
        if percent:
            weights[revision] = weights.get(revision, 0) + percent
        if tag is not None:
            require(
                isinstance(tag, str)
                and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", tag)
                and tag not in tags,
                "tag_ambiguous",
            )
            tags[tag] = revision
    require(sum(weights.values()) == 100, "traffic_weights_invalid")
    return {"weights": weights, "tags": tags}


def traffic_spec(baseline: dict) -> list[dict]:
    return [
        {"revisionName": name, "percent": percent} for name, percent in baseline["weights"].items()
    ] + [{"revisionName": name, "percent": 0, "tag": tag} for tag, name in baseline["tags"].items()]


def service(target: Target, service: dict, policy: dict) -> None:
    metadata = service.get("metadata", {})
    annotations = metadata.get("annotations", {})
    template = service.get("spec", {}).get("template", {})
    require(
        metadata.get("name") == SERVICE
        and all(metadata.get("labels", {}).get(k) == v for k, v in target.labels.items())
        and annotations.get("run.googleapis.com/invoker-iam-disabled", "false") == "false"
        and annotations.get("run.googleapis.com/maxScale") == "1"
        and template.get("metadata", {})
        .get("annotations", {})
        .get("autoscaling.knative.dev/maxScale")
        == "1",
        "service_unowned_or_unbounded",
    )
    require(
        not annotations.get("run.googleapis.com/secrets")
        and not template.get("metadata", {})
        .get("annotations", {})
        .get("run.googleapis.com/secrets"),
        "secret_alias_unexpected",
    )
    require(
        template.get("spec", {}).get("serviceAccountName") == target.runtime_sa
        and template.get("metadata", {})
        .get("annotations", {})
        .get("run.googleapis.com/cloudsql-instances")
        == target.instance,
        "service_target_changed",
    )
    require(
        not any(
            member in {"allUsers", "allAuthenticatedUsers"}
            for binding in policy.get("bindings", [])
            for member in binding.get("members", [])
        ),
        "public_iam",
    )


def origin(value: str) -> str:
    parsed = urlsplit(value)
    require(
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.hostname.endswith(".run.app")
        and parsed.netloc == parsed.hostname
        and not (parsed.path or parsed.query or parsed.fragment),
        "origin_invalid",
    )
    return value


def environment(container: dict) -> dict:
    result = {}
    for item in container.get("env", []):
        name = item.get("name")
        require(
            isinstance(name, str)
            and name not in result
            and set(item) <= {"name", "value", "valueFrom"}
            and not ("value" in item and "valueFrom" in item),
            "environment_ambiguous",
        )
        result[name] = (
            {"valueFrom": item["valueFrom"]}
            if "valueFrom" in item
            else {"value": item.get("value", "")}
        )
    return result


def urls(service: dict, tag: str, revision: str) -> tuple[str, str]:
    service_url = origin(service.get("status", {}).get("url", ""))
    entries = [
        entry for entry in service.get("status", {}).get("traffic", []) if entry.get("tag") == tag
    ]
    require(
        len(entries) == 1 and entries[0].get("revisionName") == revision,
        "tag_binding_changed",
    )
    candidate_url = origin(entries[0].get("url", ""))
    require(
        candidate_url != service_url
        and urlsplit(candidate_url).hostname.startswith(tag + "---" + SERVICE + "-"),
        "tag_origin_invalid",
    )
    return service_url, candidate_url


def runtime(revision: dict, document: dict, name: str) -> dict:
    metadata, spec = revision.get("metadata", {}), revision.get("spec", {})
    expected = document["spec"]["template"]
    containers = spec.get("containers", [])
    require(
        metadata.get("name") == name
        and len(containers) == 1
        and metadata.get("labels", {}).get("serving.knative.dev/service") == SERVICE
        and all(
            metadata.get("labels", {}).get(k) == v
            for k, v in expected["metadata"]["labels"].items()
        )
        and all(
            metadata.get("annotations", {}).get(k) == v
            for k, v in expected["metadata"]["annotations"].items()
        )
        and spec.get("serviceAccountName") == expected["spec"]["serviceAccountName"]
        and not spec.get("volumes")
        and not containers[0].get("volumeMounts")
        and not metadata.get("annotations", {}).get("run.googleapis.com/secrets"),
        "runtime_identity_changed",
    )
    actual, wanted = containers[0], expected["spec"]["containers"][0]
    require(
        environment(actual) == environment(wanted)
        and all(actual.get(key) == wanted[key] for key in ("image", "command", "args")),
        "runtime_configuration_changed",
    )
    return actual


def expected_traffic(descriptor: dict) -> dict:
    baseline = descriptor["baselineTraffic"]
    weights = {descriptor["revision"]: 100} if descriptor["freshService"] else baseline["weights"]
    return {
        "weights": weights,
        "tags": baseline["tags"] | {descriptor["tag"]: descriptor["revision"]},
    }
