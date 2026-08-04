"""Sign Wallet Profile passes through the org-owned `hushh-wallet-api` service.

This is the alternative to signing locally in `apple_wallet_pass_service`. The
two produce the same *kind* of artifact — a signed `.pkpass` — but the signing
identity, and therefore the certificate custody, is different:

- local   -> `pass.com.hushh.app.one`, certificate in this project's Secret Manager
- service -> `pass.com.hushh.wallet`, certificate held by `hushh-wallet-api`

`wallet_pass_provider` chooses between them; nothing here decides policy.

The card face is deliberately plain: Hushh gold, black text, the official app
icon, and a QR. No strip, no thumbnail, no generated artwork — a membership
card reads as premium when it is uncluttered, and every image we do not send is
one fewer thing that can render badly on a device we cannot test.

Privacy: contract §10.3 forbids logging any `card_payload` value, so no field
value, no API key and no response body is ever logged. Failures are reported by
exception class only.
"""

from __future__ import annotations

import base64
import io
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
from PIL import Image

from hushh_mcp.services.apple_wallet_pass_service import (
    ORGANIZATION_NAME,
    PASS_DESCRIPTION,
    PASS_LOGO_TEXT,
    WalletPassContent,
    WalletPassSigningUnavailableError,
    _build_back_fields,
    _present,
    _text_field,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Card face
# ---------------------------------------------------------------------------

# Hushh gold, black text. These are the brand's own pass constants, not a
# per-user palette: every Hushh pass should be recognisable at a glance in a
# stack of cards.
CARD_BACKGROUND_COLOR = "rgb(212, 175, 55)"
CARD_FOREGROUND_COLOR = "rgb(12, 12, 12)"
CARD_LABEL_COLOR = "rgb(32, 32, 32)"

# `storeCard` is the membership-card style. It is the right shape for an
# identity card you hand someone, and — unlike `generic` — it does not reserve
# a thumbnail slot we deliberately leave empty.
PASS_STYLE = "storeCard"  # noqa: S105 — pass style, not a credential

# Apple's icon sizes at @1x/@2x/@3x. The icon is what Wallet shows on the lock
# screen and in notifications; a pass without one renders a grey placeholder.
_ICON_SCALES = {"icon.png": 29, "icon@2x.png": 58, "icon@3x.png": 87}

# The logo slot sits top-left, beside `logoText`. Apple allows up to 160x50, but
# the mark is square, so it is sent at the slot's 50pt height and Wallet renders
# the wordmark next to it in the system font. Sending nothing here is worse than
# it sounds: the service substitutes a blank placeholder square.
_LOGO_SCALES = {"logo.png": 50, "logo@2x.png": 100, "logo@3x.png": 150}

_ICON_SOURCE = Path(__file__).with_name("assets") / "hushh_pass_icon.png"

_REQUEST_TIMEOUT_SECONDS = 15.0


@lru_cache(maxsize=1)
def _icon_images() -> dict[str, str]:
    """Base64 PNGs of the official app icon, at every scale Wallet asks for.

    Cached: the source never changes at runtime, and LANCZOS-downscaling a
    1024px master six times per pass request would be pure waste.
    """
    try:
        with Image.open(_ICON_SOURCE) as opened:
            master = opened.convert("RGBA")
            out: dict[str, str] = {}
            for name, size in {**_ICON_SCALES, **_LOGO_SCALES}.items():
                buf = io.BytesIO()
                master.resize((size, size), Image.LANCZOS).save(buf, format="PNG")
                out[name] = base64.b64encode(buf.getvalue()).decode("ascii")
            return out
    except (OSError, ValueError) as exc:
        # A missing asset must not take the whole pass down: the service
        # substitutes its own placeholder, which is worse-looking but valid.
        logger.warning("wallet_pass.icon_unavailable error=%s", exc.__class__.__name__)
        return {}


def _fields(content: WalletPassContent) -> dict[str, list[dict[str, str]]]:
    """Front-of-card fields, ordered by what a stranger needs first.

    `storeCard` shows one primary plus a combined budget of secondary and
    auxiliary rows, so this stays deliberately short: who they are, what they
    do, where they are. Everything else lives on the back.
    """
    return {
        "primaryFields": _present(_text_field("holder", content.full_name, label="")),
        "secondaryFields": _present(
            _text_field("headline", content.headline, label="Role"),
            _text_field("organisation", content.organisation, label="Organisation"),
        ),
        "auxiliaryFields": _present(
            _text_field("location", content.location_label, label="Location"),
        ),
        "backFields": _build_back_fields(content),
    }


def build_pass_request(content: WalletPassContent) -> dict[str, Any]:
    """The JSON body `hushh-wallet-api` expects for one Wallet Profile pass."""
    body: dict[str, Any] = {
        "passType": PASS_STYLE,
        "description": PASS_DESCRIPTION,
        "organizationName": ORGANIZATION_NAME,
        "logoText": PASS_LOGO_TEXT,
        "backgroundColor": CARD_BACKGROUND_COLOR,
        "foregroundColor": CARD_FOREGROUND_COLOR,
        "labelColor": CARD_LABEL_COLOR,
        "barcode": {
            "message": content.public_card_url,
            "format": "PKBarcodeFormatQR",
            "altText": content.alt_text,
        },
        **_fields(content),
    }
    images = _icon_images()
    if images:
        body["images"] = images
    return body


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


def sign_pass(
    content: WalletPassContent,
    *,
    base_url: str,
    api_key: str,
    timeout_seconds: float = _REQUEST_TIMEOUT_SECONDS,
) -> bytes:
    """POST the card to `hushh-wallet-api` and return the signed `.pkpass`.

    Raises `WalletPassSigningUnavailableError` for every failure mode, so the
    route keeps answering its single friendly 503 instead of leaking whether
    the upstream was down, refused the key, or rejected the payload.
    """
    if not base_url.strip() or not api_key.strip():
        raise WalletPassSigningUnavailableError("Wallet pass service is not configured.")

    url = f"{base_url.rstrip('/')}/v1/passes"
    try:
        response = httpx.post(
            url,
            json=build_pass_request(content),
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            timeout=timeout_seconds,
        )
    except httpx.HTTPError as exc:
        # Network detail stays server-side; the class alone is enough to triage
        # a timeout from a DNS failure without naming the host in a log line.
        logger.error("wallet_pass.service_unreachable error=%s", exc.__class__.__name__)
        raise WalletPassSigningUnavailableError("Wallet pass service is unreachable.") from exc

    if response.status_code != 200:
        # Never log the body: a 400 echoes back the payload it rejected, which
        # would put card_payload values into the log.
        logger.error("wallet_pass.service_rejected status=%s", response.status_code)
        raise WalletPassSigningUnavailableError(
            f"Wallet pass service returned {response.status_code}."
        )

    bundle = response.content
    if not bundle:
        logger.error("wallet_pass.service_empty_bundle")
        raise WalletPassSigningUnavailableError("Wallet pass service returned no pass.")
    return bundle
