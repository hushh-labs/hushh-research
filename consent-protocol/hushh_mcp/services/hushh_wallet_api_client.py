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

# `generic`, not `storeCard`. A storeCard reserves a full-width strip band at
# the top and renders the primary field inside it; with no strip image that band
# collapses into a large empty slab of background — which is exactly how the
# first build looked on device. `generic` has no strip, so a sparse card stays
# compact instead of stranding the holder's name above a void.
PASS_STYLE = "generic"  # noqa: S105 — pass style, not a credential

# Apple's icon sizes at @1x/@2x/@3x. The icon is what Wallet shows on the lock
# screen and in notifications; a pass without one renders a grey placeholder.
_ICON_SCALES = {"icon.png": 29, "icon@2x.png": 58, "icon@3x.png": 87}

# The logo sits top-left, and the signing service forces `logoText` to "HUSHH"
# beside it — an empty string does not suppress it. So the logo must be a MARK,
# not a wordmark: a "hussh" wordmark next to "HUSHH" reads as a stutter. The app
# icon tile is the mark, at the logo slot's 50pt height.
_LOGO_SCALES = {"logo.png": 50, "logo@2x.png": 100, "logo@3x.png": 150}

# NOT a directory named `assets`: the repo-root .gcloudignore excludes
# `assets/` at any depth for the frontend's large media, which silently
# stripped this icon from the Cloud Build context and shipped a
# placeholder pass. `test_pass_assets_reach_the_deployed_image` guards it.
_ASSET_DIR = Path(__file__).with_name("pass_assets")
_ICON_SOURCE = _ASSET_DIR / "hushh_pass_icon.png"

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


# Front-of-card rows in the order a stranger wants them, richest identity
# signal first. The card fills from whatever the owner actually shared rather
# than from fixed slots: a profile carrying only a name and an email must not
# render one line above an empty card, which is what a fixed mapping produced.
_DISPLAY_ROWS: tuple[tuple[str, str], ...] = (
    ("headline", "Role"),
    ("organisation", "Organisation"),
    ("location_label", "Location"),
    ("email", "Email"),
    ("phone", "Phone"),
    ("website", "Link"),
)

# Apple caps a generic pass carrying a square barcode at four secondary and
# auxiliary fields combined.
_MAX_FRONT_ROWS = 4


def _fields(content: WalletPassContent) -> dict[str, list[dict[str, str]]]:
    """Front-of-card fields, packed from whatever the owner shared.

    The holder's name is the hero and carries no label — a label above a name
    reads like a form. Everything else fills the remaining rows in priority
    order and the rest goes to the back, so the front is never empty and never
    overflows Apple's budget.
    """
    rows: list[dict[str, str]] = []
    for attribute, label in _DISPLAY_ROWS:
        if len(rows) == _MAX_FRONT_ROWS:
            break
        field = _text_field(attribute, getattr(content, attribute, ""), label=label)
        if field:
            rows.append(field)

    return {
        "primaryFields": _present(_text_field("holder", content.full_name, label="")),
        "secondaryFields": rows[:2],
        "auxiliaryFields": rows[2:_MAX_FRONT_ROWS],
        "backFields": _build_back_fields(content),
    }


def build_pass_request(content: WalletPassContent) -> dict[str, Any]:
    """The JSON body `hushh-wallet-api` expects for one Wallet Profile pass."""
    body: dict[str, Any] = {
        "passType": PASS_STYLE,
        "description": PASS_DESCRIPTION,
        "organizationName": ORGANIZATION_NAME,
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
