# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Cloud health deployment authority, immutable builds and operator recovery."""

import importlib.util
import io
import json
import subprocess
import tarfile
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.feature_auth_reliability


def load_health_setup():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "setup_auth_health", root / "deploy/observability/setup_auth_health.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_health_transport_scopes_adc_before_identity_verification(monkeypatch):
    import google.auth
    import google.auth.transport.requests
    import requests

    module = load_health_setup()
    calls = []

    class Credentials:
        token = "access-token"

        def refresh(self, request):
            calls.append(("refresh", request))

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"email": "github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com"}

    credentials = Credentials()

    def default(**kwargs):
        calls.append(("default", kwargs))
        return credentials, "hushh-pda-uat"

    def post(url, **kwargs):
        calls.append(("tokeninfo", url, kwargs))
        return nullcontext(Response())

    monkeypatch.setattr(google.auth, "default", default)
    monkeypatch.setattr(google.auth.transport.requests, "Request", lambda: "request")
    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(
        google.auth.transport.requests,
        "AuthorizedSession",
        lambda observed: calls.append(("session", observed)) or "authorized-session",
    )

    _, api = module._transport("hushh-pda-uat", build_only=True)

    assert api == "authorized-session"
    assert calls[0] == (
        "default",
        {"scopes": ["https://www.googleapis.com/auth/cloud-platform"]},
    )
    assert calls[1] == ("refresh", "request")
    assert calls[2][0:2] == ("tokeninfo", "https://oauth2.googleapis.com/tokeninfo")
    assert calls[3] == ("session", credentials)


def test_health_transport_stops_before_identity_or_resource_access_on_refresh_failure(
    monkeypatch,
):
    import google.auth
    import google.auth.transport.requests
    import requests

    module = load_health_setup()
    calls = []

    class Credentials:
        def refresh(self, request):
            calls.append(("refresh", request))
            raise RuntimeError("credential refresh failed")

    def default(**kwargs):
        calls.append(("default", kwargs))
        return Credentials(), "hushh-pda-uat"

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Identity or resource access must follow refresh")

    monkeypatch.setattr(google.auth, "default", default)
    monkeypatch.setattr(google.auth.transport.requests, "Request", lambda: "request")
    monkeypatch.setattr(requests, "post", unexpected)
    monkeypatch.setattr(google.auth.transport.requests, "AuthorizedSession", unexpected)

    with pytest.raises(RuntimeError, match="credential refresh failed"):
        module._transport("hushh-pda-uat", build_only=True)

    assert calls[0] == (
        "default",
        {"scopes": ["https://www.googleapis.com/auth/cloud-platform"]},
    )
    assert calls[1] == ("refresh", "request")
    assert len(calls) == 2


def test_health_source_is_pinned_despite_concurrent_worktree_edit(tmp_path, monkeypatch):
    module = load_health_setup()
    subprocess.run(  # noqa: S603 - fixed Git command in pytest's disposable directory
        ["git", "init", "--quiet", str(tmp_path)], check=True, timeout=10
    )
    source = tmp_path / "Dockerfile"
    source.write_bytes(b"reviewed source")
    subprocess.run(["git", "add", "Dockerfile"], cwd=tmp_path, check=True, timeout=10)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
        cwd=tmp_path,
        check=True,
        timeout=10,
    )
    commit = (
        subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tmp_path, timeout=10)
        .decode()
        .strip()
    )
    source.write_bytes(b"concurrent unreviewed edit")
    monkeypatch.setattr(module, "ROOT", tmp_path)
    assert module._source_blob(commit, "Dockerfile") == b"reviewed source"
    assert source.read_bytes() == b"concurrent unreviewed edit"


@pytest.mark.parametrize("case", ["same", "replaced", "lost-create-response"])
def test_health_setup_retries_preserve_workload_identity(case):
    module = load_health_setup()
    project, operation = "hushh-pda-uat", "a" * 32
    checker = f"auth-health-check@{project}.iam.gserviceaccount.com"
    journal = {"identities": {checker: "original"}} if case != "lost-create-response" else {}
    grants = []

    def cloud(args, **kwargs):
        if args[:2] == ["iam", "service-accounts"]:
            account = args[3]
            return {
                "email": account,
                "projectId": project,
                "uniqueId": "replacement" if case == "replaced" else "original",
                "description": f"Hussh auth-health operation {operation}",
            }
        if args[:3] == ["iam", "roles", "describe"]:
            return {
                "includedPermissions": [
                    "secretmanager.versions.list",
                    "secretmanager.versions.access",
                ]
            }
        grants.append(args)
        return {}

    def save(**values):
        journal.update(values)

    if case == "replaced":
        with pytest.raises(RuntimeError, match="identity changed"):
            module._identities(cloud, project, operation, "fixture-bucket", False, journal, save)
        assert not grants
        assert journal["identities"][checker] == "original"
    else:
        module._identities(cloud, project, operation, "fixture-bucket", False, journal, save)
        assert grants
        assert journal["identities"][checker] == "original"


