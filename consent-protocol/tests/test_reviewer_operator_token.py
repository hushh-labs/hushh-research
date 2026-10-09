"""Operator-token authority is separate from the backend reviewer mint API."""

import pytest


@pytest.fixture
def issuer():
    import importlib.util
    from pathlib import Path

    script = Path(__file__).resolve().parents[2] / (
        ".codex/skills/reviewer-app-testing/scripts/reviewer_operator_token.py"
    )
    spec = importlib.util.spec_from_file_location("reviewer_operator_token", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def dev_policy():
    return {
        "environment": "dev",
        "scope_commerce_frontend_origin": "https://dev.one.hushh.ai",
        "scope_commerce_sandbox_policy_required": True,
        "scope_commerce_stripe_livemode": False,
        "scope_commerce_stripe_account_id": "acct_1UNyyyLsJU9ZDBZX",
        "scope_commerce_sandbox_policy_json": {
            "environment": "sandbox",
            "platform_account_id": "acct_1UNyyyLsJU9ZDBZX",
            "reviewer_user_ids": ["primary", "counterpart"],
            "reviewer_funding_cap_cents": 2000,
            "operating_capital_cap_cents": 2500,
        },
    }


def test_shared_dev_admission_requires_exact_sandbox_policy(issuer):
    from copy import deepcopy

    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    origin = "https://dev.one.hushh.ai"
    backend = "https://consent-protocol-synthetic-uc.a.run.app"
    policy = dev_policy()
    assert issuer.shared_dev_reviewer_ids(policy, origin, backend) == {"primary", "counterpart"}
    assert issuer.shared_dev_reviewer_ids(
        policy, origin, "https://consent-protocol-621416509462.us-central1.run.app"
    ) == {"primary", "counterpart"}
    for field, value in (
        ("environment", "production"),
        ("scope_commerce_frontend_origin", "https://one.hushh.ai"),
        ("scope_commerce_sandbox_policy_required", False),
        ("scope_commerce_stripe_livemode", True),
        ("scope_commerce_stripe_account_id", "acct_foreign"),
    ):
        wrong = {**policy, field: value}
        with pytest.raises(ValueError):
            issuer.shared_dev_reviewer_ids(wrong, origin, backend)
    for wrong_origin, wrong_backend in (
        ("https://one.hushh.ai", backend),
        (origin, "https://consent-protocol-commerce-sandbox-synthetic-uc.a.run.app"),
    ):
        with pytest.raises(ValueError):
            issuer.shared_dev_reviewer_ids(policy, wrong_origin, wrong_backend)
    wrong = deepcopy(policy)
    wrong["scope_commerce_sandbox_policy_json"]["reviewer_user_ids"] = ["primary"] * 2
    with pytest.raises(CommerceProviderError):
        issuer.shared_dev_reviewer_ids(wrong, origin, backend)


@pytest.fixture
def dev_runtime():
    backend = "https://consent-protocol-synthetic-uc.a.run.app"
    service = {
        "status": {
            "url": backend,
            "traffic": [{"percent": 100, "revisionName": "consent-protocol-synthetic"}],
        }
    }
    revision = {
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "ENVIRONMENT", "value": "dev"},
                        {"name": "APP_REVIEW_MODE", "value": "true"},
                        *(
                            {
                                "name": name,
                                "valueFrom": {"secretKeyRef": {"name": name, "key": "7"}},
                            }
                            for name in (
                                "BACKEND_RUNTIME_CONFIG_JSON",
                                "FIREBASE_ADMIN_CREDENTIALS_JSON",
                            )
                        ),
                        {"name": "HUSHH_DEPLOY_ENV", "value": "dev"},
                    ]
                }
            ]
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }
    return {
        "services/consent-protocol": service,
        "revisions/consent-protocol-synthetic": revision,
    }


