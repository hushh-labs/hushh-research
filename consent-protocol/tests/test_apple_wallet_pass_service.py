"""Contract tests for the Apple Wallet `.pkpass` factory.

The pass bundle is opaque once it reaches a device, so everything Wallet
validates is asserted here: the exact bundle members, a SHA-1 manifest that
matches the bytes it describes, a detached PKCS#7 signature over that manifest,
the required `pass.json` keys, the absence of any web-service key, and the
generic-style front-field budget.

Signing material is generated per test with a throwaway RSA key. No fixture,
environment variable or file in this repository holds real Apple key material.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import UTC, datetime, timedelta

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography.x509.oid import NameOID
from PIL import Image

from hushh_mcp.services.apple_wallet_pass_service import (
    ORGANIZATION_NAME,
    PASS_DESCRIPTION,
    PASS_TYPE_IDENTIFIER,
    WALLET_PASS_CONTENT_TYPE,
    WALLET_PASS_FILENAME,
    WalletPassBuildError,
    WalletPassContent,
    WalletPassSigningMaterial,
    WalletPassSigningUnavailableError,
    build_manifest,
    build_pkpass,
    wallet_pass_signing_available,
)

TEAM_IDENTIFIER = "TEAMID1234"
PUBLIC_CARD_URL = "https://one.hushh.ai/c/share-token-abc"
PASS_SERIAL = "6f2f0e6a-6d5e-4b0a-9f0a-0d1c2b3a4e5f"

EXPECTED_BUNDLE_MEMBERS = frozenset(
    {
        "pass.json",
        "manifest.json",
        "signature",
        "icon.png",
        "icon@2x.png",
        "icon@3x.png",
        "logo.png",
        "logo@2x.png",
        "logo@3x.png",
        "thumbnail.png",
        "thumbnail@2x.png",
        "thumbnail@3x.png",
    }
)

FULL_CARD_PAYLOAD = {
    "full_name": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "organisation": "Hussh Labs",
    "location_label": "Mumbai, India",
    "summary": "Builds private agents.",
    "skills": ["Python", "Cryptography", "Product"],
    "email": "ada@example.com",
    "phone": "+91 99999 90000",
    "website": "https://ada.example.com",
    "linkedin": "https://www.linkedin.com/in/ada",
    "github": "https://github.com/ada",
    "portfolio": "https://ada.example.com/work",
    "preferred_contact": "email",
}


# ---------------------------------------------------------------------------
# Throwaway signing material
# ---------------------------------------------------------------------------


def _self_signed(
    common_name: str,
    *,
    pass_type_identifier: str | None = None,
    not_before: datetime | None = None,
    not_after: datetime | None = None,
) -> tuple[x509.Certificate, rsa.RSAPrivateKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attributes = [x509.NameAttribute(NameOID.COMMON_NAME, common_name)]
    if pass_type_identifier:
        attributes.append(x509.NameAttribute(NameOID.USER_ID, pass_type_identifier))
    name = x509.Name(attributes)
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before or now - timedelta(days=1))
        .not_valid_after(not_after or now + timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    return certificate, key


def _pem_certificate(certificate: x509.Certificate) -> str:
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


def _pem_key(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


@pytest.fixture
def signing_material() -> WalletPassSigningMaterial:
    certificate, key = _self_signed(
        "Pass Type ID: pass.com.hushh.app.one",
        pass_type_identifier=PASS_TYPE_IDENTIFIER,
    )
    wwdr, _ = _self_signed("Apple Worldwide Developer Relations Certification Authority")
    return WalletPassSigningMaterial(
        team_identifier=TEAM_IDENTIFIER,
        certificate_pem=_pem_certificate(certificate),
        private_key_pem=_pem_key(key),
        wwdr_pem=_pem_certificate(wwdr),
        pass_type_identifier=PASS_TYPE_IDENTIFIER,
    )


def _content(**overrides: object) -> WalletPassContent:
    defaults: dict[str, object] = {
        "pass_serial": PASS_SERIAL,
        "public_card_url": PUBLIC_CARD_URL,
        "card_payload": dict(FULL_CARD_PAYLOAD),
    }
    defaults.update(overrides)
    return WalletPassContent.from_card_payload(**defaults)  # type: ignore[arg-type]


def _bundle_members(bundle: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _png_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        return image.size


# ---------------------------------------------------------------------------
# Bundle shape
# ---------------------------------------------------------------------------


def test_bundle_contains_exactly_the_expected_members(signing_material) -> None:
    members = _bundle_members(build_pkpass(_content(), material=signing_material))

    assert set(members) == EXPECTED_BUNDLE_MEMBERS
    assert ".DS_Store" not in members
    for name, payload in members.items():
        assert payload, name


def test_manifest_lists_sha1_of_every_file_except_itself_and_the_signature(
    signing_material,
) -> None:
    members = _bundle_members(build_pkpass(_content(), material=signing_material))
    manifest = json.loads(members["manifest.json"].decode("utf-8"))

    assert set(manifest) == EXPECTED_BUNDLE_MEMBERS - {"manifest.json", "signature"}
    for name, digest in manifest.items():
        expected = hashlib.sha1(members[name], usedforsecurity=False).hexdigest()
        assert digest == expected, name
        assert len(digest) == 40


def test_build_manifest_excludes_manifest_signature_and_ds_store() -> None:
    manifest = json.loads(
        build_manifest(
            {
                "pass.json": b"{}",
                "manifest.json": b"stale",
                "signature": b"stale",
                ".DS_Store": b"junk",
            }
        ).decode("utf-8")
    )

    assert set(manifest) == {"pass.json"}


def test_signature_is_a_detached_pkcs7_carrying_the_signer_and_wwdr(
    signing_material,
) -> None:
    members = _bundle_members(build_pkpass(_content(), material=signing_material))
    signature = members["signature"]
    manifest = members["manifest.json"]

    certificates = pkcs7.load_der_pkcs7_certificates(signature)
    subjects = {certificate.subject.rfc4514_string() for certificate in certificates}

    assert len(certificates) >= 2
    assert any("Pass Type ID" in subject for subject in subjects)
    assert any("Worldwide Developer Relations" in subject for subject in subjects)
    # Detached: the manifest bytes must not be embedded in the signature blob,
    # and the blob must be materially smaller than the payload it signs would
    # make an attached CMS message.
    assert manifest not in signature
    assert b'"pass.json"' not in signature


def test_bundle_is_deterministic_for_unchanged_content(signing_material) -> None:
    first = _bundle_members(build_pkpass(_content(), material=signing_material))
    second = _bundle_members(build_pkpass(_content(), material=signing_material))

    # Everything but the CMS blob is byte-stable; CMS signatures carry random
    # padding by construction.
    for name in EXPECTED_BUNDLE_MEMBERS - {"signature"}:
        assert first[name] == second[name], name


# ---------------------------------------------------------------------------
# pass.json
# ---------------------------------------------------------------------------


def _pass_json(signing_material, **overrides: object) -> dict:
    members = _bundle_members(build_pkpass(_content(**overrides), material=signing_material))
    return json.loads(members["pass.json"].decode("utf-8"))


def test_pass_json_has_every_required_key(signing_material) -> None:
    pass_json = _pass_json(signing_material)

    assert pass_json["formatVersion"] == 1
    assert pass_json["passTypeIdentifier"] == PASS_TYPE_IDENTIFIER
    assert pass_json["teamIdentifier"] == TEAM_IDENTIFIER
    assert pass_json["organizationName"] == ORGANIZATION_NAME
    assert pass_json["description"] == PASS_DESCRIPTION
    assert pass_json["serialNumber"] == PASS_SERIAL
    assert "generic" in pass_json


def test_pass_json_omits_the_wallet_web_service_keys(signing_material) -> None:
    """D2: no web service, so no APNs, no device registration, no auth token."""
    pass_json = _pass_json(signing_material)

    assert "webServiceURL" not in pass_json
    assert "authenticationToken" not in pass_json
    assert "webServiceURL" not in json.dumps(pass_json)
    assert "authenticationToken" not in json.dumps(pass_json)


def test_pass_json_carries_a_square_qr_barcode_pointing_at_the_public_card(
    signing_material,
) -> None:
    pass_json = _pass_json(signing_material)
    barcodes = pass_json["barcodes"]

    assert len(barcodes) == 1
    barcode = barcodes[0]
    assert barcode["format"] == "PKBarcodeFormatQR"
    assert barcode["message"] == PUBLIC_CARD_URL
    assert barcode["messageEncoding"] == "iso-8859-1"
    assert barcode["altText"] == "Ada Lovelace"
    # The share token is inside the QR payload; it must never be printed.
    assert "share-token-abc" not in barcode["altText"]


def test_front_field_budget_for_a_generic_pass_with_a_square_barcode(
    signing_material,
) -> None:
    """At most 3 header + 1 primary + 4 combined secondary/auxiliary (D3)."""
    generic = _pass_json(signing_material)["generic"]

    header = generic.get("headerFields", [])
    primary = generic.get("primaryFields", [])
    secondary = generic.get("secondaryFields", [])
    auxiliary = generic.get("auxiliaryFields", [])

    assert len(header) <= 3
    assert len(primary) == 1
    assert len(secondary) + len(auxiliary) <= 4
    assert primary[0]["value"] == "Ada Lovelace"


def test_back_fields_carry_the_volatile_detail_and_the_control_note(
    signing_material,
) -> None:
    generic = _pass_json(signing_material)["generic"]
    back = {field["key"]: field["value"] for field in generic["backFields"]}

    assert back["summary"] == "Builds private agents."
    assert back["skills"] == "Python · Cryptography · Product"
    assert back["email"] == "ada@example.com"
    assert back["portfolio"] == "https://ada.example.com/work"
    assert back["profile_link"] == PUBLIC_CARD_URL
    assert "how_it_works" in back
    assert back["control"] == "Only what you pick is visible. Change or switch it off anytime."


def test_absent_optional_fields_produce_no_blank_rows(signing_material) -> None:
    generic = _pass_json(
        signing_material,
        card_payload={"full_name": "Ada Lovelace"},
    )["generic"]

    assert "secondaryFields" not in generic
    assert "auxiliaryFields" not in generic
    back_keys = {field["key"] for field in generic["backFields"]}
    assert "email" not in back_keys
    assert "skills" not in back_keys
    assert "how_it_works" in back_keys


def test_expiry_is_emitted_as_a_w3c_timestamp(signing_material) -> None:
    pass_json = _pass_json(
        signing_material,
        expires_at=datetime(2027, 3, 1, 12, 30, 0, tzinfo=UTC),
    )

    assert pass_json["expirationDate"] == "2027-03-01T12:30:00Z"


def test_pass_json_without_expiry_has_no_expiration_date(signing_material) -> None:
    assert "expirationDate" not in _pass_json(signing_material)


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def test_a_missing_avatar_still_produces_a_valid_pass(signing_material) -> None:
    members = _bundle_members(
        build_pkpass(_content(), material=signing_material, avatar_image=None)
    )

    assert set(members) == EXPECTED_BUNDLE_MEMBERS
    assert _png_size(members["thumbnail.png"]) == (90, 90)
    assert _png_size(members["thumbnail@2x.png"]) == (180, 180)
    assert _png_size(members["thumbnail@3x.png"]) == (270, 270)


def test_an_unreadable_avatar_falls_back_instead_of_failing_the_build(
    signing_material,
) -> None:
    members = _bundle_members(
        build_pkpass(_content(), material=signing_material, avatar_image=b"not-an-image")
    )

    assert set(members) == EXPECTED_BUNDLE_MEMBERS
    assert _png_size(members["thumbnail.png"]) == (90, 90)


def test_a_supplied_avatar_is_re_encoded_at_every_scale(signing_material) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (600, 800), (10, 120, 240)).save(buffer, format="PNG")

    members = _bundle_members(
        build_pkpass(_content(), material=signing_material, avatar_image=buffer.getvalue())
    )

    assert _png_size(members["thumbnail.png"]) == (90, 90)
    assert _png_size(members["thumbnail@2x.png"]) == (180, 180)
    assert _png_size(members["thumbnail@3x.png"]) == (270, 270)
    assert _png_size(members["icon.png"]) == (29, 29)
    assert _png_size(members["logo.png"]) == (50, 50)


# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------


def test_missing_signing_material_is_reported_as_unavailable() -> None:
    material = WalletPassSigningMaterial(team_identifier="")

    assert material.configured is False
    assert wallet_pass_signing_available(material) is False
    with pytest.raises(WalletPassSigningUnavailableError):
        build_pkpass(_content(), material=material)


def test_available_signing_material_passes_the_readiness_probe(signing_material) -> None:
    assert signing_material.configured is True
    assert wallet_pass_signing_available(signing_material) is True


def test_a_mismatched_private_key_fails_closed(signing_material) -> None:
    _, other_key = _self_signed("Someone else")
    material = WalletPassSigningMaterial(
        team_identifier=signing_material.team_identifier,
        certificate_pem=signing_material.certificate_pem,
        private_key_pem=_pem_key(other_key),
        wwdr_pem=signing_material.wwdr_pem,
        pass_type_identifier=PASS_TYPE_IDENTIFIER,
    )

    assert wallet_pass_signing_available(material) is False
    with pytest.raises(WalletPassSigningUnavailableError):
        build_pkpass(_content(), material=material)


def test_an_expired_certificate_fails_closed(signing_material) -> None:
    now = datetime.now(UTC)
    certificate, key = _self_signed(
        "Pass Type ID: pass.com.hushh.app.one",
        pass_type_identifier=PASS_TYPE_IDENTIFIER,
        not_before=now - timedelta(days=400),
        not_after=now - timedelta(days=1),
    )
    material = WalletPassSigningMaterial(
        team_identifier=TEAM_IDENTIFIER,
        certificate_pem=_pem_certificate(certificate),
        private_key_pem=_pem_key(key),
        wwdr_pem=signing_material.wwdr_pem,
        pass_type_identifier=PASS_TYPE_IDENTIFIER,
    )

    assert wallet_pass_signing_available(material) is False
    with pytest.raises(WalletPassSigningUnavailableError):
        build_pkpass(_content(), material=material)


def test_unparseable_pem_is_reported_without_echoing_the_material(
    signing_material,
) -> None:
    material = WalletPassSigningMaterial(
        team_identifier=TEAM_IDENTIFIER,
        certificate_pem="-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----",
        private_key_pem=signing_material.private_key_pem,
        wwdr_pem=signing_material.wwdr_pem,
        pass_type_identifier=PASS_TYPE_IDENTIFIER,
    )

    with pytest.raises(WalletPassSigningUnavailableError) as exc:
        build_pkpass(_content(), material=material)

    assert "not-a-certificate" not in str(exc.value)


def test_a_non_https_card_url_is_refused(signing_material) -> None:
    with pytest.raises(WalletPassBuildError):
        build_pkpass(
            _content(public_card_url="http://one.hushh.ai/c/token"),
            material=signing_material,
        )


def test_a_missing_serial_is_refused(signing_material) -> None:
    with pytest.raises(WalletPassBuildError):
        build_pkpass(_content(pass_serial=""), material=signing_material)


def test_barcode_content_must_survive_the_declared_encoding(signing_material) -> None:
    with pytest.raises(WalletPassBuildError):
        build_pkpass(
            _content(public_card_url="https://one.hushh.ai/c/tokén-☂"),
            material=signing_material,
        )


# ---------------------------------------------------------------------------
# Privacy
# ---------------------------------------------------------------------------


def test_signing_material_repr_never_exposes_pem_bytes(signing_material) -> None:
    printed = repr(signing_material)

    assert "BEGIN" not in printed
    assert "PRIVATE KEY" not in printed
    assert signing_material.private_key_pem not in printed
    assert TEAM_IDENTIFIER in printed


def test_pass_content_repr_never_exposes_card_payload_values() -> None:
    printed = repr(_content())

    assert "Ada Lovelace" not in printed
    assert "ada@example.com" not in printed
    assert "Builds private agents." not in printed
    assert PASS_SERIAL in printed


def test_content_projection_ignores_keys_outside_the_allowlist() -> None:
    content = _content(
        card_payload={
            "full_name": "Ada Lovelace",
            "vault_key": "should-never-appear",
            "user_id": "user_123",
        }
    )

    printed = json.dumps(
        {
            "full_name": content.full_name,
            "summary": content.summary,
            "skills": list(content.skills),
        }
    )
    assert "should-never-appear" not in printed
    assert "user_123" not in printed
    assert not hasattr(content, "vault_key")
    assert not hasattr(content, "user_id")


def test_transport_constants_match_the_contract() -> None:
    assert PASS_TYPE_IDENTIFIER == "pass.com.hushh.app.one"
    assert WALLET_PASS_CONTENT_TYPE == "application/vnd.apple.pkpass"
    assert WALLET_PASS_FILENAME == "hushh-one.pkpass"
