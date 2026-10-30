"""An image already installed does not imply its broader Browser policy is approved."""

import json
from copy import deepcopy

import pytest

from hushh_mcp.services.pod_browser.capability_update import plan_from_observation
from hushh_mcp.services.pod_browser.execution_authority import PublicResearchPolicy
from hushh_mcp.services.pod_browser.update_offer import browser_review_available
from tests.helpers.pod_browser_capability import (
    azure_browser_capability_fixture,
    browser_capability_fixture,
)


def configured(provider, monkeypatch):
    row, image, service, qualification, release = browser_capability_fixture()
    plan = plan_from_observation(row, image, service, qualification)
    if provider == "azure":
        monkeypatch.setenv(
            "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
        )
        row, image, _, qualification, plan, *_ = azure_browser_capability_fixture()
    row["backend_metadata"].update(
        image_digest=image.rsplit("@", 1)[-1],
        browserCapability={"status": "configured", "planDigest": plan.digest},
        upgradeApproval={
            "version": 2,
            "capability": "browser",
            "status": "succeeded",
            "ownerId": plan.ownerId,
            "hushhId": plan.hushhId,
            "podIncarnation": plan.serviceUid,
            "targetImage": image,
            "browserPlan": plan.model_dump(mode="json"),
            "browserPlanDigest": plan.digest,
        },
    )
    release.update(image=image, browserQualifications=[qualification])
    return row, image, qualification, release


@pytest.mark.parametrize("provider", ["gcp", "azure"])
def test_same_image_changed_policy_is_reviewable_without_approving_it(monkeypatch, provider):
    monkeypatch.setenv("HUSSH_POD_BROWSER_ENABLED", "true")
    row, image, qualification, release = configured(provider, monkeypatch)
    before = deepcopy(row)
    assert not browser_review_available(row, image, release)
    changed = deepcopy(qualification)
    changed["public_policy"]["interactive_origins"] = ["https://account.example.com"]
    changed["public_policy_sha256"] = PublicResearchPolicy.model_validate_json(
        json.dumps(changed["public_policy"])
    ).digest
    release["browserQualifications"] = [changed]
    assert browser_review_available(row, image, release)
    assert row == before, "Discovery cannot approve or modify installed scope"
    # No unverifiable image-only marker can stand in for exact approved terms.
    row["backend_metadata"].pop("upgradeApproval")
    assert browser_review_available(row, image, release)


@pytest.mark.parametrize("provider", ["gcp", "azure"])
@pytest.mark.parametrize("interlock", ["lease", "erasure", "pending-approval", "disabled"])
def test_changed_same_image_policy_retains_existing_lifecycle_interlocks(
    monkeypatch, provider, interlock
):
    monkeypatch.setenv("HUSSH_POD_BROWSER_ENABLED", "true")
    row, image, _, release = configured(provider, monkeypatch)
    row["backend_metadata"].pop("upgradeApproval")
    if interlock == "lease":
        row["backend_metadata"]["upgradeLease"] = "held"
    elif interlock == "erasure":
        row["backend_metadata"]["erasure"] = {}
    elif interlock == "pending-approval":
        row["backend_metadata"]["upgradeApproval"] = {"status": "scheduled"}
    else:
        monkeypatch.delenv("HUSSH_POD_BROWSER_ENABLED")
    assert not browser_review_available(row, image, release)
