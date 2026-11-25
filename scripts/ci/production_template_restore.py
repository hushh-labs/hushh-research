# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Restore an accepted serving template without allocating another revision.

The existing Maintenance owner supplies the healthy release and deployment lock.
This operation preserves traffic, IAM and immutable revisions. Ordinary retention
owns any subsequent deletion of the displaced, non-serving latest revision.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROFILE = "existing_serving_template_v1"
PROJECT = "hushh-pda"
SERVICE = "consent-protocol"
REGION = "us-central1"
RESOURCE = f"projects/{PROJECT}/locations/{REGION}/services/{SERVICE}"
URL = f"https://run.googleapis.com/v2/{RESOURCE}"
RESERVED = (
    "run.googleapis.com/",
    "cloud.googleapis.com/",
    "serving.knative.dev/",
    "autoscaling.knative.dev/",
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def receipt(value, unsafe):
    if value is None:
        return None
    fields = {
        "profile",
        "resource",
        "source",
        "uid",
        "revisions",
        "controls",
        "traffic",
        "iam",
        "displaced",
        "requested",
        "status",
        "operation",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value["profile"] != PROFILE
        or value["resource"] != RESOURCE
        or value["status"] not in {"intent", "verified"}
        or type(value["requested"]) is not bool
        or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", value["source"])
        or not isinstance(value["uid"], str)
        or not value["uid"]
        or not isinstance(value["displaced"], str)
        or not isinstance(value["iam"], str)
        or not value["iam"]
        or any(
            not re.fullmatch(r"[a-f0-9]{64}", value[k])
            for k in ("revisions", "controls", "traffic")
        )
        or value["operation"] is not None
        and not re.fullmatch(
            re.escape(f"projects/{PROJECT}/locations/{REGION}/operations/")
            + r"[a-zA-Z0-9-]+",
            value["operation"],
        )
    ):
        raise unsafe("Invalid serving-template restoration receipt")
    return value


class Native:
    def __init__(self, owner):
        self.owner = owner
        self.token = owner.run_command(
            ["gcloud", "auth", "print-access-token"], timeout=20
        ).stdout.strip()

    def call(self, method, url, body=None):
        request = urllib.request.Request(
            url,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
            },
            data=None if body is None else json.dumps(body).encode(),
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.owner.remaining_seconds(20)
            ) as response:
                raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise ValueError("response bound")
            return json.loads(raw)
        except (OSError, ValueError) as error:
            # Never include provider bodies or a request containing environment values.
            raise self.owner.UnsafeState(
                "Serving-template native request failed"
            ) from error


def template(service, revision, properties, unsafe):
    name = revision["name"].rsplit("/", 1)[-1]
    if (
        revision.get("service", "").rsplit("/", 1)[-1] != SERVICE
        or not revision.get("uid")
        or not any(
            c.get("type") == "Ready" and c.get("state") == "CONDITION_SUCCEEDED"
            for c in revision.get("conditions", [])
        )
        or [
            (t["revision"].rsplit("/", 1)[-1], t.get("percent", 0))
            for t in service["trafficStatuses"]
            if t.get("percent")
        ]
        != [(name, 100)]
        or any(
            t.get("type") != "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
            for t in service["traffic"]
        )
    ):
        raise unsafe(
            "Serving-template source is not the uniquely accepted ready revision"
        )
    result = {
        k: copy.deepcopy(v)
        for k, v in revision.items()
        if k in properties and k != "revision"
    }
    result["revision"] = name
    for field in ("labels", "annotations"):
        if field in result:
            result[field] = {
                k: v for k, v in result[field].items() if not k.startswith(RESERVED)
            }
    return result


def observe(native, properties):
    service = native.call("GET", URL)
    revisions, page = [], ""
    while True:
        query = urllib.parse.urlencode(
            {"pageSize": 100, **({"pageToken": page} if page else {})}
        )
        result = native.call("GET", URL + "/revisions?" + query)
        revisions.extend(result.get("revisions", []))
        page = result.get("nextPageToken", "")
        if len(revisions) > 1000:
            raise native.owner.UnsafeState(
                "Revision inventory exceeds its restoration bound"
            )
        if not page:
            break
    policy = native.call("GET", URL + ":getIamPolicy")
    # The template is the sole mutable field. Preserve every other writable field.
    controls = {
        k: service[k]
        for k, spec in properties.items()
        if k != "template" and not spec.get("readOnly") and k in service
    }
    controls.pop("etag", None)
    return service, revisions, policy, controls


