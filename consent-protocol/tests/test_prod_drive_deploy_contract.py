"""Production Drive release must stay closed until its fixed prerequisites pass."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
from functools import partial
from pathlib import Path

import pathspec
import pytest
import yaml

from tests.helpers.deployment_cli import probe_worker_payment_bindings, production_release_tools

ROOT = Path(__file__).resolve().parents[2]
DEV_CI_PRODUCTION_PRESERVE_INPUT_SHA256 = {
    "__production_preservation_closure__": "63309253d862ca3cbef96aafc26b9147012c307d46a8a9a46afdb52e72f75da1",
}
OLDER_TARGET_BASE_PATHS = (
    "scripts/ci/resolve-cloud-run-deploy-revision.py",
    "scripts/ci/resolve-uat-verified-image.py",
    "scripts/ci/assert_one_voice_live_probe.py",
    "scripts/ci/runtime-capacity-budget.py",
    "config/runtime-capacity.json",
    "deploy/backend.cloudbuild.yaml",
    ".gcloudignore",
    "deploy/drive/verify_hashcoin_config.sh",
    "deploy/sso/bind_workos.sh",
    "scripts/ops/sync_backend_runtime_secrets.py",
    "hushh-webapp/lib/vault/passkey-domain-aliases.json",
)


def _module(name: str):
    path = ROOT / "deploy/drive" / name
    spec = importlib.util.spec_from_file_location(name.removesuffix(".py"), path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _expand_braces(token: str) -> tuple[str, ...]:
    match = re.search(r"\{([^{}]+)\}", token)
    if match is None:
        return (token,)
    return tuple(
        token[: match.start()] + choice + token[match.end() :]
        for choice in match.group(1).split(",")
    )


def _paths_for_cp_source(root: Path, token: str) -> set[str]:
    if "$" in token or token.startswith("-"):
        return set()
    result: set[str] = set()
    for expanded in _expand_braces(token):
        if any(char in expanded for char in "*?["):
            matches = sorted(path for path in root.glob(expanded) if path.is_file())
            if matches:
                result.update(path.relative_to(root).as_posix() for path in matches)
            else:
                result.add(expanded)
        else:
            result.add(expanded)
    return result


def _cp_sources(root: Path, command: str) -> set[str]:
    try:
        words = shlex.split(command.strip())
    except ValueError:
        return set()
    if not words or words[0] != "cp" or len(words) < 3:
        return set()
    return set().union(*(_paths_for_cp_source(root, word) for word in words[1:-1]))


def _workflow_preserved_source_paths(root: Path) -> set[str]:
    workflow = yaml.safe_load((root / ".github/workflows/deploy-production.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("name") == "Preserve current release tooling"
    )
    script = re.sub(r"\\\s*\n\s*", " ", step["run"])
    loop_pattern = re.compile(
        r"(?ms)^[ \t]*for\s+(?P<variable>\w+)\s+in\s+"
        r"(?P<values>.*?)\s*;\s*do(?P<body>.*?)^[ \t]*done\b[^\n]*$"
    )
    paths: set[str] = set()
    for loop in loop_pattern.finditer(script):
        for value in shlex.split(loop.group("values")):
            body = (
                loop.group("body")
                .replace("${" + loop.group("variable") + "}", value)
                .replace("$" + loop.group("variable"), value)
            )
            for line in body.splitlines():
                if line.strip().startswith("cp "):
                    paths.update(_cp_sources(root, line.strip()))
    non_loop_script = loop_pattern.sub("", script)
    for line in non_loop_script.splitlines():
        if line.strip().startswith("cp "):
            paths.update(_cp_sources(root, line.strip()))
    return paths


def _production_preservation_input_paths(root: Path) -> tuple[str, ...]:
    paths = set(
        production_release_tools(root, OLDER_TARGET_BASE_PATHS)
    ) | _workflow_preserved_source_paths(root)
    paths.update(
        {
            ".github/workflows/deploy-production.yml",
            "consent-protocol/tests/helpers/deployment_cli.py",
            "consent-protocol/tests/helpers/production_release_tools.py",
            "consent-protocol/tests/fixtures/cloudbuild_sources.py",
        }
    )
    return tuple(sorted(paths))


def _production_preservation_input_digests(
    root: Path, paths: tuple[str, ...] | None = None
) -> dict[str, str] | None:
    digests: dict[str, str] = {}
    for relative_path in paths or _production_preservation_input_paths(root):
        try:
            contents = (root / relative_path).read_bytes()
        except FileNotFoundError:
            digests[relative_path] = "missing"
        except OSError:
            return None
        else:
            digests[relative_path] = hashlib.sha256(contents).hexdigest()
    closure = json.dumps(digests, sort_keys=True, separators=(",", ":")).encode()
    return {"__production_preservation_closure__": hashlib.sha256(closure).hexdigest()}


def _dev_ci_has_unchanged_production_preserve_inputs(environment, root: Path = ROOT) -> bool:
    repository = "hushh-labs/hushh-research"
    if environment.get("GITHUB_ACTIONS") != "true":
        return False
    if environment.get("GITHUB_REPOSITORY") != repository:
        return False
    workflow_prefix = f"{repository}/.github/workflows/ci.yml@"
    workflow_ref = environment.get("GITHUB_WORKFLOW_REF", "")
    if not workflow_ref.startswith(workflow_prefix):
        return False
    source_ref = workflow_ref.removeprefix(workflow_prefix)
    event = environment.get("GITHUB_EVENT_NAME")
    if event == "pull_request":
        if environment.get("GITHUB_BASE_REF") != "dev":
            return False
        if re.fullmatch(r"refs/pull/[1-9][0-9]*/merge", source_ref) is None:
            return False
    elif event == "workflow_dispatch":
        if (
            environment.get("GITHUB_REF") != "refs/heads/dev"
            or environment.get("GITHUB_REF_NAME") != "dev"
            or source_ref != "refs/heads/dev"
        ):
            return False
    else:
        return False
    return _production_preservation_input_digests(root) == DEV_CI_PRODUCTION_PRESERVE_INPUT_SHA256


def test_dev_ci_preserve_exception_requires_dev_context_and_unchanged_inputs(tmp_path, monkeypatch):
    synthetic_paths = (
        ".github/workflows/deploy-production.yml",
        "consent-protocol/tests/helpers/production_release_tools.py",
        "scripts/ci/tag-last-known-good.sh",
        "scripts/ci/production_emergency.py",
        "deploy/drive/resolve_protected_document_release.py",
        "scripts/ci/production_auth_domain_refresh.py",
    )
    monkeypatch.setattr(
        sys.modules[__name__],
        "_production_preservation_input_paths",
        lambda _root: synthetic_paths,
    )
    baseline_root = tmp_path / "baseline"
    for relative_path in synthetic_paths[:-1]:
        destination = baseline_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(f"synthetic production input: {relative_path}".encode())
    expected_digests = _production_preservation_input_digests(baseline_root)
    assert expected_digests is not None
    monkeypatch.setattr(
        sys.modules[__name__],
        "DEV_CI_PRODUCTION_PRESERVE_INPUT_SHA256",
        expected_digests,
    )
    dev_pr = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
        "GITHUB_WORKFLOW_REF": (
            "hushh-labs/hushh-research/.github/workflows/ci.yml@refs/pull/42/merge"
        ),
        "GITHUB_EVENT_NAME": "pull_request",
        "GITHUB_BASE_REF": "dev",
    }
    assert _dev_ci_has_unchanged_production_preserve_inputs(dev_pr, baseline_root)
    dev_dispatch = {
        **dev_pr,
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/dev",
        "GITHUB_REF_NAME": "dev",
        "GITHUB_WORKFLOW_REF": (
            "hushh-labs/hushh-research/.github/workflows/ci.yml@refs/heads/dev"
        ),
    }
    assert _dev_ci_has_unchanged_production_preserve_inputs(dev_dispatch, baseline_root)
    for outside_dev in (
        {**dev_pr, "GITHUB_BASE_REF": "main"},
        {**dev_pr, "GITHUB_BASE_REF": "uat"},
        {**dev_pr, "GITHUB_REPOSITORY": "example/other"},
        {
            **dev_pr,
            "GITHUB_WORKFLOW_REF": "hushh-labs/hushh-research/.github/workflows/deploy-uat.yml@refs/pull/42/merge",
        },
        {**dev_pr, "GITHUB_EVENT_NAME": "push"},
        {**dev_pr, "GITHUB_ACTIONS": "false"},
        {
            **dev_dispatch,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REF_NAME": "main",
            "GITHUB_WORKFLOW_REF": (
                "hushh-labs/hushh-research/.github/workflows/ci.yml@refs/heads/main"
            ),
        },
        {
            **dev_dispatch,
            "GITHUB_REF": "refs/heads/uat",
            "GITHUB_REF_NAME": "uat",
            "GITHUB_WORKFLOW_REF": (
                "hushh-labs/hushh-research/.github/workflows/ci.yml@refs/heads/uat"
            ),
        },
    ):
        assert not _dev_ci_has_unchanged_production_preserve_inputs(outside_dev, baseline_root)
    for changed_path in synthetic_paths:
        changed_root = tmp_path / f"changed-{Path(changed_path).name}"
        for relative_path in synthetic_paths[:-1]:
            destination = changed_root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = f"synthetic production input: {relative_path}".encode()
            if relative_path == changed_path:
                content += b"\nchanged\n"
            destination.write_bytes(content)
        if changed_path == synthetic_paths[-1]:
            created = changed_root / changed_path
            created.parent.mkdir(parents=True, exist_ok=True)
            created.write_bytes(b"newly present production helper")
        assert not _dev_ci_has_unchanged_production_preserve_inputs(dev_pr, changed_root)


def test_production_preserve_guard_tracks_workflow_and_rehearsal_closure():
    paths = set(_production_preservation_input_paths(ROOT))
    workflow_paths = _workflow_preserved_source_paths(ROOT)
    rehearsal_paths = set(production_release_tools(ROOT, OLDER_TARGET_BASE_PATHS))
    assert ".github/workflows/deploy-production.yml" in paths
    assert "scripts/ci/document-delivery-check.sh" not in paths
    assert workflow_paths <= paths
    assert rehearsal_paths <= paths
    assert {
        "scripts/ci/tag-last-known-good.sh",
        "scripts/ci/production_emergency.py",
        "deploy/drive/resolve_protected_document_release.py",
        "scripts/ci/production_auth_domain_refresh.py",
    }.issubset(paths)


def test_production_dispatch_is_opt_in_and_worker_precedes_app_traffic():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    assert workflow[True]["workflow_dispatch"]["inputs"]["drive_live_mode"]["default"] == "preserve"
    assert workflow["env"]["DRIVE_CANDIDATE_RUNTIME_SECRET"].endswith(
        "${{ github.run_id }}_${{ github.run_attempt }}"
    )
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Resolve production Drive release mode from serving backend") < names.index(
        "Verify production Drive prerequisites before mutation"
    )
    assert names.index("Verify production Drive prerequisites before mutation") < names.index(
        "Sync canonical hosted runtime secrets"
    )
    preflight = steps[names.index("Verify production Drive prerequisites before mutation")]
    assert (
        '--domain-catalog "${RUNNER_TEMP}/release-tools/drive-domain-aliases.json"'
        in (preflight["run"])
    )
    assert names.index("Deploy and attest private production Drive worker") < names.index(
        "Promote deployed revisions to production traffic"
    )
    worker = next(step for step in steps if step.get("id") == "deploy-drive-worker")
    assert "steps.drive-mode.outputs.active == 'true'" in worker["if"]
    assert worker["env"]["RELEASE_RUN_ATTEMPT"] == (
        "${{ steps.staged-worker.outputs.loaded == 'true' && steps.staged-worker.outputs.attempt || github.run_attempt }}"
    )
    promote = next(step for step in steps if step.get("id") == "promote-traffic")
    assert "steps.deploy-drive-worker.outcome == 'success'" in promote["if"]
    assert any(step.get("id") == "rollback-drive-worker" for step in steps)


def test_drive_release_mode_preserves_live_state_and_requires_explicit_change():
    module = _module("resolve_prod_release_mode.py")
    revision = {
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": "production"},
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "true"},
                        {
                            "name": "BACKEND_RUNTIME_CONFIG_JSON",
                            "valueFrom": {
                                "secretKeyRef": {"name": "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_123_1"}
                            },
                        },
                    ]
                }
            ]
        }
    }
    runtime = {"environment": "production", **dict.fromkeys(module.DRIVE_FLAGS, "true")}
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (True, True)
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=False, revision=revision, runtime=runtime
    ) == (True, True)
    assert module.resolve_mode(
        requested_mode="disable", backend_deploy=True, revision=revision, runtime=runtime
    ) == (True, False)
    with pytest.raises(module.DriveReleaseStateError, match="requires a backend release"):
        module.resolve_mode(
            requested_mode="disable", backend_deploy=False, revision=revision, runtime=runtime
        )
    runtime["google_drive_live"] = "false"
    with pytest.raises(module.DriveReleaseStateError, match="incomplete"):
        module.resolve_mode(
            requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
        )


def test_drive_release_mode_defaults_off_until_explicit_enable():
    module = _module("resolve_prod_release_mode.py")
    revision = {
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": "production"},
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "false"},
                        {
                            "name": "BACKEND_RUNTIME_CONFIG_JSON",
                            "valueFrom": {"secretKeyRef": {"name": "BACKEND_RUNTIME_CONFIG_JSON"}},
                        },
                    ]
                }
            ]
        }
    }
    runtime = {"environment": "production", **dict.fromkeys(module.DRIVE_FLAGS, "false")}
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, False)
    assert module.resolve_mode(
        requested_mode="enable", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, True)
    revision["spec"]["containers"][0]["env"][2]["valueFrom"]["secretKeyRef"]["name"] = (
        "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_123_1"
    )
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, False)


def test_production_backend_config_stays_on_candidate_and_frontend_scope_skips_places():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    by_name = {step["name"]: step for step in steps}
    places = by_name["Verify production Places prerequisites"]
    assert "steps.scope.outputs.deploy_backend == 'true'" in places["if"]
    backend_sync = by_name["Sync canonical hosted runtime secrets"]
    frontend_sync = by_name["Sync frontend hosted runtime secrets"]
    assert (
        backend_sync["if"]
        == "env.PHONE_DEPLOY_PHASE != 'cold' && (steps.scope.outputs.deploy_backend == 'true')"
    )
    assert (
        frontend_sync["if"]
        == "env.PHONE_DEPLOY_PHASE != 'cold' && steps.scope.outputs.deploy_frontend == 'true' && !inputs.frontend_auth_domain_refresh"
    )
    assert backend_sync["run"] == "bash deploy/drive/sync_runtime_config_prod.sh"
    common_sync = (ROOT / "deploy/drive/sync_runtime_config_prod.sh").read_text()
    assert "sync_backend_runtime_secrets.py" in common_sync
    assert "sync_frontend_runtime_secrets.py" not in backend_sync["run"]
    assert "sync_frontend_runtime_secrets.py" in frontend_sync["run"]
    deploy = by_name["Deploy backend using Cloud Build"]["run"]
    assert (
        'DRIVE_SUBSTITUTIONS=",_BACKEND_RUNTIME_CONFIG_JSON_SECRET=${DRIVE_CANDIDATE_RUNTIME_SECRET}"'
        in deploy
    )
    readiness = by_name["Verify backend candidate readiness and exact-SHA provenance"]["run"]
    assert 'expected_runtime_secret = os.environ["DRIVE_CANDIDATE_RUNTIME_SECRET"]' in readiness


def test_production_drive_worker_keeps_refund_credentials_bound_and_fails_closed():
    script = (ROOT / "deploy/drive/deploy_worker_service_prod.sh").read_text()
    block = (
        'payment_secret_bindings=""'
        + script.split('payment_secret_bindings=""', 1)[1].split("\ngcloud --quiet run deploy", 1)[
            0
        ]
    )
    assert "${payment_secret_bindings}" in script.split("--set-secrets=", 1)[1]
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    worker = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("id") == "deploy-drive-worker"
    )
    assert worker["env"]["DRIVE_REQUEST_PAYMENTS_PROD_ENABLED"] == (
        "${{ vars.DRIVE_REQUEST_PAYMENTS_PROD_ENABLED || 'false' }}"
    )
    mocked = """set -euo pipefail
