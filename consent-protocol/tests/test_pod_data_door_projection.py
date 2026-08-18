"""The data door is read-only by construction and its projection fails closed.

Phase 5 lets a keyless pod READ a DB-backed specialist by asking the hub to run
the read and return a projection. The whole security of that hinges on two
things this file pins as executable invariants rather than prose:

  * the door has no write path, and its registry is keyed on a specialist NAME
    that maps to fixed read-only code (not a scope, which could not separate a
    location read from a location write -- they share one scope); and
  * the projection is an ALLOWLIST, so a field added to the underlying service
    later -- above all the owner's wrapped private key -- is dropped by omission,
    never carried by default.

The wrapped-private-key test is the one that matters most: it is the field whose
crossing to a keyless pod would break Zero Knowledge.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_data_door as door


def _full_list_state() -> dict:
    """A list_state payload with every sensitive field the real service emits,
    so the projection is tested against what it must actually drop."""
    return {
        "recipients": [
            {
                "userId": "u-friend",
                "displayName": "Sarah Chen",
                "maskedEmail": "s***@example.com",
                "maskedPhone": "+1******89",
                "phoneVerified": True,
                "keyId": "k-1",
                "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "pub"},
                "keyAlgorithm": "ECDH-P256-AES256-GCM",
                "keyRegisteredAt": "2026-01-01T00:00:00+00:00",
                "canReceiveLocation": True,
            }
        ],
        "circles": [{"id": "c-1", "name": "Family"}],
        "myRecipientKey": {
            "keyId": "k-owner",
            "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "ownerpub"},
            "keyAlgorithm": "ECDH-P256-AES256-GCM",
            "encryptedPrivateKeyJwk": {"ciphertext": "THE-OWNERS-WRAPPED-PRIVATE-KEY"},
            "keyRegisteredAt": "2026-01-01T00:00:00+00:00",
        },
        "ownerGrants": [
            {
                "id": "g-1",
                "ownerUserId": "u-owner",
                "recipientUserId": "u-friend",
                "ownerMaskedPhone": "+1******11",
                "recipientMaskedPhone": "+1******89",
                "status": "active",
                "consentScope": "cap.location.live.view",
                "expiresAt": "2026-01-02T00:00:00+00:00",
                "latestEnvelopeId": "env-secret-abc",
            }
        ],
        "receivedGrants": [],
        "requests": [{"id": "r-1"}],
        "capabilityScopes": ["cap.location.live.view"],
    }


def test_the_owners_wrapped_private_key_never_crosses_the_door() -> None:
    projected = door.project_location_state(_full_list_state())
    blob = repr(projected)
    assert "THE-OWNERS-WRAPPED-PRIVATE-KEY" not in blob
    assert "encryptedPrivateKeyJwk" not in blob
    # The public half is still there -- it is public.
    assert projected["myRecipientKey"]["publicKeyJwk"]["x"] == "ownerpub"
    assert projected["myRecipientKey"]["keyId"] == "k-owner"


def test_masked_phone_and_email_joins_are_dropped() -> None:
    projected = door.project_location_state(_full_list_state())
    blob = repr(projected)
    assert "maskedPhone" not in blob
    assert "maskedEmail" not in blob
    assert "ownerMaskedPhone" not in blob
    assert "recipientMaskedPhone" not in blob


def test_ciphertext_envelope_id_is_not_enumerated() -> None:
    projected = door.project_location_state(_full_list_state())
    assert "env-secret-abc" not in repr(projected)


def test_projection_is_an_allowlist_a_new_field_is_dropped_by_default() -> None:
    """The fail-closed guarantee: a field the service adds tomorrow -- modelled
    here as a brand-new wrapped key on a recipient -- is dropped because it is
    not on the keep-list, without this module being touched."""
    raw = _full_list_state()
    raw["recipients"][0]["encryptedSomethingNew"] = {"secret": "leaked-if-denylist"}
    raw["someBrandNewTopLevelSection"] = [{"secret": "also-leaked-if-denylist"}]
    projected = door.project_location_state(raw)
    blob = repr(projected)
    assert "leaked-if-denylist" not in blob
    assert "also-leaked-if-denylist" not in blob
    assert "someBrandNewTopLevelSection" not in projected


def test_the_recipient_fields_a_location_answer_needs_survive() -> None:
    projected = door.project_location_state(_full_list_state())
    rec = projected["recipients"][0]
    assert rec["displayName"] == "Sarah Chen"
    assert rec["canReceiveLocation"] is True
    assert rec["userId"] == "u-friend"


def test_the_registry_holds_no_write_path() -> None:
    """Read-only by construction: every registered door is a PodDataDoorRead with
    a projection, and the module exposes no write/mutate entrypoint at all."""
    for name, spec in door.POD_DATA_DOOR_READS.items():
        assert isinstance(spec, door.PodDataDoorRead)
        assert spec.name == name
        assert callable(spec.project)
    # There is no write registry, mutate function, or verb-taking reader.
    assert not hasattr(door, "POD_DATA_DOOR_WRITES")
    assert not any("write" in n.lower() or "mutate" in n.lower() for n in door.__all__)


def test_an_unregistered_name_refuses_rather_than_reading_something_adjacent() -> None:
    with pytest.raises(KeyError):
        door.run_pod_data_door_read("vault", owner_id="u-owner")


def test_the_reader_receives_the_authenticated_owner_not_a_pod_value(monkeypatch) -> None:
    """``owner_id`` threaded to the read is the broker's authenticated owner. The
    read function must be called with exactly that id."""
    seen: dict = {}

    def _fake_read(owner_id: str) -> dict:
        seen["owner_id"] = owner_id
        return _full_list_state()

    monkeypatch.setitem(door._READERS, "location", _fake_read)
    door.run_pod_data_door_read("location", owner_id="u-owner-authenticated")
    assert seen["owner_id"] == "u-owner-authenticated"


def test_the_flag_defaults_off_which_is_the_security_position(monkeypatch) -> None:
    from hushh_mcp import runtime_settings

    monkeypatch.delenv("POD_DATA_DOOR_ENABLED", raising=False)
    assert runtime_settings.pod_data_door_enabled() is False
