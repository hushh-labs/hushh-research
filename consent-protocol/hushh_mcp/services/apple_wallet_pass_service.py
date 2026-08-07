"""Apple Wallet `.pkpass` construction and PKCS#7 signing for the Wallet Profile.

This module is a pure, self-contained pass factory: given the card content and
the signing material it returns the signed `.pkpass` archive as bytes. It does
no database access, holds no global state, and makes **no network calls** — the
caller supplies both the public card URL and (optionally) the raw avatar bytes.

Two design decisions are baked in here and are worth stating up front.

**No Wallet web service.** `webServiceURL` and `authenticationToken` are
deliberately omitted. Apple's pass reference makes them optional; only
`formatVersion`, `passTypeIdentifier`, `teamIdentifier`, `organizationName`,
`description` and `serialNumber` are required. Because the QR code carries a
URL that is resolved server-side on every scan, edit / pause / rotate / revoke
take effect instantly with zero Wallet involvement. That removes APNs, device
registration, a registrations table and five endpoints from the system. The
accepted cost is that the text *printed* on an installed pass, and the QR
payload baked into it, cannot be changed after installation — so the pass face
is kept minimal and stable and everything volatile lives behind the QR.

**Re-issue overwrites in place.** Wallet keys an installed pass on
`passTypeIdentifier` + `serialNumber`. `pass_serial` is minted once per user and
never changes, so re-adding a pass after a token rotation silently replaces the
previously installed one instead of stacking a duplicate — the user re-adds with
a single tap and the stale QR stops resolving.

Privacy notes: no `card_payload` value, share token or key material is ever
logged, personal fields are excluded from dataclass `repr` so they cannot leak
through a traceback, and an uploaded avatar is re-encoded into a fresh image so
EXIF metadata (including GPS coordinates) never reaches the pass bundle.
"""

from __future__ import annotations

import colorsys
import hashlib
import io
import json
import logging
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs7
from PIL import Image, ImageDraw, ImageFont, ImageOps

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------

# ruff's S105 heuristic flags any constant whose name contains "pass"; every
# constant below is public pass-format metadata, not a credential.
PASS_TYPE_IDENTIFIER = "pass.com.hushh.app.one"  # noqa: S105
ORGANIZATION_NAME = "Hussh"
PASS_DESCRIPTION = "Hussh One profile"  # noqa: S105
PASS_LOGO_TEXT = "Hussh One"  # noqa: S105

WALLET_PASS_CONTENT_TYPE = "application/vnd.apple.pkpass"  # noqa: S105
WALLET_PASS_FILENAME = "hushh-one.pkpass"  # noqa: S105

# User-facing failure copy (contract §9). The technical cause is logged
# server-side only and is never returned to the client.
WALLET_PASS_UNAVAILABLE_CODE = "wallet_pass_unavailable"  # noqa: S105
WALLET_PASS_UNAVAILABLE_MESSAGE = "Couldn't create your pass. Try again in a moment."  # noqa: S105

_CARD_BACKGROUND_COLOR = "rgb(12, 13, 17)"
_CARD_FOREGROUND_COLOR = "rgb(255, 255, 255)"
_CARD_LABEL_COLOR = "rgb(152, 156, 166)"

# Apple system blue — the product accent (`--app-accent: #007aff`).
_BRAND_ACCENT_RGB = (0, 122, 255)
_MARK_RGB = (255, 255, 255)

# Point sizes from Apple's pass design guidance; each is emitted at @1x/@2x/@3x.
_ICON_POINT_SIZE = 29
_LOGO_POINT_SIZE = 50
_THUMBNAIL_POINT_SIZE = 90
_IMAGE_SCALES = (1, 2, 3)

# Supersampling factor for the vector-drawn brand mark before LANCZOS downscale.
_MARK_SUPERSAMPLE = 4