PROJECT_ID=hushh-pda
REGION=us-central1
previous_revision="${PREVIOUS_REVISION:-}"
gcloud() {
  if [[ "$1" == secrets && "$2" == describe ]]; then
    [[ "$3" != "${MISSING_SECRET:-}" ]]
  elif [[ "$1" == run && "$2" == revisions && "$3" == describe ]]; then
    if [[ "${PREVIOUS_STRIPE_BOUND:-false}" == true ]]; then
      printf '%s\\n' '{"spec":{"containers":[{"name":"drive-worker","env":[{"name":"STRIPE_SECRET_KEY","valueFrom":{"secretKeyRef":{"name":"STRIPE_SECRET_KEY"}}}]}]}}'
    else
      printf '%s\\n' '{"spec":{"containers":[{"name":"drive-worker","env":[]}]}}'
    fi
  else
    return 2
  fi
}
"""

    run = partial(probe_worker_payment_bindings, block, mocked)

    ready = run(enabled=False)
    assert ready.returncode == 0
    assert "STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest" in ready.stdout
    assert "STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest" in ready.stdout
    assert "APP_FRONTEND_ORIGIN=APP_FRONTEND_ORIGIN:latest" in ready.stdout
    missing_off = run(enabled=False, missing="STRIPE_WEBHOOK_SECRET")
    assert missing_off.returncode == 0 and missing_off.stdout == ""
    hosted_ready = run(enabled=False, hosted=True)
    assert (
        hosted_ready.returncode == 0
        and "STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest" in hosted_ready.stdout
    )
    hosted_missing = run(enabled=False, hosted=True, missing="STRIPE_WEBHOOK_SECRET")
    assert hosted_missing.returncode != 0
    assert "requires the production Stripe and origin secrets" in hosted_missing.stderr
    missing_previous = run(enabled=False, missing="STRIPE_WEBHOOK_SECRET", previous_bound=True)
    assert missing_previous.returncode != 0
    assert "requires the production Stripe and origin secrets" in missing_previous.stderr
    for secret in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "APP_FRONTEND_ORIGIN"):
        missing_on = run(enabled=True, missing=secret)
        assert missing_on.returncode != 0
        assert "requires the production Stripe and origin secrets" in missing_on.stderr


def test_disabling_drive_preserves_jobs_until_promotion_and_restores_on_failure():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert (
        names.index("Promote deployed revisions to production traffic")
        < names.index("Quarantine production Drive jobs after disabling live Drive")
        < names.index("Post-deploy backend runtime health gate")
    )
    pause = next(step for step in steps if step.get("id") == "pause-drive-worker")
    assert pause["run"].index(" capture ") < pause["run"].index(" quarantine")
    assert pause["run"].index('echo "snapshot=') < pause["run"].index(" quarantine")
    classify = next(step for step in steps if step.get("id") == "classify")
    assert (
        "backend_failure=true"
        in classify["run"].split(
            'if [ "$release_failed" = "true" ] && [ -n "$DRIVE_PAUSE_SNAPSHOT" ]; then'
        )[1]
    )
    restore = next(step for step in steps if step.get("id") == "rollback-paused-drive-worker")
    assert "steps.rollback-backend.outcome == 'success'" in restore["if"]
    assert "work_drain_scheduler_snapshot_prod.py restore" in restore["run"]


@pytest.mark.parametrize(
    "worker_origin", [None, "https://consent-protocol-drive-worker-test.a.run.app"]
)
def test_quarantined_drive_job_restores_exact_prior_state(monkeypatch, tmp_path, worker_origin):
    module = _module("work_drain_scheduler_snapshot_prod.py")
    name = "drive-work-drain-prod"
    job = module._candidate_job(name, worker_origin or module.PUBLIC_ORIGIN)
    if worker_origin is None:
        job["audience"] = module.PUBLIC_ORIGIN
    raw = {
        "name": f"projects/{module.PROJECT}/locations/{module.LOCATION}/jobs/{name}",
        "httpTarget": {
            "uri": job["uri"],
            "httpMethod": job["httpMethod"],
            "body": base64.b64encode(job["body"].encode()).decode(),
            "headers": dict(job["headers"]),
            "oidcToken": {
                "serviceAccountEmail": job["serviceAccountEmail"],
                "audience": job["audience"],
            },
        },
        "schedule": job["schedule"],
        "timeZone": job["timeZone"],
        "state": job["state"],
        "attemptDeadline": job["attemptDeadline"],
        "retryConfig": dict(job["retryConfig"]),
    }
    monkeypatch.setattr(module, "_job_names", lambda: {name})
    monkeypatch.setattr(module, "_describe", lambda _: raw)

    def fake_gcloud(*args):
        if args[:3] == ("scheduler", "jobs", "pause"):
            raw["state"] = "PAUSED"
        elif args[:3] == ("scheduler", "jobs", "resume"):
            raw["state"] = "ENABLED"
        elif args[:3] != ("scheduler", "jobs", "update"):
            raise AssertionError(f"Unexpected scheduler mutation: {args[:3]}")
        return ""

    monkeypatch.setattr(module, "_gcloud", fake_gcloud)
    snapshot = tmp_path / "scheduler.json"
    module.capture(snapshot, worker_origin=worker_origin)
    module.quarantine()
    assert raw["state"] == "PAUSED"
    module.restore(snapshot, worker_origin=worker_origin)
    assert raw["state"] == "ENABLED"
    module.verify(snapshot, worker_origin=worker_origin)


def test_production_preflight_rejects_unattested_oauth_and_wrong_picker(monkeypatch):
    module = _module("verify_prod_prerequisites.py")
    with pytest.raises(module.PrerequisiteError, match="attestation is missing"):
        module.verify(oauth_attested=False)

    values = {name: "value" for name in module.SECRETS}
    values["GOOGLE_DRIVE_OAUTH_CLIENT_ID"] = "client.apps.googleusercontent.com"
    values["DRIVE_DOCUMENT_KEY_V1"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    values["DRIVE_SHARING_KEY_V1"] = base64.b64encode(b"\x01" * 32).decode()
    values["EXTERNAL_CONNECTOR_CREDENTIAL_KEY"] = base64.b64encode(b"\x02" * 32).decode()
    monkeypatch.setattr(module, "_secret", values.__getitem__)
    expected_referrers = {
        "https://one.hushh.ai/*",
        "https://one.hussh.ai/*",
        "https://one.hussh.si/*",
    }
    referrers = list(expected_referrers)

    def fake_gcloud(*args):
        if args[:3] == ("services", "api-keys", "list"):
            return json.dumps(
                [
                    {
                        "name": "projects/prod/locations/global/keys/reviewed",
                        "displayName": module.PICKER_KEY_NAME,
                        "restrictions": {
                            "apiTargets": [{"service": "picker.googleapis.com"}],
                            "browserKeyRestrictions": {"allowedReferrers": referrers},
                        },
                    }
                ]
            )
        if args[:3] == ("services", "api-keys", "get-key-string"):
            return json.dumps({"keyString": values["GOOGLE_DRIVE_PICKER_API_KEY"]})
        if args[:2] == ("projects", "get-iam-policy"):
            return json.dumps(
                {
                    "bindings": [
                        {
                            "role": "roles/cloudscheduler.jobRunner",
                            "members": [f"serviceAccount:{module.RUNTIME_ACCOUNT}"],
                        }
                    ]
                }
            )
        return "{}"

    monkeypatch.setattr(module, "_gcloud", fake_gcloud)
    module.verify(oauth_attested=True)
    for invalid in (
        ["https://uat.one.hushh.ai/*"],
        [*expected_referrers, "https://uat.one.hussh.ai/*"],
        [*expected_referrers, "https://uat.one.hussh.si/*"],
        [*expected_referrers, "http://one.hushh.ai/*"],
        [*expected_referrers, "https://*.hussh.ai/*"],
        ["https://one.hushh.ai/*", "https://one.hussh.ai/*"],
        ["https://one.hushh.ai/*"],
    ):
        referrers[:] = invalid
        with pytest.raises(module.PrerequisiteError, match="restrictions are incomplete"):
            module.verify(oauth_attested=True)
    referrers[:] = expected_referrers
    for reused in (values["DRIVE_DOCUMENT_KEY_V1"], values["DRIVE_SHARING_KEY_V1"], "\x00" * 32):
        values["EXTERNAL_CONNECTOR_CREDENTIAL_KEY"] = reused
        with pytest.raises(module.PrerequisiteError, match="must be distinct"):
            module.verify(oauth_attested=True)
    values["EXTERNAL_CONNECTOR_CREDENTIAL_KEY"] = base64.b64encode(b"\x02" * 32).decode()

    values["DRIVE_SHARING_KEY_V1"] = values["DRIVE_DOCUMENT_KEY_V1"]
    with pytest.raises(module.PrerequisiteError, match="must be distinct"):
        module.verify(oauth_attested=True)


def test_first_production_worker_release_snapshots_absent_fixed_jobs(monkeypatch, tmp_path):
    module = _module("work_drain_scheduler_snapshot_prod.py")
    monkeypatch.setattr(module, "_job_names", lambda: set())
    snapshot = tmp_path / "scheduler.json"
    module.capture(snapshot, worker_origin=None)
    payload = json.loads(snapshot.read_text())
    assert payload["schema"] == "drive.scheduler.prod.snapshot.v1"
    assert set(payload["jobs"]) == {
        "drive-work-drain-prod",
        "drive-work-suggestions-prod",
        "drive-work-sharing-prod",
    }
    assert all(value is None for value in payload["jobs"].values())
    payload["jobs"]["drive-work-drain-uat"] = None
    snapshot.write_text(json.dumps(payload))
    with pytest.raises(module.SchedulerStateError, match="snapshot is invalid"):
        module.verify(snapshot, worker_origin=None)


def test_older_target_keeps_release_tooling_but_cannot_enable_drive(tmp_path, monkeypatch):
    """Run the actual checkout steps against an old commit without production Drive."""
    if _dev_ci_has_unchanged_production_preserve_inputs(os.environ):
        pytest.skip("production current-tool preservation is verified outside Dev CI")
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = {step["name"]: step for step in workflow["jobs"]["deploy"]["steps"]}
    repo = tmp_path / "repo"
    repo.mkdir()
    runner = tmp_path / "runner"

    def git(*args):
        return subprocess.run(  # noqa: S603 - fixed git command and synthetic fixture arguments
            ["git", *args], cwd=repo, capture_output=True, text=True, check=True
        ).stdout.strip()

    def write(path, contents):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)

    git("init", "-q")
    git("config", "user.name", "Drive Release Test")
    git("config", "user.email", "drive-release@example.test")
    old_paths = OLDER_TARGET_BASE_PATHS
    catalog_path = old_paths[-1]
    old_catalog = json.dumps({"production": ["one.hushh.ai", "one.hussh.ai"]})
    for path in old_paths:
        contents = old_catalog if path == catalog_path else "old release tooling\n"
        if path == ".gcloudignore":
            contents = "*.sh\n!deploy/drive/verify_hashcoin_config.sh\n!deploy/sso/bind_workos.sh\n"
        elif path in {"deploy/drive/verify_hashcoin_config.sh", "deploy/sso/bind_workos.sh"}:
            contents = (ROOT / path).read_text()
        write(path, contents)
    git("add", ".")
    git("commit", "-qm", "Old application target")
    old_sha = git("rev-parse", "HEAD")
    old_upload_policy = git("show", f"{old_sha}:.gcloudignore")
    current_paths = production_release_tools(ROOT, old_paths)
    for path in current_paths:
        write(path, (ROOT / path).read_text())
    registry = "consent-protocol/hushh_mcp/services/drive_prod_registry_provisioning.py"
    write(registry, "# Production Drive runtime support\n")
    git("add", ".")
    git("commit", "-qm", "Introduce production Drive support")
    feature_sha = git("rev-parse", "HEAD")
    env = {**os.environ, "RUNNER_TEMP": str(runner)}
    subprocess.run(  # noqa: S603 - execute the repo-authored release steps in an isolated fixture
        ["bash", "-c", steps["Preserve current release tooling"]["run"]],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    checkout = steps["Checkout deployment SHA"]["run"].replace(
        "${{ github.event.inputs.sha }}", old_sha
    )
    subprocess.run(  # noqa: S603 - execute the repo-authored release steps in an isolated fixture
        ["bash", "-c", checkout], cwd=repo, env=env, capture_output=True, text=True, check=True
    )
    for companion in (
        "resolve-deploy-scope.py",
        "release_acceptance_provenance.py",
        "production_emergency.py",
        "require-deploy-sha-on-main.sh",
        "resolve-cloud-run-serving-state.py",
    ):
        assert (runner / "release-tools" / companion).read_text() == (
            ROOT / "scripts/ci" / companion
        ).read_text()
    for path in current_paths:
        # Main-owned helpers are consumed directly from RUNNER_TEMP.
        if path.endswith(
            (
                "tag-last-known-good.sh",
                "resolve-cloud-run-deploy-revision.py",
                "resolve-uat-verified-image.py",
                "verify-predecessor-acceptance.py",
                "release_acceptance_provenance.py",
                "resolve-deploy-scope.py",
                "production_emergency.py",
                "require-deploy-sha-on-main.sh",
                "resolve-cloud-run-serving-state.py",
                "verify-prod-places-readiness.py",
                "passkey-domain-aliases.json",
            )
        ):
            continue
        assert (repo / path).read_text() == (ROOT / path).read_text()
    # Import the restored policies without cloud access.
    subprocess.run(  # noqa: S603 - pure restored policy helpers, synthetic checkout
        [
            sys.executable,
            "-c",
            "import runpy; "
            "sync = runpy.run_path('scripts/ops/sync_backend_runtime_secrets.py'); "
            "assert callable(sync['_scope_commerce_runtime_policy']()['apply_policy']); "
            "assert callable(runpy.run_path('scripts/ops/shared_files_runtime_policy.py')['apply_policy']); "
            "assert callable(runpy.run_path('scripts/ops/passkey_domain_policy.py')['allowed_rp_ids']); "
            "runpy.run_path('scripts/ops/upsert_gcp_secret.py', run_name='restored_secret_tool')",
        ],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    build = yaml.safe_load((repo / "deploy/backend.cloudbuild.yaml").read_text())
    from tests.fixtures.cloudbuild_sources import cloudbuild_sourced_shell_helpers

    referenced = cloudbuild_sourced_shell_helpers(repo, build)
    assert "scripts/deploy/backend-deploy.sh" in referenced
    assert "scripts/deploy/verify-managed-vertex-runtime.sh" in referenced
    referenced.update(
        match
        for step in build["steps"]
        for argument in step.get("args", [])
        for match in re.findall(
            r"\bpython3\s+(scripts/ci/managed_provider_readiness\.py)\b", argument
        )
    )
    assert referenced, "Exercise the preserved Cloud Build source dependencies"
    assert "scripts/ci/managed_provider_readiness.py" in referenced
    upload_filter = pathspec.GitIgnoreSpec.from_lines(
        (repo / ".gcloudignore").read_text().splitlines()
    )
    for helper in referenced:
        assert (repo / helper).is_file()
        assert not upload_filter.match_file(helper), f"Older target upload excludes {helper}"
        for directory in Path(helper).parents:
            if directory != Path("."):
                assert not upload_filter.match_file(directory.as_posix() + "/")
    # The old target's upload rule must reject the newly preserved companion.
    assert pathspec.GitIgnoreSpec.from_lines(old_upload_policy.splitlines()).match_file(
        "deploy/email-auth/bind_secrets.sh"
    )
    assert upload_filter.match_file(".env"), "Keep secret-file upload exclusion intact"

    # Current tooling on an older app SHA must keep production email OTP disabled.
    subprocess.run(  # noqa: S603 - fixed authored shell helper in the synthetic checkout
        [
            "bash",
            "-c",
            "set -euo pipefail; add_secret() { return 99; }; "
            "source deploy/email-auth/bind_secrets.sh production",
        ],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert (runner / "release-tools/verify-prod-places-readiness.py").read_text() == (
        ROOT / "scripts/ci/verify-prod-places-readiness.py"
    ).read_text()
    assert (repo / "scripts/ci/process_group.py").read_text() == (
        ROOT / "scripts/ci/process_group.py"
    ).read_text()
    retained_catalog = runner / "release-tools/drive-domain-aliases.json"
    assert retained_catalog.read_text() == (ROOT / catalog_path).read_text()
    assert (repo / catalog_path).read_text() == old_catalog
    preflight_module = _module("verify_prod_prerequisites.py")
    assert "https://one.hussh.si/*" in preflight_module._picker_referrers(retained_catalog)
    assert "https://one.hussh.si/*" not in preflight_module._picker_referrers(repo / catalog_path)
    assert not (repo / registry).exists(), (
        "Release tooling must not replace target application code"
    )
    assert (runner / "release-tools/prod-drive-feature-commit").read_text().strip() == feature_sha

    module = _module("resolve_prod_release_mode.py")
    monkeypatch.chdir(repo)
    module.verify_target_support(
        active=False, backend_deploy=True, target_sha=old_sha, required_ancestor=feature_sha
    )
    with pytest.raises(module.DriveReleaseStateError, match="runtime support"):
        module.verify_target_support(
            active=True, backend_deploy=True, target_sha=old_sha, required_ancestor=feature_sha
        )
    module.verify_target_support(
        active=True, backend_deploy=True, target_sha=feature_sha, required_ancestor=feature_sha
    )
