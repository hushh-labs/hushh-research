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
    revision = {**template, "name": name + "/revisions/fixed"}
    service = {
        "name": name,
        "etag": "fixture-etag",
        "template": template,
        "uri": "https://fixed-preview.run.app",
        "reconciling": False,
        "trafficStatuses": [{"revision": revision["name"], "percent": 100}],
    }
    return service, revision, image


@pytest.mark.parametrize(
    "mutation", ["identity", "image", "secret", "public", "disabled", "traffic", "sha"]
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
    else:
        revision["labels"]["deploy-sha"] = "unverified"

    class FakeApi:
        def request(self, path):
            return policy if path.endswith(":getIamPolicy") else revision

    with pytest.raises(module["BootstrapError"]):
        module["inspect"](FakeApi(), service["name"], service)


@pytest.mark.parametrize("existing", [False, True])
def test_fixed_preview_bootstrap_creates_only_missing_lanes_and_preserves_applications(
    tmp_path, existing
):
    module = _preview_module("commerce-preview-bootstrap.py")
    writes = []
    services, revisions = {}, {}
    for identifier in (module["BACKEND"], module["FRONTEND"]):
        service, revision, image = _bootstrap_fixture(module, identifier, bootstrap=not existing)
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
