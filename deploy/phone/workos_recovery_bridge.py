# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Verify the one recorded SQL-free bridge in the production issuer inventory."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from runpy import run_path

ROOT = Path(__file__).resolve().parents[2]
BIRTH = ("1n44wmtdc4kk", "2ti2q8dcfo8")
DEPLOYER = "github-actions-prod-deployer@hushh-pda.iam.gserviceaccount.com"
NAMESPACE = "1006304528804"
BIRTH_TIME = "2026-11-11T08:58:32.264869Z"
DISPLACED_COMPLETIONS = {
    "-c6lnicdhya4": ("2026-10-30T01:28:35.422240Z", 314),
    "-xij5xzcqsg": ("2026-10-31T07:45:08.284111Z", 315),
}
DISPLACED_TEMPLATE = "b71feefcfac02e332ab09daad673cebdebf033ea67f9ca0560c4ab88d63c9ee8"
COMPLETION_LOG = "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Fsystem_event"
BASE_TRAFFIC = [
    {"revisionName": "consent-protocol-00309-nir", "percent": 100},
    {
        "revisionName": "consent-protocol-00309-nir",
        "tag": "account-deletion-40430296874",
    },
]
PROVIDER_FIELDS = {
    "run.googleapis.com/client-name",
    "run.googleapis.com/client-version",
}


@lru_cache(maxsize=1)
def contract():
    return run_path(str(ROOT / "scripts/ci/production_recovery_capacity.py"))


def scope(project, service, flag, closed_key, container_name):
    return (
        project == "hushh-pda"
        and service == "consent-protocol"
        and flag == "WORKOS_SSO_ENABLED"
        and closed_key == "direct_sso_false"
        and container_name is None
    )


def live(row):
    bridge = contract()
    return row.get("metadata", {}).get("uid") == bridge[
        "OBSERVED_BRIDGE_UID"
    ] and bridge["inert_revision_matches"](row)


def _require(condition):
    if not condition:
        raise ValueError("workos_recorded_bridge_audit_unqualified")


def _parts(event):
    payload = event.get("protoPayload") or {}
    request = (payload.get("request") or {}).get("service") or {}
    response = payload.get("response") or {}
    return payload, request, response


def _template(document):
    return (document.get("spec") or {}).get("template") or {}


def _check_template(document, bridge, *, redacted):
    template = _template(document)
    metadata = template.get("metadata") or {}
    expected_labels = dict(bridge["LABELS"])
    if not redacted:
        expected_labels["run.googleapis.com/startupProbeType"] = "Custom"
    labels = metadata.get("labels") or {}
    _require(
        metadata.get("name") == bridge["REVISION"]
        and all(labels.get(key) == value for key, value in expected_labels.items())
        and all(
            key in expected_labels or key == "run.googleapis.com/startupProbeType"
            for key in labels
        )
        and {
            key: value
            for key, value in (metadata.get("annotations") or {}).items()
            if key not in PROVIDER_FIELDS
        }
        == bridge["ANNOTATIONS"]
    )
    spec = template.get("spec")
    exact = bridge["SPEC"]
    if redacted:
        safe_fields = {"image", "name", "resources"}
        redaction = {
            **exact,
            "containers": [
                {k: v for k, v in c.items() if k in safe_fields}
                for c in exact["containers"]
            ],
        }
        _require(spec in (redaction, exact))
    else:
        _require(spec == exact)


def needs_completion_history(events, inventory):
    bridge = contract()
    names = {bridge["REVISION"], bridge["DISPLACED"]}
    return bool(names.intersection(inventory)) or any(
        _template(part).get("metadata", {}).get("name") in names
        for event in events
        for part in _parts(event)[1:]
    )


def completion_filter(until):
    bridge = contract()
    return (
        f'logName="{COMPLETION_LOG}" protoPayload.serviceName="run.googleapis.com" '
        f'resource.labels.service_name="{bridge["BACKEND"]}" '
        'protoPayload.methodName="/Services.ReplaceService" '
        f'((protoPayload.response.spec.template.metadata.name="{bridge["REVISION"]}" '
        f'AND timestamp>="{BIRTH_TIME}") OR insertId="-c6lnicdhya4" OR insertId="-xij5xzcqsg") '
        f'timestamp>="2026-10-30T01:28:35.422240Z" timestamp<="{until}"'
    )


