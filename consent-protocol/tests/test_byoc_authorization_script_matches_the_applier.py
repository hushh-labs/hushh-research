"""The script a customer runs must grant exactly what the applier needs -- no more.

Two lists, two files, one truth. `deploy/iam/authorize_byoc_project.sh` is what a
person runs in THEIR project; `user_gcp_bootstrap.py` is what hushh then does with the
access. If the script grants less, provisioning fails partway through someone's own
cloud with an error that names none of it. If it grants more, hushh asked a customer
for authority it does not use -- which is worse, because nothing will ever fail to
reveal it.

Neither list can be checked by reading one file, which is why this test exists rather
than a comment asking people to keep them in sync.
"""

from __future__ import annotations

import re
from pathlib import Path

from hushh_mcp.services.user_gcp_bootstrap import BOOTSTRAP_ROLES, REQUIRED_SERVICES

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "iam" / "authorize_byoc_project.sh"


def _bash_array(name: str) -> list[str]:
    text = SCRIPT.read_text(encoding="utf-8")
    block = re.search(rf"readonly -a {name}=\((.*?)\n\)", text, re.S)
    assert block, f"{name} is not declared in {SCRIPT.name}"
    return re.findall(r'"([^"]+)"', block.group(1))


def test_the_script_grants_exactly_the_roles_the_applier_uses():
    """Set equality in both directions, deliberately.

    A missing role is a half-authorized project. An EXTRA role is a customer granting
    hushh authority nothing exercises -- and no failure will ever surface that, so the
    only thing that can is this assertion.
    """
    assert set(_bash_array("BOOTSTRAP_ROLES")) == {role for role, _why in BOOTSTRAP_ROLES}


def test_the_script_enables_exactly_the_services_the_applier_needs():
    assert set(_bash_array("REQUIRED_SERVICES")) == set(REQUIRED_SERVICES)


def test_the_script_never_creates_a_key_and_refuses_to_pass_if_one_exists():
    """The credential model is the product promise, not an implementation detail."""
    text = SCRIPT.read_text(encoding="utf-8")
    assert "keys create" not in text, "the script would mint a long-lived credential"
    assert "keys list" in text and "--managed-by=user" in text, (
        "the script does not check for user-managed keys, so someone creating one "
        "'just to make it work' would go unnoticed"
    )


def test_the_script_tells_the_person_how_to_revoke():
    """Access nobody knows how to withdraw is not consent."""
    text = SCRIPT.read_text(encoding="utf-8")
    assert "remove-iam-policy-binding" in text
    assert "roles/iam.serviceAccountTokenCreator" in text


def test_the_script_reads_its_work_back():
    """Asking gcloud to bind a role is not evidence the role is bound."""
    text = SCRIPT.read_text(encoding="utf-8")
    for readback in ("services list --enabled", "get-iam-policy"):
        assert readback in text, f"no verification step reads back {readback}"
