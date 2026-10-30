"""Packaged public phone/device admission and the retained binary policy floor."""

import importlib.util
import json
from contextlib import nullcontext
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.feature_auth_reliability


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("bypass", [None, "phone", "device"])
def test_packaged_reader_rejects_phone_and_device_admission_bypass(monkeypatch, bypass):
    from api.routes import account
    from api.utils import account_principal_policy

    probe = load("phone_reader_admission", "deploy/phone/reader_probe.py")
    monkeypatch.setenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "false")
    if bypass == "phone":
        monkeypatch.setattr(account_principal_policy, "admit_phone_principal", lambda *_: None)
    elif bypass == "device":

        async def unguarded(**_kwargs):
            return {"success": True}

        monkeypatch.setattr(account, "revoke_trusted_device", unguarded)
    with pytest.raises(AssertionError) if bypass else nullcontext():
        verdict = probe.qualify(ROOT / "consent-protocol")
        assert verdict["retired"] == "AUTH_PHONE_ACCESS_REVOKED"
        assert verdict["social"] == "admitted"
        assert verdict["device_revoke_missing_proof"] == "DEVICE_ACTION_PROOF_REQUIRED"


@pytest.mark.parametrize("device_floor", [False, True])
def test_rollback_manifest_requires_device_proof_policy_not_only_phone_fences(
    monkeypatch, device_floor
):
    module = load("phone_device_binary_floor", "deploy/account-deletion/activate_release.py")
    policy = module.SOURCE
    migrations = [policy["MIGRATION"], policy["PHONE_MIGRATION"]]
    if device_floor:
        migrations.append(policy["PHONE_ACTION_MIGRATION"])

    def source(command, **_kwargs):
        assert command[:2] == ["git", "show"]
        return json.dumps(
            {"version": 1}
            if command[-1].endswith(policy["POLICY"])
            else {"ordered_migrations": migrations}
        )

    monkeypatch.setattr(module, "run", source)
    assert module.supports_current_contract("a" * 40) is True
    assert module.supports_current_contract("a" * 40, rollback=True) is device_floor
