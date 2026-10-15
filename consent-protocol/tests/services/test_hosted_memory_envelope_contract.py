"""Cross-language AAD and strict encrypted-envelope wire acceptance."""

import pytest

from hushh_mcp.services.hosted_memory_envelope_contract import (
    admitted_source_id,
    decode_base64url,
    encode_base64url,
    owner_source_aad,
)


def test_owner_aad_matches_browser_contract_vector():
    assert owner_source_aad(
        user_id="owner-A",
        grant_id="e35460f9-f31c-4513-b172-8fc6d633f932",
        generation=4,
        source_id="google_drive",
        revision=1,
    ) == (
        b"hushh-hosted-source-v1\n"
        b"b3duZXItQQ\n"
        b"e35460f9-f31c-4513-b172-8fc6d633f932\n"
        b"4\ngoogle_drive\nconnector_status.v1\n1"
    )


def test_provider_admission_and_noncanonical_base64_fail_closed():
    assert admitted_source_id("hubspot")
    assert not admitted_source_id("google_drive")
    assert not admitted_source_id("unreviewed-provider")
    assert encode_base64url(decode_base64url("AQID")) == "AQID"
    for value in ("AQID=", "AQID/", "A", ""):
        with pytest.raises(ValueError):
            decode_base64url(value)
