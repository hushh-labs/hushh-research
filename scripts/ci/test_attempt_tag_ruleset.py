#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Regression tests for immutable exact-attempt receipt tag protection."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))

from attempt_tag_ruleset import RulesetError, desired_payload, reconcile  # noqa: E402


POLICY = {"attempt_receipt_tag_ruleset": {
    "name": "immutable deployment attempt receipts",
    "patterns": [
        "refs/tags/deployed/dev-attempt/*",
        "refs/tags/deployed/uat-attempt/*",
    ],
}}


def _verifier_module():
    path = ROOT / "scripts/ci/verify-attempt-tag-ruleset.py"
    spec = importlib.util.spec_from_file_location("verify_attempt_tag_ruleset", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _raises(error_type, message, callback):
    try:
        callback()
    except error_type as exc:
        assert message in str(exc), str(exc)
        return
    raise AssertionError(f"expected {error_type.__name__} containing {message!r}")


def test_policy_blocks_update_and_deletion_but_allows_creation() -> None:
    payload = desired_payload(POLICY)
    assert payload["target"] == "tag"
    assert payload["enforcement"] == "active"
    assert payload["bypass_actors"] == []
    assert payload["rules"] == [{"type": "deletion"}, {"type": "update"}]
    assert not any(rule["type"] == "creation" for rule in payload["rules"])


def test_reconcile_creates_then_verifies_exact_ruleset() -> None:
    writes = []
    summaries = []

    def read(endpoint):
        if endpoint.endswith("?per_page=100"):
            return summaries
        raise AssertionError(f"unexpected read: {endpoint}")

    def write(method, endpoint, payload):
        writes.append((method, endpoint, payload))

    assert reconcile(POLICY, read=read, write=write, apply=False, output=lambda _: None)
    assert writes == []
    assert reconcile(POLICY, read=read, write=write, apply=True, output=lambda _: None)
    assert writes == [("POST", "repos/hushh-labs/hushh-research/rulesets", desired_payload(POLICY))]


def test_reconcile_refuses_duplicate_or_retargeted_named_ruleset() -> None:
    payload = desired_payload(POLICY)
    summary = {"id": 7, "name": payload["name"]}
    _raises(
        RulesetError,
        "multiple rulesets",
        lambda: reconcile(POLICY, read=lambda _: [summary, summary], write=lambda *_: None,
                          apply=False, output=lambda _: None),
    )

    detail = {**payload, "id": 7, "target": "branch"}

    def read(endpoint):
        return [summary] if endpoint.endswith("?per_page=100") else detail

    _raises(
        RulesetError,
        "refusing to retarget",
        lambda: reconcile(POLICY, read=read, write=lambda *_: None, apply=False,
                          output=lambda _: None),
    )

    changed_detail = {**payload, "id": 8}

    def read_changed(endpoint):
        return [summary] if endpoint.endswith("?per_page=100") else changed_detail

    _raises(
        RulesetError,
        "identity changed",
        lambda: reconcile(POLICY, read=read_changed, write=lambda *_: None,
                          apply=False, output=lambda _: None),
    )


def test_live_verifier_requires_active_immutable_exact_ruleset() -> None:
    verifier = _verifier_module()
    payload = {**desired_payload(POLICY), "id": 7}

    def read(endpoint):
        return [payload] if endpoint.endswith("?per_page=100") else payload

    assert verifier.verify(POLICY, read=read) == []
    invalid = {**payload, "bypass_actors": [{"actor_type": "RepositoryRole", "actor_id": 5}]}

    def read_invalid(endpoint):
        return [payload] if endpoint.endswith("?per_page=100") else invalid

    assert "ruleset has one or more bypass actors" in verifier.verify(POLICY, read=read_invalid)
    wrong_identity = {**payload, "name": "other"}

    def read_wrong_identity(endpoint):
        return [payload] if endpoint.endswith("?per_page=100") else wrong_identity

    assert "identity changed" in verifier.verify(POLICY, read=read_wrong_identity)[0]


if __name__ == "__main__":
    for check in (
        test_policy_blocks_update_and_deletion_but_allows_creation,
        test_reconcile_creates_then_verifies_exact_ruleset,
        test_reconcile_refuses_duplicate_or_retargeted_named_ruleset,
        test_live_verifier_requires_active_immutable_exact_ruleset,
    ):
        check()
        print(f"ok {check.__name__}")
