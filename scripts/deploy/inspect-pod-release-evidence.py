#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Inspect one pod release's retained evidence without contacting a provider.

This is an offline consistency check, never authority to publish or install.
Native freshness, object generations and owner journeys remain separate gates.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

import pod_publication_evidence as evidence

ROOT = Path(__file__).resolve().parents[2]
LIMIT = 1_000_000


def _reuse_contract():
    spec = importlib.util.spec_from_file_location(
        "pod_reuse", ROOT / "scripts/deploy/reuse-pod-release.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("release validator unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read(path: Path, *, limit: int = LIMIT) -> bytes:
    with path.open("rb") as source:
        raw = source.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("evidence exceeds its size bound")
    return raw


def _json(path: Path) -> dict:
    value = json.loads(_read(path))
    if not isinstance(value, dict):
        raise ValueError("evidence must be an object")
    return value


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _platform(state: dict, release: dict, preparation: dict, probe: Path) -> None:
    execution = state.get("nativeExecution") or {}
    cleanup = state.get("cleanup") or {}
    rows = state.get("receipts", [])
    receipts = {item.get("stage"): item for item in rows}
    entry, component = (
        receipts.get("normal_entrypoint", {}),
        receipts.get("component", {}),
    )
    expected_tag = f"dev-{release['sourceRevision']}-{release['publisher']['runId']}-{preparation['preparationAttempt']}"
    completed = [
        item
        for item in execution.get("conditions", [])
        if item.get("type") == "Completed"
    ]
    if (
        state.get("image") != release["image"]
        or state.get("sourceRevision") != release["sourceRevision"]
        or state.get("probeSha256") != _sha(_read(probe))
        or state.get("status") != "verified"
        or state.get("nativeResourceRemoved") is not True
        or state.get("expectedImageTag") != expected_tag
        or not evidence.EXECUTION.fullmatch(str(state.get("execution") or ""))
        or state.get("expectedLimits") != {"cpu": "1", "memory": "2Gi"}
        or execution.get("succeededCount") != 1
        or execution.get("failedCount") not in (None, 0)
        or not execution.get("completionTime")
        or len(completed) != 1
        or completed[0].get("state") != "CONDITION_SUCCEEDED"
        or any(
            cleanup.get(key) is not True
            for key in ("executionTerminal", "jobRemoved", "accountRemoved")
        )
        or len(rows) != 2
        or set(receipts) != {"normal_entrypoint", "component"}
        or entry.get("status") != "verified"
        or entry.get("uid") != 10001
        or entry.get("workers") != 1
        or entry.get("machineWall") != "404"
        or entry.get("controlSocketUid") != 10001
        or entry.get("controlSocketReadOnlyStatus") is not True
        or entry.get("completedPrivateTurnWarmup") is not True
        or entry.get("modelCalls") != 0
        or (entry.get("deterministicHealth") or {}).get("status") != "ready"
        or component.get("status") != "verified"
        or component.get("uid") != 10001
        or component.get("modelCalls") != 0
        or not str((component.get("versions") or {}).get("torch", "")).endswith("+cpu")
        or not (component.get("versions") or {}).get("google-adk")
        or not (component.get("versions") or {}).get("google-genai")
        or not component.get("manifests")
        or not component.get("routes")
    ):
        raise ValueError("platform evidence is incomplete or differs from the release")


def _recovery(
    state: dict,
    release: dict,
    preparation: bytes,
    entry: Path,
    predecessor: str,
    directory: Path,
) -> list[str]:
    seed, restore = state.get("seed") or {}, state.get("restore") or {}
    same = (
        "public_key_sha256",
        "identity_ciphertext_sha256",
        "log_records",
        "log_head_sha256",
        "file_bytes",
        "file_sha256",
    )
    checks = (
        "memory_recalled",
        "revocation_retained",
        "provider_consent_preserved",
        "pkm_rebuilt",
        "files_preserved",
    )
    if (
        state.get("sourceRevision") != release["sourceRevision"]
        or state.get("candidateImage") != release["image"]
        or state.get("predecessorImage", "").rsplit("@", 1)[-1] != predecessor
        or state.get("preparationSha256") != _sha(preparation)
        or state.get("entrySha256") != _sha(_read(entry))
        or state.get("recovery") != "verified_isolated_format_not_owner_installation"
        or state.get("cleanup")
        != "active_fixture_generations_absent_provider_soft_delete_pending"
        or state.get("canonicalImagesAndOwnerPreserved") is not True
        or seed.get("code") != "EXACT_IMAGE_RECOVERY_FORMAT_VERIFIED"
        or restore.get("code") != seed.get("code")
        or seed.get("identity_created") is not True
        or restore.get("identity_created") is not False
        or any(seed.get(k) is not True or restore.get(k) is not True for k in checks)
        or any(seed.get(k) is None or seed[k] != restore.get(k) for k in same)
    ):
        raise ValueError("recovery evidence is incomplete or differs from the release")
    tag = state.get("tag")
    if not isinstance(tag, str) or not re.fullmatch(
        r"hosted-recovery-[a-f0-9]{12}", tag
    ):
        raise ValueError("recovery fixture identity is invalid")
    executions = []
    for phase, digest, receipt in (
        ("seed", predecessor, seed),
        ("restore", release["image"].rsplit("@", 1)[-1], restore),
    ):
        journal = _json(directory / f"{tag}-{phase}.json")
        if (
            journal.get("state") != "format_phase_verified_not_owner_recovery"
            or journal.get("phase") != phase
            or journal.get("sourceRevision") != release["sourceRevision"]
            or str(journal.get("image", "")).rsplit("@", 1)[-1] != digest
            or journal.get("entrySha256") != state["entrySha256"]
            or journal.get("receipt") != receipt
            or journal.get("modelCalls") != 0
            or journal.get("cleanup")
            != "exact_job_deleted_404_runtime_account_preserved"
            or not (journal.get("executionTiming") or {}).get("completionTime")
            or not evidence.EXECUTION.fullmatch(str(journal.get("execution") or ""))
        ):
            raise ValueError("recovery phase journal is incomplete or changed")
        executions.append(journal["execution"])
    if len(set(executions)) != 2:
        raise ValueError("recovery phases must have distinct native executions")
    return executions


def _reader(directory: Path):
    root = directory.resolve()

    def read(_session, name: str, *, generation: str):
        path = (root / name).resolve()
        if not path.is_relative_to(root):
            raise ValueError("evidence path escapes its directory")
        return _read(path, limit=65536)

    return read


def _original_preparation(args, reuse, preparation_raw, preparation, release):
    # Metadata-only publication has a new run and proof while retaining the
    # image's original preparation, job and recovery receipts.
    original_preparation_path = getattr(args, "image_preparation_json", None)
    original_release_path = getattr(args, "image_release_json", None)
    if bool(original_preparation_path) != bool(original_release_path):
        raise ValueError(
            "original image preparation and release must be supplied together"
        )
    original_raw, image_preparation, image_release = (
        preparation_raw,
        preparation,
        release,
    )
    if original_preparation_path:
        original_raw = _read(original_preparation_path)
        image_preparation = json.loads(original_raw)
        original_pin = reuse.validate_pin(
            image_preparation["release"], project="hushh-pda-dev"
        )
        image_release = reuse.validate_archive(
            original_pin, _read(original_release_path), project="hushh-pda-dev"
        )
        if (
            image_release["image"] != release["image"]
            or image_release["sourceRevision"] != release["sourceRevision"]
            or image_preparation["descriptorSourceRevision"]
            != image_release["sourceRevision"]
        ):
            raise ValueError(
                "original image preparation differs from the current image"
            )
    return original_raw, image_preparation, image_release


def _check_activation(
    args, preparation, release, baseline, platform, recovery, recovery_executions
):
    activation = evidence.validate_pin(_json(args.pin))
    for key in (
        "release",
        "descriptorSourceRevision",
        "preparationBuildId",
        "preparationAttempt",
        "preparationArtifactId",
        "preparationArtifactSha256",
        "preparationManifestSha256",
    ):
        if activation[key] != preparation[key]:
            raise ValueError("activation pin differs from preparation")
    if activation["baseline"] != baseline:
        raise ValueError("shared baseline differs from activation pin")
    try:
        reader = _reader(args.evidence_dir)
        evidence.verify_evidence(None, activation, release, object_reader=reader)
        platform_ref = next(
            ref for ref in activation["evidence"] if ref["kind"] == "platform"
        )
        if (
            platform_ref["nativeExecutions"] != [platform["execution"]]
            or platform_ref["probeSha256"] != platform["probeSha256"]
        ):
            raise ValueError("platform envelope differs from retained execution")
        recovered = []
        for ref in activation["evidence"]:
            if ref["kind"] != "recovery":
                continue
            envelope = json.loads(
                reader(None, ref["object"], generation=str(ref["generation"]))
            )
            if (
                str(envelope.get("predecessorImage", "")).rsplit("@", 1)[-1]
                == args.predecessor_digest
            ):
                recovered.append(ref)
        if (
            len(recovered) != 1
            or recovered[0]["nativeExecutions"] != recovery_executions
            or recovered[0]["probeSha256"] != recovery["entrySha256"]
        ):
            raise ValueError("recovery envelope differs from retained executions")
    except FileNotFoundError:
        return False
    return True


def inspect(args) -> dict:
    reuse = _reuse_contract()
    preparation_raw = _read(args.preparation_json)
    preparation = json.loads(preparation_raw)
    pin = reuse.validate_pin(preparation["release"], project="hushh-pda-dev")
    release = reuse.validate_archive(
        pin, _read(args.release_json), project="hushh-pda-dev"
    )
    if args.image_digest != release["image"].rsplit("@", 1)[-1]:
        raise ValueError("candidate digest differs from the release")
    if preparation["descriptorSourceRevision"] != release["sourceRevision"]:
        reuse.require_unchanged_image_context(
            pin, preparation["descriptorSourceRevision"]
        )
    original_raw, image_preparation, image_release = _original_preparation(
        args, reuse, preparation_raw, preparation, release
    )
    source = release["sourceRevision"]
    platform = _json(args.evidence_dir / f"image-platform-state-{source}.json")
    recovery = _json(args.evidence_dir / f"pilot-format-recovery-{source}.json")
    _platform(
        platform,
        image_release,
        image_preparation,
        args.evidence_dir / "image_platform_probe.py",
    )
    recovery_executions = _recovery(
        recovery,
        image_release,
        original_raw,
        args.recovery_entry,
        args.predecessor_digest,
        args.evidence_dir,
    )
    baseline = _json(args.baseline_json)["baseline"]
    missing = []
    if args.predecessor_digest not in release["descriptor"]["supportedUpgradeDigests"]:
        missing.append("reviewed predecessor compatibility")
    if args.pin is None:
        missing.extend(["reviewed activation pin", "shared/pod compatibility"])
    elif not _check_activation(
        args, preparation, release, baseline, platform, recovery, recovery_executions
    ):
        missing.append("pinned qualification envelope")
    return {
        "status": "INCOMPLETE" if missing else "LOCAL_EVIDENCE_CONSISTENT",
        "mode": "offline",
        "sourceRevision": source,
        "imageDigest": args.image_digest,
        "adapters": args.adapter,
        "nativeFreshness": "unchecked",
        "archiveGeneration": "unchecked",
        "adapterAcceptance": "unchecked",
        "physicalPurgeVerified": False,
        "missing": missing,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in (
        "release-json",
        "preparation-json",
        "baseline-json",
        "evidence-dir",
        "recovery-entry",
    ):
        parser.add_argument("--" + option, type=Path, required=True)
    parser.add_argument("--image-release-json", type=Path)
    parser.add_argument("--image-preparation-json", type=Path)
    parser.add_argument("--image-digest", required=True)
    parser.add_argument("--predecessor-digest", required=True)
    parser.add_argument(
        "--adapter",
        action="append",
        required=True,
        choices=("gcp-byoc", "gcp-hosted", "azure"),
    )
    parser.add_argument("--pin", type=Path)
    args = parser.parse_args()
    if any(
        not re.fullmatch(r"sha256:[a-f0-9]{64}", value)
        for value in (args.image_digest, args.predecessor_digest)
    ):
        parser.error("candidate and predecessor must be immutable sha256 digests")
    try:
        result = inspect(args)
    except FileNotFoundError:
        result = {
            "status": "INCOMPLETE",
            "mode": "offline",
            "missing": ["required evidence file"],
        }
    except (AttributeError, IndexError, KeyError, TypeError, ValueError):
        result = {"status": "INVALID", "mode": "offline"}
    print(json.dumps(result, sort_keys=True))
    return {"LOCAL_EVIDENCE_CONSISTENT": 0, "INVALID": 1, "INCOMPLETE": 2}[
        result["status"]
    ]


if __name__ == "__main__":
    sys.exit(main())
