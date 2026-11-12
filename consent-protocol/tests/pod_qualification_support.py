"""Synthetic release evidence; never a substitute for native provider receipts."""

import hashlib
import json
from types import SimpleNamespace

from tests.test_pod_publication import load


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _preparation(case):
    archive = json.dumps(case.release).encode()
    case.release_path.write_bytes(archive)
    return {
        "schemaVersion": 1,
        "descriptorSourceRevision": case.source,
        "release": {
            "image": case.image,
            "sourceRevision": case.source,
            "runId": case.release["publisher"]["runId"],
            "archiveSha256": _digest(archive),
        },
        "preparationBuildId": "a" * 36,
        "preparationManifestSha256": "b" * 64,
        "preparationAttempt": 1,
        "preparationArtifactId": 1,
        "preparationArtifactSha256": "c" * 64,
    }


def _platform(case):
    return {
        "sourceRevision": case.source,
        "image": case.image,
        "probeSha256": _digest(case.probe.read_bytes()),
        "status": "verified",
        "nativeResourceRemoved": True,
        "execution": case.execution,
        "expectedLimits": {"cpu": "1", "memory": "2Gi"},
        "expectedImageTag": f"dev-{case.source}-{case.release['publisher']['runId']}-1",
        "nativeExecution": {
            "succeededCount": 1,
            "completionTime": "synthetic",
            "conditions": [{"type": "Completed", "state": "CONDITION_SUCCEEDED"}],
        },
        "cleanup": {"executionTerminal": True, "jobRemoved": True, "accountRemoved": True},
        "receipts": [
            {
                "stage": "normal_entrypoint",
                "status": "verified",
                "uid": 10001,
                "workers": 1,
                "machineWall": "404",
                "modelCalls": 0,
                "deterministicHealth": {"status": "ready"},
                "controlSocketUid": 10001,
                "controlSocketReadOnlyStatus": True,
                "completedPrivateTurnWarmup": True,
            },
            {
                "stage": "component",
                "status": "verified",
                "uid": 10001,
                "modelCalls": 0,
                "versions": {"google-adk": "1", "google-genai": "1", "torch": "1+cpu"},
                "manifests": 1,
                "routes": 1,
            },
        ],
    }


def _recovery(case):
    result = {
        "code": "EXACT_IMAGE_RECOVERY_FORMAT_VERIFIED",
        "public_key_sha256": "a" * 64,
        "identity_ciphertext_sha256": "b" * 64,
        "log_records": 1,
        "log_head_sha256": "c" * 64,
        "file_bytes": 1,
        "file_sha256": "d" * 64,
        "memory_recalled": True,
        "revocation_retained": True,
        "provider_consent_preserved": True,
        "pkm_rebuilt": True,
        "files_preserved": True,
    }
    seed, restore = {**result, "identity_created": True}, {**result, "identity_created": False}
    value = {
        "tag": "hosted-recovery-" + "a" * 12,
        "sourceRevision": case.source,
        "candidateImage": case.image,
        "predecessorImage": "example@" + case.predecessor,
        "preparationSha256": _digest(case.prep_path.read_bytes()),
        "entrySha256": _digest(case.entry.read_bytes()),
        "recovery": "verified_isolated_format_not_owner_installation",
        "cleanup": "active_fixture_generations_absent_provider_soft_delete_pending",
        "canonicalImagesAndOwnerPreserved": True,
        "physicalPurgeVerified": False,
        "seed": seed,
        "restore": restore,
    }
    for index, (phase, digest, receipt) in enumerate(
        (("seed", case.predecessor, seed), ("restore", case.image.rsplit("@", 1)[1], restore))
    ):
        journal = {
            "state": "format_phase_verified_not_owner_recovery",
            "phase": phase,
            "sourceRevision": case.source,
            "image": "example@" + digest,
            "entrySha256": value["entrySha256"],
            "receipt": receipt,
            "modelCalls": 0,
            "cleanup": "exact_job_deleted_404_runtime_account_preserved",
            "executionTiming": {"completionTime": "synthetic"},
            "execution": case.recovery_executions[index],
        }
        (case.root / f"{value['tag']}-{phase}.json").write_text(json.dumps(journal))
    return value