# Proportions of the drawn "H": glyph box aspect, stem width and crossbar height
# as fractions of that box. Tuned once, reused at every raster size.
_MARK_ASPECT = 0.93
_MARK_STEM_RATIO = 0.31
_MARK_BAR_RATIO = 0.25

# Margin around the mark: the icon is a coloured tile and needs padding, the
# transparent logo sits alone in its slot and should fill it.
_ICON_MARK_INSET = 0.22
_LOGO_MARK_INSET = 0.06

# Refuse absurd avatar uploads before Pillow touches them.
_MAX_AVATAR_BYTES = 8 * 1024 * 1024
_MAX_AVATAR_PIXELS = 40_000_000

# Fixed zip timestamp so an unchanged card always produces byte-identical output.
_ZIP_TIMESTAMP = (2001, 1, 1, 0, 0, 0)

# Apple's pass format specifies SHA-1 digests in manifest.json. This is a
# format requirement, not a security control — the integrity guarantee comes
# from the PKCS#7 signature over manifest.json below.
_MANIFEST_EXCLUDED = frozenset({"manifest.json", "signature", ".DS_Store"})

_CERT_EXPIRY_WARNING_DAYS = 30

# `altText` is the short caption Wallet renders beneath the barcode; anything
# longer than this is truncated by the UI anyway.
_ALT_TEXT_MAX_CHARS = 32

# Subject attribute Apple uses to carry the pass type identifier in the
# Pass Type ID certificate (userId / UID).
_UID_OID = x509.ObjectIdentifier("0.9.2342.19200300.100.1.1")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class WalletPassError(RuntimeError):
    """Base class for every Wallet pass generation failure."""


class WalletPassSigningUnavailableError(WalletPassError):
    """Signing material is missing, malformed, mismatched or expired.

    The route layer catches this and returns the friendly 503 copy; the
    underlying cryptographic detail stays in the server log.
    """


class WalletPassBuildError(WalletPassError):
    """The supplied card content cannot be rendered into a valid pass."""


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WalletPassSigningMaterial:
    """PEM material and identifiers needed to sign one pass.

    Every PEM is `repr=False` so the private key can never surface in a log
    line, an exception repr or a traceback frame dump.
    """

    team_identifier: str
    certificate_pem: str = field(repr=False, default="")
    private_key_pem: str = field(repr=False, default="")
    wwdr_pem: str = field(repr=False, default="")
    pass_type_identifier: str = PASS_TYPE_IDENTIFIER

    @property
    def configured(self) -> bool:
        return bool(
            self.team_identifier.strip()
            and self.certificate_pem.strip()
            and self.private_key_pem.strip()
            and self.wwdr_pem.strip()
            and self.pass_type_identifier.strip()
        )

    @classmethod
    def from_runtime_settings(cls) -> WalletPassSigningMaterial:
        """Read the signing material from backend runtime settings.

        The import is function-local on purpose: a deployment that has not yet
        provisioned the Wallet settings block degrades into the friendly 503
        for this one route instead of failing the whole backend at import time.
        """
        try:
            from hushh_mcp.runtime_settings import get_wallet_pass_settings
        except ImportError as exc:
            raise WalletPassSigningUnavailableError(
                "Wallet pass runtime settings are not available in this build."
            ) from exc

        settings = get_wallet_pass_settings()
        return cls(
            team_identifier=str(settings.team_identifier or "").strip(),
            certificate_pem=_normalize_pem(settings.cert_pem),
            private_key_pem=_normalize_pem(settings.key_pem),
            wwdr_pem=_normalize_pem(settings.wwdr_pem),
            pass_type_identifier=(
                str(settings.pass_type_identifier or "").strip() or PASS_TYPE_IDENTIFIER
            ),
        )


