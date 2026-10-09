"""Fixed preview identity, isolation and release-policy contracts."""

import json
import os
import re
import subprocess
import sys
from runpy import run_path

import pytest
import yaml

from tests.test_dev_candidate_gate import ROOT


def _preview_module(name):
    return run_path(str(ROOT / "scripts/deploy" / name))


def _preview_policy(module):
    return {
        "environment": "uat",
        "db_name": module["DATABASE"],
        "db_unix_socket": "/cloudsql/hushh-pda-dev:us-central1:hushh-dev-pg",
        "scope_commerce_stripe_livemode": False,
        "scope_commerce_sandbox_policy_required": True,
        "scope_commerce_frontend_origin": "https://hushh-webapp-commerce-sandbox-test.run.app",
        "scope_commerce_drain_audience": "https://consent-protocol-commerce-sandbox-test.run.app",
        "scope_commerce_drain_scheduler_service_accounts": [module["SCHEDULER_SA"]],
        "scope_commerce_stripe_account_id": module["STRIPE_ACCOUNT"],
        "scope_commerce_country_policies_json": {"US": {}},
        "scope_commerce_sandbox_policy_json": {
            "environment": "sandbox",
            "platform_account_id": module["STRIPE_ACCOUNT"],
            "reviewer_user_ids": ["synthetic-one", "synthetic-two"],
            "reviewer_funding_cap_cents": 2000,
            "operating_capital_cap_cents": 2500,
        },
    }


def test_preview_rejects_shared_identity_database_origin_and_ingestion():
    module = _preview_module("commerce-preview-target.py")
    target = module["PreviewTarget"]()
    for identity in (target.runtime_sa, module["SCHEDULER_SA"]):
        assert re.fullmatch(
            r"[a-z][a-z0-9-]{4,28}[a-z0-9]@hushh-pda-dev\.iam\.gserviceaccount\.com", identity
        )
    config = _preview_policy(module)
    frontend = config["scope_commerce_frontend_origin"]
    backend = config["scope_commerce_drain_audience"]
    assert target.validate_policy(config, frontend, backend) == ("synthetic-one", "synthetic-two")
    for key, invalid in (
        ("db_name", "postgres"),
        ("scope_commerce_stripe_livemode", True),
        ("scope_commerce_drain_audience", "https://shared.run.app"),
        ("scope_commerce_drain_scheduler_service_accounts", ["shared@example.invalid"]),
        ("gmail_chat_reads", True),
    ):
        with pytest.raises(module["PreviewError"]):
            target.validate_policy(config | {key: invalid}, frontend, backend)
    invalid = json.loads(json.dumps(config))
    invalid["scope_commerce_sandbox_policy_json"]["reviewer_user_ids"] = [{}, "synthetic-two"]
    with pytest.raises(module["PreviewError"]):
        target.validate_policy(invalid, frontend, backend)
    service = {
        "metadata": {"name": target.frontend},
        "spec": {"template": {"spec": {"serviceAccountName": target.runtime_sa}}},
        "status": {"url": frontend},
    }
    assert target.service_origin(service, target.frontend) == frontend
    service["spec"]["template"]["spec"]["serviceAccountName"] = "shared@example.invalid"
    with pytest.raises(module["PreviewError"]):
        target.service_origin(service, target.frontend)


@pytest.mark.parametrize("model_project", ["hushh-pda-dev", "unapproved-project"])
def test_preview_substitutions_preserve_single_delimiter_and_namespace(model_project):
    module = _preview_module("commerce-preview-substitutions.py")
    output = module["substitutions"](
        f"_DEPLOY_ENV=dev##_GMAIL_OAUTH_CLIENT_ID_SECRET=shared##_GENAI_PROJECT_ID={model_project}",
        "backend",
    )
    assert not output.startswith("^")
    pairs = dict(row.split("=", 1) for row in output.split("##"))
    assert pairs["_SECRET_PREFIX"] == "SCOPE_COMMERCE_SANDBOX_"
    assert pairs["_BACKEND_SERVICE"] == "consent-protocol-commerce-sandbox"
    assert pairs["_BUILD_POD_IMAGE"] == "false"
    assert pairs["_CLOUD_RUN_MAX_INSTANCES"] == "1"
    assert pairs["_CLOUD_RUN_MIN_INSTANCES"] == "1"
    assert pairs["_GMAIL_OAUTH_CLIENT_ID_SECRET"] == ""
    assert pairs["_GENAI_PROJECT_ID"] == "hushh-vertex-personal54"
    assert module["TARGET"]["PROJECT"] == "hushh-pda-dev"
    assert pairs["_RUNTIME_SERVICE_ACCOUNT"] == (
        "commerce-sandbox-runtime@hushh-pda-dev.iam.gserviceaccount.com"
    )
    assert pairs["_CLOUDSQL_INSTANCES"] == "hushh-pda-dev:us-central1:hushh-dev-pg"
    with pytest.raises(ValueError, match="preview_candidate_interface_missing"):
        module["substitutions"]("_UNDECLARED=unsafe", "backend")