def maintain(release, checkpoint: Path, *, create: bool, owner, native=None):
    state = json.loads(checkpoint.read_text())
    prior = receipt(state.get("serving_template_restore"), owner.UnsafeState)
    if not create and (prior is None or prior["status"] == "verified"):
        return
    if prior is not None and prior["status"] == "verified":
        # A new explicit request is independently bound to the current healthy release.
        prior = None
    native = native or Native(owner)
    schema = native.call(
        "GET", "https://run.googleapis.com/$discovery/rest?version=v2"
    )["schemas"]
    service, revisions, policy, controls = observe(
        native, schema["GoogleCloudRunV2Service"]["properties"]
    )
    expected = release["final"]["backend_revision"]
    sources = [r for r in revisions if r["name"].rsplit("/", 1)[-1] == expected]
    if len(sources) != 1:
        raise owner.UnsafeState("Accepted serving revision is missing or ambiguous")
    source = sources[0]
    desired = template(
        service,
        source,
        schema["GoogleCloudRunV2RevisionTemplate"]["properties"],
        owner.UnsafeState,
    )
    facts = {
        "profile": PROFILE,
        "resource": RESOURCE,
        "source": expected,
        "uid": source["uid"],
        "revisions": digest(sorted((r["name"], r["uid"]) for r in revisions)),
        "controls": digest(controls),
        "traffic": digest(service["traffic"]),
        "iam": policy.get("etag", ""),
    }
    if prior is not None and any(prior[k] != v for k, v in facts.items()):
        raise owner.UnsafeState(
            "Serving-template restoration identity or controls changed"
        )
    if not policy.get("etag"):
        raise owner.UnsafeState("Serving-template IAM observation is incomplete")
    if prior is None:
        prior = {
            **facts,
            "displaced": service["latestCreatedRevision"],
            "requested": False,
            "status": "intent",
            "operation": None,
        }

    def save():
        state["serving_template_restore"] = prior
        owner.atomic_state(checkpoint, state)

    latest = (
        service.get("latestCreatedRevision", ""),
        service.get("latestReadyRevision", ""),
    )
    target = RESOURCE + "/revisions/" + expected
    if prior["operation"]:
        operation = native.call(
            "GET", "https://run.googleapis.com/v2/" + prior["operation"]
        )
        if not operation.get("done"):
            raise owner.MutationUncertain(
                "Serving-template provider operation is still pending"
            )
        if operation.get("error"):
            raise owner.UnsafeState(
                "Serving-template restoration was rejected by the provider"
            )
    settled = (
        service.get("reconciling") is not True
        and service.get("generation") is not None
        and service.get("observedGeneration") == service["generation"]
        and service.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED"
    )
    if latest == (target, target) and settled:
        prior["status"] = "verified"
        save()
        return
    if prior["requested"]:
        raise owner.MutationUncertain(
            "Serving-template outcome requires another native observation; request not replayed"
        )
    if not settled:
        raise owner.UnsafeState("Serving-template source service is still reconciling")
    if not create:
        raise owner.MutationUncertain(
            "Serving-template intent awaits an explicitly requested maintenance pass"
        )
    save()
    # Validate the exact existing-name request before marking a native mutation requested.
    body = {"name": service["name"], "etag": service["etag"], "template": desired}
    native.call("PATCH", URL + "?updateMask=template&validateOnly=true", body)
    prior["requested"] = True
    save()
    try:
        operation = native.call("PATCH", URL + "?updateMask=template", body)
        prior["operation"] = operation["name"]
        save()
    except Exception as error:
        raise owner.MutationUncertain(
            "Serving-template submission requires reconciliation; request not replayed"
        ) from error
    for _ in range(10):
        observed = native.call(
            "GET", "https://run.googleapis.com/v2/" + prior["operation"]
        )
        if observed.get("done"):
            if observed.get("error"):
                raise owner.UnsafeState(
                    "Serving-template restoration failed; native state requires reconciliation"
                )
            return maintain(
                release, checkpoint, create=False, owner=owner, native=native
            )
        time.sleep(owner.remaining_seconds(2))
    raise owner.MutationUncertain(
        "Serving-template operation is still pending; request not replayed"
    )
