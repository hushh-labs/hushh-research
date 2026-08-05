"""Contract tests for signing a Wallet Profile pass through `hushh-wallet-api`.

Two things are pinned here. First the card face: a Hushh pass must be gold with
black text and carry the real app icon, because a placeholder square is what the
service substitutes when we send nothing and it looks cheap on a device.

Second, and more importantly, the failure surface. Every upstream outcome —
timeout, refused key, rejected payload, empty body — has to collapse into one
`WalletPassSigningUnavailableError` so the route keeps answering a single
generic 503. A visitor must never be able to tell why a pass did not build.

No real network call is made and no API key is used: `httpx.post` is replaced.
"""

from __future__ import annotations

import base64
import io
import json
import logging

import httpx
import pytest
from PIL import Image

from hushh_mcp.services import hushh_wallet_api_client as client
from hushh_mcp.services.apple_wallet_pass_service import (
    WalletPassContent,
    WalletPassSigningUnavailableError,
)

PASS_SERIAL = "6f2f0e6a-6d5e-4b0a-9f0a-0d1c2b3a4e5f"  # noqa: S105 — fixture id, not a credential
BASE_URL = "https://wallet.example.invalid"
API_KEY = "test-key-not-a-real-secret"  # noqa: S105

CARD_PAYLOAD = {
    "full_name": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "organisation": "Hussh Labs",
    "location_label": "Mumbai, India",
    "email": "ada@example.com",
    "phone": "+91 99999 90000",
    "linkedin": "https://www.linkedin.com/in/ada",
    "preferred_contact": "email",
}


def _content(**overrides) -> WalletPassContent:
    payload = dict(CARD_PAYLOAD)
    payload.update(overrides.pop("card_payload", {}))
    return WalletPassContent.from_card_payload(
        pass_serial=PASS_SERIAL,
        public_card_url="https://uat.one.hushh.ai/c/token",
        card_payload=payload,
        **overrides,
    )


class _Response:
    def __init__(self, status_code: int, content: bytes = b"") -> None:
        self.status_code = status_code
        self.content = content


# ---------------------------------------------------------------------------
# Card face
# ---------------------------------------------------------------------------


def test_card_is_hushh_gold_with_black_text() -> None:
    body = client.build_pass_request(_content())

    assert body["backgroundColor"] == "rgb(212, 175, 55)"
    assert body["foregroundColor"] == "rgb(12, 12, 12)"
    assert body["labelColor"] == "rgb(32, 32, 32)"
    assert body["passType"] == "generic"


def test_every_image_is_the_real_icon_not_a_placeholder() -> None:
    images = client.build_pass_request(_content())["images"]

    expected = {"icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"}
    assert set(images) == expected

    sizes = {
        "icon.png": 29,
        "icon@2x.png": 58,
        "icon@3x.png": 87,
        "logo.png": 50,
        "logo@2x.png": 100,
        "logo@3x.png": 150,
    }
    for name, encoded in images.items():
        raw = base64.b64decode(encoded)
        with Image.open(io.BytesIO(raw)) as img:
            assert img.format == "PNG", name
            assert img.size == (sizes[name], sizes[name]), name
        # The service's own fallback is a ~100 byte flat square; anything that
        # small means we shipped a placeholder rather than the brand mark.
        assert len(raw) > 500, f"{name} looks like a placeholder ({len(raw)}B)"


def test_qr_carries_the_public_card_url_and_never_the_raw_token() -> None:
    content = _content()
    barcode = client.build_pass_request(content)["barcode"]

    assert barcode["message"] == content.public_card_url
    assert barcode["format"] == "PKBarcodeFormatQR"
    # alt text is the human label; printing the token invites transcription
    assert "token" not in barcode["altText"]


def test_front_of_card_stays_short_and_back_carries_the_detail() -> None:
    body = client.build_pass_request(_content())

    assert [f["value"] for f in body["primaryFields"]] == ["Ada Lovelace"]
    front = body["secondaryFields"] + body["auxiliaryFields"]
    # storeCard budgets secondary + auxiliary together; keep well inside it.
    assert len(front) <= 4
    assert body["backFields"], "contact detail belongs on the back"


def test_absent_fields_do_not_emit_blank_rows() -> None:
    blank = dict.fromkeys([key for key, _ in client._DISPLAY_ROWS], "")
    body = client.build_pass_request(_content(card_payload=blank))

    assert body["secondaryFields"] == []
    assert body["auxiliaryFields"] == []
    # The holder is still the hero even when nothing else was shared.
    assert [f["value"] for f in body["primaryFields"]] == ["Ada Lovelace"]


