# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Main-reviewed immutable evidence pins, not caller-supplied readiness claims."""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import quote

CHECKS = {
    "platform": {
        "cpuOnly",
        "nonRoot",
        "singleWorker",
        "startup",
        "routeAllowlist",
        "deterministicRequest",
        "cleanup",
    },
    "recovery": {
        "identity",
        "memory",
        "revocation",
        "processingConsent",
        "pkm",
        "files",
        "cleanup",
    },
    "compatibility": {
        "binding",
        "handshake",
        "sessionAdmission",
        "consentGrant",
        "consentRevocation",
        "catalogDiscovery",
        "approvalPlanning",
    },
}
EXECUTION = re.compile(
    r"projects/(?:hushh-pda-dev|hussh-hp-7da5778b-261027a|hussh-hp-a3a6730e-261027b)"
    r"/locations/us-central1/jobs/[a-z][a-z0-9-]{0,62}/executions/[a-z][a-z0-9-]{0,62}"
)


def digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def validate_pin(value: object) -> dict:
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schemaVersion",
            "release",
            "descriptorSourceRevision",
            "baseline",
            "preparationBuildId",
            "preparationManifestSha256",
            "evidence",
        }
        or value["schemaVersion"] != 1
    ):
        raise ValueError("Activation needs a Main-reviewed publication pin")
    if not digest(value["preparationManifestSha256"]):
        raise ValueError("Native build artifact manifest must be pinned")
    if not isinstance(value["descriptorSourceRevision"], str) or not re.fullmatch(
        r"[a-f0-9]{40}", value["descriptorSourceRevision"]
    ):
        raise ValueError("Reviewed descriptor source is required")
    base = value["baseline"]
    if (
        not isinstance(base, dict)
        or set(base)
        != {
            "serviceUid",
            "revision",
            "applicationSource",
            "applicationImage",
            "configurationSha256",
            "trafficSha256",
        }
        or not digest(base["configurationSha256"])
        or not digest(base["trafficSha256"])
    ):
        raise ValueError("Coordinated application baseline is incomplete")
    if not isinstance(value["preparationBuildId"], str) or not re.fullmatch(
        r"[a-f0-9-]{36}", value["preparationBuildId"]
    ):
        raise ValueError("Native preparation build is required")
    refs = value["evidence"]
    if (
        not isinstance(refs, list)
        or not 3 <= len(refs) <= 10
        or {r.get("kind") for r in refs if isinstance(r, dict)} != set(CHECKS)
    ):
        raise ValueError(
            "Platform, recovery and application pairing evidence are required"
        )
    for kind in ("platform", "compatibility"):
        if sum(r.get("kind") == kind for r in refs) != 1:
            raise ValueError("Qualification evidence is ambiguous")
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != {
            "kind",
            "object",
            "generation",
            "sha256",
            "nativeExecutions",
            "probeSha256",
        }:
            raise ValueError("Invalid immutable qualification reference")
        if (
            not digest(ref["sha256"])
            or not digest(ref["probeSha256"])
            or not re.fullmatch(r"[1-9][0-9]{0,24}", str(ref["generation"]))
        ):
            raise ValueError("Qualification lacks immutable byte provenance")
        executions = ref["nativeExecutions"]
        if (
            not isinstance(executions, list)
            or not 1 <= len(executions) <= 4
            or any(
                not isinstance(v, str) or not EXECUTION.fullmatch(v) for v in executions
            )
        ):
            raise ValueError("Qualification native execution identity is invalid")
    return value


def read_object(
    session, object_name: str, *, generation: str | None = None, limit: int = 65536
) -> bytes:
    url = (
        "https://storage.googleapis.com/storage/v1/b/hushh-pda-dev_cloudbuild/o/"
        + quote(object_name, safe="")
    )
    params = {"alt": "media"}
    if generation is not None:
        params["generation"] = generation
    with session.get(
        url, params=params, timeout=30, stream=True, allow_redirects=False
    ) as response:
        if response.status_code != 200:
            raise ValueError("Pinned publication object is unavailable")
        raw = bytearray()
        for part in response.iter_content(4096):
            raw.extend(part)
            if len(raw) > limit:
                raise ValueError("Publication object exceeds its bound")
    return bytes(raw)


