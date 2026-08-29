"""Spend on a pod can be traced back to the person whose agent it is.

WHY THIS EXISTS
`space_id` was plumbed end to end and assigned by nobody. `PodSpec` carried the
field, `PersonalAgentRegistryRepo.upsert` accepted it, migration 900 had the
column, and `gcp_backend` rendered `hussh-space-id` from it -- so every pod hushh
has ever created shipped that label EMPTY. Cost attribution that is fully wired
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
    mint_hushh_id,
    mint_space_id,
)

# The repo's own regex for a legal label VALUE. A value may start with a digit;
# it is the label KEY that must start with a lowercase letter.
_GCP_LABEL_VALUE = re.compile(r"^[a-z0-9_-]{0,63}$")

_PHONES = [f"+1206555{n:04d}" for n in range(200)]


# --------------------------------------------------------------------------- #
# The identifier itself
# --------------------------------------------------------------------------- #


def test_every_minted_space_id_is_a_legal_label_value():
    for phone in _PHONES:
        value = mint_space_id(mint_hushh_id(phone))
        assert _GCP_LABEL_VALUE.match(value), value
        assert len(value) <= 63


def test_space_ids_are_unique_across_a_realistic_population():
    ids = {mint_space_id(mint_hushh_id(p)) for p in _PHONES}
    assert len(ids) == len(_PHONES)


def test_the_same_person_always_gets_the_same_space():
    hid = mint_hushh_id(_PHONES[0])
    assert mint_space_id(hid) == mint_space_id(hid)


def test_the_space_id_discloses_neither_the_hushh_id_nor_the_phone():
    """The whole reason it is derived rather than reused. `_label_value`'s own
    docstring forbids a raw user id from reaching a billing label."""
    phone = _PHONES[0]
    hid = mint_hushh_id(phone)
    space = mint_space_id(hid)
    assert hid.lower() not in space
    assert space.replace("sp_", "") not in hid.lower()
    assert phone.strip("+") not in space


def test_it_cannot_be_cross_derived_from_the_other_two_identifiers():
    """Distinct HMAC contexts, so holding one identifier never yields another."""
    phone = _PHONES[0]
    hid = mint_hushh_id(phone)
    assert mint_space_id(hid) != hash_phone_e164(phone)
    assert mint_space_id(hid) != hid


def test_minting_without_a_subject_refuses_rather_than_returning_a_shared_space():
    """A blank subject would hash to ONE value for everyone, which is worse than
    an empty label: it would look like attribution while pooling every person."""
    with pytest.raises(ValueError):
        mint_space_id("")


# --------------------------------------------------------------------------- #
# The wiring. This is the half that was missing.
# --------------------------------------------------------------------------- #


def test_the_rendered_label_carries_the_minted_space():
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.gcp_backend import GcpBackend

    hid = mint_hushh_id(_PHONES[0])
    space = mint_space_id(hid)
    spec = PodSpec(hushh_id=hid, phone_e164_hash="x", pod_pubkey="", space_id=space)
    config = GcpBackend(project="p", region="us-central1", live=False).render_deploy_config(spec)
    labels = config["metadata"]["labels"]
    assert labels["hussh-space-id"] == space
    assert _GCP_LABEL_VALUE.match(labels["hussh-space-id"])


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
    assert "space_id = mint_space_id(hushh_id)" in src, "provision stopped minting a space id"
    assert "space_id=space_id," in src, "the spec or the row stopped carrying it"
    # Both consumers, named separately: the label makes spend visible, the row
    # makes it joinable, and one without the other attributes nothing.
    assert src.count("space_id=space_id,") >= 2


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
        assert 'space_id=(row or {}).get("space_id")' in src, rel


def test_the_drill_and_the_identity_proof_do_not_create_unattributable_pods():
    """A drill pod bills like any other pod. Leaving these unset would make the
    one slice of the fleet that runs on a schedule the one nobody can account
    for."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    for rel in ("scripts/ops/pod_lifecycle_drill.py", "scripts/ops/prove_identity.py"):
        assert "space_id=mint_space_id(hushh_id)" in (root / rel).read_text(), rel