@dataclass(frozen=True)
class WalletPassContent:
    """Everything printed on, or linked from, one Wallet Profile pass.

    All personal fields are `repr=False`: contract §10.3 forbids logging any
    `card_payload` value, and dataclass reprs are the easiest way to leak one.
    """

    pass_serial: str
    public_card_url: str
    full_name: str = field(repr=False, default="")
    headline: str = field(repr=False, default="")
    organisation: str = field(repr=False, default="")
    location_label: str = field(repr=False, default="")
    summary: str = field(repr=False, default="")
    skills: tuple[str, ...] = field(repr=False, default=())
    email: str = field(repr=False, default="")
    phone: str = field(repr=False, default="")
    website: str = field(repr=False, default="")
    linkedin: str = field(repr=False, default="")
    github: str = field(repr=False, default="")
    portfolio: str = field(repr=False, default="")
    preferred_contact: str = field(repr=False, default="")
    expires_at: datetime | None = field(repr=False, default=None)

    @classmethod
    def from_card_payload(
        cls,
        *,
        pass_serial: str,
        public_card_url: str,
        card_payload: dict[str, Any] | None = None,
        display_name: str | None = None,
        headline: str | None = None,
        expires_at: datetime | None = None,
    ) -> WalletPassContent:
        """Project a stored card row onto the pass face.

        Only allowlisted `card_payload` keys are read (contract §3); anything
        else in the payload is ignored here. The denormalised `display_name` /
        `headline` columns act as fallbacks so a card whose payload predates a
        column still renders.
        """
        payload = card_payload if isinstance(card_payload, dict) else {}
        return cls(
            pass_serial=_clean(pass_serial),
            public_card_url=_clean(public_card_url),
            full_name=_clean(payload.get("full_name")) or _clean(display_name),
            headline=_clean(payload.get("headline")) or _clean(headline),
            organisation=_clean(payload.get("organisation")),
            location_label=_clean(payload.get("location_label")),
            summary=_clean(payload.get("summary")),
            skills=_clean_str_tuple(payload.get("skills")),
            email=_clean(payload.get("email")),
            phone=_clean(payload.get("phone")),
            website=_clean(payload.get("website")),
            linkedin=_clean(payload.get("linkedin")),
            github=_clean(payload.get("github")),
            portfolio=_clean(payload.get("portfolio")),
            preferred_contact=_clean(payload.get("preferred_contact")).lower(),
            expires_at=expires_at,
        )

    @property
    def alt_text(self) -> str:
        """Short human label rendered under the QR code.

        Never the share token: the token is inside the QR payload already, and
        printing it as legible text invites shoulder-surfing transcription.
        Capped so a long legal name cannot crowd the barcode caption.
        """
        label = self.full_name or PASS_LOGO_TEXT
        if len(label) <= _ALT_TEXT_MAX_CHARS:
            return label
        return f"{label[: _ALT_TEXT_MAX_CHARS - 1].rstrip()}…"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _clean_str_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(_clean(item) for item in value if _clean(item))


def _normalize_pem(value: Any) -> str:
    """Accept PEM material that arrived with literal `\\n` escapes.

    Secret Manager round-trips and some CI shells turn real newlines into the
    two-character sequence; without this every PEM would fail to parse.
    """
    text = _clean(value)
    if not text:
        return ""
    if "\\n" in text and "\n" not in text:
        text = text.replace("\\n", "\n")
    return text


def _sha1_hex(data: bytes) -> str:
    """SHA-1 digest for manifest.json.

    Mandated by Apple's pass format. `usedforsecurity=False` records that this
    is a format-compatibility digest: tamper resistance is provided by the
    PKCS#7 signature over the manifest, not by this hash.
    """
    return hashlib.sha1(data, usedforsecurity=False).hexdigest()