def test_health_journal_is_atomic_and_serializes_recovery(tmp_path, monkeypatch):
    module = load_health_setup()
    path = tmp_path / "operation.json"
    with module._operation_lock(path):
        journal, save = module._journal("hushh-pda-uat", "a" * 40, path)
        initial = path.read_bytes()
        with pytest.raises(RuntimeError, match="already running"), module._operation_lock(path):
            pytest.fail("Concurrent cloud operations acquired the same journal")
        with monkeypatch.context() as patch:
            patch.setattr(
                module.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("disk full"))
            )
            with pytest.raises(OSError, match="disk full"):
                save(phase="configured")
        assert path.read_bytes() == initial
        assert journal["phase"] == "prepared"
        assert not list(tmp_path.glob(".auth-health-*"))
        save(phase="configured")
    with module._operation_lock(path):
        recovered, _ = module._journal("hushh-pda-uat", "a" * 40, path)
        assert recovered["operation"] == journal["operation"]
        assert recovered["phase"] == "configured"
        with pytest.raises(RuntimeError, match="source changed"):
            module._journal("hushh-pda-uat", "b" * 40, path)
        upgraded, _ = module._journal("hushh-pda-uat", "b" * 40, path, upgrade_from="a" * 40)
        assert upgraded["operation"] == recovered["operation"]
        assert upgraded["previous_source"] == "a" * 40
        assert upgraded["phase"] == "upgrading"


@pytest.mark.parametrize("existing", [False, True])
def test_health_build_and_timer_use_supported_cloud_cli_contracts(existing, monkeypatch):
    module = load_health_setup()
    project, operation = "hushh-pda-uat", "a" * 32
    calls = []
    image = {
        "id": "build-1",
        "status": "SUCCESS",
        "images": [f"gcr.io/{project}/auth-health-job:source"],
        "results": {
            "images": [
                {"name": f"gcr.io/{project}/auth-health-job:source", "digest": "sha256:" + "b" * 64}
            ]
        },
    }

    def cloud(args, **kwargs):
        calls.append(args)
        if args[:2] == ["builds", "list"]:
            return []
        if args[:2] == ["builds", "submit"]:
            config = json.loads(
                Path(
                    next(a.split("=", 1)[1] for a in args if a.startswith("--config="))
                ).read_text()
            )
            assert config["tags"] == [f"auth-health-{operation}", "auth-health-source-source"]
            assert config["images"] == image["images"]
            assert config["timeout"] == "600s"
            assert not any(a.startswith("--tags=") for a in args)
            return image
        return {}

    verified = []
    monkeypatch.setattr(
        module, "_source_blob", lambda source, name: b"immutable-source:" + name.encode()
    )
    monkeypatch.setattr(module, "_verify_image_source", lambda *args: verified.append(args))
    digest, _ = module._image(
        cloud, None, project, operation, "source", "fixture-bucket", lambda **_: None
    )
    assert len(verified) == 1 and "Dockerfile" in verified[0][-1]
    assert digest.endswith("b" * 64)
    name = f"projects/{project}/locations/us-central1/jobs/{module.JOB}"

    def observe(url, *, timeout, allow_redirects):
        assert timeout == 30 and allow_redirects is False
        assert url in {
            f"https://run.googleapis.com/v2/{name}",
            f"https://cloudscheduler.googleapis.com/v1/{name}",
        }
        return nullcontext(
            SimpleNamespace(
                status_code=200 if existing else 404,
                json=lambda: {
                    "name": name,
                    "labels": {"operation": operation},
                    "description": f"Hussh auth-health operation {operation}",
                },
            )
        )

    module._timer(
        cloud,
        SimpleNamespace(get=observe),
        project,
        operation,
        digest,
        "checker",
        "clock",
        False,
        "17 * * * *",
    )
    timer = next(c for c in calls if c[:2] == ["scheduler", "jobs"] and "describe" not in c)
    assert timer[2] == ("update" if existing else "create")
    assert (
        "--update-headers=" if existing else "--headers="
    ) + "Content-Type=application/json" in timer
    assert (
        "--headers=" if existing else "--update-headers="
    ) + "Content-Type=application/json" not in timer


