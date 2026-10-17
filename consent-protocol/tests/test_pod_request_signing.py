"""Pod-to-hub request signing: the scheme, the pod's key, and the pod's one door.

The golden vectors pin the scheme byte for byte. A change to the canonical form, the
key derivation or the header shape breaks every deployed pod's identity at once, so
it must show up here as a red test rather than in production as a fleet of 401s.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.services import pod_request_signing as prs
from hushh_mcp.services import pod_self_registration
from hushh_mcp.services.pod_hub_client import (
    POD_IDENTITY_HEADER,
    PodHubClient,
    PodHubUnavailable,
)
from hushh_mcp.services.pod_self_registration import SIGNING_KEY_INFO, derive_signing_key

_GOLDEN_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32, 64)))
_GOLDEN_KID = "pods_e64f81b2413017defb414ec821c76a19"
_GOLDEN_FIELDS = dict(
    aud="https://hub.example/",
    hushh_id="ha1_golden",
    method="post",
    path="/api/one/pod/heartbeat",
    query_pairs=[("b", "2"), ("a", "1 x/y")],
    body=b'{"imageTag":"v1"}',
)
_GOLDEN_TS = 1759363200000
_GOLDEN_NONCE = "AAECAwQFBgcICQoLDA0ODw"
_GOLDEN_PAYLOAD = (
    b'{"aud":"https://hub.example","body_sha256":'
    b'"7dd1fcea53b95d17a665e8268483fbadecd464e1a379f6708cf35c006d154a38",'
    b'"hushh_id":"ha1_golden","kid":"pods_e64f81b2413017defb414ec821c76a19",'
    b'"method":"POST","nonce":"AAECAwQFBgcICQoLDA0ODw","path":"/api/one/pod/heartbeat",'
    b'"purpose":"hushh/pod-hub-request/v1","query":"a=1%20x%2Fy&b=2","ts_ms":1759363200000}'
)
_GOLDEN_SIGNATURE = (
    "ed25519.pods_e64f81b2413017defb414ec821c76a19."
    "Mm6iBLgQ5YOAIAHBvKfOOQ13oRZagzhE9T0On-AbOoEnVkngmXd0V-oFWWzQcBff3ZI1WVbq4jAIxqg1v7zNDg"
)


def _sign(**overrides):
    fields = {**_GOLDEN_FIELDS, "ts_ms": _GOLDEN_TS, "nonce": _GOLDEN_NONCE, **overrides}
    return prs.sign_pod_request(_GOLDEN_KEY, **fields)


def _verify(headers, **overrides) -> bool:
    signed = prs.parse_signature_headers(headers)
    assert signed is not None
    fields = {**_GOLDEN_FIELDS, **overrides}
    return prs.verify_request_signature(prs.public_key_b64(_GOLDEN_KEY), signed, **fields)


# -- the scheme, byte for byte ---------------------------------------------------------


def test_golden_payload_is_byte_exact():
    payload = prs.request_signing_payload(
        **_GOLDEN_FIELDS, kid=_GOLDEN_KID, ts_ms=_GOLDEN_TS, nonce=_GOLDEN_NONCE
    )
    assert payload == _GOLDEN_PAYLOAD
    assert hashlib.sha256(_GOLDEN_FIELDS["body"]).hexdigest() in payload.decode()


def test_golden_signature_headers_are_byte_exact():
    headers = _sign()
    assert headers == {
        prs.SIGNATURE_HEADER: _GOLDEN_SIGNATURE,
        prs.TIMESTAMP_HEADER: str(_GOLDEN_TS),
        prs.NONCE_HEADER: _GOLDEN_NONCE,
    }
    assert prs.signing_key_id(prs.public_key_b64(_GOLDEN_KEY)) == _GOLDEN_KID


def test_key_derivation_is_rfc5869_hkdf_of_the_x25519_private_key():
    """Cross-checked against a hand-rolled RFC 5869 HKDF, then pinned as a literal."""
    raw = bytes(range(32))
    prk = hmac.new(b"\x00" * 32, raw, hashlib.sha256).digest()
    seed = hmac.new(prk, SIGNING_KEY_INFO + b"\x01", hashlib.sha256).digest()
    expected = prs.public_key_b64(Ed25519PrivateKey.from_private_bytes(seed))

    derived = derive_signing_key(X25519PrivateKey.from_private_bytes(raw))
    assert prs.public_key_b64(derived) == expected
    assert expected == "n0q5dc8HAhW8CwGr0DTbH3b/gb28IQuBN3j0DjG1NhI="
    assert prs.signing_key_id(expected) == "pods_187e10cbea897787e6147238230f9091"
    assert SIGNING_KEY_INFO == b"hushh/pod-hub-request-signing/ed25519/v1"


def test_round_trip_verifies():
    assert _verify(_sign())


@pytest.mark.parametrize(
    "overrides",
    [
        {"body": b'{"imageTag":"v2"}'},
        {"path": "/api/one/pod/consent/verify"},
        {"query_pairs": [("b", "2"), ("a", "1 x/z")]},
        {"query_pairs": []},
        {"aud": "https://evil.example"},
        {"hushh_id": "ha1_someone_else"},
        {"method": "GET"},
    ],
)
def test_any_tampered_field_is_refused(overrides):
    assert not _verify(_sign(), **overrides)


def test_query_order_and_trailing_audience_slash_do_not_matter():
    headers = _sign()
    assert _verify(headers, query_pairs=[("a", "1 x/y"), ("b", "2")], aud="https://hub.example")


def test_a_header_naming_another_kid_cannot_verify():
    other = Ed25519PrivateKey.from_private_bytes(bytes(range(64, 96)))
    headers = _sign()
    other_kid = prs.signing_key_id(prs.public_key_b64(other))
    headers[prs.SIGNATURE_HEADER] = headers[prs.SIGNATURE_HEADER].replace(_GOLDEN_KID, other_kid)
    signed = prs.parse_signature_headers(headers)
    assert not prs.verify_request_signature(prs.public_key_b64(other), signed, **_GOLDEN_FIELDS)
    assert not prs.verify_request_signature(
        prs.public_key_b64(_GOLDEN_KEY), signed, **_GOLDEN_FIELDS
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda h: h.update({prs.SIGNATURE_HEADER: "hmac.abc.def"}),
        lambda h: h.update({prs.SIGNATURE_HEADER: "ed25519.podk_x.AAAA"}),
        lambda h: h.update({prs.TIMESTAMP_HEADER: "soon"}),
        lambda h: h.pop(prs.NONCE_HEADER),
        lambda h: h.update({prs.NONCE_HEADER: "short"}),
    ],
)
def test_malformed_headers_are_refused_not_ignored(mutate):
    headers = _sign()
    mutate(headers)
    with pytest.raises(prs.PodRequestSignatureMalformed):
        prs.parse_signature_headers(headers)


def test_no_signature_header_is_unsigned():
    assert prs.parse_signature_headers({}) is None


def test_the_window_is_sixty_seconds_back_thirty_ahead():
    now = 1_000_000_000_000
    assert prs.timestamp_in_window(now - 60_000, now)
    assert prs.timestamp_in_window(now + 30_000, now)
    assert not prs.timestamp_in_window(now - 60_001, now)
    assert not prs.timestamp_in_window(now + 30_001, now)


def test_query_pairs_mirror_what_requests_sends():
    assert prs.query_pairs_from_params({"a": 1, "b": None, "c": ["x", "y"]}) == [
        ("a", "1"),
        ("c", "x"),
        ("c", "y"),
    ]
    assert prs.canonical_query([]) == ""


# -- the pod's published key -----------------------------------------------------------


@pytest.fixture
def fixed_pod_key(monkeypatch):
    raw = bytes(range(32))
    monkeypatch.setenv(pod_self_registration.POD_PRIVATE_KEY_ENV, base64.b64encode(raw).decode())
    monkeypatch.setattr(pod_self_registration, "_STATE", None)
    monkeypatch.setattr(pod_self_registration, "_SIGNING", None)
    return raw


def test_the_public_key_route_publishes_the_signing_key_additively(fixed_pod_key, monkeypatch):
    import pod_server

    monkeypatch.setenv("HUSSH_ID", "ha1_golden")
    body = pod_server.pod_public_key()
    assert body["podPublicKey"] and body["podKeyId"].startswith("podk_")
    assert body["podSigningKey"] == "n0q5dc8HAhW8CwGr0DTbH3b/gb28IQuBN3j0DjG1NhI="
    assert body["podSigningKeyId"] == "pods_187e10cbea897787e6147238230f9091"
    assert body["podSigningAlg"] == "ed25519"
    assert "private" not in json.dumps(body).lower()


# -- the pod's one door ----------------------------------------------------------------


class _Resp:
    def __init__(self, status_code=200, text="", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload or {}

    def json(self):
        return self._payload


class _Session:
    """Records exactly what went on the wire."""

    def __init__(self, *, metadata: bool):
        self.metadata = metadata
        self.sent: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None):
        if "metadata.google.internal" in url:
            if not self.metadata:
                raise ConnectionError("no metadata server off Google Cloud")
            return _Resp(200, text="google-id-token")
        self.sent.append({"method": "GET", "url": url, "params": params, "headers": headers})
        return _Resp(200, payload={"ok": True})

    def post(self, url, data=None, headers=None, timeout=None):
        self.sent.append({"method": "POST", "url": url, "data": data, "headers": headers})
        return _Resp(200, payload={"ok": True})


def _hub_verifies(call, *, query_pairs=()) -> bool:
    headers = call["headers"]
    signed = prs.parse_signature_headers(headers)
    public = prs.public_key_b64(pod_self_registration.pod_signing_key())
    return prs.verify_request_signature(
        public,
        signed,
        aud="https://hub.example",
        hushh_id=headers[POD_IDENTITY_HEADER],
        method=call["method"],
        path="/api/one/pod/heartbeat" if call["method"] == "POST" else "/api/one/agent-prompt",
        query_pairs=list(query_pairs),
        body=call.get("data") or b"",
    )


def test_gcp_pod_sends_the_google_token_alongside_and_signs_the_sent_bytes(
    fixed_pod_key, monkeypatch
):
    monkeypatch.setenv("HUSSH_ID", "ha1_golden")
    session = _Session(metadata=True)
    client = PodHubClient(base_url="https://hub.example/", session=session)

    client.post("/api/one/pod/heartbeat", json={"imageTag": "v1", "note": "é"})

    call = session.sent[0]
    assert call["headers"]["Authorization"] == "Bearer google-id-token"
    assert call["headers"]["Content-Type"] == "application/json"
    assert isinstance(call["data"], bytes)
    assert json.loads(call["data"]) == {"imageTag": "v1", "note": "é"}
    assert _hub_verifies(call)


def test_azure_pod_with_no_metadata_server_sends_the_signature_alone(fixed_pod_key, monkeypatch):
    monkeypatch.setenv("HUSSH_ID", "ha1_golden")
    session = _Session(metadata=False)
    client = PodHubClient(base_url="https://hub.example", session=session)

    client.get("/api/one/agent-prompt", params={"channel": "default"})
    client.get("/api/one/agent-prompt", params={"channel": "default"})

    first, second = session.sent
    assert "Authorization" not in first["headers"]
    assert _hub_verifies(first, query_pairs=[("channel", "default")])
    assert first["headers"][prs.NONCE_HEADER] != second["headers"][prs.NONCE_HEADER]


def test_a_pod_with_neither_identity_refuses_to_call(monkeypatch):
    monkeypatch.delenv("HUSSH_ID", raising=False)
    client = PodHubClient(base_url="https://hub.example", session=_Session(metadata=False))
    with pytest.raises(PodHubUnavailable):
        client.post("/api/one/pod/heartbeat", json={})


def test_command_reads_go_through_the_signed_data_door(monkeypatch):
    """The Location command read used to post on its own; it now uses the door."""
    import asyncio

    from hushh_mcp.services.pod_command_reads import PodCommandReads

    seen: dict = {}

    class _Door:
        def read_specialist(self, name, scope_token, **options):
            seen.update(name=name, scope=scope_token, **options)
            return {"projection": {"status": "observed"}, "observations": []}

        def post(self, *_args, **_kwargs):
            raise AssertionError("command reads must not bypass the data door")

    scope = "synthetic-scope"
    reads = PodCommandReads(scope_token=scope, client=_Door(), user_id="u1")
    result = asyncio.run(reads.read("settings"))

    assert result == {"status": "observed"}
    assert seen["name"] == "location" and seen["scope"] == scope
    assert seen["command_read"]["kind"] == "settings"