def _scaled_filename(base: str, scale: int) -> str:
    return f"{base}.png" if scale == 1 else f"{base}@{scale}x.png"


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _w3c_datetime(value: datetime) -> str:
    moment = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _text_field(key: str, value: str, *, label: str = "") -> dict[str, str] | None:
    """Build one pass field, or `None` when the value is absent.

    Callers filter the `None`s out. Emitting an empty row instead would leave a
    labelled blank on the pass face that the user can never fill in.
    """
    cleaned = _clean(value)
    if not cleaned:
        return None
    entry: dict[str, str] = {"key": key, "value": cleaned}
    if label:
        entry["label"] = label
    return entry


def _present(*fields: dict[str, str] | None) -> list[dict[str, str]]:
    return [entry for entry in fields if entry is not None]


# ---------------------------------------------------------------------------
# pass.json
# ---------------------------------------------------------------------------


def _preferred_contact_label(choice: str) -> str:
    return {
        "email": "Email",
        "phone": "Phone",
        "linkedin": "LinkedIn",
        "website": "Website",
    }.get(choice, "")


def _build_back_fields(content: WalletPassContent) -> list[dict[str, str]]:
    """Back-of-pass rows. Unlimited by Apple; every row is omitted when empty.

    Wallet's data detectors turn plain email addresses, phone numbers and URLs
    in `value` into tappable actions, so no attributedValue markup is needed.
    """
    skills = " · ".join(content.skills)
    preferred = _preferred_contact_label(content.preferred_contact)

    return _present(
        _text_field("summary", content.summary, label="About"),
        _text_field("skills", skills, label="Skills"),
        _text_field("email", content.email, label="Email"),
        _text_field("phone", content.phone, label="Phone"),
        _text_field("website", content.website, label="Website"),
        _text_field("linkedin", content.linkedin, label="LinkedIn"),
        _text_field("github", content.github, label="GitHub"),
        _text_field("portfolio", content.portfolio, label="Portfolio"),
        _text_field("preferred_contact", preferred, label="Preferred contact"),
        _text_field("profile_link", content.public_card_url, label="Profile link"),
        _text_field(
            "how_it_works",
            "Scan the code on the front to open this profile.",
            label="How this works",
        ),
        _text_field(
            "control",
            "Only what you pick is visible. Change or switch it off anytime.",
            label="You choose what shows",
        ),
    )