def test_preview_allows_unknown_costs_only_with_both_admission_switches_disabled():
    module = _preview_module("commerce-preview-target.py")
    target = module["PreviewTarget"]()
    config = _preview_policy(module) | {
        "scope_commerce_country_policies_json": {},
        "scope_commerce_enabled": False,
        "scope_commerce_provider_enabled": False,
    }
    frontend = config["scope_commerce_frontend_origin"]
    backend = config["scope_commerce_drain_audience"]
    assert target.validate_policy(config, frontend, backend) == ("synthetic-one", "synthetic-two")
    for key in ("scope_commerce_enabled", "scope_commerce_provider_enabled"):
        for value in (True, "false", None, 0):
            with pytest.raises(module["PreviewError"], match="preview_commerce_policy_mismatch"):
                target.validate_policy(config | {key: value}, frontend, backend)
        missing = {name: value for name, value in config.items() if name != key}
        with pytest.raises(module["PreviewError"], match="preview_commerce_policy_mismatch"):
            target.validate_policy(missing, frontend, backend)
    with pytest.raises(module["PreviewError"], match="preview_commerce_policy_mismatch"):
        target.validate_policy(
            config | {"scope_commerce_country_policies_json": {"CA": {}}}, frontend, backend
        )


def test_preview_mount_and_readiness_proof_reject_shared_or_stale_authority():
    module = _preview_module("commerce-preview-verify.py")
    env = [
        {
            "name": "DB_USER",
            "valueFrom": {
                "secretKeyRef": {"name": "SCOPE_COMMERCE_SANDBOX_DB_USER", "key": "latest"}
            },
        }
    ]
    service = {"spec": {"template": {"spec": {"containers": [{"env": env}]}}}}
    module["validate_mounts"](service, {"DB_USER": "DB_USER"})
    env.append(
        {
            "name": "DB_PASSWORD",
            "valueFrom": {"secretKeyRef": {"name": "DB_PASSWORD", "key": "latest"}},
        }
    )
    with pytest.raises(module["PreviewError"], match="preview_shared_secret_binding"):
        module["validate_mounts"](service, {"DB_USER": "DB_USER"})
    config = _preview_policy(_preview_module("commerce-preview-target.py"))
    context = {"app_origin": config["scope_commerce_frontend_origin"], "config": config}
    head = json.loads((ROOT / "consent-protocol/db/contracts/prod_core_schema.json").read_text())[
        "expected_migration_version"
    ]
    proof = {
        "app_origin": context["app_origin"],
        "environment": "sandbox",
        "platform_account_id": config["scope_commerce_stripe_account_id"],
        "livemode": False,
        "persisted_pin_matches": True,
        "reviewer_funding_cap_cents": 2000,
        "operating_capital_cap_cents": 2500,
        "schema_head": int(head),
        "new_activity_enabled": False,
    }
    module["validate_app_proof"](proof, context)
    for key, value in (("livemode", True), ("schema_head", None), ("new_activity_enabled", True)):
        with pytest.raises(module["PreviewError"]):
            module["validate_app_proof"](proof | {key: value}, context)


