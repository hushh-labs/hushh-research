"""Frozen Cloud Run evidence and the database-free recovery maintenance profile."""

from __future__ import annotations

import copy
import hashlib
import json
import re

PROJECT = "hushh-pda"
REGION = "us-central1"
BACKEND = "consent-protocol"
BACKEND_SERVICE_UID = "35918680-6774-4fa5-8d01-d1f32895cc26"
BACKEND_SOURCE = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
BACKEND_IMAGE = "gcr.io/hushh-pda/consent-protocol@sha256:cce7d40168dfd8fc0958903f530242f754d346c3d8df6ae264e62fd11e889f60"
SERVING_BACKEND = "consent-protocol-00309-nir"
SERVING_BACKEND_UID = "2cdde8d7-00e6-477f-860b-9e0eb26e97e5"
DISPLACED = "consent-protocol-00314-cor"
DISPLACED_UID = "357a6894-1522-4235-8bf4-05edd2b89090"
DISPLACED_FINGERPRINT = "492284ccb0413109427494261cf2236d79d65f09b662930acef5d69635ed70c5"
ROLLBACK = "consent-protocol-00312-fig"
ROLLBACK_RUN, ROLLBACK_ATTEMPT = "40884680280", 1

FRONTEND_RUN = 41608303952
FRONTEND_SOURCE = "00507b68ea293524f73ad42b1839984bcaa46c98"
FRONTEND_IMAGE = "gcr.io/hushh-pda/hushh-webapp@sha256:580ab8bc135f7641f2f08a7f6ea0f9c09ce45a3dbb693c34bac92a489a3e4ad2"
FRONTEND_SERVICE_UID = "4f627ef3-5d86-40ad-ae22-d6b9c9c4c740"
FRONTEND_OLD = "hushh-webapp-00162-r4d"
FRONTEND_NEW = "hushh-webapp-cred126-20261107"
FRONTEND_BASE_ANNOTATIONS = {
    "autoscaling.knative.dev/maxScale": "10",
    "run.googleapis.com/startup-cpu-boost": "true",
}
FRONTEND_IDENTITIES = {
    FRONTEND_OLD: {
        "uid": "8410fcdc-7c5c-41d9-bbb1-c479952a1cb2",
        "spec_sha256": "76661f8fd0be5be2e16654835ca15504c466eefae9e6b14d38e1f6f5b5ed3c74",
        "annotations": FRONTEND_BASE_ANNOTATIONS,
    },
    FRONTEND_NEW: {
        "uid": "2edc610e-8c12-4e68-a444-aff5f6ec85f6",
        "spec_sha256": "cdc941e6a37e1b7c200e7ae909a0604dd733ba8cf0c4f583dc5b68f8d1660d1c",
        "annotations": {
            **FRONTEND_BASE_ANNOTATIONS,
            "autoscaling.knative.dev/minScale": "0",
            "run.googleapis.com/cpu-throttling": "true",
            "run.googleapis.com/ingress": "all",
            "run.googleapis.com/sessionAffinity": "false",
        },
    },
}