@pytest.mark.parametrize("service", ["run", "cloudscheduler"])
@pytest.mark.parametrize(
    "failure", ["denied", "unavailable", "redirect", "malformed", "wrong-target", "wrong-owner"]
)
def test_health_timer_refuses_unverified_resources_before_mutation(service, failure):
    module = load_health_setup()
    project, operation = "hushh-pda-uat", "a" * 32
    name = f"projects/{project}/locations/us-central1/jobs/{module.JOB}"
    calls = []

    def observe(url, **kwargs):
        target = url.startswith(f"https://{service}.googleapis.com/")
        status = (
            {"denied": 403, "unavailable": 503, "redirect": 302}.get(failure, 200)
            if target
            else 200
        )
        body = {
            "name": name,
            "labels": {"operation": operation},
            "description": f"Hussh auth-health operation {operation}",
        }
        if target:
            if failure == "malformed":
                body = []
            elif failure == "wrong-target":
                body["name"] += "-foreign"
            elif failure == "wrong-owner":
                body.update(labels={"operation": "b" * 32}, description="foreign operation")
        return nullcontext(SimpleNamespace(status_code=status, json=lambda: body))

    with pytest.raises(RuntimeError, match="Health resource|health (job|schedule)"):
        module._timer(
            lambda args: calls.append(args),
            SimpleNamespace(get=observe),
            project,
            operation,
            "sha256:" + "b" * 64,
            "checker",
            "clock",
            False,
            "17 * * * *",
        )
    assert not calls


@pytest.mark.parametrize(
    "fault", [None, "recipe", "unversioned", "tampered", "extra", "link", "duplicate"]
)
def test_health_image_reuse_requires_exact_provider_source(fault):
    module = load_health_setup()
    tag = "gcr.io/hushh-pda-uat/auth-health-job:source"
    build = {
        "projectId": "hushh-pda-uat",
        "images": [tag],
        "steps": [{"name": "gcr.io/cloud-builders/docker", "args": ["build", "--tag", tag, "."]}],
        "sourceProvenance": {
            "resolvedStorageSource": {
                "bucket": "owned-bucket",
                "object": "sources/source.tgz",
                "generation": "123",
            }
        },
    }
    if fault == "recipe":
        build["steps"][0]["entrypoint"] = "unreviewed"
    if fault == "unversioned":
        del build["sourceProvenance"]["resolvedStorageSource"]["generation"]
    expected = {"Dockerfile": b"reviewed"}
    contents = io.BytesIO()
    with tarfile.open(fileobj=contents, mode="w:gz") as archive:
        names = ["Dockerfile", "Dockerfile"] if fault == "duplicate" else ["Dockerfile"]
        if fault == "extra":
            names.append("unreviewed")
        for name in names:
            body = b"tampered" if fault == "tampered" else b"reviewed"
            info = tarfile.TarInfo(name)
            info.size = len(body)
            if fault == "link":
                info.type, info.linkname = tarfile.SYMTYPE, "/private"
            archive.addfile(info, io.BytesIO(body))

    def observe(url, *, params, **kwargs):
        assert (
            url == "https://storage.googleapis.com/storage/v1/b/owned-bucket/o/sources%2Fsource.tgz"
        )
        assert params == {"alt": "media", "generation": "123"}
        assert kwargs == {"timeout": 30, "stream": True, "allow_redirects": False}
        return nullcontext(SimpleNamespace(status_code=200, raw=io.BytesIO(contents.getvalue())))

    args = (SimpleNamespace(get=observe), build, "hushh-pda-uat", "owned-bucket", tag, expected)
    if fault:
        with pytest.raises(RuntimeError, match="Health"):
            module._verify_image_source(*args)
    else:
        module._verify_image_source(*args)