def verify_evidence(session, pin: dict, release: dict) -> list[dict]:
    prefix = f"pod-releases/{release['sourceRevision']}/"
    predecessors = set(release["descriptor"]["supportedUpgradeDigests"])
    recovered = set()
    outcomes = []
    for ref in pin["evidence"]:
        if not isinstance(ref["object"], str) or not re.fullmatch(
            re.escape(prefix) + r"[1-9][0-9]{0,19}/qualification-[a-z0-9-]+\.json",
            ref["object"],
        ):
            raise ValueError("Qualification is outside the prepared release archive")
        raw = read_object(session, ref["object"], generation=str(ref["generation"]))
        if hashlib.sha256(raw).hexdigest() != ref["sha256"]:
            raise ValueError("Reviewed qualification bytes changed")
        observed = json.loads(raw)
        kind = ref["kind"]
        if (
            not isinstance(observed, dict)
            or observed.get("schemaVersion") != 1
            or any(
                observed.get(key) != value
                for key, value in {
                    "kind": kind,
                    "image": release["image"],
                    "sourceRevision": release["sourceRevision"],
                    "nativeExecutions": ref["nativeExecutions"],
                    "probeSha256": ref["probeSha256"],
                }.items()
            )
        ):
            raise ValueError(
                "Qualification belongs to a different image, source or native execution"
            )
        checks = observed.get("checks")
        if (
            not isinstance(checks, dict)
            or set(checks) != CHECKS[kind]
            or any(v is not True for v in checks.values())
        ):
            raise ValueError("Required qualification is incomplete")
        if kind == "compatibility" and observed.get("baseline") != pin["baseline"]:
            raise ValueError(
                "Shared/pod pairing is stale; coordinated requalification is required"
            )
        if kind == "recovery":
            predecessor = observed.get("predecessorImage", "")
            if not isinstance(predecessor, str) or not re.fullmatch(
                r"gcr\.io/hushh-pda-dev/consent-protocol-pod@sha256:[a-f0-9]{64}",
                predecessor,
            ):
                raise ValueError("Recovery predecessor is not immutable")
            recovered.add(predecessor.rsplit("@", 1)[1])
        outcomes.append(
            {
                "kind": kind,
                "sha256": ref["sha256"],
                "nativeExecutions": ref["nativeExecutions"],
            }
        )
    if not predecessors <= recovered:
        raise ValueError("An advertised predecessor has no recovery evidence")
    return outcomes


def verify_build_artifacts(
    session, build: dict, pin: dict, release: dict, archive: bytes, resolver
) -> None:
    """Bind release bytes and the executable digest to native build upload results."""
    prefix = f"pod-preparations/{pin['descriptorSourceRevision']}/{release['publisher']['runId']}/"
    manifest_object = prefix + "artifacts-" + pin["preparationBuildId"] + ".json"
    expected = "gs://hushh-pda-dev_cloudbuild/" + manifest_object
    location = build.get("results", {}).get("artifactManifest", "")
    if not isinstance(location, str) or not re.fullmatch(
        re.escape(expected) + r"(?:#[1-9][0-9]{0,24})?", location
    ):
        raise ValueError("Native build artifact manifest location is invalid")
    raw = read_object(
        session,
        manifest_object,
        generation=location.split("#", 1)[1] if "#" in location else None,
    )
    if hashlib.sha256(raw).hexdigest() != pin["preparationManifestSha256"]:
        raise ValueError("Native artifact manifest bytes changed")
    try:
        rows = json.loads(raw)
        rows = rows if isinstance(rows, list) else [rows]
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    files = {}
    names = {"pod-image-provenance.json", "pod-image-manifest.json", "pod-release.json"}
    if len(rows) != 3:
        raise ValueError("Native artifact manifest is incomplete")
    for row in rows:
        path = row.get("location", "")
        match = re.fullmatch(
            re.escape("gs://hushh-pda-dev_cloudbuild/" + prefix)
            + r"([^/#]+)#([1-9][0-9]{0,24})",
            path,
        )
        if match is None or match[1] not in names or match[1] in files:
            raise ValueError("Native artifact identity is invalid")
        files[match[1]] = read_object(
            session, prefix + match[1], generation=match[2], limit=2 * 1024 * 1024
        )
    if files["pod-release.json"] != archive:
        raise ValueError("Archived descriptor was not produced by the native build")
    provenance = json.loads(files["pod-image-provenance.json"])
    if (
        provenance.get("status") != "pinned"
        or provenance.get("image_reference") != release["image"]
        or provenance.get("sha") != release["sourceRevision"]
    ):
        raise ValueError("Native resolver provenance names another image")
    if (
        provenance.get("descriptorSourceRevision", pin["descriptorSourceRevision"])
        != pin["descriptorSourceRevision"]
    ):
        raise ValueError("Native descriptor provenance differs")
    index = provenance.get("index_reference", release["image"])
    repository, separator, expected_digest = index.partition("@")
    resolved = resolver.resolve_manifest(
        files["pod-image-manifest.json"], expected_digest
    )
    if not separator or repository + "@" + resolved["digest"] != release["image"]:
        raise ValueError("Native executable manifest differs from the offered image")