def _build_pass_json(
    content: WalletPassContent,
    material: WalletPassSigningMaterial,
) -> dict[str, Any]:
    """Assemble pass.json for the `generic` style.

    Front-field budget for a generic pass with a square barcode: up to 3 header
    fields, 1 primary field, and 4 secondary + auxiliary fields *combined*. We
    use 0 header (the logo text carries the brand), 1 primary, and at most 3
    combined — always inside the cap, whatever the user filled in.

    `webServiceURL` and `authenticationToken` are intentionally absent: there is
    no Wallet web service (see the module docstring).
    """
    secondary = _present(_text_field("headline", content.headline))
    auxiliary = _present(
        _text_field("organisation", content.organisation, label="Organisation"),
        _text_field("location", content.location_label, label="Location"),
    )

    primary = _present(
        _text_field("name", content.full_name or PASS_LOGO_TEXT),
    )

    generic: dict[str, list[dict[str, str]]] = {"primaryFields": primary}
    if secondary:
        generic["secondaryFields"] = secondary
    if auxiliary:
        generic["auxiliaryFields"] = auxiliary
    generic["backFields"] = _build_back_fields(content)

    pass_json: dict[str, Any] = {
        "formatVersion": 1,
        "passTypeIdentifier": material.pass_type_identifier,
        "teamIdentifier": material.team_identifier,
        "organizationName": ORGANIZATION_NAME,
        "description": PASS_DESCRIPTION,
        "serialNumber": content.pass_serial,
        "logoText": PASS_LOGO_TEXT,
        "backgroundColor": _CARD_BACKGROUND_COLOR,
        "foregroundColor": _CARD_FOREGROUND_COLOR,
        "labelColor": _CARD_LABEL_COLOR,
        "sharingProhibited": True,
        "barcodes": [
            {
                "format": "PKBarcodeFormatQR",
                "message": content.public_card_url,
                "messageEncoding": "iso-8859-1",
                "altText": content.alt_text,
            }
        ],
        "generic": generic,
    }

    if content.expires_at is not None:
        pass_json["expirationDate"] = _w3c_datetime(content.expires_at)

    return pass_json


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def _draw_brand_mark(
    size: int,
    *,
    background: tuple[int, int, int] | None,
    mark: tuple[int, int, int],
    inset: float = _ICON_MARK_INSET,
) -> Image.Image:
    """Draw the Hussh "H" mark as vector primitives at `size` × `size`.

    Deliberately font-free: the mark must render identically on a developer Mac
    and in the Linux container, and no system typeface is guaranteed in either.
    Drawn 4× oversized and LANCZOS-downscaled for clean antialiased edges.

    `inset` is the margin around the mark as a fraction of the canvas — a tile
    with a coloured background needs breathing room, a transparent logo should
    fill its slot.
    """
    scale = size * _MARK_SUPERSAMPLE
    canvas_fill = (*background, 255) if background is not None else (0, 0, 0, 0)
    canvas = Image.new("RGBA", (scale, scale), canvas_fill)
    draw = ImageDraw.Draw(canvas)

    # Glyph box, centred inside the inset margin. The mark is slightly wider
    # than tall (_MARK_ASPECT), the proportions of a geometric grotesque "H".
    box_height = scale * (1.0 - 2.0 * inset)
    box_width = box_height * _MARK_ASPECT
    left = (scale - box_width) / 2.0
    top = (scale - box_height) / 2.0

    stem_width = box_width * _MARK_STEM_RATIO
    bar_height = box_height * _MARK_BAR_RATIO
    fill = (*mark, 255)

    left_stem_x = left + stem_width
    right_stem_x = left + box_width - stem_width
    bar_top = top + (box_height - bar_height) / 2.0

    draw.rounded_rectangle(
        (left, top, left_stem_x, top + box_height),
        radius=stem_width / 2.0,
        fill=fill,
    )
    draw.rounded_rectangle(
        (right_stem_x, top, left + box_width, top + box_height),
        radius=stem_width / 2.0,
        fill=fill,
    )
    draw.rounded_rectangle(
        (left, bar_top, left + box_width, bar_top + bar_height),
        radius=bar_height / 2.0,
        fill=fill,
    )

    return canvas.resize((size, size), Image.LANCZOS)


def _monogram_palette(seed: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """Deterministic, muted two-stop gradient derived from the user's name."""
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    hue = digest[0] / 255.0
    top = colorsys.hsv_to_rgb(hue, 0.52, 0.64)
    bottom = colorsys.hsv_to_rgb(hue, 0.62, 0.34)
    return (
        tuple(int(round(channel * 255)) for channel in top),  # type: ignore[return-value]
        tuple(int(round(channel * 255)) for channel in bottom),  # type: ignore[return-value]
    )


def _vertical_gradient(
    size: int,
    top: tuple[int, int, int],
    bottom: tuple[int, int, int],
) -> Image.Image:
    canvas = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(canvas)
    span = max(size - 1, 1)
    for row in range(size):
        ratio = row / span
        draw.line(
            [(0, row), (size, row)],
            fill=tuple(
                int(round(top[channel] + (bottom[channel] - top[channel]) * ratio))
                for channel in range(3)
            ),
        )
    return canvas


def _initials(full_name: str) -> str:
    """First + last initial, restricted to glyphs the bundled font actually has.

    Anything outside Latin-1 letters returns "" so the caller falls back to the
    brand mark rather than rendering a row of .notdef boxes.
    """
    tokens = [token for token in full_name.split() if token]
    if not tokens:
        return ""
    candidates = [tokens[0][0]] if len(tokens) == 1 else [tokens[0][0], tokens[-1][0]]
    letters = [char.upper() for char in candidates if char.isalpha() and ord(char) < 0x100]
    if len(letters) != len(candidates):
        return ""
    return "".join(letters)


def _monogram_thumbnail(size: int, initials: str, seed: str) -> Image.Image:
    """Built-in avatar fallback: initials on a deterministic gradient."""
    top, bottom = _monogram_palette(seed)
    canvas = _vertical_gradient(size, top, bottom).convert("RGBA")

    if not initials:
        mark = _draw_brand_mark(size, background=None, mark=_MARK_RGB)
        canvas.alpha_composite(mark)
        return canvas.convert("RGB")

    # Pillow's bundled Aileron face — scalable and shipped with the wheel, so
    # it renders identically everywhere without a system font dependency.
    font = ImageFont.load_default(size=int(size * 0.42))
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (size / 2, size / 2),
        initials,
        font=font,
        fill=(255, 255, 255, 235),
        anchor="mm",
    )
    return canvas.convert("RGB")


