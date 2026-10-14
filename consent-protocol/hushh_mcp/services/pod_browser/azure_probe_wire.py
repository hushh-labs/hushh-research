"""Fixed synthetic source and creation request; never owner/browser execution."""

CONTAINER_NAME = "canary"
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
        },
        "skipEgressProxy": False,
    }
