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
                # A recipient's public JWK that WRONGLY carries a private scalar.
                "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "pub", "d": "LEAK-1"},
                "keyAlgorithm": "ECDH-P256-AES256-GCM",
                "keyRegisteredAt": "2026-01-01T00:00:00+00:00",
                "canReceiveLocation": True,
            }
        ],
        "circles": [
            {
                "id": "c-1",
                "name": "Family",
                "kind": "family",
                "role": "owner",
                "memberCount": 3,
                # A future member list carrying keys + verified flags must NOT ride
                # through the door via a wholesale circle passthrough.
                "members": [
                    {
                        "displayName": "Sarah",
                        "phone_verified": True,
                        "publicKeyJwk": {"d": "LEAK-M"},
                    }
                ],
            }
        ],
        "myRecipientKey": {
            "keyId": "k-owner",
            # The owner's own public JWK, likewise WRONGLY carrying the private
            # member -- the sharpest case, since it is the owner's own key.
            "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "ownerpub", "d": "OWNER-PRIVATE-D"},
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
        "publicInvites": [
            {
                "id": "pi-1",
                "ownerUserId": "u-owner",
                "status": "active",
                "durationHours": 2.0,
                "expiresAt": "2026-01-02T00:00:00+00:00",
                "ownerLabel": "Alex",
                "locationAvailable": True,
            }
        ],
        "requests": [
            {
                "id": "req-1",
                "ownerUserId": "u-owner",
                "requesterUserId": "u-stranger",
                "requesterDisplayName": "Jordan",
                "requesterMaskedPhone": "+1******77",
                "status": "pending",
                "message": "can I see your location?",
            }
        ],
        # A structured entry alongside the real scope: it must not ride through.
        "capabilityScopes": ["cap.location.live.view", {"sneaky": "object"}],
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


async def test_an_unregistered_name_refuses_rather_than_reading_something_adjacent() -> None:
    with pytest.raises(KeyError):
        await door.run_pod_data_door_read("vault", owner_id="u-owner")


async def test_the_reader_receives_the_authenticated_owner_not_a_pod_value(monkeypatch) -> None:
    """``owner_id`` threaded to the read is the broker's authenticated owner. The
    read function must be called with exactly that id. Readers are async now (an
    OAuth-backed door awaits network I/O), so the double is async too."""
    seen: dict = {}

    async def _fake_read(owner_id: str) -> dict:
        seen["owner_id"] = owner_id
        return _full_list_state()

    monkeypatch.setitem(door._READERS, "location", _fake_read)
    await door.run_pod_data_door_read("location", owner_id="u-owner-authenticated")
    assert seen["owner_id"] == "u-owner-authenticated"


def test_the_flag_defaults_off_which_is_the_security_position(monkeypatch) -> None:
    from hushh_mcp import runtime_settings

    monkeypatch.delenv("POD_DATA_DOOR_ENABLED", raising=False)
    assert runtime_settings.pod_data_door_enabled() is False


# --- hardening the projection at the VALUE level (adversarial review findings) ---


def test_a_private_jwk_member_never_crosses_even_inside_a_kept_public_key() -> None:
    """Finding 1: publicKeyJwk is a kept KEY, but its value is re-projected through
    a member allowlist, so a private scalar 'd' wrongly present inside it -- on the
    owner's key OR a recipient's -- is dropped. A key keep-list alone would copy it."""
    projected = door.project_location_state(_full_list_state())
    blob = repr(projected)
    assert "OWNER-PRIVATE-D" not in blob
    assert "LEAK-1" not in blob
    assert "LEAK-M" not in blob
    assert '"d"' not in blob and "'d'" not in blob
    # The public members are preserved so the key is still usable.
    assert projected["myRecipientKey"]["publicKeyJwk"] == {
        "kty": "EC",
        "crv": "P-256",
        "x": "ownerpub",
    }
    assert projected["recipients"][0]["publicKeyJwk"] == {"kty": "EC", "crv": "P-256", "x": "pub"}


def test_a_circle_member_list_is_dropped_by_the_circle_allowlist() -> None:
    """Finding 4: circles are projected through their own keep-list, so a future
    members[] carrying keys and verified flags does not ride through wholesale."""
    projected = door.project_location_state(_full_list_state())
    circle = projected["circles"][0]
    assert circle["name"] == "Family"
    assert "members" not in circle
    assert "LEAK-M" not in repr(projected)


def test_capability_scopes_are_coerced_to_plain_strings() -> None:
    """Finding 4: a structured entry sneaked into capabilityScopes is dropped."""
    projected = door.project_location_state(_full_list_state())
    assert projected["capabilityScopes"] == ["cap.location.live.view"]
    assert "sneaky" not in repr(projected)


def test_public_invites_survive_for_read_parity() -> None:
    """Shim-agent gap: the specialist answers 'what public links do I have', so the
    projection must carry publicInvites (it did not, before this)."""
    projected = door.project_location_state(_full_list_state())
    assert projected["publicInvites"][0]["id"] == "pi-1"
    assert projected["publicInvites"][0]["ownerLabel"] == "Alex"
    assert projected["publicInvites"][0]["locationAvailable"] is True


def test_access_requests_survive_but_the_requester_phone_join_does_not() -> None:
    """Shim-agent gap: 'who is requesting access to my location' must be answerable,
    so requests cross -- but the masked-phone join is dropped like every other."""
    projected = door.project_location_state(_full_list_state())
    req = projected["requests"][0]
    assert req["requesterDisplayName"] == "Jordan"
    assert req["message"] == "can I see your location?"
    assert "requesterMaskedPhone" not in req
    assert "+1******77" not in repr(projected)


def test_the_projection_shape_is_stable_for_a_non_dict_input() -> None:
    """A degraded read returns the full empty shape, so a consumer never sees a
    key present in one call and absent in another."""
    empty = door.project_location_state(None)  # type: ignore[arg-type]
    assert set(empty) == {
        "recipients",
        "circles",
        "myRecipientKey",
        "ownerGrants",
        "receivedGrants",
        "publicInvites",
        "requests",
        "capabilityScopes",
    }


async def test_the_door_read_forces_read_only_so_it_never_mutates_the_owner_db(monkeypatch) -> None:
    """Finding 2: list_state runs expiry HOUSEKEEPING WRITES unless read_only is
    forced. The door reader must pass read_only=True, or a 'read-only by
    construction' door would mutate the owner's DB. The reader is async now and
    runs the sync list_state off the event loop, so await it."""
    seen: dict = {}

    class _FakeService:
        def list_state(self, *, user_id, read_only=False):
            seen["user_id"] = user_id
            seen["read_only"] = read_only
            return {}

    import hushh_mcp.services.one_location_agent_service as svc

    monkeypatch.setattr(svc, "OneLocationAgentService", _FakeService)
    await door._read_location("u-owner")
    assert seen["read_only"] is True, "the door read must force read-only"
