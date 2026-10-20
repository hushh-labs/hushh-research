"""Fixed synthetic source and creation request; never owner/browser execution."""

from copy import deepcopy

CONTAINER_NAME = "canary"


def exact_deny_policy(value: object) -> bool:
    """Accept the API's equivalent flat or mirrored HTTP deny readback only.

    The September API projects the legacy fields into ``http``. Both HTTP copies
    must independently retain Deny/Full/Enforced, with explicit TCP/UDP default
    deny. No proxy, permitted transport rule,
    nonempty rule, validation warning or unknown extension is accepted.
    """
    if not isinstance(value, dict):
        return False
    expected = {"defaultAction": "Deny", "trafficInspection": "Full", "enforcementMode": "Enforced"}
    if not _same_json(value.get("transportRules"), {"defaultAction": "Deny", "rules": []}):
        return False

    def http_policy(fields: dict) -> bool:
        return {
            key: item
            for key, item in fields.items()
            if key not in {"hostRules", "rules", "validationWarnings"} or item != []
        } == expected

    outer = {key: item for key, item in value.items() if key not in {"http", "transportRules"}}
    if not http_policy(outer):
        return False
    return "http" not in value or isinstance(value["http"], dict) and http_policy(value["http"])


SOURCE = {
    "pod": {
        "securityContext": {"runAsUser": 10002, "runAsGroup": 10002, "runAsNonRoot": True},
        "restartPolicy": "Never",
        "containers": [
            {
                "name": CONTAINER_NAME,
                "diskImage": {"name": "ubuntu", "isPublic": True},
                "securityContext": {
                    "runAsUser": 10002,
                    "runAsGroup": 10002,
                    "runAsNonRoot": True,
                    "privileged": False,
                    "capabilities": {"drop": ["ALL"]},
                    "allowPrivilegeEscalation": False,
                    "readOnlyRootFilesystem": True,
                    "seccompProfile": {"type": "RuntimeDefault"},
                },
            }
        ],
    }
}


def _same_json(actual: object, expected: object) -> bool:
    # JSON booleans and numbers are distinct; Python's True == 1 is insufficient
    # for an execution-identity or immutable-source receipt.
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and actual.keys() == expected.keys()
            and all(_same_json(actual[key], item) for key, item in expected.items())
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(_same_json(left, right) for left, right in zip(actual, expected, strict=True))
        )
    return actual == expected


def exact_source(value: object) -> bool:
    """Ignore only documented inactive defaults, never a changed source or control.

    Native readback can materialize empty optional pod/container collections.
    Preserve exact image, identity, capabilities and every nonempty field. An
    unknown field is refused even when empty.
    """
    if not isinstance(value, dict):
        return False
    observed = deepcopy(value)
    try:
        container = observed["pod"]["containers"][0]
    except (KeyError, IndexError, TypeError):
        return False
    if not isinstance(container, dict):
        return False
    # The live API materializes exactly these two inactive collections. Do not
    # infer equivalence for command/args, environment or any unobserved default.
    for key in ("volumeMounts", "contentPackageDownloads"):
        if type(container.get(key)) is list and not container[key]:
            del container[key]
    return _same_json(observed, SOURCE)


def creation_body(probe_id: str) -> dict:
    """Only the fixed synthetic image, no inherited owner resources or direct egress."""
    return {
        "sourcesRef": SOURCE,
        "resources": {"cpu": "1000m", "memory": "2048Mi"},
        "labels": {"hushhProbe": probe_id},
        "lifecycle": {
            "autoSuspendPolicy": {"enabled": False},
            "autoDeletePolicy": {"enabled": False},
        },
        "egressPolicy": {
            "defaultAction": "Deny",
            "trafficInspection": "Full",
            "enforcementMode": "Enforced",
            "transportRules": {"defaultAction": "Deny", "rules": []},
        },
        "skipEgressProxy": False,
    }
