"""Permanent exact-attempt release receipts survive GitHub artifact expiry."""

from __future__ import annotations

import json

import pytest

from scripts.ci.uat_attempt_receipt import (
    InvalidReceipt,
    TAG_PREFIX,
    attempt_tag_prefix,
    build_tag_message,
    decode_tag_message,
    decode_tag_message_with_bytes,
)

SHA = "a" * 40
REPOSITORY = "hushh-labs/hushh-research"


def full_receipt() -> dict:
    return {
        "schema_version": 1,
        "repository": REPOSITORY,
        "workflow": ".github/workflows/deploy-uat.yml",
        "run_id": 123,
        "run_attempt": 2,
        "environment": "uat",
        "target": "uat",
        "resolved_services": ["backend"],
        "release": {
            "status": "healthy",
            "release_failed": False,
            "sha": SHA,
            "scope": "backend",
            "final": {
                "backend_revision": "consent-protocol-00001",
                "backend_sha": SHA,
                "frontend_revision": "hushh-webapp-00001",
                "frontend_sha": "b" * 40,
            },
        },
        "classification": {
            "status": "healthy",
            "release_failed": False,
            "blocking_classifications": [],
        },
    }


def one_chat_receipt() -> dict:
    return {
        "project": "hushh-pda-uat",
        "region": "us-central1",
        "service": "consent-protocol",
        "target_sha": SHA,
        "run_id": "123",
        "attempt": 2,
        "status": "success",
        "image": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "c" * 64,
        "final_serving_revision": "consent-protocol-00001",
        "final_traffic": {"consent-protocol-00001": 100},
    }


def dev_receipt() -> dict:
    receipt = full_receipt()
    receipt["workflow"] = ".github/workflows/deploy-dev.yml"
    receipt["environment"] = "dev"
    receipt["target"] = "shared-dev"
    return receipt


@pytest.mark.parametrize(
    ("kind", "receipt", "workflow", "environment"),
    [
        ("full", full_receipt(), ".github/workflows/deploy-uat.yml", "uat"),
        ("one-chat", one_chat_receipt(), ".github/workflows/deploy-uat-one-chat.yml", "uat"),
        ("full", dev_receipt(), ".github/workflows/deploy-dev.yml", "dev"),
    ],
)
def test_tag_message_round_trips_the_exact_attempt(kind, receipt, workflow, environment):
    raw = json.dumps(receipt, sort_keys=True).encode()
    message = build_tag_message(
        kind=kind,
        run_id=123,
        attempt=2,
        repository=REPOSITORY,
        workflow=workflow,
        target_sha=SHA,
        raw=raw,
        environment=environment,
    )

    recovered, digest = decode_tag_message(
        message,
        tag_name=f"{attempt_tag_prefix(environment)}/123-2",
        tag_target_sha=SHA,
        run_id=123,
        attempt=2,
        repository=REPOSITORY,
        kind=kind,
        environment=environment,
    )

    assert recovered == receipt
    assert digest
    recovered_with_bytes, same_digest, receipt_bytes = decode_tag_message_with_bytes(
        message,
        tag_name=f"{attempt_tag_prefix(environment)}/123-2",
        tag_target_sha=SHA,
        run_id=123,
        attempt=2,
        repository=REPOSITORY,
        kind=kind,
        environment=environment,
    )
    assert recovered_with_bytes == receipt
    assert same_digest == digest
    assert receipt_bytes == raw


def test_tag_cannot_rebind_receipt_to_another_workflow_attempt():
    raw = json.dumps(full_receipt()).encode()
    message = build_tag_message(
        kind="full",
        run_id=123,
        attempt=2,
        repository=REPOSITORY,
        workflow=".github/workflows/deploy-uat.yml",
        target_sha=SHA,
        raw=raw,
    )

    with pytest.raises(InvalidReceipt, match="identity is mismatched"):
        decode_tag_message(
            message,
            tag_name=f"{TAG_PREFIX}/123-1",
            tag_target_sha=SHA,
            run_id=123,
            attempt=1,
            repository=REPOSITORY,
            kind="full",
        )


def test_full_receipt_requires_selected_service_source_to_match_application_sha():
    receipt = full_receipt()
    receipt["release"]["final"]["backend_sha"] = "b" * 40

    with pytest.raises(InvalidReceipt, match="does not match the selected SHA"):
        build_tag_message(
            kind="full",
            run_id=123,
            attempt=2,
            repository=REPOSITORY,
            workflow=".github/workflows/deploy-uat.yml",
            target_sha=SHA,
            raw=json.dumps(receipt).encode(),
        )