def _decode_avatar(data: bytes) -> Image.Image | None:
    """Decode an avatar into a square RGB master, or `None` on any problem.

    Re-encoding through a fresh canvas strips every metadata block, so EXIF
    (including GPS coordinates) never travels inside the pass bundle. A failure
    here is never fatal — the caller falls back to the monogram.
    """
    if not data or len(data) > _MAX_AVATAR_BYTES:
        return None

    master_size = _THUMBNAIL_POINT_SIZE * max(_IMAGE_SCALES)
    try:
        with Image.open(io.BytesIO(data)) as source:
            width, height = source.size
            if width <= 0 or height <= 0 or width * height > _MAX_AVATAR_PIXELS:
                return None
            oriented = ImageOps.exif_transpose(source) or source
            square = ImageOps.fit(
                oriented.convert("RGB"),
                (master_size, master_size),
                method=Image.LANCZOS,
                centering=(0.5, 0.4),
            )
    except Exception:
        logger.info("wallet_pass.avatar_decode_failed; using generated fallback")
        return None

    # Copy the pixels into a brand-new image so no source metadata survives.
    clean = Image.new("RGB", (master_size, master_size))
    clean.paste(square)
    return clean


def _build_pass_images(
    content: WalletPassContent,
    avatar_image: bytes | None,
) -> dict[str, bytes]:
    """Every image the bundle needs, at @1x/@2x/@3x.

    `icon` and `logo` are required by Apple; `thumbnail` is the generic style's
    headshot slot. All three are always present — a user with no avatar gets the
    generated monogram rather than a pass that fails to build.
    """
    images: dict[str, bytes] = {}

    for scale in _IMAGE_SCALES:
        icon = _draw_brand_mark(
            _ICON_POINT_SIZE * scale,
            background=_BRAND_ACCENT_RGB,
            mark=_MARK_RGB,
        )
        images[_scaled_filename("icon", scale)] = _png_bytes(icon.convert("RGB"))

    for scale in _IMAGE_SCALES:
        logo = _draw_brand_mark(
            _LOGO_POINT_SIZE * scale,
            background=None,
            mark=_MARK_RGB,
            inset=_LOGO_MARK_INSET,
        )
        images[_scaled_filename("logo", scale)] = _png_bytes(logo)

    master = _decode_avatar(avatar_image) if avatar_image else None
    if master is None:
        master_size = _THUMBNAIL_POINT_SIZE * max(_IMAGE_SCALES)
        master = _monogram_thumbnail(
            master_size,
            _initials(content.full_name),
            content.full_name or content.pass_serial,
        )

    for scale in _IMAGE_SCALES:
        target = _THUMBNAIL_POINT_SIZE * scale
        thumbnail = (
            master
            if master.size == (target, target)
            else master.resize((target, target), Image.LANCZOS)
        )
        images[_scaled_filename("thumbnail", scale)] = _png_bytes(thumbnail)

    return images


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _SigningContext:
    certificate: x509.Certificate
    private_key: Any = field(repr=False, default=None)
    wwdr: x509.Certificate | None = None


