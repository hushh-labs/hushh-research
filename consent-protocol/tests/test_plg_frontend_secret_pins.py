"""Synthetic proposed pins cannot establish provider or build acceptance."""

import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
import frontend_secret_pins as pins  # noqa: E402


def inventory(environment, *, fixture_backend=False):
    required, optional = pins.catalog(environment, fixture_backend=fixture_backend)
    project = pins.release.TARGETS[environment]
    return {
        name: {"name": f"projects/{project}/secrets/{name}/versions/3", "state": "ENABLED"}
        if name in required
        else None
        for name in required | optional
    }


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_inventory_is_exact_and_never_grants_authority(environment):
    result = pins.validate_inventory(environment, inventory(environment))
    assert result["project"] == pins.release.TARGETS[environment]
    assert all(
        result[name] is False
        for name in (
            "providerVerified",
            "consumptionVerified",
            "environmentAccepted",
            "productionTrafficAuthorized",
        )
    )


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "extra",
        "required_absent",
        "latest",
        "wrong_project",
        "wrong_secret",
        "disabled",
        "extra_field",
        "zero",
    ],
)
def test_unverified_inventory_refused(case):
    data = inventory("uat")
    name = "BACKEND_URL"
    if case == "missing":
        del data[name]
    elif case == "extra":
        data["unreviewed"] = None
    elif case == "required_absent":
        data[name] = None
    elif case == "latest":
        data[name]["name"] = data[name]["name"].replace("/3", "/latest")
    elif case == "wrong_project":
        data[name]["name"] = data[name]["name"].replace("hushh-pda-uat", "hushh-pda-dev")
    elif case == "wrong_secret":
        data[name]["name"] = data[name]["name"].replace(name, "APP_FRONTEND_ORIGIN")
    elif case == "disabled":
        data[name]["state"] = "DISABLED"
    elif case == "extra_field":
        data[name]["value"] = "unexpected"
    else:
        data[name]["name"] = data[name]["name"].replace("/3", "/0")
    with pytest.raises(pins.release.Refused):
        pins.validate_inventory("uat", data)


def test_uat_contacts_is_required_and_native_dev_pins_do_not_leak_between_environments():
    dev = inventory("dev")
    uat = inventory("uat")
    assert dev[pins.CONTACTS] is None
    uat[pins.CONTACTS] = None
    with pytest.raises(pins.release.Refused):
        pins.validate_inventory("uat", uat)
    wrong = copy.deepcopy(dev)
    wrong[pins.RECEIPT] = None
    with pytest.raises(pins.release.Refused):
        pins.validate_inventory("dev", wrong)


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_fixture_inventory_requires_only_separate_backend_secret(environment):
    proposed = inventory(environment, fixture_backend=True)
    assert pins.FIXTURE_BACKEND in proposed and "BACKEND_URL" not in proposed
    result = pins.validate_inventory(environment, proposed, fixture_backend=True)
    assert result["versions"][pins.FIXTURE_BACKEND].endswith("/versions/3")
    with pytest.raises(pins.release.Refused):
        pins.validate_inventory(environment, proposed)
