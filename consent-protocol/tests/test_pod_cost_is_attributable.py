"""Spend on a pod can be traced back to the person whose agent it is.

WHY THIS EXISTS
The opaque cost-attribution id (`billing_space_id`) was plumbed end to end and
assigned by nobody. `PodSpec` carried the field, `PersonalAgentRegistryRepo.upsert`
accepted it, migration 900 had a column, and `gcp_backend` rendered the label from
it -- so every pod hushh has ever created shipped that label EMPTY. (It was called
`space_id` then; that name now belongs to the owner's handle, and the opaque id is
`billing_space_id`, which is what this file guards.) Cost attribution that is fully wired
and reached by no caller is this programme's signature defect, and the existing
cost-label test could never have caught it: it builds its own specs, so it only
ever proved the renderer works on a value somebody hands it.

The two properties, kept separate on purpose:
  1. the minted id is OPAQUE and GCP-legal, because a label is readable by anyone
     with project billing access;
  2. the provisioning path actually assigns it, AND writes the same value to the
     registry row, because a label nobody can join back to an account attributes
     spend to a string rather than to a person.
"""

from __future__ import annotations

import re

import pytest

from hushh_mcp.services.personal_agent_identity_service import (
    hash_phone_e164,
    is_valid_space_handle,
    mint_billing_space_id,
    mint_hushh_id,
)

# The repo's own regex for a legal label VALUE. A value may start with a digit;
# it is the label KEY that must start with a lowercase letter.
_GCP_LABEL_VALUE = re.compile(r"^[a-z0-9_-]{0,63}$")

_PHONES = [f"+1206555{n:04d}" for n in range(200)]


# --------------------------------------------------------------------------- #
# The identifier itself
# --------------------------------------------------------------------------- #


def test_every_minted_billing_space_id_is_a_legal_label_value():
    for phone in _PHONES:
        value = mint_billing_space_id(mint_hushh_id(phone))
        assert _GCP_LABEL_VALUE.match(value), value
        assert len(value) <= 63


def test_billing_space_ids_are_unique_across_a_realistic_population():
    ids = {mint_billing_space_id(mint_hushh_id(p)) for p in _PHONES}
    assert len(ids) == len(_PHONES)


def test_the_same_person_always_gets_the_same_space():
    hid = mint_hushh_id(_PHONES[0])
    assert mint_billing_space_id(hid) == mint_billing_space_id(hid)


def test_the_billing_space_id_discloses_neither_the_hushh_id_nor_the_phone():
    """The whole reason it is derived rather than reused. `_label_value`'s own
    docstring forbids a raw user id from reaching a billing label."""
    phone = _PHONES[0]
    hid = mint_hushh_id(phone)
    space = mint_billing_space_id(hid)
    assert hid.lower() not in space
    assert space.replace("bsp_", "") not in hid.lower()
    assert phone.strip("+") not in space


def test_it_cannot_be_cross_derived_from_the_other_two_identifiers():
    """Distinct HMAC contexts, so holding one identifier never yields another."""
    phone = _PHONES[0]
    hid = mint_hushh_id(phone)
    assert mint_billing_space_id(hid) != hash_phone_e164(phone)
    assert mint_billing_space_id(hid) != hid


def test_minting_without_a_subject_refuses_rather_than_returning_a_shared_space():
    """A blank subject would hash to ONE value for everyone, which is worse than
    an empty label: it would look like attribution while pooling every person."""
    with pytest.raises(ValueError):
        mint_billing_space_id("")


# --------------------------------------------------------------------------- #
# The wiring. This is the half that was missing.
# --------------------------------------------------------------------------- #


def test_the_rendered_label_carries_the_minted_space():
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.gcp_backend import GcpBackend

    hid = mint_hushh_id(_PHONES[0])
    space = mint_billing_space_id(hid)
    spec = PodSpec(hushh_id=hid, phone_e164_hash="x", pod_pubkey="", billing_space_id=space)
    config = GcpBackend(project="p", region="us-central1", live=False).render_deploy_config(spec)
    labels = config["metadata"]["labels"]
    assert labels["hussh-billing-space"] == space
    assert _GCP_LABEL_VALUE.match(labels["hussh-billing-space"])


