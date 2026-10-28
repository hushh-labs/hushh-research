"""Private candidate provenance, routing preservation and probe drift boundaries."""

import base64
import copy
import importlib
import json
import time
import urllib.response
from io import BytesIO
from pathlib import Path

import pytest

from tests.helpers.plg_qualification import _runtime

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def candidate(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    module = importlib.import_module("qualification_candidate")
    monkeypatch.setattr(
        module.acceptance,
        "reviewed_definitions",
        lambda *_: {
            module.MODULE: "a" * 64,
            "deploy/plg/qualification_candidate_contract.py": "b" * 64,
        },
    )
    return module


class Cloud:
    def __init__(self, target, document, *, existing=False):
        self.target, self.document = target, document
        self.service, self.revisions, self.mutations, self.policy = None, {}, [], {"bindings": []}
        self.fail_replace = False
        if existing:
            previous = copy.deepcopy(document)
            previous["spec"]["template"]["metadata"]["name"] = "consent-protocol-plg-qual-old"
            self.install(previous)
            self.service["status"]["traffic"] = [
                {
                    "revisionName": "consent-protocol-plg-qual-old",
                    "percent": 70,
                    "latestRevision": True,
                },
                {
                    "revisionName": "consent-protocol-plg-qual-older",
                    "percent": 30,
                    "tag": "kept",
                    "url": self.url("kept"),
                },
            ]

    def url(self, tag=None):
        return (
            "https://"
            + ((tag + "---") if tag else "")
            + "consent-protocol-plg-qual-abc-uc.a.run.app"
        )

    def install(self, document):
        self.service = copy.deepcopy(document)
        self.service["metadata"]["resourceVersion"] = "opaque-resource-version"
        name = document["spec"]["template"]["metadata"]["name"]
        self.service["status"] = {
            "url": self.url(),
            "traffic": copy.deepcopy(
                document["spec"].get(
                    "traffic", [{"revisionName": name, "percent": 100, "latestRevision": True}]
                )
            ),
        }
        template = copy.deepcopy(document["spec"]["template"])
        template["metadata"]["labels"]["serving.knative.dev/service"] = "consent-protocol-plg-qual"
        template["status"] = {
            "imageDigest": document["spec"]["template"]["spec"]["containers"][0]["image"],
            "conditions": [{"type": "Ready", "status": "True"}],
        }
        self.revisions[name] = template

    def command(self, *args, **_kwargs):
        if args[:3] == ("run", "services", "list"):
            return json.dumps([] if self.service is None else [self.service]).encode()
        self.mutations.append(args)
        if args[:3] == ("run", "services", "replace"):
            document = json.loads(Path(args[3]).read_bytes())
            assert not any(row.get("latestRevision") for row in document["spec"].get("traffic", []))
            self.install(document)
            if self.fail_replace:
                raise RuntimeError("uncertain replacement")
        else:
            assert args[:3] == ("run", "services", "update-traffic")
            tag, name = (
                next(arg for arg in args if arg.startswith("--update-tags="))
                .split("=", 1)[1]
                .split("=", 1)
            )
            self.service["status"]["traffic"].append(
                {"tag": tag, "revisionName": name, "percent": 0, "url": self.url(tag)}
            )
        return b"{}"

    def read(self, *args):
        if args[2] == "get-iam-policy":
            return copy.deepcopy(self.policy)
        if args[1] == "services":
            return copy.deepcopy(self.service)
        return copy.deepcopy(self.revisions[args[3]])


class Http:
    def __init__(self, *, public=False):
        self.calls, self.public, self.after_second = [], public, None

    def get(self, url, token=None):
        self.calls.append((url, token))
        if token is None:
            return (200 if self.public else 403), b""
        if sum(value is not None for _, value in self.calls) == 2 and self.after_second:
            self.after_second()
        return 200, b'{"status":"healthy"}'


def context(module, *, existing=False):
    target, attempt = module.Target("dev"), module.image.Attempt("a" * 40, "123", "2")
    versions = {name: "1" for name in module.RUNTIME_SECRETS}
    versions["BACKEND_RUNTIME_CONFIG_JSON"] = "2"
    image = "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "b" * 64
    document = target.service_document(image, versions, attempt.run_id)
    return target, attempt, image, versions, Cloud(target, document, existing=existing), Http()


def token(audience):
    payload = json.dumps(
        {"aud": audience, "exp": int(time.time()) + 600, "iss": "https://accounts.google.com"}
    ).encode()
    return "header." + base64.urlsafe_b64encode(payload).decode().rstrip("=") + ".signature"


@pytest.mark.parametrize("existing", [False, True])
def test_deploy_preserves_actual_routing_and_emits_genuine_private_provenance(candidate, existing):
    target, attempt, image, versions, cloud, http = context(candidate, existing=existing)
    checkpoints = []
    descriptor = candidate.deploy_candidate(
        target, attempt, image, versions, cloud=cloud, http=http, checkpoint=checkpoints.append
    )
    assert len(cloud.mutations) == 2 and len(checkpoints) == 2
    assert (
        cloud.mutations[1][4] == "--update-tags=" + descriptor["tag"] + "=" + descriptor["revision"]
    )
    assert descriptor["serviceUrl"] != descriptor["candidateUrl"]
    assert descriptor["freshService"] is (not existing)
    if existing:
        assert descriptor["actualTraffic"]["weights"] == descriptor["baselineTraffic"]["weights"]
        assert descriptor["actualTraffic"]["tags"]["kept"] == "consent-protocol-plg-qual-older"
    else:
        assert descriptor["actualTraffic"]["weights"] == {descriptor["revision"]: 100}
    result = candidate.verify_and_probe(
        descriptor, token(descriptor["serviceUrl"]), cloud=cloud, http=http
    )
    assert result["candidate"]["provenance"]["ok"] is True
    assert result["candidate"]["actualTraffic"] == descriptor["actualTraffic"]
    iam_proof = _runtime(candidate.acceptance_contract, target)["iam"]
    iam_proof["runtimeSecretVersions"] = {
        candidate.PREFIX + name: version for name, version in versions.items()
    }
    observed_versions = candidate.acceptance_contract.iam(iam_proof, target)
    candidate.acceptance_contract.candidate(
        result["candidate"],
        result["health"],
        target,
        {"id": int(attempt.run_id)},
        image,
        observed_versions,
    )
    assert result["candidate"]["runtimeSecretVersions"] == observed_versions
    with pytest.raises(ValueError, match="runtime_unverified"):
        candidate.acceptance_contract.candidate(
            result["candidate"] | {"runtimeSecretVersions": versions},
            result["health"],
            target,
            {"id": int(attempt.run_id)},
            image,
            observed_versions,
        )
    assert result["health"]["passes"] == [{"httpStatus": 200, "bodyStatus": "healthy"}] * 2
    assert result["health"]["audience"] == descriptor["serviceUrl"]
    assert all(url == descriptor["candidateUrl"] + "/health" for url, value in http.calls if value)


@pytest.mark.parametrize("drift", ["ownership", "public-iam", "public-probe", "unresolved-traffic"])
def test_existing_service_must_qualify_before_any_write(candidate, drift):
    target, attempt, image, versions, cloud, http = context(candidate, existing=True)
    if drift == "ownership":
        cloud.service["metadata"]["labels"]["purpose"] = "shared"
    elif drift == "public-iam":
        cloud.policy = {
            "bindings": [
                {
                    "role": "roles/run.invoker",
                    "members": ["allUsers"],
                    "condition": {"expression": "true"},
                }
            ]
        }
    elif drift == "public-probe":
        http.public = True
    else:
        cloud.service["status"]["traffic"][0].pop("revisionName")
    with pytest.raises(ValueError):
        candidate.deploy_candidate(target, attempt, image, versions, cloud=cloud, http=http)
    assert cloud.mutations == []


def test_uncertain_replace_retains_intent_without_second_mutation(candidate):
    target, attempt, image, versions, cloud, http = context(candidate)
    cloud.fail_replace, checkpoints = True, []
    with pytest.raises(RuntimeError, match="uncertain replacement"):
        candidate.deploy_candidate(
            target, attempt, image, versions, cloud=cloud, http=http, checkpoint=checkpoints.append
        )
    assert len(cloud.mutations) == 1 and checkpoints[-1]["status"] == "deploy-needs-reconciliation"


def test_wrong_token_audience_and_tag_binding_refuse_before_credential_forwarding(candidate):
    target, attempt, image, versions, cloud, http = context(candidate)
    descriptor = candidate.deploy_candidate(
        target, attempt, image, versions, cloud=cloud, http=http
    )
    with pytest.raises(ValueError, match="token_audience_or_expiry"):
        candidate.verify_and_probe(
            descriptor, token(descriptor["candidateUrl"]), cloud=cloud, http=http
        )
    assert http.calls == []
    cloud.service["status"]["traffic"][-1]["revisionName"] = "consent-protocol-plg-qual-other"
    with pytest.raises(ValueError, match="traffic_changed"):
        candidate.verify_and_probe(
            descriptor, token(descriptor["serviceUrl"]), cloud=cloud, http=http
        )
    assert http.calls == []


def test_post_probe_live_recheck_detects_worker_drift_with_broken_control(candidate, monkeypatch):
    target, attempt, image, versions, cloud, http = context(candidate)
    descriptor = candidate.deploy_candidate(
        target, attempt, image, versions, cloud=cloud, http=http
    )
    snapshot = candidate.observe(cloud, target, descriptor)

    def drift():
        cloud.revisions[descriptor["revision"]]["spec"]["containers"][0]["args"][2] = "2"

    http.after_second = drift
    with pytest.raises(ValueError, match="runtime_configuration_changed"):
        candidate.verify_and_probe(
            descriptor, token(descriptor["serviceUrl"]), cloud=cloud, http=http
        )
    # Broken control: replacing actual rereads with a frozen earlier observation
    # admits the same live drift, demonstrating this test's trust boundary.
    http.calls.clear()
    monkeypatch.setattr(candidate, "observe", lambda *_: copy.deepcopy(snapshot))
    assert (
        candidate.verify_and_probe(
            descriptor, token(descriptor["serviceUrl"]), cloud=cloud, http=http
        )["health"]["provenanceRechecked"]
        is True
    )


def test_http_uses_only_serverless_header_and_refuses_other_origins(candidate, monkeypatch):
    requests = []

    class Response:
        code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, count):
            assert count == 65537
            return b'{"status":"healthy"}'

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            assert timeout == 30
            return Response()

    monkeypatch.setattr(candidate.urllib.request, "build_opener", lambda handler: Opener())
    candidate.Http().get(
        "https://consent-protocol-plg-qual-abc-uc.a.run.app/health", "synthetic-token"
    )
    assert dict(requests[0].header_items()) == {
        "X-serverless-authorization": "Bearer synthetic-token"
    }
    with pytest.raises(ValueError):
        candidate.Http().get("file:///health", "synthetic-token")
    assert len(requests) == 1


