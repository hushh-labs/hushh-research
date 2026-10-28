"""Hosted isolated acceptance and joined security-receipt trust boundaries."""

import importlib
from pathlib import Path

import pytest

from tests.helpers.plg_qualification import HostedAcceptance

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_hosted_isolated_acceptance_has_distinct_type_and_source_consumer(monkeypatch, environment):
    hosted = HostedAcceptance(monkeypatch)
    accepted = hosted.module.verify(environment, hosted.runs[environment], github=hosted)
    assert isinstance(accepted, hosted.module.IsolatedAcceptance)
    assert accepted.pin()["sharedEnvironmentAccepted"] is False
    assert accepted.pin()["productionTrafficAuthorized"] is False
    assert hosted.source_calls == [31] * (2 if environment == "uat" else 1)


@pytest.mark.parametrize(
    "case",
    [
        "ordinary-artifact",
        "shared",
        "fork",
        "skipped",
        "source",
        "authority",
        "digest",
        "build",
        "rerun",
        "schema",
        "runtime-privileges",
        "iam",
        "capacity",
        "health",
        "worker-count",
        "worker-default",
        "market-refresh",
        "market-default",
        "revision-labels",
        "stale",
    ],
)
def test_hosted_consumer_refuses_untrusted_or_unjoined_evidence(monkeypatch, case):
    hosted = HostedAcceptance(monkeypatch)
    hosted.break_evidence(case)
    with pytest.raises(ValueError):
        hosted.module.verify("dev", 17, github=hosted)


@pytest.mark.parametrize("case", ["uat-rebuild", "uat-image", "uat-shared", "rerun"])
def test_uat_requires_the_exact_latest_isolated_dev_artifact_and_bytes(monkeypatch, case):
    hosted = HostedAcceptance(monkeypatch)
    hosted.break_evidence(case)
    with pytest.raises(ValueError):
        hosted.module.verify("uat", 18, github=hosted)


@pytest.mark.parametrize("changed", ["hosted", "working"])
def test_isolated_authority_binds_both_definitions(monkeypatch, tmp_path, changed):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    module = importlib.import_module("qualification_acceptance")
    monkeypatch.setattr(module, "AUTHORITY_PATHS", ("definition",))
    monkeypatch.setattr(module.validation, "ROOT", tmp_path)
    (tmp_path / "definition").write_text("changed" if changed == "working" else "reviewed")

    def git(*args):
        return b"changed" if changed == "hosted" and args[-1].startswith("a" * 40) else b"reviewed"

    monkeypatch.setattr(module.validation.authority, "_git", git)
    with pytest.raises(ValueError):
        module.reviewed_definitions("a" * 40, "dev")
