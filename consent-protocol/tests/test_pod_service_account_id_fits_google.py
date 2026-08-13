"""A BYOC pod's service account must be creatable for a REAL person, not a test fixture.

THE DEFECT

`accountId` in Google's `CreateServiceAccountRequest` is documented as 6-30 characters
and the IAM API answers 400 outside it. A real HusshID is `"ha1_"` + base32(20 bytes) =
36 characters; `_slug` caps at 40 so nothing is trimmed; `"one-pod-" + slug` = **44**.
Over the limit by 14, for every real person who has ever existed.

WHY NOTHING CAUGHT IT

Every test and the one live BYOC run used a short synthetic id:

    HA1BYOC0000001    -> one-pod-ha1byoc0000001     (22)  fits
    HA1ABC234DEF      -> one-pod-ha1abc234def       (20)  fits
    ha1byocjourney01  -> one-pod-ha1byocjourney01   (24)  fits

So the suite was green against a constraint no production id can satisfy, and the
substrate applier's `pod_service_account` step could only ever 400 -- three steps into
a person's onboarding, in their own cloud, with the cause 40 characters away.

That is why the first assertion below mints an id through the REAL
`mint_hushh_id` rather than writing one down. A fixture is exactly what hid this.
"""

from __future__ import annotations

import re

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.personal_agent_identity_service import mint_hushh_id
from hushh_mcp.services.user_gcp_backend import UserGcpBackend, pod_service_account_id

# Google's rule, transcribed once: 6-30 chars, lowercase alphanumeric or hyphen,
# must start with a letter, must not end with a hyphen.
GOOGLE_ACCOUNT_ID = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


def _real_ids(count: int = 25) -> list[str]:
    """Ids minted the way production mints them, not written down here."""
    return [mint_hushh_id(phone_e164=f"+1555{i:07d}", generation=0) for i in range(count)]


def test_a_real_hushh_id_produces_a_creatable_account():
    """THE assertion. If this fails, BYO GCP is unreachable for everyone."""
    for hushh_id in _real_ids():
        account = pod_service_account_id(hushh_id)
        assert len(account) <= 30, (
            f"{hushh_id} -> {account} is {len(account)} chars. Google refuses an "
            "accountId over 30, so the pod_service_account bootstrap step returns 400 "
            "and this person can never be provisioned into their own project."
        )
        assert GOOGLE_ACCOUNT_ID.match(account), f"{account} is not a legal accountId"


def test_the_derived_name_is_unique_per_person():
    """Teardown and drift recompute this name rather than looking it up.

    Two people deriving the same account would mean one person's pod running as the
    other's identity -- the isolation boundary, lost to a truncation.
    """
    ids = _real_ids(200)
    accounts = [pod_service_account_id(i) for i in ids]
    assert len(set(accounts)) == len(accounts), "two HusshIDs derived one account"


def test_it_is_deterministic():
    hushh_id = _real_ids(1)[0]
    assert pod_service_account_id(hushh_id) == pod_service_account_id(hushh_id)


def test_ids_that_already_fit_are_returned_unchanged():
    """No existing resource is renamed by this fix.

    `one-pod-ha1byocjourney01` exists in hushh-byoc-test from the 2026-08-11 run. A
    change that renamed it would orphan a real service account in someone's project --
    which hushh cannot delete unilaterally, by design.
    """
    assert pod_service_account_id("ha1byocjourney01") == "one-pod-ha1byocjourney01"
    assert pod_service_account_id("HA1ABC234DEF") == "one-pod-ha1abc234def"


def test_the_rendered_pod_and_the_bootstrap_plan_name_the_same_account():
    """Two construction sites, one name -- or the pod runs as an identity the
    substrate never created."""
    hushh_id = _real_ids(1)[0]
    spec = PodSpec(hushh_id=hushh_id, phone_e164_hash="h", pod_pubkey="k")
    backend = UserGcpBackend(user_project="user-proj", image="img")

    rendered = backend.render_deploy_config(spec)["spec"]["template"]["spec"]["serviceAccountName"]
    planned = next(
        r["id"]
        for r in backend.render_bootstrap_plan(spec)["resources"]
        if r["type"] == "service_account"
    )
    assert rendered == planned, (
        f"the pod would run as {rendered} while the bootstrap creates {planned}"
    )
    # And the applier splits this on '@' to get the accountId it POSTs.
    assert len(planned.split("@")[0]) <= 30
