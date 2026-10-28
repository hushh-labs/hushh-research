"""Caller proposals do not authorize hosted or cloud operations."""

import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
sys.path.insert(0, str(ROOT / "consent-protocol/tests"))
import frontend_hosted_caller as caller  # noqa: E402
import test_plg_frontend_build_evidence as build_fixture  # noqa: E402
import test_plg_frontend_secret_pins as pins_fixture  # noqa: E402


def fixture(monkeypatch):
    build_args = build_fixture.fixture(monkeypatch)
    attempt, prepared, recipe = build_args[:3]
    original_recipe, original_overlays = build_args[-2:]
    inventory = pins_fixture.inventory("uat")
    snapshot = {
        "environment": "uat",
        "project": attempt.project,
        "inventory": inventory,
        "optionalLatestUnresolved": sorted(
            name for name, value in inventory.items() if value is None
        ),
        "snapshotAtomic": False,
        "buildConsumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
    return attempt, prepared, snapshot, recipe, original_recipe, original_overlays


def test_intent_has_no_provider_hosted_or_fence_authority(monkeypatch):
    args = fixture(monkeypatch)
    attempt = args[0]
    intent = caller.proposed_build_intent(*args)
    assert intent["imageTag"] == attempt.tag
    assert not any(
        intent[key]
        for key in (
            "artifactPublished",
            "hostedVerified",
            "providerVerified",
            "durableFenceVerified",
            "maySubmit",
        )
    )
    with pytest.raises(caller.release.Refused, match="Fixture hosted context"):
        caller.authorize_submission(intent, lambda: pytest.fail("must not call supplied callback"))


def test_bound_intent_rederives_exact_recipe_without_authorizing(monkeypatch):
    build_args = build_fixture.bind_fixture(build_fixture.fixture(monkeypatch))
    attempt, prepared, recipe = build_args[:3]
    inventory = pins_fixture.inventory("uat", fixture_backend=True)
    snapshot = {
        "environment": "uat",
        "project": attempt.project,
        "inventory": inventory,
        "fixtureBackend": True,
        "optionalLatestUnresolved": sorted(
            name for name, value in inventory.items() if value is None
        ),
        "snapshotAtomic": False,
        "buildConsumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
    args = (attempt, prepared, snapshot, recipe, build_args[-2], build_args[-1])
    result = caller.proposed_build_intent(*args)
    assert (
        result["backendTargetBound"]
        and not result["backendTargetVerified"]
        and not result["maySubmit"]
    )
    prepared["backendPair"]["candidateUrl"] = "https://wrong.example.run.app"
    with pytest.raises(caller.release.Refused):
        caller.proposed_build_intent(*args)


@pytest.mark.parametrize(
    "case",
    [
        "version",
        "environment",
        "attempt",
        "archive",
        "authority_claim",
        "unresolved",
        "missing_validation",
        "missing_workflow",
        "derived_recipe",
        "incomplete_validation",
        "bad_authority_hash",
    ],
)
def test_mismatched_proposed_intent_is_refused(monkeypatch, case):
    attempt, prepared, snapshot, recipe, original_recipe, original_overlays = fixture(monkeypatch)
    prepared, snapshot = copy.deepcopy(prepared), copy.deepcopy(snapshot)
    if case == "version":
        snapshot["inventory"]["BACKEND_URL"]["name"] = (
            "projects/hushh-pda-uat/secrets/BACKEND_URL/versions/4"
        )
    elif case == "environment":
        snapshot["project"] = "hushh-pda-dev"
    elif case == "attempt":
        prepared["runAttempt"] = "3"
    elif case == "archive":
        prepared["archive"]["sourceSha"] = "a" * 40
    elif case == "authority_claim":
        snapshot["snapshotAtomic"] = True
    elif case == "unresolved":
        snapshot["optionalLatestUnresolved"] = []
    elif case == "missing_validation":
        del prepared["sourceValidation"]
    elif case == "missing_workflow":
        del prepared["authorityFiles"][caller.release.WORKFLOWS["uat"]]
    elif case == "derived_recipe":
        recipe = b"wrong recipe"
    elif case == "incomplete_validation":
        del prepared["sourceValidation"]["artifactDigest"]
    else:
        prepared["authorityFiles"][caller.release.WORKFLOWS["uat"]] = "not-a-hash"
    with pytest.raises(caller.release.Refused):
        caller.proposed_build_intent(
            attempt, prepared, snapshot, recipe, original_recipe, original_overlays
        )