def displaced_completion(event, *, start, until, instant):
    bridge = contract()
    payload, request, response = _parts(event)
    meta = response.get("metadata") or {}
    labels = (event.get("resource") or {}).get("labels") or {}
    stamp = event.get("timestamp")
    _require(
        DISPLACED_COMPLETIONS.get(event.get("insertId"))
        == (stamp, meta.get("generation"))
        and instant(start) <= instant(stamp) <= instant(until)
        and not request
        and event.get("logName") == COMPLETION_LOG
        and labels.get("project_id") == bridge["PROJECT"]
        and labels.get("location") == bridge["REGION"]
        and labels.get("service_name") == bridge["BACKEND"]
        and payload.get("serviceName") == "run.googleapis.com"
        and payload.get("methodName") == "/Services.ReplaceService"
        and payload.get("resourceName")
        == f"namespaces/{bridge['PROJECT']}/services/{bridge['BACKEND']}"
        and not (payload.get("status") or {}).get("code")
        and response.get("kind") == "Service"
        and meta.get("uid") == bridge["BACKEND_SERVICE_UID"]
        and (response.get("status") or {}).get("latestCreatedRevisionName")
        == bridge["DISPLACED"]
        and bridge["fingerprint"](_template(response)) == DISPLACED_TEMPLATE
    )


def _traffic_matches(service, expected):
    traffic = service.get("spec", {}).get("traffic")
    if traffic == expected:
        return True
    if len(expected) == len(BASE_TRAFFIC):
        return False
    return traffic == [*BASE_TRAFFIC, {**expected[-1], "percent": 0}]


def review(events, completions, *, present, until, instant):
    """Join the recorded creation and its exact traffic-only CAS history."""
    bridge = contract()
    marker = bridge["REVISION"]
    relevant = [
        event
        for event in events
        if any(
            _template(part).get("metadata", {}).get("name") == marker
            for part in _parts(event)[1:]
        )
    ]
    if not relevant and not present and not completions:
        return set()
    _require(
        isinstance(completions, list)
        and len(relevant) in {1, 3, 5}
        and len(relevant) == len(completions)
    )
    requests = sorted(relevant, key=lambda event: instant(event["timestamp"]))
    responses = sorted(completions, key=lambda event: instant(event["timestamp"]))
    _require((requests[0].get("insertId"), responses[0].get("insertId")) == BIRTH)
    _require(
        len({event.get("insertId") for event in [*requests, *responses]})
        == 2 * len(requests)
    )
    for step, (request_event, response_event) in enumerate(
        zip(requests, responses, strict=True)
    ):
        request_payload, request, unexpected_response = _parts(request_event)
        response_payload, unexpected_request, response = _parts(response_event)
        request_meta, response_meta = (
            request.get("metadata", {}),
            response.get("metadata", {}),
        )
        for event in (request_event, response_event):
            labels = (event.get("resource") or {}).get("labels") or {}
            _require(
                labels.get("project_id") == bridge["PROJECT"]
                and labels.get("location") == bridge["REGION"]
                and labels.get("service_name") == bridge["BACKEND"]
            )
        targets = BASE_TRAFFIC
        if step % 2:
            targets = [*targets, {"revisionName": marker, "tag": bridge["STARTUP_TAG"]}]
        _require(
            not unexpected_response
            and not unexpected_request
            and request_event.get("logName")
            == f"projects/{bridge['PROJECT']}/logs/cloudaudit.googleapis.com%2Factivity"
            and response_event.get("logName") == COMPLETION_LOG
            and response_payload.get("serviceName") == "run.googleapis.com"
            and response.get("kind") == "Service"
            and instant(BIRTH_TIME)
            <= instant(request_event["timestamp"])
            <= instant(response_event["timestamp"])
            <= instant(until)
            and (
                step == len(requests) - 1
                or instant(response_event["timestamp"])
                < instant(requests[step + 1]["timestamp"])
            )
            and request_payload.get("methodName")
            == "google.cloud.run.v1.Services.ReplaceService"
            and request_payload.get("resourceName")
            == f"namespaces/{NAMESPACE}/services/{bridge['BACKEND']}"
            and (request_payload.get("authenticationInfo") or {}).get("principalEmail")
            == DEPLOYER
            and response_payload.get("methodName") == "/Services.ReplaceService"
            and response_payload.get("resourceName")
            == f"namespaces/{bridge['PROJECT']}/services/{bridge['BACKEND']}"
            and not (response_payload.get("status") or {}).get("code")
            and request_meta.get("name")
            == response_meta.get("name")
            == bridge["BACKEND"]
            and request_meta.get("namespace")
            == response_meta.get("namespace")
            == NAMESPACE
            and bool(request_meta.get("resourceVersion"))
            and response_meta.get("generation") == 316 + step
            and bool(response_meta.get("resourceVersion"))
            and response_meta["resourceVersion"] != request_meta["resourceVersion"]
            and response_meta.get("uid") == bridge["BACKEND_SERVICE_UID"]
            and (response.get("status") or {}).get("latestCreatedRevisionName")
            == marker
            and _traffic_matches(request, targets)
            and _traffic_matches(response, targets)
        )
        _check_template(request, bridge, redacted=True)
        _check_template(response, bridge, redacted=False)
    return {id(event) for event in requests}