def test_preview_rejects_migration_secrets_and_privileged_runtime():
    module = _preview_module("commerce-preview-verify.py")
    role = {
        "rolname": "scope_commerce_sandbox",
        **dict.fromkeys(
            (
                "rolsuper",
                "rolcreaterole",
                "rolcreatedb",
                "rolreplication",
                "rolbypassrls",
                "elevated_membership",
                "other_database_ownership",
            ),
            False,
        ),
    }
    module["validate_runtime_database_role"](role)
    for flag in role.keys() - {"rolname"}:
        with pytest.raises(module["PreviewError"], match="preview_runtime_database_privileged"):
            module["validate_runtime_database_role"](role | {flag: True})
    with pytest.raises(module["PreviewError"]):
        module["validate_runtime_database_role"](
            role | {"rolname": "scope_commerce_sandbox_migrator"}
        )
    for name, secret in (
        ("MIGRATOR_DB_USER", None),
        ("DB_PASSWORD", "SCOPE_COMMERCE_SANDBOX_MIGRATOR_DB_PASSWORD"),
    ):
        entry = {"name": name, "value": "synthetic"}
        if secret:
            entry = {"name": name, "valueFrom": {"secretKeyRef": {"name": secret}}}
        spec = {"containers": [{"env": [entry]}]}
        with pytest.raises(module["PreviewError"], match="preview_migration_credential_mounted"):
            module["validate_mounts"]({"spec": {"template": {"spec": spec}}}, {})
    spec = {
        "containers": [{"env": []}],
        "volumes": [{"secret": {"secretName": "SCOPE_COMMERCE_SANDBOX_MIGRATOR_DB_PASSWORD"}}],
    }
    with pytest.raises(module["PreviewError"], match="preview_migration_credential_mounted"):
        module["validate_mounts"]({"spec": {"template": {"spec": spec}}}, {})


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "file:///tmp/fixture",
        "http://example.invalid",
        "https://user:password@example.invalid",
        "https://example.invalid/#fragment",
    ],
)
def test_preview_refuses_unsafe_authority_transport_before_constructing_request(
    monkeypatch, unsafe_url
):
    module = _preview_module("commerce-preview-verify.py")

    def unexpected_request(*args, **kwargs):
        raise AssertionError("unsafe request must not be constructed")

    monkeypatch.setitem(module["json_http"].__globals__, "Request", unexpected_request)
    with pytest.raises(module["PreviewError"], match="preview_https_required"):
        module["json_http"](unsafe_url)


def test_preview_keeps_authority_gates_and_checks_bindings_before_promotion():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Assert manual dispatch originates from main") < names.index(
        "Resolve fixed deployment target"
    )
    assert names.index("Assert manual dev dispatch actor policy") < names.index(
        "Resolve fixed deployment target"
    )
    assert names.index("Verify isolated preview bindings before traffic promotion") < names.index(
        "Promote deployed revisions to dev traffic"
    )
    binding = next(step for step in steps if "isolated preview bindings" in step["name"])
    assert "continue-on-error" not in binding
    assert "--phase mounts" in binding["run"]
    source = (ROOT / ".github/workflows/deploy-dev.yml").read_text()
    assert 'REQUIRE_CI_SUCCESS: "1"' in source
    assert (
        'REQUIRED_CHECK_NAME: "CI Status Gate,Queue Validation,Main Post-Merge Smoke Gate"'
        in source
    )


def test_flag_off_payment_helper_keeps_default_and_isolated_provider_mounts() -> None:
    # Execute the actual helper with a binding recorder; no cloud reads/writes.
    for prefix in ("", "SCOPE_COMMERCE_SANDBOX_"):
        section = (
            (ROOT / "scripts/deploy/backend-deploy.sh")
            .read_text()
            .split("# Disabling new paid requests", 1)[1]
            .split('append_optional_secret "${_OPENAI_API_KEY_SECRET}"', 1)[0]
        )
        section = section.replace(
            'source "$(dirname "${BASH_SOURCE[0]}")/scope-commerce-secrets.sh"',
            "source scripts/deploy/scope-commerce-secrets.sh",
        )
        script = (
            'append_optional_secret() { printf \'%s=%s%s\\n\' "$2" "$PREFIX" "$1"; }\n'
            + "# Disabling new paid requests"
            + section
        )
        result = subprocess.run(  # noqa: S603 - repository helper with a binding recorder
            ["bash", "-eu", "-c", script],
            cwd=ROOT,
            env={
                **os.environ,
                "PREFIX": prefix,
                "_DRIVE_REQUEST_PAYMENTS_ENABLED": "false",
                "SCOPE_COMMERCE_ENABLED": "false",
                "_STRIPE_SECRET_KEY_SECRET": "STRIPE_SECRET_KEY",
                "_STRIPE_WEBHOOK_SECRET_SECRET": "STRIPE_WEBHOOK_SECRET",
            },
            text=True,
            capture_output=True,
            check=True,
        )
        names = (
            "STRIPE_SECRET_KEY",
            "STRIPE_WEBHOOK_SECRET",
            "SCOPE_COMMERCE_STRIPE_SECRET_KEY",
            "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
            "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
        )
        assert result.stdout.splitlines() == [f"{name}={prefix}{name}" for name in names]


