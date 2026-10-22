"""Contract for the private worker's exact candidate attestation.

The passing fixture contains only the safe fields observed on a real UAT
Cloud Run revision. Cloud Run resolves the pinned ClamAV OCI index digest to
the linux/amd64 manifest digest and mirrors the registry before reporting it.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFIER_PATH = REPO_ROOT / "deploy" / "drive" / "verify_worker_revision.py"
SPEC = importlib.util.spec_from_file_location("verify_worker_revision", VERIFIER_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

DEPLOY_SHA = "47f71d9feeb3a508032faf9b1ec8dd980b77b1ae"
APP_IMAGE = (
    "gcr.io/hushh-pda-uat/consent-protocol@sha256:"
    "d5bd1e5551a04bf6e9fc034d14947213cf9e1be95dbb99d0ebf5ddd16c5c42e1"
)
SCANNER_INDEX_DIGEST = "sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"
SCANNER_AMD64_DIGEST = "sha256:e8388295191bff0893fb889d9415ae975491201c989b205e30c9057b1985d36a"


def _deployed_revision() -> dict:
    return {
        "metadata": {
            "name": "consent-protocol-drive-worker-00002-wuc",
            "labels": {"deploy-sha": DEPLOY_SHA},
            # The serving UAT revision (2026-10-18) has no zero-floor annotation.
            "annotations": {"autoscaling.knative.dev/maxScale": "2"},
        },
        "spec": {
            "containerConcurrency": 1,
            "containers": [
                {"name": "drive-worker", "image": APP_IMAGE},
                {
                    "name": "clamav",
                    "image": f"mirror.gcr.io/clamav/clamav@{SCANNER_AMD64_DIGEST}",
                },
            ],
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }


def _verify(revision: dict, *, drain_enabled: str | None = None, **scaling: str) -> None:
    MODULE.verify_revision(
        revision,
        deploy_sha=DEPLOY_SHA,
        app_image=APP_IMAGE,
        scanner_index_digest=SCANNER_INDEX_DIGEST,
        scanner_amd64_digest=SCANNER_AMD64_DIGEST,
        drain_enabled=drain_enabled,
        **scaling,
    )


def test_accepts_real_cloud_run_resolved_scanner_manifest() -> None:
    _verify(_deployed_revision())


def test_accepts_pinned_index_when_cloud_run_does_not_resolve_it() -> None:
    revision = _deployed_revision()
    revision["spec"]["containers"][1]["image"] = f"clamav/clamav@{SCANNER_INDEX_DIGEST}"
    _verify(revision)


@pytest.mark.parametrize("actual", ["false", "true", None])
def test_paused_release_requires_disabled_worker_in_fresh_revision(actual: str | None) -> None:
    revision = _deployed_revision()
    if actual is not None:
        revision["spec"]["containers"][0]["env"] = [
            {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": actual}
        ]
    if actual == "false":
        _verify(revision, drain_enabled="false")
    else:
        with pytest.raises(ValueError, match="background processing state mismatch"):
            _verify(revision, drain_enabled="false")


@pytest.mark.parametrize("lane", ["ordinary", "v1"])
@pytest.mark.parametrize("provider", ["gemini", "azure_openai"])
@pytest.mark.parametrize("tamper", [None, "missing", "wrong", "duplicate", "secret_ref"])
def test_release_cli_attests_exact_explicit_semantic_provider(
    monkeypatch, lane: str, provider: str, tamper: str | None
) -> None:
    verifier = MODULE
    if lane == "v1":
        monkeypatch.setitem(sys.modules, "verify_worker_revision", MODULE)
        spec = importlib.util.spec_from_file_location(
            "verify_v1_worker_revision", VERIFIER_PATH.with_name("verify_v1_worker_revision.py")
        )
        assert spec is not None and spec.loader is not None
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

    revision = _deployed_revision()
    revision["spec"]["serviceAccountName"] = (
        "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
    )
    flags = [
        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "true"},
        {"name": "DRIVE_WORKER_MODE", "value": "true"},
        {"name": "DRIVE_WORKER_V1_ONLY", "value": "true"},
        {"name": "ENVIRONMENT", "value": "uat"},
    ]
    selection = {"name": "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "value": provider}
    if tamper == "wrong":
        selection["value"] = "gemini" if provider == "azure_openai" else "azure_openai"
    elif tamper == "secret_ref":
        selection = {
            "name": selection["name"],
            "valueFrom": {"secretKeyRef": {"name": "synthetic", "key": "latest"}},
        }
    if tamper != "missing":
        flags.append(selection)
    if tamper == "duplicate":
        flags.append(dict(selection))
    revision["spec"]["containers"][0]["env"] = flags
    for name, value in {
        "EXPECTED_SHA": DEPLOY_SHA,
        "EXPECTED_APP_IMAGE": APP_IMAGE,
        "EXPECTED_SCANNER_INDEX_DIGEST": SCANNER_INDEX_DIGEST,
        "EXPECTED_SCANNER_AMD64_DIGEST": SCANNER_AMD64_DIGEST,
        "EXPECTED_DRAIN_ENABLED": "true",
        "EXPECTED_SEMANTIC_MODEL_PROVIDER": provider,
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("EXPECTED_MAX_INSTANCES", raising=False)
    monkeypatch.delenv("EXPECTED_CONCURRENCY", raising=False)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(revision)))

    assert verifier.main() == (0 if tamper is None else 1)


def test_refuses_unknown_expected_semantic_provider() -> None:
    revision = _deployed_revision()
    revision["spec"]["containers"][0]["env"] = [
        {"name": "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "value": "unknown"}
    ]
    with pytest.raises(ValueError, match="semantic model provider mismatch"):
        _verify(revision, semantic_model_provider="unknown")


@pytest.mark.parametrize(
    "tamper",
    [
        None,
        "explicit_zero_floor",
        "revision_floor",
        "two_requests",
        "wider_cap",
        "missing_scale",
        "partial_expectation",
    ],
)
def test_budgeted_scaling_is_attested_when_the_release_requests_it(tamper: str | None) -> None:
    """The connection budget counts each revision at its cap and one request.

    A revision-level floor would keep every tagged rollback revision warm, so
    warm capacity must come only from the service-level floor.
    """
    revision = deepcopy(_deployed_revision())
    expected = {"max_instances": "2", "concurrency": "1"}
    annotations = revision["metadata"]["annotations"]
    if tamper == "explicit_zero_floor":
        annotations["autoscaling.knative.dev/minScale"] = "0"
    elif tamper == "revision_floor":
        annotations["autoscaling.knative.dev/minScale"] = "1"
    elif tamper == "two_requests":
        revision["spec"]["containerConcurrency"] = 2
    elif tamper == "wider_cap":
        annotations["autoscaling.knative.dev/maxScale"] = "3"
    elif tamper == "missing_scale":
        del revision["metadata"]["annotations"]
        del revision["spec"]["containerConcurrency"]
    elif tamper == "partial_expectation":
        del expected["concurrency"]

    # The V1 and production releases pass no scaling expectation.
    _verify(revision)
    if tamper in {None, "explicit_zero_floor"}:
        _verify(revision, **expected)
    else:
        with pytest.raises(ValueError, match="revision scaling mismatch"):
            _verify(revision, **expected)


@pytest.mark.parametrize(
    "tamper",
    [
        "wrong_sha",
        "wrong_app_digest",
        "wrong_scanner_digest",
        "not_ready",
        "missing_scanner",
    ],
)
def test_rejects_unverified_candidate(tamper: str) -> None:
    revision = deepcopy(_deployed_revision())
    if tamper == "wrong_sha":
        revision["metadata"]["labels"]["deploy-sha"] = "0" * 40
    elif tamper == "wrong_app_digest":
        revision["spec"]["containers"][0]["image"] = APP_IMAGE[:-1] + "0"
    elif tamper == "wrong_scanner_digest":
        revision["spec"]["containers"][1]["image"] = (
            "mirror.gcr.io/clamav/clamav@sha256:" + "0" * 64
        )
    elif tamper == "not_ready":
        revision["status"]["conditions"][0]["status"] = "False"
    elif tamper == "missing_scanner":
        revision["spec"]["containers"].pop()

    with pytest.raises(ValueError):
        _verify(revision)


@pytest.mark.parametrize("selected", ["azure_openai", "vertex"])
def test_worker_preserves_promoted_api_provider_and_rejects_divergence(selected):
    revision = _deployed_revision()
    worker = revision["spec"]["containers"][0]
    worker["env"] = [
        {"name": name, "value": selected}
        for name in ("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "HUSHH_UAT_MANAGED_AI_PROVIDER")
    ]
    _verify(revision, managed_text_provider=selected)
    worker["env"][1]["value"] = "vertex" if selected == "azure_openai" else "azure_openai"
    with pytest.raises(ValueError, match="managed capability provider mismatch"):
        _verify(revision, managed_text_provider=selected)
    worker["env"][1]["value"] = selected
    with pytest.raises(ValueError, match="managed text provider mismatch"):
        _verify(
            revision,
            managed_text_provider="vertex" if selected == "azure_openai" else "azure_openai",
        )
    worker["env"] = []
    with pytest.raises(ValueError, match="managed text provider mismatch"):
        _verify(revision, managed_text_provider=selected)