def _load_signing_context(material: WalletPassSigningMaterial) -> _SigningContext:
    """Parse and sanity-check the PEM material.

    Fails closed on every problem — a pass signed with an expired or mismatched
    certificate installs nowhere, so a friendly 503 is more honest than handing
    the user a broken download.
    """
    if not material.configured:
        raise WalletPassSigningUnavailableError("Wallet pass signing material is not configured.")

    try:
        certificate = x509.load_pem_x509_certificate(material.certificate_pem.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise WalletPassSigningUnavailableError(
            f"Pass Type ID certificate could not be parsed ({type(exc).__name__})."
        ) from exc

    try:
        wwdr = x509.load_pem_x509_certificate(material.wwdr_pem.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise WalletPassSigningUnavailableError(
            f"WWDR intermediate certificate could not be parsed ({type(exc).__name__})."
        ) from exc

    try:
        private_key = serialization.load_pem_private_key(
            material.private_key_pem.encode("utf-8"),
            password=None,
        )
    except (ValueError, TypeError) as exc:
        # Only the exception *class* is reported: never the message, never the PEM.
        raise WalletPassSigningUnavailableError(
            f"Pass Type ID private key could not be loaded ({type(exc).__name__})."
        ) from exc

    _assert_key_matches_certificate(certificate, private_key)
    _assert_certificate_valid(certificate, material.pass_type_identifier)
    return _SigningContext(certificate=certificate, private_key=private_key, wwdr=wwdr)


def _assert_key_matches_certificate(certificate: x509.Certificate, private_key: Any) -> None:
    try:
        matches = certificate.public_key().public_numbers() == (
            private_key.public_key().public_numbers()
        )
    except AttributeError as exc:
        raise WalletPassSigningUnavailableError(
            "Pass Type ID key type is not supported for pass signing."
        ) from exc
    if not matches:
        raise WalletPassSigningUnavailableError(
            "Pass Type ID private key does not match the configured certificate."
        )


def _assert_certificate_valid(certificate: x509.Certificate, pass_type_identifier: str) -> None:
    now = datetime.now(UTC)
    not_after = certificate.not_valid_after_utc
    if not_after <= now:
        raise WalletPassSigningUnavailableError(
            f"Pass Type ID certificate expired on {not_after.date().isoformat()}."
        )
    if certificate.not_valid_before_utc > now:
        raise WalletPassSigningUnavailableError(
            "Pass Type ID certificate is not valid yet; check the runtime clock."
        )

    days_left = (not_after - now).days
    if days_left <= _CERT_EXPIRY_WARNING_DAYS:
        logger.warning(
            "wallet_pass.certificate_expiring days_left=%s not_after=%s",
            days_left,
            not_after.date().isoformat(),
        )

    # Soft check only: Apple carries the pass type id in the subject UID, but a
    # renewed certificate occasionally omits it. Mismatch is worth an operator
    # log line, not a hard failure.
    subject_uid = certificate.subject.get_attributes_for_oid(_UID_OID)
    if subject_uid and str(subject_uid[0].value) != pass_type_identifier:
        logger.warning(
            "wallet_pass.pass_type_identifier_mismatch configured=%s certificate=%s",
            pass_type_identifier,
            subject_uid[0].value,
        )


def _sign_manifest(manifest_bytes: bytes, context: _SigningContext) -> bytes:
    """PKCS#7 *detached* DER signature over manifest.json.

    `Binary` stops the CMS layer from normalising line endings in the payload;
    `DetachedSignature` keeps the manifest out of the signature blob, which is
    what Wallet expects. The WWDR intermediate rides along so the device can
    build the chain to the Apple root.
    """
    builder = (
        pkcs7.PKCS7SignatureBuilder()
        .set_data(manifest_bytes)
        .add_signer(context.certificate, context.private_key, hashes.SHA256())
    )
    if context.wwdr is not None:
        builder = builder.add_certificate(context.wwdr)

    try:
        return builder.sign(
            serialization.Encoding.DER,
            [pkcs7.PKCS7Options.DetachedSignature, pkcs7.PKCS7Options.Binary],
        )
    except (ValueError, TypeError) as exc:
        raise WalletPassSigningUnavailableError(
            f"Pass signature could not be produced ({type(exc).__name__})."
        ) from exc


# ---------------------------------------------------------------------------
# Bundle assembly
# ---------------------------------------------------------------------------


def build_manifest(files: dict[str, bytes]) -> bytes:
    """manifest.json: SHA-1 hex digest per bundle file, keyed by relative name.

    `.DS_Store`, the manifest itself and the signature are excluded. Keys are
    sorted so an unchanged card always serialises identically.
    """
    digests = {
        name: _sha1_hex(payload)
        for name, payload in files.items()
        if name not in _MANIFEST_EXCLUDED
    }
    return json.dumps(digests, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _zip_bundle(files: dict[str, bytes]) -> bytes:
    """Zip the bundle with a fixed timestamp so output stays reproducible."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(filename=name, date_time=_ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])
    return buffer.getvalue()


def _validate_content(content: WalletPassContent) -> None:
    if not content.pass_serial:
        raise WalletPassBuildError("pass_serial is required to build a Wallet pass.")
    if not content.public_card_url.startswith("https://"):
        raise WalletPassBuildError("The public card URL must be an https:// URL.")
    try:
        # `messageEncoding` governs the barcode payload only: a URL that cannot
        # round-trip through iso-8859-1 would scan as mojibake. `altText` is an
        # ordinary localisable string in UTF-8 pass.json and is deliberately NOT
        # checked here — holding it to Latin-1 would make a pass impossible for
        # anyone whose name is written in a non-Latin script.
        content.public_card_url.encode("iso-8859-1")
    except UnicodeEncodeError as exc:
        raise WalletPassBuildError("The public card URL must be encodable as iso-8859-1.") from exc


def build_pkpass(
    content: WalletPassContent,
    *,
    material: WalletPassSigningMaterial | None = None,
    avatar_image: bytes | None = None,
) -> bytes:
    """Build and sign one `.pkpass` archive and return it as bytes.

    Deterministic: the same content, avatar and signing material produce the
    same bundle (the PKCS#7 blob itself varies, as CMS signatures do).

    Raises:
        WalletPassBuildError: the card content cannot make a valid pass.
        WalletPassSigningUnavailableError: signing material missing or unusable
            — the route maps this to the friendly 503 copy.
    """
    _validate_content(content)

    signing_material = material or WalletPassSigningMaterial.from_runtime_settings()
    context = _load_signing_context(signing_material)

    files: dict[str, bytes] = dict(_build_pass_images(content, avatar_image))
    files["pass.json"] = json.dumps(
        _build_pass_json(content, signing_material),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    manifest = build_manifest(files)
    files["manifest.json"] = manifest
    files["signature"] = _sign_manifest(manifest, context)

    bundle = _zip_bundle(files)
    logger.info(
        "wallet_pass.built serial=%s files=%s bytes=%s",
        content.pass_serial,
        len(files),
        len(bundle),
    )
    return bundle


def wallet_pass_signing_available(
    material: WalletPassSigningMaterial | None = None,
) -> bool:
    """Cheap readiness probe for health checks and the owner setup screen.

    Never raises and never logs secrets; returns False for any configuration
    problem so callers can hide Add-to-Wallet instead of offering a download
    that would 503.
    """
    try:
        _load_signing_context(material or WalletPassSigningMaterial.from_runtime_settings())
        return True
    except WalletPassSigningUnavailableError as exc:
        logger.warning("wallet_pass.signing_unavailable: %s", exc)
        return False
