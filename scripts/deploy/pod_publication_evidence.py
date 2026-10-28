# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Main-reviewed immutable evidence pins, not caller-supplied readiness claims."""

from __future__ import annotations

import hashlib
import importlib
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
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
            "preparationAttempt",
            "preparationArtifactId",
            "preparationArtifactSha256",
            "evidence",
        }
        or value["schemaVersion"] != 1
    ):
        raise ValueError("Activation needs a Main-reviewed publication pin")
    _validate_preparation_pin(value)
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


def _validate_preparation_pin(value: dict) -> None:
    if any(
        type(value[k]) is not int or value[k] < 1
        for k in ("preparationAttempt", "preparationArtifactId")
    ):
        raise ValueError("Exact preparation attempt and artifact identity are required")
    if not digest(value["preparationArtifactSha256"]):
        raise ValueError("Preparation artifact digest is required")
    if not digest(value["preparationManifestSha256"]):
        raise ValueError("Native build artifact manifest must be pinned")
    if not isinstance(value["descriptorSourceRevision"], str) or not re.fullmatch(
        r"[a-f0-9]{40}", value["descriptorSourceRevision"]
    ):
        raise ValueError("Reviewed descriptor source is required")
    if not isinstance(value["preparationBuildId"], str) or not re.fullmatch(
        r"[a-f0-9-]{36}", value["preparationBuildId"]
    ):
        raise ValueError("Native preparation build is required")


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


def verify_preparation_attempt(command, run: dict, pin: dict, archive: bytes) -> None:
    """Bind native build outputs to the successful Main-owned prepare step."""
    attempt = pin["preparationAttempt"]
    if run.get("run_attempt") != attempt:
        raise ValueError("Preparation attempt differs from the reviewed pin")
    prefix = "repos/hushh-labs/hushh-research/actions/"
    jobs = json.loads(
        command(
            "gh",
            "api",
            prefix + f"runs/{run['id']}/attempts/{attempt}/jobs?per_page=100",
        )
    )
    rows = jobs.get("jobs", [])
    if (
        not isinstance(rows, list)
        or len(rows) > 100
        or jobs.get("total_count") != len(rows)
    ):
        raise ValueError("Preparation job inventory is incomplete")
    selected = [j for j in rows if j.get("name") == "Pod Release Publication"]
    if (
        len(selected) != 1
        or selected[0].get("conclusion") != "success"
        or selected[0].get("status") != "completed"
        or selected[0].get("run_id") != run["id"]
        or selected[0].get("run_attempt") != attempt
    ):
        raise ValueError("Preparation job did not succeed")
    required = {
        "Prepare common pod artifact without deploying the application",
        "Retain bounded publication evidence",
    }
    steps = selected[0].get("steps", [])
    if any(
        sum(s.get("name") == name and s.get("conclusion") == "success" for s in steps)
        != 1
        for name in required
    ):
        raise ValueError("Preparation or evidence upload did not succeed")
    inventory = json.loads(
        command("gh", "api", prefix + f"runs/{run['id']}/artifacts?per_page=100")
    )
    artifacts = inventory.get("artifacts", [])
    if (
        not isinstance(artifacts, list)
        or len(artifacts) > 100
        or inventory.get("total_count") != len(artifacts)
    ):
        raise ValueError("Preparation artifact inventory is incomplete")
    matches = [
        a
        for a in artifacts
        if a.get("name") == f"pod-publication-dev-{run['id']}-{attempt}"
    ]
    if len(matches) != 1:
        raise ValueError("Preparation artifact is missing or ambiguous")
    artifact = matches[0]
    if (
        artifact.get("id") != pin["preparationArtifactId"]
        or artifact.get("expired") is not False
        or artifact.get("digest") != "sha256:" + pin["preparationArtifactSha256"]
        or artifact.get("workflow_run", {}).get("id") != run["id"]
        or artifact.get("workflow_run", {}).get("head_sha") != run["head_sha"]
    ):
        raise ValueError("Preparation artifact provenance differs")
    _verify_preparation_archive(artifact, pin, archive)


def _verify_preparation_archive(artifact: dict, pin: dict, archive: bytes) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/ci"))
    receipts = importlib.import_module("release_artifact_receipts")
    process = importlib.import_module("process_group")

    def bounded(args, *, timeout, text):
        return SimpleNamespace(
            stdout=process.bounded_stdout(
                args, max_bytes=10 * 1024 * 1024, timeout=timeout
            )
        )

    packed = receipts.immutable_archive(
        "hushh-labs/hushh-research", artifact, run_command=bounded, timeout=30
    )
    expected = {
        "build-id.txt": (pin["preparationBuildId"] + "\n").encode(),
        "outcome.txt": b"artifact_prepared_not_qualified_or_activated\n",
        "release.json": archive,
    }
    for name, content in expected.items():
        if receipts._status_bytes(packed, name) != content:
            raise ValueError(
                "Preparation artifact bytes do not match the selected build/release"
            )