def test_the_provision_path_assigns_a_space_and_records_it_on_the_row():
    """THE test that would have caught the defect. The cost-label test constructs
    its own spec, so it can only prove the renderer works; nothing anywhere
    asserted that a real provision puts a value into the field."""
    import pathlib

    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "hushh_mcp"
        / "services"
        / "personal_agent_provisioning_service.py"
    ).read_text()
    assert "billing_space_id = mint_billing_space_id(hushh_id)" in src, (
        "provision stopped minting the billing id"
    )
    assert "billing_space_id=billing_space_id," in src, "the spec or the row stopped carrying it"
    # Both consumers, named separately: the label makes spend visible, the row
    # makes it joinable, and one without the other attributes nothing.
    assert src.count("billing_space_id=billing_space_id,") >= 2


def test_the_lifecycle_paths_read_the_space_off_the_row_rather_than_re_deriving_it():
    """The derivation is keyed by APP_SIGNING_KEY. Re-deriving at read time means
    a key rotation silently unmatches every historical pod from its own spend, so
    the row is the authority everywhere after provision."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    for rel in (
        "hushh_mcp/services/personal_agent_provisioning_service.py",
        "api/routes/one/pod_wake.py",
    ):
        src = (root / rel).read_text()
        assert 'billing_space_id=(row or {}).get("billing_space_id")' in src, rel


def test_the_drill_and_the_identity_proof_do_not_create_unattributable_pods():
    """A drill pod bills like any other pod. Leaving these unset would make the
    one slice of the fleet that runs on a schedule the one nobody can account
    for."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    for rel in ("scripts/ops/pod_lifecycle_drill.py", "scripts/ops/prove_identity.py"):
        assert "billing_space_id=mint_billing_space_id(hushh_id)" in (root / rel).read_text(), rel


# --------------------------------------------------------------------------- #
# The handle and the billing id are two different things
# --------------------------------------------------------------------------- #
#
# This is the property the whole rename exists to protect: the owner's chosen
# spaceID handle must NEVER become the opaque billing id, and must NEVER reach a
# cloud label. Conflating them is the drift that shipped a user-facing concept as
# a billing token.


def test_a_handle_and_the_billing_id_are_never_the_same_string():
    hid = mint_hushh_id(_PHONES[0])
    billing = mint_billing_space_id(hid)
    # A plausible handle a person might pick.
    for handle in ("Kushal's Agent", "my space", "home-pod", "Agent One"):
        ok, _ = is_valid_space_handle(handle)
        assert ok, handle
        assert handle != billing
        # The billing id is opaque with the bsp_ prefix; a human handle is not.
        assert not handle.startswith("bsp_")


def test_the_billing_id_is_prefixed_so_it_cannot_be_mistaken_for_a_handle():
    billing = mint_billing_space_id(mint_hushh_id(_PHONES[0]))
    assert billing.startswith("bsp_")


def test_the_handle_validator_rejects_what_must_not_be_stored():
    for bad in ("", "   ", "a" * 49, "/etc/passwd", "space\nname", "<script>"):
        ok, reason = is_valid_space_handle(bad)
        assert not ok, bad
        assert reason


def test_the_registry_carries_both_columns_as_distinct_fields():
    """The repo must accept the handle and the billing id as SEPARATE kwargs, or
    the two would collapse back into one and the drift returns."""
    import inspect

    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    params = inspect.signature(PersonalAgentRegistryRepo.upsert).parameters
    assert "space_id" in params
    assert "billing_space_id" in params


def test_provisioning_never_writes_a_handle_as_the_billing_id():
    """Provisioning mints the billing id; it must not set the handle at all (the
    owner names their space through the space-name path). If provisioning started
    writing space_id, a machine-minted token could land where a human name goes."""
    import pathlib

    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "hushh_mcp"
        / "services"
        / "personal_agent_provisioning_service.py"
    ).read_text()
    assert "billing_space_id = mint_billing_space_id(hushh_id)" in src
    # The bare `space_id=` handle kwarg must not be written at provision.
    assert "space_id=space_id," not in src
