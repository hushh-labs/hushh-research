"""The hub fences two placements by key and epoch (STANDBY-SYNC.md E4).

Driven through ``verify_pod_request`` with real Starlette requests signed the way a
pod signs them, against fakes with the same contracts as the registry, the nonce
store, the hub's own key pull and the standby store. The regression half pins that a
person with no standby and epoch 0 is decided exactly as before 950.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from starlette.requests import Request

from api.routes.one import pod_identity_auth as pia
from hushh_mcp.services import pod_request_signing as prs
from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER
from hushh_mcp.services.pod_request_verifier import (
    PullCap,
    SignedOutcome,
    SignedRequest,
    verify_signed_request,
)
from tests.test_pod_request_signing import (
    _GOLDEN_FIELDS,
    _GOLDEN_KEY,
    _GOLDEN_KID,
    _GOLDEN_NONCE,
    _GOLDEN_PAYLOAD,
    _GOLDEN_SIGNATURE,
    _GOLDEN_TS,
)

AUD = "https://hub.example"
OWNER = "ha1_owner"
PATH = "/api/one/pod/heartbeat"
PRIMARY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
STANDBY = Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))
STRANGER = Ed25519PrivateKey.from_private_bytes(bytes(range(2, 34)))


def _public(key: Ed25519PrivateKey) -> tuple[str, str]:
    public = prs.public_key_b64(key)
    return public, prs.signing_key_id(public)


# -- the scheme: the epoch is signed only when sent -----------------------------------


def test_the_golden_vector_is_byte_identical_without_the_epoch():
    fields = {**_GOLDEN_FIELDS, "kid": _GOLDEN_KID, "ts_ms": _GOLDEN_TS, "nonce": _GOLDEN_NONCE}
    assert prs.request_signing_payload(**fields) == _GOLDEN_PAYLOAD
    assert prs.request_signing_payload(**fields, epoch=None) == _GOLDEN_PAYLOAD
    headers = prs.sign_pod_request(
        _GOLDEN_KEY, **_GOLDEN_FIELDS, ts_ms=_GOLDEN_TS, nonce=_GOLDEN_NONCE, epoch=None
    )
    assert headers == {
        prs.SIGNATURE_HEADER: _GOLDEN_SIGNATURE,
        prs.TIMESTAMP_HEADER: str(_GOLDEN_TS),
        prs.NONCE_HEADER: _GOLDEN_NONCE,
    }


def test_a_sent_epoch_is_covered_by_the_signature():
    headers = prs.sign_pod_request(
        _GOLDEN_KEY, **_GOLDEN_FIELDS, ts_ms=_GOLDEN_TS, nonce=_GOLDEN_NONCE, epoch=3
    )
    assert headers[prs.EPOCH_HEADER] == "3"
    assert headers[prs.SIGNATURE_HEADER] != _GOLDEN_SIGNATURE
    public = prs.public_key_b64(_GOLDEN_KEY)
    signed = prs.parse_signature_headers(headers)
    assert signed is not None and signed.epoch == 3
    assert prs.verify_request_signature(public, signed, **_GOLDEN_FIELDS)
    for tampered in ({**headers, prs.EPOCH_HEADER: "4"}, _without(headers, prs.EPOCH_HEADER)):
        signed = prs.parse_signature_headers(tampered)
        assert signed is not None
        assert not prs.verify_request_signature(public, signed, **_GOLDEN_FIELDS)


@pytest.mark.parametrize("value", ["", "-1", "01", "1.0", "x", "9" * 19])
def test_a_malformed_epoch_header_is_refused_not_ignored(value):
    headers = prs.sign_pod_request(_GOLDEN_KEY, **_GOLDEN_FIELDS, epoch=1)
    with pytest.raises(prs.PodRequestSignatureMalformed):
        prs.parse_signature_headers({**headers, prs.EPOCH_HEADER: value})


@pytest.mark.parametrize("epoch", [-1, True, 1.0, "1"])
def test_the_signer_refuses_a_non_integer_epoch(epoch):
    with pytest.raises(ValueError):
        prs.sign_pod_request(_GOLDEN_KEY, **_GOLDEN_FIELDS, epoch=epoch)


def _without(headers: dict, name: str) -> dict:
    return {key: value for key, value in headers.items() if key != name}


# -- fakes with the production contracts ---------------------------------------------


class _Registry:
    def __init__(self, row: dict) -> None:
        self.row = row

    async def get_by_hushh_id(self, hushh_id: str) -> Optional[dict]:
        return dict(self.row) if hushh_id == self.row["hushh_id"] else None


class _Store:
    def __init__(self, registry: _Registry) -> None:
        self.registry = registry
        self.nonces: set[tuple[str, str]] = set()
        self.latched: list[str] = []

    async def consume_nonce(self, *, kid: str, nonce: str, expires_at_ms: int) -> bool:
        if (kid, nonce) in self.nonces:
            return False
        self.nonces.add((kid, nonce))
        return True

    async def claim_key_pull(self, *, hushh_id: str, interval_ms: int, now_ms: int) -> bool:
        return True

    async def latch_signed(self, *, hushh_id: str, kid: str) -> bool:
        if self.registry.row.get("pod_signing_key_id") != kid:
            return False
        self.registry.row["identity_mode"] = "signed"
        self.latched.append(kid)
        return True


class _Standbys:
    def __init__(self, standby: Optional[dict] = None, *, fail: bool = False) -> None:
        self.standby = standby
        self.fail = fail
        self.reads = 0

    async def read_standby(self, user_id: str) -> Optional[dict]:
        self.reads += 1
        if self.fail:
            raise RuntimeError("database unavailable")
        return dict(self.standby) if self.standby else None


def _row(**extra: Any) -> dict:
    public, kid = _public(PRIMARY)
    row = {
        "hushh_id": OWNER,
        "user_id": "uid-owner",
        "status": "provisioned",
        "pod_signing_pubkey": public,
        "pod_signing_key_id": kid,
    }
    row.update(extra)
    return row


def _standby_row(signer: Ed25519PrivateKey = STANDBY) -> dict:
    public, kid = _public(signer)
    return {"hushh_id": OWNER, "pod_signing_pubkey": public, "pod_signing_key_id": kid}


def _request(
    key: Ed25519PrivateKey, *, epoch: Optional[int] = None, body: bytes = b"{}"
) -> Request:
    sent = {POD_IDENTITY_HEADER: OWNER, "Content-Type": "application/json"}
    sent.update(
        prs.sign_pod_request(
            key, aud=AUD, hushh_id=OWNER, method="POST", path=PATH, query_pairs=[], body=body,
            epoch=epoch,
        )
    )  # fmt: skip

    async def receive() -> dict:
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http", "method": "POST", "path": PATH, "raw_path": PATH.encode(),
        "query_string": b"", "root_path": "", "scheme": "https",
        "server": ("hub.example", 443),
        "headers": [(k.lower().encode(), v.encode()) for k, v in sent.items()],
    }  # fmt: skip
    return Request(scope, receive)


@pytest.fixture
def hub(monkeypatch):
    """``verify(request, row=..., standbys=..., sync_path=...)`` plus the Google call log."""
    monkeypatch.setattr(pia, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(pia, "pod_hub_expected_audience", lambda: AUD)
    google_calls: list = []

    async def google(_request, _authorization, *, owner_bound=False):
        google_calls.append(owner_bound)
        return OWNER  # a Google path that WOULD accept, so falling through is visible

    monkeypatch.setattr(pia, "verify_pod_identity", google)
    state: dict[str, Any] = {}

    async def verify(request, *, row, standbys=None, sync_path=False, authorization="Bearer t"):
        registry = _Registry(row)
        store = _Store(registry)
        pulls: list[str] = []

        async def refresh(_row: dict) -> str:
            pulls.append(_row["hushh_id"])
            return "provisioned"

        state.update(registry=registry, store=store, pulls=pulls)
        return await pia.verify_pod_request(
            request,
            authorization,
            registry=registry,
            store=store,
            refresh=refresh,
            standbys=standbys or _Standbys(),
            sync_path=sync_path,
        )

    return verify, google_calls, state


# -- regression: no standby and epoch 0 is today's behaviour exactly -----------------


async def test_without_950_no_standby_is_read_and_the_decision_is_unchanged(hub):
    verify, google_calls, state = hub
    standbys = _Standbys(_standby_row())
    pod = await verify(_request(PRIMARY), row=_row(), standbys=standbys)
    assert pod == prs.VerifiedPod(OWNER, key_id=_public(PRIMARY)[1])
    assert standbys.reads == 0 and google_calls == []
    assert state["store"].latched == [_public(PRIMARY)[1]]


async def test_no_standby_at_epoch_zero_verifies_exactly_as_before(hub):
    verify, google_calls, state = hub
    standbys = _Standbys(None)
    pod = await verify(_request(PRIMARY), row=_row(placement_epoch=0), standbys=standbys)
    assert pod == prs.VerifiedPod(OWNER, key_id=_public(PRIMARY)[1])
    assert not pod.standby and standbys.reads == 1 and google_calls == []
    assert state["store"].latched == [_public(PRIMARY)[1]]
    # An unknown key still resolves to the transitional path, as it always did.
    stranger = await verify(_request(STRANGER), row=_row(placement_epoch=0), standbys=standbys)
    assert stranger == prs.VerifiedPod(OWNER)  # the Google stand-in accepted
    assert google_calls == [False]


async def test_an_epoch_header_at_epoch_zero_is_still_signed_and_accepted(hub):
    verify, *_ = hub
    pod = await verify(_request(PRIMARY, epoch=0), row=_row(placement_epoch=0))
    assert pod == prs.VerifiedPod(OWNER, key_id=_public(PRIMARY)[1])


# -- fenced: an epoch above 0 ---------------------------------------------------------


@pytest.mark.parametrize("epoch", [None, 1], ids=["missing", "stale"])
async def test_at_epoch_above_zero_a_missing_or_stale_epoch_is_invalid(hub, epoch):
    verify, google_calls, state = hub
    row = _row(placement_epoch=2)
    assert await verify(_request(PRIMARY, epoch=epoch), row=row) is None
    assert google_calls == []  # INVALID never falls through to the Google path
    assert state["store"].nonces == set()


async def test_at_epoch_above_zero_the_current_epoch_verifies(hub):
    verify, google_calls, _ = hub
    pod = await verify(_request(PRIMARY, epoch=2), row=_row(placement_epoch=2))
    assert pod == prs.VerifiedPod(OWNER, key_id=_public(PRIMARY)[1]) and google_calls == []


async def test_a_switched_person_is_latched_against_the_google_path(hub):
    verify, google_calls, _ = hub
    unsigned = Request(
        {
            "type": "http",
            "method": "POST",
            "path": PATH,
            "raw_path": PATH.encode(),
            "query_string": b"",
            "root_path": "",
            "scheme": "https",
            "server": ("hub.example", 443),
            "headers": [(POD_IDENTITY_HEADER.lower().encode(), OWNER.encode())],
        }  # fmt: skip
    )
    row = _row(placement_epoch=1, identity_mode=None)
    assert await verify(unsigned, row=row) is None
    assert google_calls == [False]  # consulted, then refused by the latch


# -- fenced: a standby exists ---------------------------------------------------------


async def test_with_a_standby_a_missing_epoch_is_invalid_even_at_epoch_zero(hub):
    verify, google_calls, _ = hub
    standbys = _Standbys(_standby_row())
    assert await verify(_request(PRIMARY), row=_row(placement_epoch=0), standbys=standbys) is None
    assert google_calls == []


async def test_the_standby_key_is_refused_on_a_turn_path(hub):
    verify, google_calls, state = hub
    standbys = _Standbys(_standby_row())
    request = _request(STANDBY, epoch=0)
    assert await verify(request, row=_row(placement_epoch=0), standbys=standbys) is None
    assert google_calls == [] and state["pulls"] == []


async def test_the_standby_key_is_accepted_on_a_sync_path_without_latching(hub):
    verify, google_calls, state = hub
    standbys = _Standbys(_standby_row())
    pod = await verify(
        _request(STANDBY, epoch=0), row=_row(placement_epoch=0), standbys=standbys, sync_path=True
    )
    assert pod == prs.VerifiedPod(OWNER, key_id=_public(STANDBY)[1], standby=True)
    assert state["store"].latched == [] and google_calls == []


async def test_the_primary_key_is_accepted_on_both_path_classes(hub):
    verify, *_ = hub
    for sync_path in (False, True):
        standbys = _Standbys(_standby_row())
        pod = await verify(
            _request(PRIMARY, epoch=0),
            row=_row(placement_epoch=0),
            standbys=standbys,
            sync_path=sync_path,
        )
        assert pod == prs.VerifiedPod(OWNER, key_id=_public(PRIMARY)[1])


async def test_an_unreadable_standby_is_invalid_not_a_guess(hub):
    verify, google_calls, _ = hub
    standbys = _Standbys(fail=True)
    assert (
        await verify(_request(PRIMARY, epoch=0), row=_row(placement_epoch=0), standbys=standbys)
        is None
    )
    assert google_calls == []


async def test_ambiguous_placement_keys_are_invalid(hub):
    verify, google_calls, _ = hub
    standbys = _Standbys(_standby_row(PRIMARY))
    request = _request(PRIMARY, epoch=0)
    assert await verify(request, row=_row(placement_epoch=0), standbys=standbys) is None
    assert google_calls == []


async def test_a_fenced_unknown_key_is_invalid_after_one_pull():
    row = _row(placement_epoch=1)
    registry = _Registry(row)
    pulls: list[str] = []

    async def refresh(_row: dict) -> str:
        pulls.append(_row["hushh_id"])
        return "provisioned"

    body = b"{}"
    headers = {POD_IDENTITY_HEADER: OWNER}
    headers.update(
        prs.sign_pod_request(
            STRANGER, aud=AUD, hushh_id=OWNER, method="POST", path=PATH, query_pairs=[],
            body=body, epoch=1,
        )
    )  # fmt: skip
    decision = await verify_signed_request(
        SignedRequest(headers=headers, method="POST", path=PATH, query_pairs=[], body=body),
        aud=AUD,
        registry=registry,
        store=_Store(registry),
        refresh=refresh,
        cap=PullCap(),
        standbys=_Standbys(None),
    )
    assert decision.outcome is SignedOutcome.INVALID  # never KEY_UNRESOLVED once fenced
    assert pulls == [OWNER]


def test_the_hub_caller_wires_a_standby_reader_by_default():
    from hushh_mcp.services.personal_agent_standby_store import PersonalAgentStandbyStore

    assert isinstance(pia._standby_store(), PersonalAgentStandbyStore)