def test_stripe_secret_bindings_survive_payment_rollout_switch_off() -> None:
    """Existing paid-required requests still need Checkout and signed webhooks."""
    backend_build = (ROOT / "deploy/backend.cloudbuild.yaml").read_text()
    backend_deploy = (ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    for lane in ("dev", "uat", "production"):
        workflow = (ROOT / f".github/workflows/deploy-{lane}.yml").read_text()
        assert "_STRIPE_SECRET_KEY_SECRET=STRIPE_SECRET_KEY" in workflow
        assert "_STRIPE_WEBHOOK_SECRET_SECRET=STRIPE_WEBHOOK_SECRET" in workflow
        assert "_STRIPE_SECRET_KEY_SECRET=${{" not in workflow
        assert "_STRIPE_WEBHOOK_SECRET_SECRET=${{" not in workflow

    # The build binds optional existing secrets, but refuses an enabled
    # new-request rollout unless both names resolve in the deploy project.
    assert 'if [[ "${_DRIVE_REQUEST_PAYMENTS_ENABLED}" == "true" ]]; then' in backend_deploy
    assert (
        'for required_secret in "${_STRIPE_SECRET_KEY_SECRET}" "${_STRIPE_WEBHOOK_SECRET_SECRET}"; do'
        in backend_deploy
    )
    helper = (ROOT / "scripts/deploy/scope-commerce-secrets.sh").read_text()
    assert 'source "$(dirname "${BASH_SOURCE[0]}")/scope-commerce-secrets.sh"' in backend_deploy
    assert "\nappend_payment_provider_secrets\n" in backend_deploy
    for name in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"):
        assert f'append_optional_secret "${{_{name}_SECRET}}" "{name}"' in helper
        assert f"${{_{name}_SECRET}}" in backend_build
    assert (
        'append_optional_env "DRIVE_REQUEST_PAYMENTS_ENABLED" "${_DRIVE_REQUEST_PAYMENTS_ENABLED}"'
        in backend_deploy
    )


def test_uat_and_production_verify_the_candidate_runs_the_pinned_digest() -> None:
    for lane in ("uat", "production"):
        workflow = yaml.safe_load((ROOT / f".github/workflows/deploy-{lane}.yml").read_text())
        steps = workflow["jobs"]["deploy"]["steps"]
        names = [str(step.get("name") or "") for step in steps]
        verify = "Verify frontend candidate runs the pinned image digest"
        assert names.index("Resolve deployed candidate revisions") < names.index(verify)
        promote = next(name for name in names if name.startswith("Promote deployed revisions"))
        assert names.index(verify) < names.index(promote)
        run = str(next(step for step in steps if step.get("name") == verify)["run"])
        assert "spec.containers[0].image" in run
        assert '"${deployed_image}" != "${EXPECTED_IMAGE_REFERENCE}"' in run


@pytest.mark.parametrize("preview,missing", [(False, False), (False, True), (True, False)])
def test_preview_disables_analytics_without_fetching_public_ids(tmp_path, preview, missing):
    config = yaml.safe_load((ROOT / "deploy/frontend-image.cloudbuild.yaml").read_text())
    step = config["steps"][0]["args"][-1]
    body = (
        step.split("        # Analytics is disabled", 1)[-1]
        if "        # Analytics is disabled" in step
        else step.split("# Analytics is disabled", 1)[1]
    )
    body = "# Analytics is disabled" + body.split("google_contacts_client_id_file=", 1)[0]
    for key, value in config["substitutions"].items():
        replacement = (
            "SCOPE_COMMERCE_SANDBOX_"
            if preview and key == "_SECRET_PREFIX"
            else "false"
            if preview and key == "_OBSERVABILITY_ENABLED"
            else str(value)
        )
        body = body.replace("${" + key + "}", replacement)
    body = body.replace("$$", "$").replace("/workspace", str(tmp_path))
    trace = tmp_path / "calls"
    script = (
        'set -euo pipefail\ngcloud() { printf \'%s\\n\' "$*" >> "$TRACE"; '
        + ("return 1;" if missing else "printf synthetic-id;")
        + " };\n"
        + body
    )
    result = subprocess.run(  # noqa: S603 - real resolver with hermetic cloud recorder
        ["bash", "-c", script],
        env={**os.environ, "TRACE": str(trace), "PROJECT_ID": "hushh-pda-dev"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == (1 if missing else 0)
    if preview:
        assert not trace.exists()
        assert all(path.read_text() == "" for path in (tmp_path / ".frontend-analytics").iterdir())
    elif not missing:
        assert len(trace.read_text().splitlines()) == 2
    for secret in config["availableSecrets"]["secretManager"]:
        assert "MEASUREMENT_ID" not in secret["env"] and "GTM_ID" not in secret["env"]


@pytest.mark.parametrize("unavailable", ["missing", "disabled"])
def test_preview_authentication_requires_both_existing_enabled_reviewers(monkeypatch, unavailable):
    from types import SimpleNamespace

    module = _preview_module("commerce-preview-verify.py")
    calls = []

    def get_user(uid, **kwargs):
        calls.append(uid)
        if uid == "synthetic-two" and unavailable == "missing":
            raise RuntimeError("synthetic_missing_subject")
        return SimpleNamespace(disabled=uid == "synthetic-two")

    auth = SimpleNamespace(
        get_user=get_user,
        create_custom_token=lambda *args, **kwargs: pytest.fail("must not authenticate"),
    )
    monkeypatch.setitem(
        sys.modules,
        "firebase_admin",
        SimpleNamespace(
            auth=auth,
            credentials=SimpleNamespace(Certificate=lambda value: value),
            initialize_app=lambda *args, **kwargs: "fixture",
            delete_app=lambda app: calls.append("deleted"),
        ),
    )
    reader = SimpleNamespace(
        secret=lambda name: (
            json.dumps({"project_id": "synthetic"})
            if name == "FIREBASE_ADMIN_CREDENTIALS_JSON"
            else "synthetic"
        )
    )
    verifier = module["PreviewVerifier"](reader)
    with pytest.raises((RuntimeError, module["PreviewError"])):
        verifier.app({"users": ["synthetic-one", "synthetic-two"]})
    assert calls == ["synthetic-one", "synthetic-two", "deleted"]


@pytest.mark.parametrize("volume", [False, True])
def test_preview_resolves_provider_aliases_before_secret_admission(volume):
    module = _preview_module("commerce-preview-verify.py")
    prefix = "SCOPE_COMMERCE_SANDBOX_"
    alias = prefix + "DB_PASSWORD"
    spec = {"containers": [{"env": []}]}
    if volume:
        spec["volumes"] = [{"secret": {"secretName": alias}}]
    else:
        spec["containers"][0]["env"] = [
            {"name": "DB_PASSWORD", "valueFrom": {"secretKeyRef": {"name": alias}}}
        ]
    document = {
        "metadata": {"namespace": "123456"},
        "spec": {"template": {"spec": spec, "metadata": {"annotations": {}}}},
    }
    annotations = document["spec"]["template"]["metadata"]["annotations"]
    expected = {} if volume else {"DB_PASSWORD": "DB_PASSWORD"}
    annotations["run.googleapis.com/secrets"] = f"{alias}:projects/123456/secrets/{alias}"
    module["validate_mounts"](document, expected)
    for resource in (prefix + "MIGRATOR_DB_PASSWORD", "DB_PASSWORD"):
        annotations["run.googleapis.com/secrets"] = (
            f"{alias}:projects/hushh-pda-dev/secrets/{resource}"
        )
        with pytest.raises(module["PreviewError"]):
            module["validate_mounts"](document, expected)
    annotations["run.googleapis.com/secrets"] = f"{alias}:projects/other-project/secrets/{alias}"
    with pytest.raises(module["PreviewError"], match="preview_secret_project_mismatch"):
        module["validate_mounts"](document, expected)


@pytest.mark.parametrize("prefix", ["", "SCOPE_COMMERCE_SANDBOX_"])
def test_preview_cloudbuild_preserves_iam_until_workflow_admission(prefix):
    import re

    backend = (ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    backend = backend[
        backend.index("cmd=(\n") : backend.index("# Preserve the dev-only liveness rehearsal.")
    ]
    frontend = yaml.safe_load((ROOT / "deploy/frontend.cloudbuild.yaml").read_text())
    frontend = next(step for step in frontend["steps"] if step.get("id") == "deploy-frontend")[
        "args"
    ][-1]
    frontend = frontend[
        frontend.index("cmd=(\n") : frontend.index(
            'if [[ -n "${_VPC_CONNECTOR}" ]]; then', frontend.index("cmd=(\n")
        )
    ]
    for section in (backend, frontend):
        variables = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)", section))
        env = {
            **os.environ,
            **{variable: "fixture" for variable in variables},
            "commerce_preview_prefix": prefix,
            "_SECRET_PREFIX": prefix,
        }
        result = subprocess.run(  # noqa: S603 - actual deploy command construction, no cloud execution.
            ["bash", "-eu", "-c", section + '\nprintf "%s\\n" "${cmd[@]}"'],
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )
        assert ("--allow-unauthenticated" in result.stdout.splitlines()) is (not prefix)
        assert "--no-allow-unauthenticated" not in result.stdout
