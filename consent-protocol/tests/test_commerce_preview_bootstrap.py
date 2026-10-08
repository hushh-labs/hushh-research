"""Private first-release bootstrap and rollback admission boundaries."""

import json
import subprocess
import sys
from runpy import run_path

import pytest
import yaml

from tests.test_commerce_preview_target import ROOT, _preview_module


def _bootstrap_fixture(module, identifier, *, bootstrap=True):
    name = f"{module['PARENT']}/services/{identifier}"
    image = module["BOOTSTRAP_REPOSITORY"] + "@sha256:" + "a" * 64
    template = module["bootstrap_template"](image, "b" * 40)
    if not bootstrap:
        repository = "hushh-webapp" if identifier == module["FRONTEND"] else "consent-protocol"
        template["containers"][0]["image"] = (
            f"gcr.io/{module['PROJECT']}/{repository}@sha256:" + "c" * 64
        )
        template["labels"] = {"deploy-sha": "d" * 40}
    revision_id = identifier + "-00001-fixture"
    revision = {**template, "name": name + "/revisions/" + revision_id}
    service = {
        "name": name,
        "etag": "fixture-etag",
        "template": template,
        "uri": "https://fixed-preview.run.app",
        "reconciling": False,
        "latestReadyRevision": revision["name"],
        "trafficStatuses": [{"revision": revision_id, "percent": 100}],
    }
    return service, revision, image