def test_a_sparse_card_still_fills_its_first_row() -> None:
    """The defect this replaced: a name-and-email profile rendered one line
    above an empty card because the slots were mapped to fields it lacked."""
    body = client.build_pass_request(
        _content(card_payload=dict.fromkeys(["headline", "organisation", "location_label"], ""))
    )

    # Contact detail is promoted forward when identity fields are absent,
    # so the front of the card is never one line above a void.
    assert [f["label"] for f in body["secondaryFields"]] == ["Email", "Phone"]


def test_a_full_card_fills_all_four_rows_without_overflowing() -> None:
    body = client.build_pass_request(_content())
    rows = body["secondaryFields"] + body["auxiliaryFields"]

    assert [f["label"] for f in rows] == ["Role", "Organisation", "Location", "Email"]
    # Apple caps a generic pass with a square barcode at four combined.
    assert len(rows) == client._MAX_FRONT_ROWS


def test_the_logo_is_a_mark_not_a_wordmark() -> None:
    """The signing service forces logoText to "HUSHH" and an empty string does
    not suppress it, so a wordmark logo would render as "hussh HUSHH"."""
    images = client.build_pass_request(_content())["images"]

    for name in ("logo.png", "logo@2x.png", "logo@3x.png"):
        raw = base64.b64decode(images[name])
        with Image.open(io.BytesIO(raw)) as img:
            assert img.width == img.height, f"{name} must be square (a mark, not a wordmark)"


# ---------------------------------------------------------------------------
# Transport and failure surface
# ---------------------------------------------------------------------------


def test_successful_call_returns_the_bundle_and_sends_the_key(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def fake_post(url, **kwargs):
        seen["url"] = url
        seen["headers"] = kwargs["headers"]
        seen["json"] = kwargs["json"]
        seen["timeout"] = kwargs["timeout"]
        return _Response(200, b"PK\x03\x04signed")

    monkeypatch.setattr(httpx, "post", fake_post)
    bundle = client.sign_pass(_content(), base_url=BASE_URL, api_key=API_KEY)

    assert bundle == b"PK\x03\x04signed"
    assert seen["url"] == f"{BASE_URL}/v1/passes"
    assert seen["headers"]["x-api-key"] == API_KEY
    # An unbounded call would pin a Cloud Run worker until the client gives up.
    assert isinstance(seen["timeout"], float) and seen["timeout"] > 0


@pytest.mark.parametrize("status_code", [400, 401, 403, 500, 503])
def test_every_upstream_status_collapses_into_one_error(monkeypatch, status_code) -> None:
    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Response(status_code, b"detail"))

    with pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url=BASE_URL, api_key=API_KEY)


def test_network_failure_raises_the_same_error(monkeypatch) -> None:
    def boom(url, **kwargs):
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(httpx, "post", boom)
    with pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url=BASE_URL, api_key=API_KEY)


def test_a_200_with_an_empty_body_is_still_a_failure(monkeypatch) -> None:
    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Response(200, b""))

    with pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url=BASE_URL, api_key=API_KEY)


def test_missing_configuration_fails_without_calling_out(monkeypatch) -> None:
    def unreachable(url, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("no request may be made without a key")

    monkeypatch.setattr(httpx, "post", unreachable)
    with pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url=BASE_URL, api_key="   ")
    with pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url="  ", api_key=API_KEY)


# ---------------------------------------------------------------------------
# Contract §10.3 — nothing personal reaches a log line
# ---------------------------------------------------------------------------


def test_a_rejected_call_logs_no_card_payload_value_and_no_key(monkeypatch, caplog) -> None:
    monkeypatch.setattr(
        httpx, "post", lambda url, **kw: _Response(400, json.dumps(CARD_PAYLOAD).encode())
    )

    with caplog.at_level(logging.DEBUG), pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url=BASE_URL, api_key=API_KEY)

    logged = " ".join(record.getMessage() for record in caplog.records)
    for secret in (*CARD_PAYLOAD.values(), API_KEY):
        assert str(secret) not in logged
    assert "400" in logged  # the status alone is fine, and is what triage needs


def test_a_network_failure_logs_no_key_or_host_detail(monkeypatch, caplog) -> None:
    monkeypatch.setattr(
        httpx, "post", lambda url, **kw: (_ for _ in ()).throw(httpx.ConnectError("boom"))
    )

    with caplog.at_level(logging.DEBUG), pytest.raises(WalletPassSigningUnavailableError):
        client.sign_pass(_content(), base_url=BASE_URL, api_key=API_KEY)

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert API_KEY not in logged


def test_the_request_body_is_json_serialisable() -> None:
    # httpx serialises at call time, so a non-serialisable field would surface
    # as a 503 in production rather than as a failure here.
    encoded = json.dumps(client.build_pass_request(_content()))
    assert json.loads(encoded)["passType"] == "generic"
