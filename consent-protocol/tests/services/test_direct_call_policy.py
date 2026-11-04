import base64
from dataclasses import replace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from hushh_mcp.services.direct_call_policy import CallError, CallSnapshot, RelayConfig, transition
from hushh_mcp.services.direct_calls_service import proof_bytes, release_available, verify_proof


def call(**changes):
    return replace(
        CallSnapshot(
            "call",
            "conversation",
            "alice",
            "bob",
            "alice-device",
            None,
            "ringing",
            0,
            100,
            0,
            caller_seen_at=5,
            callee_seen_at=5,
        ),
        **changes,
    )


def test_answer_roles_cas_and_multi_device_winner():
    assert transition(call(), actor="bob", device="bob-one", action="accept", revision=0, now=10)[
        :2
    ] == ("connecting", "bob-one")
    for actor, device, action, revision in [
        ("mallory", "foreign", "accept", 0),
        ("alice", "alice-device", "accept", 0),
        ("bob", "bob-one", "accept", 1),
        ("alice", "foreign", "cancel", 0),
    ]:
        with pytest.raises(CallError):
            transition(call(), actor=actor, device=device, action=action, revision=revision, now=10)
    accepted = call(state="connecting", callee_device="bob-one", revision=1)
    with pytest.raises(CallError, match="another device"):
        transition(accepted, actor="bob", device="bob-two", action="end", revision=1, now=10)


def test_connected_requires_both_endpoint_reports_and_expiry_is_absolute():
    accepted = call(state="connecting", callee_device="bob-one", revision=1)
    assert (
        transition(
            accepted, actor="alice", device="alice-device", action="connected", revision=1, now=10
        )[0]
        == "connecting"
    )
    assert (
        transition(
            replace(accepted, caller_connected=True),
            actor="bob",
            device="bob-one",
            action="connected",
            revision=1,
            now=10,
        )[0]
        == "active"
    )
    with pytest.raises(CallError, match="expired"):
        transition(call(), actor="bob", device="bob-one", action="accept", revision=0, now=100)
    with pytest.raises(CallError):
        transition(
            call(state="ended"), actor="bob", device="bob-one", action="accept", revision=0, now=1
        )


def test_relay_credentials_are_short_lived_and_do_not_disclose_identity():
    config = RelayConfig(
        "turn-uat.example.test", "synthetic-relay-test-secret-at-least-32-characters"
    )
    credentials = config.credentials(
        call_id="private-call", device_id="private-device", now=10, expires_at=1000
    )
    assert credentials["iceTransportPolicy"] == "relay"
    assert credentials["expiresAt"] == 1000
    assert credentials["iceServers"][0]["urls"] == [
        "turn:turn-uat.example.test:3478?transport=udp",
        "turns:turn-uat.example.test:443?transport=tcp",
    ]
    assert "private" not in credentials["iceServers"][0]["username"]
    for host in [
        "https://turn.example.test",
        "turn.example.test:443",
        "evil.test/path",
        "a..b",
        "",
    ]:
        with pytest.raises(CallError):
            RelayConfig(host, config.secret)
    with pytest.raises(CallError):
        config.credentials(call_id="call", device_id="device", now=10, expires_at=10)


@pytest.mark.parametrize("state", ["connecting", "active"])
@pytest.mark.parametrize("endpoint", ["caller_seen_at", "callee_seen_at"])
def test_one_live_endpoint_cannot_keep_a_lost_peer_connected(state, endpoint):
    fresh = call(
        state=state, callee_device="bob-one", expires_at=3600, caller_seen_at=64, callee_seen_at=64
    )
    assert transition(
        fresh, actor="alice", device="alice-device", action="connected", revision=0, now=65
    )[0] in {"connecting", "active"}
    for lost in (None, 5):
        stale = replace(fresh, **{endpoint: lost})
        with pytest.raises(CallError, match="expired"):
            transition(
                stale, actor="alice", device="alice-device", action="connected", revision=0, now=65
            )
        assert (
            transition(
                stale, actor="alice", device="alice-device", action="end", revision=99, now=65
            )[0]
            == "ended"
        )


def test_negotiation_is_bounded_and_connected_calls_keep_the_absolute_deadline():
    initial = call(expires_at=45)
    assert (
        transition(initial, actor="bob", device="bob-one", action="accept", revision=0, now=10)[2]
        == 130
    )
    connecting = call(
        state="connecting",
        callee_device="bob-one",
        expires_at=130,
        caller_connected=True,
        caller_seen_at=129,
        callee_seen_at=129,
    )
    assert (
        transition(
            connecting, actor="bob", device="bob-one", action="connected", revision=0, now=129
        )[2]
        == 3600
    )
    with pytest.raises(CallError, match="expired"):
        transition(
            connecting, actor="bob", device="bob-one", action="connected", revision=0, now=130
        )
    active = replace(
        connecting, state="active", expires_at=3600, caller_seen_at=3600, callee_seen_at=3600
    )
    with pytest.raises(CallError, match="expired"):
        transition(active, actor="bob", device="bob-one", action="connected", revision=0, now=3600)


def test_device_proof_binds_exact_owner_operation_body_expiry_and_nonce():
    key = ec.generate_private_key(ec.SECP256R1())
    public = base64.b64encode(
        key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode()
    proof = {"deviceId": "device", "nonce": "nonce", "expiresAt": 100, "signature": ""}
    payload = {"callId": "call", "sequence": 1, "text": "हिंदी"}
    proof["signature"] = base64.b64encode(
        key.sign(proof_bytes("alice", "signal", payload, proof), ec.ECDSA(hashes.SHA256()))
    ).decode()
    verify_proof(public, "alice", "signal", payload, proof, 10)
    for owner, operation, altered, stamp in [
        ("bob", "signal", payload, 10),
        ("alice", "accept", payload, 10),
        ("alice", "signal", {**payload, "sequence": 2}, 10),
        ("alice", "signal", payload, 100),
    ]:
        with pytest.raises(CallError):
            verify_proof(public, owner, operation, altered, proof, stamp)


def test_release_requires_all_independent_qualifications(monkeypatch):
    keys = (
        "DIRECT_CALLS_ENABLED",
        "DIRECT_MESSAGES_E2EE_QUALIFIED",
        "DIRECT_CALLS_NATIVE_QUALIFIED",
    )
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    assert not release_available()
    monkeypatch.setenv(keys[0], "1")
    assert not release_available()
    for key in keys:
        monkeypatch.setenv(key, "1")
    assert release_available()