@pytest.mark.parametrize(
    "mutation",
    [
        "identity",
        "image",
        "secret",
        "public",
        "disabled",
        "traffic",
        "sha",
        "revision",
        "project",
        "path",
        "dot",
        "ready",
    ],
)
def test_preview_bootstrap_rejects_wrong_identity_or_capabilities(mutation):
    module = _preview_module("commerce-preview-bootstrap.py")
    service, revision, _ = _bootstrap_fixture(module, module["BACKEND"])
    policy = {}
    if mutation == "identity":
        revision["serviceAccount"] = "wrong@example.invalid"
    elif mutation == "image":
        revision["containers"][0]["image"] = "gcr.io/other/image@sha256:" + "a" * 64
    elif mutation == "secret":
        revision["containers"][0]["env"] = [{"name": "SDK_KEY", "value": "synthetic"}]
    elif mutation == "public":
        policy = {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
    elif mutation == "disabled":
        service["invokerIamDisabled"] = True
    elif mutation == "traffic":
        service["trafficStatuses"][0]["percent"] = 50
    elif mutation == "revision":
        service["trafficStatuses"][0]["revision"] = module["FRONTEND"] + "-00001-fixture"
    elif mutation == "path":
        service["trafficStatuses"][0]["revision"] = revision["name"] + "/../../other"
    elif mutation == "project":
        service["trafficStatuses"][0]["revision"] = revision["name"].replace(
            module["PROJECT"], "other-project"
        )
    elif mutation == "dot":
        service["trafficStatuses"][0]["revision"] = service["name"] + "/revisions/.."
    elif mutation == "ready":
        service["latestReadyRevision"] = revision["name"] + "-other"
    else:
        revision["labels"]["deploy-sha"] = "unverified"

    class FakeApi:
        def request(self, path):
            if path.endswith(":getIamPolicy"):
                return policy
            if path == f"projects/{module['PROJECT']}":
                return {"projectId": module["PROJECT"]}
            assert path == revision["name"], "Only the exact service revision may be read"
            return revision

    with pytest.raises(module["BootstrapError"]):
        module["inspect"](FakeApi(), service["name"], service)


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("full_revision", [False, True])
def test_fixed_preview_bootstrap_creates_only_missing_lanes_and_preserves_applications(
    tmp_path, existing, full_revision
):
    module = _preview_module("commerce-preview-bootstrap.py")
    writes = []
    services, revisions = {}, {}
    for identifier in (module["BACKEND"], module["FRONTEND"]):
        service, revision, image = _bootstrap_fixture(module, identifier, bootstrap=not existing)
        if full_revision:
            service["trafficStatuses"][0]["revision"] = revision["name"]
        services[service["name"]] = service
        revisions[revision["name"]] = revision
    present = set(services) if existing else set()

    class FakeApi:
        def request(self, path, *, method="GET", body=None, missing=False):
            if method == "POST":
                writes.append((path, body))
                identifier = path.split("serviceId=")[1]
                name = module["PARENT"] + "/services/" + identifier
                present.add(name)
                return {"name": module["PARENT"] + "/operations/create", "done": True}
            if path == f"projects/{module['PROJECT']}":
                return {"projectId": module["PROJECT"]}
            if path.endswith(":getIamPolicy"):
                return {}
            if path in services:
                return services[path] if path in present else None
            return revisions[path]

        def finish(self, _):
            pass

    report = module["ensure"](FakeApi(), image, "b" * 40, tmp_path / "receipt.json")
    assert report["status"] == "ready_for_configuration"
    assert len(writes) == (0 if existing else 2)
    assert {lane["kind"] for lane in report["lanes"].values()} == {
        "application" if existing else "bootstrap"
    }
    for path, body in writes:
        assert module["PARENT"] in path and body["invokerIamDisabled"] is False
        assert body["template"]["serviceAccount"] == module["RUNTIME_SA"]
        assert not body["template"].get("volumes") and not body["template"]["containers"][0].get(
            "env"
        )
        # Cloud Run v2 otherwise defaults an explicit limits object to always-on
        # CPU, which rejects this 256Mi private provisioning responder.
        assert body["template"]["containers"][0]["resources"]["cpuIdle"] is True


def test_preview_bootstrap_does_not_treat_access_denial_as_missing(monkeypatch):
    module = _preview_module("commerce-preview-bootstrap.py")
    from urllib.error import HTTPError

    def denied(*_, **__):
        raise HTTPError("https://run.googleapis.com", 403, "denied", {}, None)

    monkeypatch.setitem(module["CloudRun"].request.__globals__, "urlopen", denied)
    api = module["CloudRun"].__new__(module["CloudRun"])
    api._token = "synthetic"
    with pytest.raises(module["BootstrapError"]):
        api.request(module["PARENT"] + "/services/" + module["BACKEND"], missing=True)


def test_inherited_public_authority_blocks_bootstrap_before_service_creation(tmp_path):
    module = _preview_module("commerce-preview-bootstrap.py")

    class InheritedApi:
        def request(self, path, *, method="GET", **_):
            assert method == "GET", "No provisioning after inherited public authority"
            if path == f"projects/{module['PROJECT']}":
                return {"projectId": module["PROJECT"], "parent": "folders/123"}
            if path == "folders/123:getIamPolicy":
                return {
                    "bindings": [{"role": "roles/run.admin", "members": ["allAuthenticatedUsers"]}]
                }
            return {}

    with pytest.raises(module["BootstrapError"], match="bootstrap_public_ancestor"):
        module["ensure"](
            InheritedApi(),
            module["BOOTSTRAP_REPOSITORY"] + "@sha256:" + "a" * 64,
            "b" * 40,
            tmp_path / "receipt.json",
        )


def test_ancestor_permission_failure_is_safe_and_prevents_provisioning(monkeypatch, tmp_path):
    from urllib.error import HTTPError

    module = _preview_module("commerce-preview-bootstrap.py")
    api = module["CloudRun"].__new__(module["CloudRun"])
    api._token = "synthetic-private-token"
    calls = []

    def denied(request, **_):
        calls.append(request.get_method())
        raise HTTPError(request.full_url, 403, "synthetic-private-body", {}, None)

    monkeypatch.setitem(api.request.__globals__, "urlopen", denied)

    class AncestryApi:
        def request(self, path, **kwargs):
            if path == f"projects/{module['PROJECT']}":
                return {"projectId": module["PROJECT"], "parent": "folders/123"}
            if path == f"projects/{module['PROJECT']}:getIamPolicy":
                return {}
            assert path == "folders/123:getIamPolicy", "No service admission after denied ancestor"
            return api.request(path, **kwargs)

    with pytest.raises(module["BootstrapError"]) as caught:
        module["ensure"](
            AncestryApi(),
            module["BOOTSTRAP_REPOSITORY"] + "@sha256:" + "a" * 64,
            "b" * 40,
            tmp_path / "receipt.json",
        )
    assert calls == ["POST"]
    assert module["safe_failure"](caught.value) == {
        "error": "commerce_preview_bootstrap_unverified",
        "stage": "ancestor_policy",
        "http_status": 403,
    }
    assert module["safe_failure"](RuntimeError("synthetic-private-token")) == {
        "error": "commerce_preview_bootstrap_unverified",
        "stage": "validation",
        "http_status": None,
    }


@pytest.mark.parametrize(
    "first,report_status,expected",
    [
        (False, "ready_for_configuration", "rolled_back"),
        (True, "quarantined", "quarantined"),
        (True, "ready_for_configuration", "blocked"),
    ],
)
def test_preview_first_release_status_never_impersonates_an_application_rollback(
    tmp_path, first, report_status, expected
):
    module = _preview_module("commerce-preview-bootstrap.py")
    path = tmp_path / "baseline.json"
    report = {
        "target": "scope-commerce-sandbox",
        "status": report_status,
        "lanes": {"backend": {"kind": "bootstrap" if first else "application"}},
    }
    path.write_text(json.dumps(report))
    if not first:

        class NoCloudWrites:
            def request(self, *_args, **_kwargs):
                pytest.fail("Existing application must use its own rollback")

        module["quarantine"](NoCloudWrites(), path)
        assert json.loads(path.read_text()) == report
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("name") == "Write dev release status artifact"
    )
    program = step["run"].split("<<'PYBOOTSTRAP'", 1)[1].split("PYBOOTSTRAP", 1)[0]
    program = program.replace("/tmp/dev-preview-bootstrap.json", str(path)).replace(  # noqa: S108 - replace runner-owned path with fixture.
        "${{ steps.classify-dev-release.outputs.release_failed }}", "true"
    )
    result = subprocess.run(  # noqa: S603 - repository-owned classifier, synthetic fixture.
        [sys.executable, "-c", program, "rolled_back"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == expected


def test_bootstrap_responder_remains_inert_and_unavailable():
    import threading
    from urllib.error import HTTPError
    from urllib.request import urlopen

    module = run_path(str(ROOT / "deploy/commerce-preview-bootstrap/responder.py"))
    server = module["ThreadingHTTPServer"](("127.0.0.1", 0), module["ProvisioningHandler"])
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with pytest.raises(HTTPError) as error:
            urlopen(f"http://127.0.0.1:{server.server_port}/health", timeout=2)  # noqa: S310 - task-owned loopback server.
        assert error.value.code == 503
        assert error.value.headers["Cache-Control"] == "no-store"
        assert json.loads(error.value.read()) == {"status": "provisioning"}
        source = (ROOT / "deploy/commerce-preview-bootstrap/responder.py").read_text()
        assert not any(name in source for name in ("hushh_mcp", "stripe", "database", "firebase"))
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


@pytest.mark.parametrize(
    "failure", [None, "bootstrap", "revision", "source", "anonymous", "unhealthy", "denied"]
)
def test_public_admission_requires_both_promoted_authenticated_applications(failure):
    module = _preview_module("commerce-preview-public-admission.py")
    bootstrap = module["BOOTSTRAP"]
    services, revisions, candidates, policies, writes = {}, {}, {}, {}, []
    for identifier in (bootstrap["BACKEND"], bootstrap["FRONTEND"]):
        service, revision, _ = _bootstrap_fixture(bootstrap, identifier, bootstrap=False)
        services[service["name"]] = service
        revisions[revision["name"]] = revision
        policies[service["name"]] = {
            "bindings": [
                {
                    "role": "roles/run.invoker",
                    "members": ["serviceAccount:existing@example.invalid"],
                }
            ]
        }
        candidates[identifier] = {
            "ok": True,
            "service": identifier,
            "project": bootstrap["PROJECT"],
            "region": bootstrap["REGION"],
            "expected": {"HUSHH_DEPLOY_SHA": "d" * 40, "HUSHH_DEPLOY_RUN_ID": "99"},
            "http_health": {"status_code": "200", "authentication": "workload_identity"},
            "checked_revisions": [{"ok": True, "revision": revision["name"].rsplit("/", 1)[-1]}],
        }
    # Mutate the second lane: a valid first lane never permits premature IAM.
    name = bootstrap["PARENT"] + "/services/" + bootstrap["FRONTEND"]
    candidate = candidates[bootstrap["FRONTEND"]]
    if failure == "bootstrap":
        service, revision, _ = _bootstrap_fixture(bootstrap, bootstrap["FRONTEND"])
        services[name] = service
        revisions[revision["name"]] = revision
    elif failure == "revision":
        candidate["checked_revisions"][0]["revision"] += "-other"
    elif failure == "source":
        candidate["expected"]["HUSHH_DEPLOY_SHA"] = "e" * 40
    elif failure == "anonymous":
        candidate["http_health"]["authentication"] = "anonymous"
    elif failure == "unhealthy":
        candidate["http_health"]["status_code"] = "403"

    class FakeApi:
        def request(self, path, *, method="GET", body=None):
            if path.endswith(":setIamPolicy"):
                writes.append(path)
                if failure == "denied":
                    raise bootstrap["BootstrapError"](
                        "bootstrap_cloud_request_failed", stage="service_policy", http_status=403
                    )
                policies[path.removesuffix(":setIamPolicy")] = json.loads(
                    json.dumps(body["policy"])
                )
                return {}
            if path.endswith(":getIamPolicy"):
                return json.loads(json.dumps(policies.get(path.removesuffix(":getIamPolicy"), {})))
            if path == f"projects/{bootstrap['PROJECT']}":
                return {"projectId": bootstrap["PROJECT"]}
            return services[path] if path in services else revisions[path]

    if failure:
        with pytest.raises(bootstrap["BootstrapError"]):
            module["admit"](FakeApi(), "d" * 40, "99", candidates)
        assert len(writes) == (1 if failure == "denied" else 0)
    else:
        result = module["admit"](FakeApi(), "d" * 40, "99", candidates)
        assert result["public_invoker_verified"] is True
        assert len(writes) == 2
        assert all("existing@example.invalid" in json.dumps(policy) for policy in policies.values())
        module["admit"](FakeApi(), "d" * 40, "99", candidates)
        assert len(writes) == 2, "Verified admission is idempotent"


@pytest.mark.parametrize("status", ["200", "302", "403"])
def test_public_preview_health_requires_anonymous_exact_200(monkeypatch, status):
    module = _preview_module("commerce-preview-public-admission.py")
    calls = []

    def curl(args, **kwargs):
        calls.append(args)
        assert "--location" not in args and "-L" not in args
        assert not any("Authorization" in arg for arg in args)
        return subprocess.CompletedProcess(args, 0, status, "")

    monkeypatch.setattr(module["subprocess"], "run", curl)
    monkeypatch.setattr(module["time"], "sleep", lambda _: None)
    if status == "200":
        assert (
            module["public_health"]("https://fixed-preview.run.app", "/health")["authentication"]
            == "anonymous"
        )
        assert len(calls) == 1
    else:
        with pytest.raises(module["BootstrapError"], match="preview_public_http_health_unverified"):
            module["public_health"]("https://fixed-preview.run.app", "/health")
        assert len(calls) == 5
