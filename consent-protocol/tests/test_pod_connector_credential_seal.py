"""The sealed connector login, byte for byte and refusal by refusal.

The golden vector (``tests/fixtures/connector_credential_seal_vector_v1.json``) is
shared with the app: both ends must produce the identical envelope from identical
inputs. Every acceptance check then has its own negative control: the same envelope
with that one property broken is refused with its typed code, and the untouched
envelope still opens. The shared envelope core must also keep two purposes apart: an
AI selection envelope never opens as a connector login, and the reverse.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.services import pod_ai_selection_seal as ai_seal
from hushh_mcp.services import pod_connector_credential_seal as seal
from hushh_mcp.services import pod_sealed_envelope as core
from hushh_mcp.services.pod_session_authority import canonical_json

VECTOR = json.loads(
    (Path(__file__).parent / "fixtures" / "connector_credential_seal_vector_v1.json").read_text()
)
POD_PUBLIC = core.b64url_decode(VECTOR["podPublicKey"])
POD = X25519PrivateKey.from_private_bytes(core.b64url_decode(VECTOR["podPrivateKey"]))
HUSHH_ID = VECTOR["aad"]["hushhId"]
KEY_ID = VECTOR["podKeyId"]
NOW = VECTOR["aad"]["issuedAtMs"]
CODE = VECTOR["plaintext"]["code"]


@pytest.fixture(autouse=True)
def public_profile(monkeypatch):
    monkeypatch.setenv("GOOGLE_IOS_CONNECTOR_CLIENT_ID", VECTOR["plaintext"]["clientId"])


def _sealed(*, plaintext: dict | None = None, **aad_changes) -> dict:
    aad = {**VECTOR["aad"], **aad_changes}
    return seal.seal_connector_credential(
        plaintext if plaintext is not None else VECTOR["plaintext"],
        pod_public_key_raw=POD_PUBLIC,
        aad=aad,
    )


def _open(envelope, **overrides):
    kwargs = {
        "pod_private_key": POD,
        "hushh_id": HUSHH_ID,
        "pod_key_id": KEY_ID,
        "connector_id": "gmail",
        "now_ms": NOW,
        "floor_issued_at_ms": 0,
        **overrides,
    }
    return seal.open_connector_credential(envelope, **kwargs)


def _refused(envelope, code: str, **overrides) -> None:
    with pytest.raises(seal.ConnectorCredentialRefused) as refused:
        _open(envelope, **overrides)
    assert refused.value.code == code
    assert CODE not in str(refused.value) and refused.value.args == (code,)


def test_the_vector_seals_byte_identically_and_opens_to_its_plaintext():
    envelope = seal.seal_connector_credential(
        VECTOR["plaintext"],
        pod_public_key_raw=POD_PUBLIC,
        aad=VECTOR["aad"],
        ephemeral_private_key_raw=core.b64url_decode(VECTOR["ephemeralPrivateKey"]),
        iv=core.b64url_decode(VECTOR["iv"]),
    )
    assert envelope == VECTOR["expectedEnvelope"]
    assert canonical_json(envelope) == VECTOR["expectedEnvelopeCanonical"]
    assert core.aad_bytes(VECTOR["aad"]).decode() == VECTOR["aadCanonical"]
    assert canonical_json(VECTOR["plaintext"]) == VECTOR["plaintextCanonical"]
    assert VECTOR["hkdfInfo"] == seal.HKDF_INFO.decode() == "hussh/connector-credential/v1"
    shared = core.b64url_decode(VECTOR["sharedSecret"])
    epk = core.b64url_decode(VECTOR["ephemeralPublicKey"])
    assert epk + POD_PUBLIC == core.b64url_decode(VECTOR["hkdfSalt"])
    derived = core.derive_key(shared, epk, POD_PUBLIC, info=seal.HKDF_INFO)
    assert derived == core.b64url_decode(VECTOR["aesKey"])
    assert base64.b64decode(VECTOR["podPublicKeyStandardBase64"]) == POD_PUBLIC

    opened = _open(VECTOR["expectedEnvelope"])
    assert (opened.kind, opened.connector_id, opened.provider) == (
        "authorization_code",
        "gmail",
        "google",
    )
    assert (opened.client_profile, opened.code, opened.issued_at_ms) == ("hussh_ios", CODE, NOW)
    assert CODE not in repr(opened) and VECTOR["plaintext"]["codeVerifier"] not in repr(opened)


def test_two_purposes_never_open_each_other():
    """The HKDF label is the purpose: a key derived for one cannot open the other."""
    as_ai = {**VECTOR["expectedEnvelope"], "aad": {**VECTOR["expectedEnvelope"]["aad"]}}
    with pytest.raises(ai_seal.AiSelectionRefused) as refused:
        ai_seal.open_ai_selection(
            as_ai, pod_private_key=POD, hushh_id=HUSHH_ID, pod_key_id=KEY_ID, now_ms=NOW
        )
    assert refused.value.code == "BAD_ENVELOPE"
    # Same AAD keys, wrong label: sealed as an AI selection, opened as a connector login.
    forged = core.seal(
        VECTOR["plaintext"],
        purpose=ai_seal.SEAL_PURPOSE.__class__(
            name="connector_credential",
            hkdf_info=ai_seal.HKDF_INFO,
            aad_keys=seal.SEAL_PURPOSE.aad_keys,
        ),
        pod_public_key_raw=POD_PUBLIC,
        aad=VECTOR["aad"],
    )
    _refused(forged, seal.BAD_ENVELOPE)
    assert _open(VECTOR["expectedEnvelope"]).code == CODE, "negative control"


def test_tampered_ciphertext_or_aad_is_a_bad_envelope():
    good = VECTOR["expectedEnvelope"]
    ct = bytearray(core.b64url_decode(good["ct"]))
    ct[-1] ^= 1
    _refused({**good, "ct": core.b64url_encode(bytes(ct))}, seal.BAD_ENVELOPE)
    for change in (
        {"issuedAtMs": NOW + 1},
        {"connectorId": "calendar"},
        {"provider": "mcp"},
        {"credentialId": "3b9f6a0e-7c2d-4e1f-9a8b-5c4d3e2f1a0c"},
    ):
        tampered = {**good, "aad": {**good["aad"], **change}}
        connector = change.get("connectorId", "gmail")
        _refused(tampered, seal.BAD_ENVELOPE, connector_id=connector)
    assert _open(good).code == CODE, "negative control: the untouched envelope opens"


@pytest.mark.parametrize(
    ("aad_change", "connector"),
    [
        ({"purpose": "ai_selection"}, "gmail"),
        ({"hushhId": "ha1_someone_else"}, "gmail"),
        ({"podKeyId": "podk_another"}, "gmail"),
        ({"credentialId": "not-a-uuid"}, "gmail"),
        ({"credentialId": "6f1c2d3e-4b5a-1c6d-8e7f-9a0b1c2d3e4f"}, "gmail"),
        ({"connectorId": "calendar"}, "gmail"),
    ],
    ids=["purpose", "owner", "pod_key", "credential_id", "uuid_v1", "other_connector"],
)
def test_an_envelope_for_another_purpose_owner_key_or_connector_is_refused(aad_change, connector):
    _refused(_sealed(**aad_change), seal.BAD_ENVELOPE, connector_id=connector)


def test_the_wrong_pod_key_cannot_open_it():
    _refused(
        VECTOR["expectedEnvelope"], seal.BAD_ENVELOPE, pod_private_key=X25519PrivateKey.generate()
    )


@pytest.mark.parametrize(
    "issued_at",
    [NOW - core.MAX_CLOCK_SKEW_MS - 1, NOW + core.MAX_CLOCK_SKEW_MS + 1],
    ids=["too_old", "from_the_future"],
)
def test_a_stale_issued_at_is_refused(issued_at):
    _refused(_sealed(issuedAtMs=issued_at), seal.STALE_CREDENTIAL)
    edge = NOW - core.MAX_CLOCK_SKEW_MS if issued_at < NOW else NOW + core.MAX_CLOCK_SKEW_MS
    assert _open(_sealed(issuedAtMs=edge)).issued_at_ms == edge


def test_a_replay_against_the_held_login_is_stale():
    envelope = VECTOR["expectedEnvelope"]
    _refused(envelope, seal.STALE_CREDENTIAL, floor_issued_at_ms=NOW)
    assert _open(envelope, floor_issued_at_ms=NOW - 1).issued_at_ms == NOW


@pytest.mark.parametrize(
    ("aad_change", "connector"),
    [
        ({"connectorId": "photos"}, "photos"),
        ({"connectorId": "gmail", "provider": "microsoft"}, "gmail"),
        ({"connectorId": "mcp_notion", "provider": "google"}, "mcp_notion"),
    ],
    ids=["unknown_connector", "unknown_provider", "mcp_id_as_google"],
)
def test_an_unsupported_connector_is_named_as_such(aad_change, connector):
    _refused(_sealed(**aad_change), seal.CONNECTOR_UNSUPPORTED, connector_id=connector)


def test_a_kind_that_does_not_fit_the_connector_is_refused():
    owner_client = {
        "kind": "owner_client",
        "clientId": VECTOR["plaintext"]["clientId"],
        "clientSecret": "owner-secret",
    }
    _refused(_sealed(plaintext=owner_client), seal.CREDENTIAL_KIND_UNSUPPORTED)
    _refused(
        _sealed(plaintext={**VECTOR["plaintext"], "kind": "magic"}), "CREDENTIAL_KIND_UNSUPPORTED"
    )
    opened = _open(
        _sealed(plaintext=owner_client, connectorId="google_owner_client"),
        connector_id="google_owner_client",
    )
    assert opened.client_secret == "owner-secret" and "owner-secret" not in repr(opened)


def test_an_unknown_client_profile_is_refused():
    plaintext = {**VECTOR["plaintext"], "clientProfile": "someone_elses_app"}
    _refused(_sealed(plaintext=plaintext), seal.CLIENT_PROFILE_UNSUPPORTED)


def test_a_native_profile_is_pinned_to_the_configured_client_and_exact_callback(monkeypatch):
    other = "123456789012-aaaaaaaaaaaaaaaa.apps.googleusercontent.com"
    changed = {
        **VECTOR["plaintext"],
        "clientId": other,
        "redirectUri": "com.googleusercontent.apps.123456789012-aaaaaaaaaaaaaaaa:/oauth2redirect",
    }
    _refused(_sealed(plaintext=changed), seal.CLIENT_PROFILE_UNSUPPORTED)
    _refused(
        _sealed(
            plaintext={
                **VECTOR["plaintext"],
                "redirectUri": VECTOR["plaintext"]["redirectUri"] + "/anything",
            }
        ),
        seal.CLIENT_PROFILE_UNSUPPORTED,
    )
    assert _open(VECTOR["expectedEnvelope"]).client_id == VECTOR["plaintext"]["clientId"]
    monkeypatch.delenv("GOOGLE_IOS_CONNECTOR_CLIENT_ID")
    _refused(VECTOR["expectedEnvelope"], seal.CLIENT_PROFILE_UNSUPPORTED)


def test_android_requires_the_configured_callback_and_dev_opt_in(monkeypatch):
    monkeypatch.setenv("GOOGLE_ANDROID_CONNECTOR_CLIENT_ID", VECTOR["plaintext"]["clientId"])
    monkeypatch.setenv("GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI", "com.hussh.app:/oauth2redirect")
    body = {
        **VECTOR["plaintext"],
        "clientProfile": "hussh_android",
        "redirectUri": "com.hussh.app:/oauth2redirect",
    }
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.delenv("GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED", raising=False)
    _refused(_sealed(plaintext=body), seal.CLIENT_PROFILE_UNSUPPORTED)
    monkeypatch.setenv("GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED", "true")
    assert _open(_sealed(plaintext=body)).client_profile == "hussh_android"
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "prod")
    _refused(_sealed(plaintext=body), seal.CLIENT_PROFILE_UNSUPPORTED)


def test_a_scope_outside_the_connector_is_refused():
    drive_on_gmail = [*VECTOR["plaintext"]["scopes"], "https://www.googleapis.com/auth/drive"]
    _refused(
        _sealed(plaintext={**VECTOR["plaintext"], "scopes": drive_on_gmail}), "SCOPE_NOT_ALLOWED"
    )
    manage = [*VECTOR["plaintext"]["scopes"], "https://www.googleapis.com/auth/gmail.modify"]
    assert (
        _open(_sealed(plaintext={**VECTOR["plaintext"], "scopes": manage}))
        .scopes[-1]
        .endswith("gmail.modify")
    )


def test_an_mcp_login_without_a_refresh_token_is_named_as_such():
    mcp = {
        "kind": "mcp_oauth",
        "endpoint": "https://mcp.example.com/mcp",
        "issuer": "https://auth.example.com",
        "tokens": {"access_token": "at", "scope": "read"},
        "clientInfo": {"client_id": "client-1"},
    }
    aad = {"connectorId": "mcp_example", "provider": "mcp"}
    _refused(_sealed(plaintext=mcp, **aad), seal.REFRESH_TOKEN_MISSING, connector_id="mcp_example")
    with_refresh = {**mcp, "tokens": {**mcp["tokens"], "refresh_token": "rt-1"}}
    opened = _open(_sealed(plaintext=with_refresh, **aad), connector_id="mcp_example")
    assert opened.mcp["refreshToken"] == "rt-1" and "rt-1" not in repr(opened)


@pytest.mark.parametrize(
    "plaintext_change",
    [
        {"code": ""},
        {"code": "has space"},
        {"codeVerifier": "short"},
        {"clientId": "not-a-google-client"},
        {"redirectUri": "com.googleusercontent.apps.999999999999-other:/oauth2redirect"},
        {"redirectUri": "javascript alert"},
        {"scopes": []},
        {"scopes": ["openid", "openid"]},
        {"surprise": "field"},
    ],
    ids=[
        "empty_code",
        "spaced_code",
        "short_verifier",
        "client_id",
        "ios_redirect_for_another_client",
        "bad_redirect",
        "no_scopes",
        "duplicate_scopes",
        "unknown_field",
    ],
)
def test_a_malformed_login_is_a_bad_envelope(plaintext_change):
    _refused(_sealed(plaintext={**VECTOR["plaintext"], **plaintext_change}), seal.BAD_ENVELOPE)


@pytest.mark.parametrize(
    "envelope_change",
    [
        {"v": 2},
        {"v": True},
        {"alg": "X25519-HKDF-SHA256-CHACHA20"},
        {"extra": 1},
        {"iv": VECTOR["expectedEnvelope"]["iv"] + "="},
        {"epk": VECTOR["expectedEnvelope"]["epk"][:-2]},
    ],
    ids=["version", "bool_version", "alg", "extra_key", "padded_b64", "short_epk"],
)
def test_a_structurally_wrong_envelope_is_refused_before_any_decryption(envelope_change):
    _refused({**VECTOR["expectedEnvelope"], **envelope_change}, seal.BAD_ENVELOPE)


def test_every_refusal_code_is_exercised_here():
    """A code nobody can trigger is a code nobody checked."""
    source = Path(__file__).read_text()
    for code in seal.REFUSAL_CODES:
        assert code in source or f"seal.{code}" in source, code
