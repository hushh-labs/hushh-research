"""Scheduler authority is distinct from owner and generic Google tokens."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pwm_notification_drain as route


@pytest.mark.parametrize(
    "defect", [None, "issuer", "audience", "account", "unverified", "disabled", "oversized"]
)
def test_scheduler_exact_authority(monkeypatch, defect):
    config = route.load_pwm_policy()["notification_scheduler"]
    claims = {
        "iss": "https://accounts.google.com",
        "aud": config["audience"],
        "email": config["service_account"],
        "email_verified": True,
    }
    if defect == "issuer":
        claims["iss"] = "https://other.test"
    if defect == "audience":
        claims["aud"] = "https://other.test"
    if defect == "account":
        claims["email"] = "other@hushh-pda-uat.iam.gserviceaccount.com"
    if defect == "unverified":
        claims["email_verified"] = "true"
    verify = Mock(return_value=claims)
    drain = AsyncMock()
    monkeypatch.setattr(route, "verify_token", verify)
    monkeypatch.setattr(
        route, "get_app_runtime_settings", lambda: SimpleNamespace(environment="uat")
    )
    monkeypatch.setattr(route, "one_profile_research_enabled", lambda: defect != "disabled")
    monkeypatch.setattr(route.world_model_notification_worker, "drain", drain)
    app = FastAPI()
    app.include_router(route.router)
    token = "x" * 8193 if defect == "oversized" else "synthetic-scheduler-token"
    result = TestClient(app).post(
        "/api/internal/pwm-notifications/drain", headers={"Authorization": "Bearer " + token}
    )
    assert result.headers["cache-control"] == "private, no-store"
    if defect is None:
        assert result.status_code == 200
        drain.assert_awaited_once()
    else:
        assert result.status_code == (404 if defect == "disabled" else 401)
        drain.assert_not_awaited()


def test_native_policy_rejects_third_party_and_unbounded_key_lease(tmp_path):
    import json

    from hushh_mcp.managed_ai_config import PROFILE_PATH, load_pwm_policy

    value = json.loads(PROFILE_PATH.read_text())
    path = tmp_path / "runtime.json"
    for field, bad in [("provider", "tavily"), ("lease_seconds", 301), ("slice_seconds", 300)]:
        changed = json.loads(json.dumps(value))
        changed["pwm_research"][field] = bad
        path.write_text(json.dumps(changed))
        with pytest.raises(ValueError):
            load_pwm_policy(path)


def test_azure_pwm_policy_requires_scoped_endpoints_and_deployments(tmp_path):
    import json

    from hushh_mcp.managed_ai_config import PROFILE_PATH, load_pwm_policy

    value = json.loads(PROFILE_PATH.read_text())
    policy = value["pwm_research"]
    policy["provider"] = "azure_openai_web_search"
    policy["search_invocations"] = 8
    policy["model_calls"] = 16
    policy["azure"] = {
        "tenant_id": "00000000-0000-4000-8000-000000000001",
        "client_id": "00000000-0000-4000-8000-000000000002",
        "primary_endpoint": "https://synthetic.openai.azure.com/openai/v1/",
        "primary_deployment": "pwm-primary",
        "phi_endpoint": "https://synthetic.services.ai.azure.com/openai/v1/",
        "phi_deployment": "pwm-phi",
    }
    path = tmp_path / "runtime.json"
    path.write_text(json.dumps(value))
    assert load_pwm_policy(path)["provider"] == "azure_openai_web_search"
    policy["search_invocations"] = 32
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        load_pwm_policy(path)
    policy["search_invocations"] = 8
    policy["azure"]["phi_endpoint"] = "https://example.test/openai/v1/"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        load_pwm_policy(path)


def test_checked_in_pwm_provider_changes_only_in_uat():
    from hushh_mcp.managed_ai_config import load_pwm_policy

    uat = load_pwm_policy(environment="uat")
    assert uat["provider"] == "azure_openai_web_search"
    assert uat["azure"]["primary_deployment"] == "pwm-gpt-5-mini-eval"
    assert uat["azure"]["phi_deployment"] == "pwm-phi-4-mini-eval"
    for environment in ("development", "dev", "production"):
        assert load_pwm_policy(environment=environment)["provider"] == "vertex_google_search"


@pytest.mark.parametrize(
    "field,bad",
    [
        ("project", "other-project"),
        ("audience", "https://other.test"),
        ("service_account", "other@hushh-pda-uat.iam.gserviceaccount.com"),
        ("job", "other-job"),
        ("location", "europe-west1"),
    ],
)
def test_scheduler_config_is_one_exact_authority(tmp_path, field, bad):
    import json

    from hushh_mcp.managed_ai_config import PROFILE_PATH, load_pwm_policy

    value = json.loads(PROFILE_PATH.read_text())
    value["pwm_research"]["notification_scheduler"][field] = bad
    path = tmp_path / "runtime.json"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        load_pwm_policy(path)
