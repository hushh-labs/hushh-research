import threading
from types import SimpleNamespace

import pytest

from hushh_mcp.services.consent_db import ConsentDBService


def test_normalize_string_list_accepts_json_encoded_lists():
    service = ConsentDBService()

    assert service._normalize_string_list('["analytics", "profile", ""]') == [
        "analytics",
        "profile",
    ]


@pytest.mark.asyncio
async def test_refresh_job_claim_preserves_eager_result_off_api_loop():
    loop_thread = threading.get_ident()
    calls = []

    def rpc(name, params):
        calls.append((threading.get_ident(), name, params))
        return SimpleNamespace(data=[{"claim_id": "synthetic-claim"}])

    service = ConsentDBService()
    service._get_db = lambda: SimpleNamespace(rpc=rpc)
    assert await service.claim_consent_export_refresh_jobs("synthetic-owner") == [
        {"claim_id": "synthetic-claim"}
    ]
    assert calls[0][0] != loop_thread
    assert calls[0][2]["p_user_id"] == "synthetic-owner"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload,expected",
    [
        ([{"complete_consent_export_refresh_v2": True}], True),
        ([{"complete_consent_export_refresh_v2": False}], False),
        ([True], True),
        (False, False),
    ],
)
async def test_refresh_completion_preserves_eager_boolean_receipt_off_loop(payload, expected):
    loop_thread = threading.get_ident()

    def rpc(name, params):
        assert threading.get_ident() != loop_thread
        assert name == "complete_consent_export_refresh_v2"
        assert params["p_user_id"] == "synthetic-owner"
        return SimpleNamespace(data=payload)

    service = ConsentDBService()
    service._get_db = lambda: SimpleNamespace(rpc=rpc)
    result = await service.complete_claimed_consent_export_refresh(
        user_id="synthetic-owner",
        claim_id="synthetic-claim",
        expected_export_revision=1,
        encrypted_data="synthetic-ciphertext",
        iv="synthetic",
        tag="synthetic",
        wrapped_key_bundle={},
        connector_key_id=None,
        connector_wrapping_alg="synthetic",
        envelope_aad={},
        envelope_aad_sha256="synthetic",
        ciphertext_sha256="synthetic",
        ciphertext_bytes=1,
        source_content_revision=1,
        source_manifest_revision=1,
    )
    assert result is expected
