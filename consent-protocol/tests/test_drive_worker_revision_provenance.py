"""Contract for the private worker's exact candidate attestation.

The passing fixture contains only the safe fields observed on a real UAT
Cloud Run revision. Cloud Run resolves the pinned ClamAV OCI index digest to
the linux/amd64 manifest digest and mirrors the registry before reporting it.
"""

from __future__ import annotations

import importlib.util
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
        },
        "spec": {
            "containers": [
                {"name": "drive-worker", "image": APP_IMAGE},
                {
                    "name": "clamav",
                    "image": f"mirror.gcr.io/clamav/clamav@{SCANNER_AMD64_DIGEST}",
                },
            ]
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }


def _verify(revision: dict) -> None:
    MODULE.verify_revision(
        revision,
        deploy_sha=DEPLOY_SHA,
        app_image=APP_IMAGE,
        scanner_index_digest=SCANNER_INDEX_DIGEST,
        scanner_amd64_digest=SCANNER_AMD64_DIGEST,
    )


def test_accepts_real_cloud_run_resolved_scanner_manifest() -> None:
    _verify(_deployed_revision())


def test_accepts_pinned_index_when_cloud_run_does_not_resolve_it() -> None:
    revision = _deployed_revision()
    revision["spec"]["containers"][1]["image"] = f"clamav/clamav@{SCANNER_INDEX_DIGEST}"
    _verify(revision)


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