PROFILE = "recorded_recovery_inert_v1"
LABEL = "recovery-inert-v1"
ANNOTATIONS = {
    "autoscaling.knative.dev/maxScale": "1",
    "run.googleapis.com/cpu-throttling": "true",
}
PROVIDER_ANNOTATIONS = {
    "run.googleapis.com/client-name",
    "run.googleapis.com/client-version",
    "run.googleapis.com/operation-id",
    "serving.knative.dev/creator",
    "serving.knative.dev/lastModifier",
}
# The reviewed image supplies Python. Isolated startup never imports the app,
# loads user/site configuration, or starts a network client.
LISTENER = """import socket
with socket.socket() as listener:
    listener.bind(("0.0.0.0", 8080))
    listener.listen()
    while True:
        connection, _ = listener.accept()
        connection.close()
"""
SPEC = {
    "containerConcurrency": 1,
    "serviceAccountName": "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com",
    "timeoutSeconds": 30,
    "containers": [{
        "name": "consent-protocol-1",
        "image": BACKEND_IMAGE,
        "command": ["/usr/local/bin/python3"],
        "args": ["-I", "-S", "-c", LISTENER],
        "ports": [{"containerPort": 8080, "name": "http1"}],
        "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
        "startupProbe": {
            "tcpSocket": {"port": 8080},
            "failureThreshold": 3,
            "periodSeconds": 5,
            "timeoutSeconds": 2,
        },
    }],
}
LABELS = {"capacity-bridge": LABEL, "deploy-env": "production", "deploy-sha": BACKEND_SOURCE}


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def frontend_identity(name):
    return {
        **FRONTEND_IDENTITIES[name], "image": FRONTEND_IMAGE,
        "service_uid": FRONTEND_SERVICE_UID,
    }


def runtime_annotations(revision):
    return {
        key: value for key, value in revision["metadata"].get("annotations", {}).items()
        if key not in PROVIDER_ANNOTATIONS
    }


def template():
    return {
        "metadata": {"name": REVISION, "annotations": ANNOTATIONS.copy(), "labels": LABELS.copy()},
        "spec": copy.deepcopy(SPEC),
    }


REVISION = BACKEND + "-cap-" + fingerprint([PROFILE, DISPLACED, SPEC, LABELS, ANNOTATIONS])[:16]


OBSERVED_BRIDGE_UID = "6b0af8c2-b677-43e7-b362-0403b4b8dc99"
STARTUP_TAG = "capacity-" + REVISION.rsplit("-", 1)[-1]
STARTUP_PHASES = frozenset({"tag_requested", "removal_requested", "complete"})


def has_inert_identity(revision):
    metadata = revision.get("metadata", {})
    return metadata.get("name") == REVISION or metadata.get("labels", {}).get("capacity-bridge") == LABEL


def unrouted(service, revision):
    for lane in ("spec", "status"):
        traffic = service.get(lane, {}).get("traffic")
        if not isinstance(traffic, list) or not traffic or any(
            not isinstance(row, dict)
            or row.get("latestRevision")
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", str(row.get("revisionName", "")))
            or row["revisionName"] == revision
            for row in traffic
        ):
            return False
    return True


def ready(document):
    return any(
        row.get("type") == "Ready" and row.get("status") == "True"
        for row in document.get("status", {}).get("conditions", [])
    )


def reconciled(service):
    generation = service.get("metadata", {}).get("generation")
    return (
        generation is not None
        and str(generation) == str(service.get("status", {}).get("observedGeneration"))
        and ready(service)
    )


def inert_revision_matches(service, revision):
    metadata = revision.get("metadata", {})
    labels = metadata.get("labels", {})
    annotations = runtime_annotations(revision)
    # These provider defaults are inert whether explicit or absent.
    for key, default in (
        ("autoscaling.knative.dev/minScale", "0"),
        ("run.googleapis.com/ingress", "all"),
        ("run.googleapis.com/sessionAffinity", "false"),
        ("run.googleapis.com/startup-cpu-boost", "false"),
    ):
        if annotations.get(key) == default:
            annotations.pop(key)
    return (
        service.get("metadata", {}).get("uid") == BACKEND_SERVICE_UID
        and metadata.get("name") == REVISION
        and bool(metadata.get("uid"))
        and labels.get("serving.knative.dev/serviceUid") == BACKEND_SERVICE_UID
        and all(labels.get(key) == value for key, value in LABELS.items())
        and annotations == ANNOTATIONS
        and revision.get("spec") == SPEC
        and revision.get("status", {}).get("imageDigest") == BACKEND_IMAGE
    )


def verified_inert(service, revision):
    return (
        inert_revision_matches(service, revision)
        and ready(revision)
        and reconciled(service)
        and unrouted(service, REVISION)
    )