def qualification_case(monkeypatch, root, release, service):
    case = SimpleNamespace(
        root=root,
        release=release,
        source=release["sourceRevision"],
        image=release["image"],
        predecessor="sha256:" + "d" * 64,
        release_path=root / "release.json",
        prep_path=root / "preparation.json",
        probe=root / "image_platform_probe.py",
        entry=root / "entry.py",
        pin_path=root / "pin.json",
    )
    case.inspector = load(
        monkeypatch, "qualification_inspector", "../ops/inspect-pod-release-evidence.py"
    )
    case.writer = load(monkeypatch, "qualification_writer", "publish-pod-catalog.py")
    case.evidence = load(monkeypatch, "qualification_evidence", "pod_publication_evidence.py")
    case.execution = (
        "projects/hushh-pda-dev/locations/us-central1/jobs/qualification/executions/qualification-1"
    )
    case.recovery_executions = [
        "projects/hushh-pda-dev/locations/us-central1/jobs/seed/executions/seed-1",
        "projects/hushh-pda-dev/locations/us-central1/jobs/restore/executions/restore-1",
    ]
    case.preparation = _preparation(case)
    case.prep_path.write_text(json.dumps(case.preparation))
    case.probe.write_text("synthetic probe")
    case.entry.write_text("synthetic recovery")
    case.platform, case.recovery = _platform(case), _recovery(case)
    case.platform_path = root / f"image-platform-state-{case.source}.json"
    case.recovery_path = root / f"pilot-format-recovery-{case.source}.json"
    case.platform_path.write_text(json.dumps(case.platform))
    case.recovery_path.write_text(json.dumps(case.recovery))
    case.baseline = case.writer.baseline(service)
    baseline_path = root / "baseline.json"
    baseline_path.write_text(json.dumps({"baseline": case.baseline}))
    case.args = SimpleNamespace(
        release_json=case.release_path,
        preparation_json=case.prep_path,
        baseline_json=baseline_path,
        evidence_dir=root,
        recovery_entry=case.entry,
        image_digest=case.image.rsplit("@", 1)[1],
        predecessor_digest=case.predecessor,
        adapter=["gcp-hosted", "gcp-byoc"],
        pin=None,
    )
    return case


def pin_case(case):
    case.release["descriptor"]["supportedUpgradeDigests"] = [case.predecessor]
    archive = json.dumps(case.release).encode()
    case.release_path.write_bytes(archive)
    case.preparation["release"]["archiveSha256"] = _digest(archive)
    case.prep_path.write_text(json.dumps(case.preparation))
    case.recovery["preparationSha256"] = _digest(case.prep_path.read_bytes())
    case.recovery_path.write_text(json.dumps(case.recovery))
    case.pin = {**case.preparation, "baseline": case.baseline, "evidence": []}
    for kind in ("platform", "recovery", "compatibility"):
        executions = case.recovery_executions if kind == "recovery" else [case.execution]
        probe = (
            case.recovery["entrySha256"]
            if kind == "recovery"
            else case.platform["probeSha256"]
            if kind == "platform"
            else "e" * 64
        )
        value = {
            "schemaVersion": 1,
            "kind": kind,
            "image": case.image,
            "sourceRevision": case.source,
            "nativeExecutions": executions,
            "probeSha256": probe,
            "checks": {name: True for name in case.evidence.CHECKS[kind]},
        }
        if kind == "compatibility":
            value["baseline"] = case.baseline
        if kind == "recovery":
            value["predecessorImage"] = (
                "gcr.io/hushh-pda-dev/consent-protocol-pod@" + case.predecessor
            )
        name = f"pod-releases/{case.source}/{case.release['publisher']['runId']}/qualification-{kind}.json"
        path = case.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(value).encode()
        path.write_bytes(raw)
        case.pin["evidence"].append(
            {
                "kind": kind,
                "object": name,
                "generation": "1",
                "sha256": _digest(raw),
                "nativeExecutions": executions,
                "probeSha256": probe,
            }
        )
    case.pin_path.write_text(json.dumps(case.pin))
    case.args.pin = case.pin_path