def test_shared_dev_admission_requires_serving_runtime_and_secret_binding(issuer, dev_runtime):
    import json
    from copy import deepcopy

    backend = "https://consent-protocol-synthetic-uc.a.run.app"
    records = dev_runtime
    assert issuer.verify_shared_dev_runtime(records.__getitem__, backend) == {
        "BACKEND_RUNTIME_CONFIG_JSON": "7",
        "FIREBASE_ADMIN_CREDENTIALS_JSON": "7",
    }
    issuer.verify_shared_dev_runtime(
        records.__getitem__, "https://consent-protocol-621416509462.us-central1.run.app"
    )
    calls = []
    policy = {**dev_policy(), "environment": "uat"}

    def secret(name, version="latest"):
        calls.append((name, version))
        return {
            "APP_FRONTEND_ORIGIN": "https://dev.one.hushh.ai",
            "BACKEND_URL": backend,
            "BACKEND_RUNTIME_CONFIG_JSON": json.dumps(policy),
        }[name]

    ids, lane, versions = issuer.runtime_reviewer_binding(
        secret, {"app_origin": "https://dev.one.hushh.ai"}, records.__getitem__
    )
    assert ids == {"primary", "counterpart"} and lane == "dev"
    assert ("BACKEND_RUNTIME_CONFIG_JSON", "7") in calls
    assert versions["FIREBASE_ADMIN_CREDENTIALS_JSON"] == "7"
    for target, update in (
        ("service", {"url": "https://foreign.example"}),
        ("service", {"traffic": [{"percent": 50}]}),
        ("revision", {"conditions": [{"type": "Ready", "status": "False"}]}),
    ):
        wrong = deepcopy(records)
        key = (
            "services/consent-protocol"
            if target == "service"
            else "revisions/consent-protocol-synthetic"
        )
        wrong[key]["status"].update(update)
        with pytest.raises(ValueError):
            issuer.verify_shared_dev_runtime(wrong.__getitem__, backend)
    wrong = deepcopy(records)
    wrong["revisions/consent-protocol-synthetic"]["spec"]["containers"][0]["env"].append(
        {"name": "APP_RUNTIME_PROFILE", "value": "production"}
    )
    with pytest.raises(ValueError):
        issuer.verify_shared_dev_runtime(wrong.__getitem__, backend)
    for ref in (
        {"name": "SCOPE_COMMERCE_SANDBOX_BACKEND_RUNTIME_CONFIG_JSON", "key": "7"},
        {"name": "BACKEND_RUNTIME_CONFIG_JSON", "key": "foreign"},
    ):
        wrong = deepcopy(records)
        wrong["revisions/consent-protocol-synthetic"]["spec"]["containers"][0]["env"][2][
            "valueFrom"
        ]["secretKeyRef"] = ref
        with pytest.raises(ValueError):
            issuer.verify_shared_dev_runtime(wrong.__getitem__, backend)

    for name, value in (
        ("ENVIRONMENT", "uat"),
        ("ENVIRONMENT", "production"),
        ("HUSHH_DEPLOY_ENV", "uat"),
        ("HUSHH_DEPLOY_ENV", "production"),
        ("APP_REVIEW_MODE", "false"),
    ):
        wrong = deepcopy(records)
        for env in wrong["revisions/consent-protocol-synthetic"]["spec"]["containers"][0]["env"]:
            if env["name"] == name:
                env["value"] = value
        with pytest.raises(ValueError):
            issuer.verify_shared_dev_runtime(wrong.__getitem__, backend)


def test_operator_firebase_authority_uses_serving_version_and_fixed_project(issuer):
    import json

    calls = []
    certificate = {"project_id": "hushh-pda"}

    def secret(name, version):
        calls.append((name, version))
        return json.dumps(certificate)

    assert (
        issuer.firebase_certificate(secret, {"FIREBASE_ADMIN_CREDENTIALS_JSON": "7"}) == certificate
    )
    assert calls == [("FIREBASE_ADMIN_CREDENTIALS_JSON", "7")]
    certificate["project_id"] = "foreign"
    with pytest.raises(ValueError):
        issuer.firebase_certificate(secret, {})


@pytest.mark.parametrize("lane", ["uat", "dev"])
def test_operator_reviewer_uses_real_uid_admission_and_preserves_lane_containment(issuer, lane):
    from types import SimpleNamespace

    module = issuer
    calls = []
    users = {uid: SimpleNamespace(uid=uid, disabled=False) for uid in ("primary", "counterpart")}
    user = users["primary"]
    sdk = SimpleNamespace(
        get_user=lambda uid, app: users[uid],
        create_custom_token=lambda uid, claims, app: (
            calls.append((uid, claims, app)) or b"synthetic-proof"
        ),
    )
    app = object()
    assert (
        module.mint_reviewer_token(sdk, app, "primary", {"primary", "counterpart"}, lane)
        == b"synthetic-proof"
    )
    assert calls == [("primary", {"hushh_review_mint": lane}, app)]
    calls.clear()
    for requested, lane, disabled, actual_uid in (
        ("foreign", "uat", False, "foreign"),
        ("primary", "production", False, "primary"),
        ("primary", "uat", True, "primary"),
        ("primary", "uat", False, "foreign"),
    ):
        user.disabled, user.uid = disabled, actual_uid
        with pytest.raises(ValueError):
            module.mint_reviewer_token(sdk, app, requested, {"primary", "counterpart"}, lane)
    assert calls == []

    user.disabled, user.uid = False, "primary"
    users["counterpart"].disabled = True
    with pytest.raises(ValueError):
        module.mint_reviewer_token(sdk, app, "primary", {"primary", "counterpart"}, "uat")
    users.pop("counterpart")
    with pytest.raises(KeyError):
        module.mint_reviewer_token(sdk, app, "primary", {"primary", "counterpart"}, "uat")
    assert calls == []