@pytest.mark.parametrize("fault", [None, "foreign-operation", "foreign-project", "absent"])
def test_governed_image_build_cannot_create_or_adopt_foreign_resources(
    monkeypatch, tmp_path, fault
):
    module = load_health_setup()
    operation = "a" * 32
    bucket = {
        "name": "hushh-pda-uat-auth-health-ops",
        "projectNumber": "123",
        "labels": {"operation": "b" * 32 if fault == "foreign-operation" else operation},
    }
    if fault == "foreign-project":
        bucket["projectNumber"] = "456"
    closed, builds = [], []
    api = SimpleNamespace(close=lambda: closed.append(True))
    monkeypatch.setattr(module, "_reviewed_source", lambda: "c" * 40)
    monkeypatch.setattr(
        module,
        "_transport",
        lambda project, *, build_only: (lambda args: {"projectNumber": "123"}, api),
    )
    monkeypatch.setattr(
        module, "_existing_resource", lambda *args: None if fault == "absent" else bucket
    )
    monkeypatch.setattr(
        module, "_image", lambda *args: builds.append(args) or ("sha256:" + "d" * 64, "build-1")
    )
    receipt = tmp_path / "receipt.json"
    if fault:
        with pytest.raises(RuntimeError, match="unverified ownership"):
            module.build_image("hushh-pda-uat", operation, receipt)
        assert not builds and not receipt.exists()
    else:
        result = module.build_image("hushh-pda-uat", operation, receipt)
        assert len(builds) == 1 and result == json.loads(receipt.read_text())
        assert result["mode"] == "image-only"
    assert closed == [True]


@pytest.mark.parametrize(
    "case", ["grant", "already-present", "replaced", "wrong-operation", "lost-response"]
)
def test_uat_runtime_access_is_exact_recoverable_and_service_scoped(tmp_path, monkeypatch, case):
    module = load_health_setup()
    operation, identity, project = "a" * 32, "112891356763771456056", "hushh-pda-uat"
    checker = f"auth-health-check@{project}.iam.gserviceaccount.com"
    policy = (
        {"bindings": [{"role": "roles/run.viewer", "members": [f"serviceAccount:{checker}"]}]}
        if case == "already-present"
        else {"bindings": []}
    )
    calls = []
    api = SimpleNamespace(close=lambda: calls.append(["close"]))

    def cloud(args):
        calls.append(args)
        if args[:2] == ["projects", "describe"]:
            return {"projectNumber": "123"}
        if args[:3] == ["iam", "service-accounts", "describe"]:
            return {
                "uniqueId": "replaced" if case == "replaced" else identity,
                "email": checker,
                "projectId": project,
                "description": f"Hussh auth-health operation {operation}",
            }
        if args[:3] == ["run", "services", "get-iam-policy"]:
            return policy
        assert args == [
            "run",
            "services",
            "add-iam-policy-binding",
            "consent-protocol",
            "--region=us-central1",
            f"--member=serviceAccount:{checker}",
            "--role=roles/run.viewer",
            "--condition=None",
        ]
        policy["bindings"].append(
            {"role": "roles/run.viewer", "members": [f"serviceAccount:{checker}"]}
        )
        if case == "lost-response":
            raise RuntimeError("transport unavailable")
        return policy

    monkeypatch.setattr(module, "_reviewed_source", lambda: "b" * 40)
    monkeypatch.setattr(module, "_transport", lambda *args, **kwargs: (cloud, api))
    monkeypatch.setattr(
        module,
        "_existing_resource",
        lambda *args: {
            "projectNumber": "123",
            "labels": {"operation": "other" if case == "wrong-operation" else operation},
        },
    )
    output = tmp_path / "receipt.json"
    if case in {"replaced", "wrong-operation", "lost-response"}:
        with pytest.raises(RuntimeError):
            module.grant_runtime_observation(project, operation, identity, output)
        assert not output.exists() and calls[-1] == ["close"]
        if case != "lost-response":
            assert not any("add-iam-policy-binding" in call for call in calls)
            return
    result = module.grant_runtime_observation(project, operation, identity, output)
    assert result["mode"] == "runtime-access" and result["verified"] is True
    assert calls[-1] == ["close"]
    assert sum("add-iam-policy-binding" in call for call in calls) == (
        0 if case == "already-present" else 1
    )


def test_runtime_observation_rejects_conditional_or_different_service_members():
    module = load_health_setup()
    assert not module._has_runtime_permission(
        {
            "bindings": [
                {"role": "roles/run.viewer", "members": ["serviceAccount:other@example.invalid"]}
            ]
        },
        "checker@example.invalid",
    )
    assert not module._has_runtime_permission(
        {
            "bindings": [
                {
                    "role": "roles/run.viewer",
                    "members": ["serviceAccount:checker@example.invalid"],
                    "condition": {"expression": "false"},
                }
            ]
        },
        "checker@example.invalid",
    )


def test_monitoring_jobs_do_not_publish_application_deployment_records():
    import yaml

    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/verify-protected-lists.yml").read_text())
    for name, environment in (
        ("uat", "uat"),
        ("production", "production"),
        ("health-image", "uat"),
    ):
        assert workflow["jobs"][name]["environment"] == {"name": environment, "deployment": False}
