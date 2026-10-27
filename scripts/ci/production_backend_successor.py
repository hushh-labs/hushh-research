"""Typed operational backend reference; historical healthy evidence stays intact.

This module handles annotation and compare-and-swap mechanics only. Its caller
must independently qualify the sealed backend proof before preparing a change.
It grants neither healthy-release status nor permission to retire a revision.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from collections.abc import Callable

FIELD = "operational_backend: "
REF = "refs/tags/deployed/production-latest"
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
HEALTHY_FIELDS = {
    "sha",
    "backend_revision",
    "backend_url",
    "frontend_revision",
    "frontend_url",
    "run",
    "actor",
    "tagged_at",
}


def require(condition: object, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def unique(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, "operational_backend_duplicate_field")
        result[key] = value
    return result


def healthy_fields(healthy: str, commit: str) -> dict[str, str]:
    """Read producer-supported empty URLs without changing historical bytes."""
    require(len(healthy.encode()) <= 65536, "operational_backend_annotation_too_large")
    require(bool(HEX40.fullmatch(commit)), "operational_backend_healthy_commit_invalid")
    values = {}
    for line in healthy.splitlines()[1:]:
        key, separator, value = line.partition(": ")
        # git tag's default cleanup removes a producer's trailing space when
        # either optional service URL is empty. No other field is optional.
        if line in {"backend_url:", "frontend_url:"}:
            key, separator, value = line[:-1], ":", ""
        require(
            bool(separator) and key in HEALTHY_FIELDS and key not in values,
            "operational_backend_healthy_annotation_invalid",
        )
        values[key] = value
    require(
        healthy.startswith("Last known good — production\n")
        and set(values) == HEALTHY_FIELDS
        and values["sha"] == commit,
        "operational_backend_healthy_annotation_invalid",
    )
    return values


def split(message: str, commit: str) -> tuple[str, dict | None]:
    """Preserve the exact healthy message, including its existing newlines."""
    require(len(message.encode()) <= 65536, "operational_backend_annotation_too_large")
    require(bool(HEX40.fullmatch(commit)), "operational_backend_healthy_commit_invalid")
    lines = message.splitlines(keepends=True)
    indices = [
        i for i, line in enumerate(lines) if line.startswith("operational_backend:")
    ]
    require(len(indices) <= 1, "operational_backend_duplicate_reference")
    record = None
    if indices:
        index = indices[0]
        require(
            index == len(lines) - 1 and lines[index].startswith(FIELD),
            "operational_backend_reference_position_invalid",
        )
        record = json.loads(lines[index][len(FIELD) :], object_pairs_hook=unique)
        lines = lines[:index]
    healthy = "".join(lines)
    healthy_fields(healthy, commit)
    if indices:
        validate(record, healthy, commit)
    return healthy, record


def validate(record: dict, healthy: str, commit: str) -> None:
    fields = {
        "schema_version",
        "kind",
        "origin",
        "revision",
        "source",
        "image",
        "uid",
        "healthy_commit",
        "healthy_message_sha256",
        "previous_tag_oid",
    }
    require(
        isinstance(record, dict) and set(record) == fields,
        "operational_backend_record_invalid",
    )
    origin = record.get("origin")
    require(
        type(record.get("schema_version")) is int
        and record["schema_version"] == 1
        and record.get("kind") == "phone-operational-backend"
        and record.get("healthy_commit") == commit
        and record.get("healthy_message_sha256")
        == hashlib.sha256(healthy.encode()).hexdigest()
        and isinstance(record.get("previous_tag_oid"), str)
        and bool(HEX40.fullmatch(record["previous_tag_oid"]))
        and isinstance(record.get("source"), str)
        and bool(HEX40.fullmatch(record["source"]))
        and isinstance(record.get("revision"), str)
        and bool(re.fullmatch(r"consent-protocol-[a-z0-9-]+", record["revision"]))
        and isinstance(record.get("image"), str)
        and bool(
            re.fullmatch(
                r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}",
                record["image"],
            )
        )
        and isinstance(record.get("uid"), str)
        and 0 < len(record["uid"]) <= 256,
        "operational_backend_identity_invalid",
    )
    require(
        isinstance(origin, dict)
        and set(origin)
        == {"run_id", "run_attempt", "workflow_sha", "artifact_id", "artifact_digest"}
        and isinstance(origin.get("run_id"), str)
        and bool(re.fullmatch(r"[1-9][0-9]*", origin["run_id"]))
        and type(origin.get("run_attempt")) is int
        and origin["run_attempt"] > 0
        and isinstance(origin.get("workflow_sha"), str)
        and bool(HEX40.fullmatch(origin["workflow_sha"]))
        and type(origin.get("artifact_id")) is int
        and origin["artifact_id"] > 0
        and isinstance(origin.get("artifact_digest"), str)
        and bool(re.fullmatch(r"sha256:[0-9a-f]{64}", origin["artifact_digest"])),
        "operational_backend_origin_invalid",
    )


def annotate(message: str, commit: str, old_oid: str, anchor: dict) -> str:
    healthy, _ = split(message, commit)
    # Current canonical tag writer terminates its annotation with a newline.
    # Refuse rather than silently change old healthy bytes to append a field.
    require(healthy.endswith("\n"), "operational_backend_healthy_newline_missing")
    record = {
        "schema_version": 1,
        "kind": "phone-operational-backend",
        "origin": anchor["origin"],
        "revision": anchor["revision"],
        "source": anchor["source"],
        "image": anchor["image"],
        "uid": anchor["uid"],
        "healthy_commit": commit,
        "healthy_message_sha256": hashlib.sha256(healthy.encode()).hexdigest(),
        "previous_tag_oid": old_oid,
    }
    validate(record, healthy, commit)
    return (
        healthy
        + FIELD
        + json.dumps(record, sort_keys=True, separators=(",", ":"))
        + "\n"
    )


def tag_identity(raw: str) -> dict:
    require(
        isinstance(raw, str) and len(raw.encode()) <= 131072,
        "operational_backend_original_tag_invalid",
    )
    header, separator, message = raw.partition("\n\n")
    rows = header.splitlines()
    require(
        bool(separator)
        and len(rows) == 4
        and rows[0].startswith("object ")
        and rows[1] == "type commit"
        and rows[2] == f"tag {REF.removeprefix('refs/tags/')}"
        and bool(
            re.fullmatch(r"tagger [^\r\n<>]+ <[^\r\n<>]+> [0-9]+ [+-][0-9]{4}", rows[3])
        ),
        "operational_backend_original_tag_invalid",
    )
    commit = rows[0].removeprefix("object ")
    split(message, commit)
    encoded = raw.encode()
    oid = hashlib.sha1(
        b"tag " + str(len(encoded)).encode() + b"\0" + encoded, usedforsecurity=False
    ).hexdigest()
    return {"tag_oid": oid, "commit": commit, "message": message, "tag_object": raw}


def git(argv: list[str], *, content: str | None = None) -> str:
    result = subprocess.run(
        ["git", *argv],
        input=content,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return result.stdout


def remote_oid(*, run: Callable = git) -> str:
    rows = run(["ls-remote", "--refs", "origin", REF]).splitlines()
    require(len(rows) == 1, "operational_backend_remote_reference_ambiguous")
    oid, ref = rows[0].split("\t")
    require(
        ref == REF and bool(HEX40.fullmatch(oid)),
        "operational_backend_remote_reference_invalid",
    )
    return oid


def tag_object(commit: str, message: str, *, run: Callable = git) -> str:
    split(message, commit)
    identity = run(["var", "GIT_COMMITTER_IDENT"]).strip()
    value = f"object {commit}\ntype commit\ntag {REF.removeprefix('refs/tags/')}\ntagger {identity}\n\n{message}"
    oid = run(["mktag"], content=value).strip()
    require(bool(HEX40.fullmatch(oid)), "operational_backend_tag_object_invalid")
    return oid


def compare_and_swap(old_oid: str, new_oid: str, *, run: Callable = git) -> str:
    """Call only after the exact old/new intent has been durably published.

    A failed push is read back once. An unchanged or third-party ref remains
    unresolved; this function never retries a write after an uncertain result.
    """
    require(
        all(HEX40.fullmatch(oid) for oid in (old_oid, new_oid)),
        "operational_backend_tag_oid_invalid",
    )
    require(remote_oid(run=run) == old_oid, "operational_backend_reference_changed")
    try:
        run(
            [
                "push",
                "origin",
                f"{new_oid}:{REF}",
                f"--force-with-lease={REF}:{old_oid}",
            ]
        )
    except (subprocess.SubprocessError, OSError):
        require(
            remote_oid(run=run) == new_oid,
            "operational_backend_push_requires_reconciliation",
        )
        return "confirmed_after_uncertain_push"
    require(remote_oid(run=run) == new_oid, "operational_backend_push_not_confirmed")
    return "confirmed"