def test_import_has_no_cloud_or_git_effects(candidate, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("external read during import")

    monkeypatch.setattr(candidate.image.Cloud, "command", forbidden)
    monkeypatch.setattr(candidate.acceptance, "reviewed_definitions", forbidden)
    assert importlib.reload(candidate).SOURCE == "5de6ee29abe3b00642bd6b745c608279091810b3"


def test_real_redirect_processing_never_forwards_candidate_token(candidate, monkeypatch):
    requests = []
    build_opener = candidate.urllib.request.build_opener

    class Https(candidate.urllib.request.HTTPSHandler):
        def https_open(self, request):
            requests.append(request)
            response = urllib.response.addinfourl(
                BytesIO(b'{"status":"healthy"}'),
                {"location": "https://unrelated.example/credential-target"},
                request.full_url,
                302 if len(requests) == 1 else 200,
            )
            response.msg = "Synthetic redirect"
            return response

    monkeypatch.setattr(
        candidate.urllib.request, "build_opener", lambda *handlers: build_opener(*handlers, Https())
    )
    status, _body = candidate.Http().get(
        "https://consent-protocol-plg-qual-abc-uc.a.run.app/health", "synthetic-token"
    )
    assert status == 302 and len(requests) == 1
    # Broken control demonstrates that the same inert transport follows the
    # redirect and copies the custom credential header without our handler.
    requests.clear()
    monkeypatch.setattr(candidate.image, "NoRedirect", candidate.urllib.request.HTTPRedirectHandler)
    status, _body = candidate.Http().get(
        "https://consent-protocol-plg-qual-abc-uc.a.run.app/health", "synthetic-token"
    )
    assert status == 200 and len(requests) == 2
    assert requests[1].get_header("X-serverless-authorization") == "Bearer synthetic-token"
