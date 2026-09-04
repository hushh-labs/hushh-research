"""Claim completion stages regulator facts in the server-writable PKM planes.

The encrypted PKM blob is BYOK, so the server never writes it. What the server
does write after a claim — the audit event, the discovery flag, and the durable
setup mirror — must be best-effort in isolation: no plane may fail the claim,
and one plane failing may not block another.
"""

from __future__ import annotations

from typing import Any

import hushh_mcp.services.personal_knowledge_model_service as pkm_module
import hushh_mcp.services.vault_keys_service as vault_keys_module
from hushh_mcp.services.ria_claim_service import RIAClaimService
from tests.test_ria_claim_flow import (
    _EVALUATE_VERIFIED,
    _TEST_UID,
    _FakeIamService,
    _FakeIdentityClient,
)


class _FakePkmService:
    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.mutation_events: list[dict[str, Any]] = []
        self.summaries: list[tuple[str, str, dict[str, Any]]] = []

    async def record_mutation_event(self, **kwargs: Any) -> bool:
        if self.fail:
            raise RuntimeError("pkm plane down")
        self.mutation_events.append(kwargs)
        return True

    async def update_domain_summary(self, user_id: str, domain: str, summary: dict) -> bool:
        if self.fail:
            raise RuntimeError("pkm plane down")
        self.summaries.append((user_id, domain, summary))
        return True


class _FakeVaultKeysService:
    existing_ids: list[str] = []
    fail = False
    get_calls: list[str] = []
    update_calls: list[dict[str, Any]] = []

    async def get_pre_vault_state(self, user_id: str) -> dict[str, Any]:
        if type(self).fail:
            raise RuntimeError("vault keys down")
        type(self).get_calls.append(user_id)
        return {"setupCapabilityIds": list(type(self).existing_ids)}

    async def update_pre_vault_state(self, *, user_id: str, **kwargs: Any) -> dict[str, Any]:
        type(self).update_calls.append({"user_id": user_id, **kwargs})
        return {}


def _wire_fakes(monkeypatch, *, pkm_fail=False, vault_fail=False, existing_ids=None):
    pkm = _FakePkmService(fail=pkm_fail)
    monkeypatch.setattr(pkm_module, "get_pkm_service", lambda: pkm)
    _FakeVaultKeysService.existing_ids = list(existing_ids or [])
    _FakeVaultKeysService.fail = vault_fail
    _FakeVaultKeysService.get_calls = []
    _FakeVaultKeysService.update_calls = []
    monkeypatch.setattr(vault_keys_module, "VaultKeysService", _FakeVaultKeysService)
    return pkm


def _service() -> RIAClaimService:
    return RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED),
        iam_service=_FakeIamService(),
    )


async def _complete(service: RIAClaimService) -> dict[str, Any]:
    return await service.complete(
        user_id=_TEST_UID,
        phone_digits="8015663510",
        claim_type="individual",
        firm_crd=283040,
        individual_crd=5308823,
    )


async def test_complete_stages_facts_and_mirrors_setup(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    pkm = _wire_fakes(monkeypatch)

    result = await _complete(_service())

    assert result["status"] == "claimed"
    event = pkm.mutation_events[0]
    assert event["user_id"] == _TEST_UID
    assert event["domain"] == "ria"
    assert event["operation_type"] == "attribute_inference"
    assert event["source_agent"] == "ria_identity_claim"
    assert event["path_set"] == ["regulator_profile"]
    # The staged facts are the same object the response shows the person.
    assert event["metadata"]["regulator_profile"] == result["facts"]

    assert pkm.summaries == [(_TEST_UID, "ria", {"has_regulator_profile": True})]

    assert _FakeVaultKeysService.get_calls == [_TEST_UID]
    update = _FakeVaultKeysService.update_calls[0]
    assert update["user_id"] == _TEST_UID
    assert "ria" in update["setup_capability_ids"]


async def test_setup_mirror_preserves_other_capabilities(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    _wire_fakes(monkeypatch, existing_ids=["mail", "wallet"])

    await _complete(_service())

    update = _FakeVaultKeysService.update_calls[0]
    assert update["setup_capability_ids"] == ["mail", "ria", "wallet"]


async def test_setup_mirror_is_a_noop_on_reclaim(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    _wire_fakes(monkeypatch, existing_ids=["ria"])

    await _complete(_service())

    assert _FakeVaultKeysService.update_calls == []


async def test_claim_succeeds_when_every_enrichment_plane_fails(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    _wire_fakes(monkeypatch, pkm_fail=True, vault_fail=True)

    result = await _complete(_service())

    assert result["status"] == "claimed"
    assert result["facts"]["crd_number"] == "5308823"


async def test_pkm_plane_failure_does_not_block_setup_mirror(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    _wire_fakes(monkeypatch, pkm_fail=True)

    await _complete(_service())

    update = _FakeVaultKeysService.update_calls[0]
    assert "ria" in update["setup_capability_ids"]
