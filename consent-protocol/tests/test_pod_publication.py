"""A catalog update cannot replace application authority or follow concurrent work."""

import hashlib
import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(monkeypatch, name, filename):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/deploy"))
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/deploy" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def modules(monkeypatch):
    return (
        load(monkeypatch, "publication_writer", "publish-pod-catalog.py"),
        load(monkeypatch, "publication_build", "prepare-pod-publication.py"),
    )


@pytest.fixture
def service():
    name = "projects/hushh-pda-dev/locations/us-central1/services/consent-protocol"
    return {
        "name": name,
        "uid": "native-service-incarnation",
        "etag": "original",
        "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
        "reconciling": False,
        "latestReadyRevision": name + "/revisions/consent-protocol-old",
        "latestCreatedRevision": name + "/revisions/consent-protocol-old",
        "traffic": [
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": "consent-protocol-old",
                "percent": 100,
            }
        ],
        "trafficStatuses": [{"revision": "consent-protocol-old", "percent": 100}],
        "uri": "https://consent-protocol-example.run.app",
        "scaling": {"maxInstanceCount": 3},
        "ingress": "INGRESS_TRAFFIC_ALL",
        "template": {
            "revision": "consent-protocol-old",
            "timeout": "3600s",
            "serviceAccount": "consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com",
            "scaling": {"maxInstanceCount": 3},
            "maxInstanceRequestConcurrency": 80,
            "volumes": [
                {"name": "sql", "cloudSqlInstance": {"instances": ["dev:region:database"]}}
            ],
            "containers": [
                {
                    "image": "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "a" * 64,
                    "resources": {"limits": {"cpu": "1", "memory": "2Gi"}},
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": "dev"},
                        {"name": "HUSHH_DEPLOY_SHA", "value": "b" * 40},
                        {"name": "HUSHH_DEPLOY_RUN_ID", "value": "12"},
                        {"name": "DB_POOL_MAX_SIZE", "value": "4"},
                        {
                            "name": "APP_SIGNING_KEY",
                            "valueSource": {
                                "secretKeyRef": {"secret": "APP_SIGNING_KEY", "version": "latest"}
                            },
                        },
                    ],
                }
            ],
        },
    }


@pytest.fixture
def release():
    value = json.loads((Path(__file__).parent / "fixtures/pod_release.v1.json").read_text())
    value["image"] = "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "c" * 64
    value["descriptor"]["supportedUpgradeDigests"] = []
    return value


class Response:
    def __init__(self, value):
        self.value = deepcopy(value)
        self.status_code = 200

    def json(self):
        return deepcopy(self.value)


class Native:
    def __init__(self, service):
        self.service = deepcopy(service)
        self.writes = []
        self.lose_create_response = False
        self.omit_revision_hint = False

    def request(self, method, url, **options):
        if method == "GET" and url.startswith(
            "https://run.googleapis.com/v2/" + self.service["name"] + "/revisions/"
        ):
            return Response(
                {**self.service["template"], "name": self.service["latestReadyRevision"]}
            )
        assert url == "https://run.googleapis.com/v2/" + self.service["name"]
        assert options["allow_redirects"] is False
        if method == "GET":
            response = Response(self.service)
            if self.omit_revision_hint:
                response.value["template"].pop("revision", None)
            return response
        assert method == "PATCH"
        body = options["json"]
        assert body["etag"] == self.service["etag"], "Native CAS must reject stale authority"
        self.writes.append(deepcopy(body))
        self.service.update(deepcopy(body))
        self.service["etag"] = "mutation-" + str(len(self.writes))
        if "template" in body:
            revision = body["template"]["revision"]
            self.service["latestReadyRevision"] = self.service["name"] + "/revisions/" + revision
            self.service["latestCreatedRevision"] = self.service["latestReadyRevision"]
        self.service["trafficStatuses"] = [
            {**t, "uri": "https://" + t.get("tag", "old") + "---consent-protocol-example.run.app"}
            for t in self.service["traffic"]
        ]
        if len(self.writes) == 1 and self.lose_create_response:
            raise TimeoutError("Uncertain provider outcome")
        return Response(
            {
                "name": "projects/hushh-pda-dev/locations/us-central1/operations/example",
                "done": True,
            }
        )


@pytest.mark.parametrize("omit_hint", [False, True])
def test_catalog_activation_preserves_application_and_duplicate_is_read_only(
    modules, monkeypatch, service, release, omit_hint
):
    writer, _ = modules
    native = Native(service)
    native.omit_revision_hint = omit_hint
    records = []
    monkeypatch.setattr(writer, "health", lambda url: None)
    pin = {"baseline": writer.baseline(service)}
    writer.activate(
        native,
        pin,
        release,
        sha="d" * 40,
        run="77",
        save=lambda phase, **fields: records.append(phase),
    )
    assert len(native.writes) == 2
    first, promotion = native.writes
    assert first["etag"] == "original" and promotion["etag"] == "mutation-1"
    assert (
        first["template"]["containers"][0]["image"] == service["template"]["containers"][0]["image"]
    )
    old_env = {e["name"]: e for e in service["template"]["containers"][0]["env"]}
    new_env = {e["name"]: e for e in first["template"]["containers"][0]["env"]}
    assert all(new_env[k] == v for k, v in old_env.items())
    for key in ("timeout", "serviceAccount", "scaling", "volumes", "maxInstanceRequestConcurrency"):
        assert first["template"][key] == service["template"][key]
    assert (
        sum(
            t.get("percent", 0) for t in first["traffic"] if t["revision"] == "consent-protocol-old"
        )
        == 100
    )
    assert records[-1] == "activated"
    writer.activate(
        native,
        pin,
        release,
        sha="d" * 40,
        run="78",
        save=lambda phase, **fields: records.append(phase),
    )
    assert len(native.writes) == 2 and records[-1] == "already_activated"


@pytest.mark.parametrize(
    "mutation", ["uid", "source", "pool", "traffic", "identity", "environment", "tag", "ssh"]
)
def test_changed_coordinated_baseline_refuses_before_any_write(
    modules, monkeypatch, service, release, mutation
):
    writer, _ = modules
    pin = {"baseline": writer.baseline(service)}
    changed = deepcopy(service)
    if mutation == "uid":
        changed["uid"] = "replacement-service"
    elif mutation == "source":
        changed["template"]["containers"][0]["env"][1]["value"] = "e" * 40
    elif mutation == "pool":
        changed["template"]["containers"][0]["env"][3]["value"] = "40"
    elif mutation == "traffic":
        changed["trafficStatuses"][0]["percent"] = 50
    elif mutation == "identity":
        changed["template"]["serviceAccount"] = "other@example.invalid"
    elif mutation == "tag":
        changed["traffic"].append(
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": "consent-protocol-old",
                "tag": "peer",
                "percent": 0,
            }
        )
    elif mutation == "ssh":
        changed["sshEnabled"] = True
    else:
        changed["template"]["containers"][0]["env"][0]["value"] = "production"
    native = Native(changed)
    with pytest.raises(ValueError):
        writer.activate(native, pin, release, sha="d" * 40, run="77", save=lambda *a, **k: None)
    assert native.writes == []


def test_mutation_during_candidate_health_cannot_promote_or_rollback_peer(
    modules, monkeypatch, service, release
):
    writer, _ = modules
    native = Native(service)

    def concurrent_release(_url):
        native.service["etag"] = "peer-owned"
        native.service["scaling"]["maxInstanceCount"] = 5

    monkeypatch.setattr(writer, "health", concurrent_release)
    with pytest.raises(ValueError, match="Concurrent"):
        writer.activate(
            native,
            {"baseline": writer.baseline(service)},
            release,
            sha="d" * 40,
            run="77",
            save=lambda *a, **k: None,
        )
    assert len(native.writes) == 1 and native.service["etag"] == "peer-owned"


def test_lost_create_response_never_replays_creation(modules, service, release):
    writer, _ = modules
    native = Native(service)
    native.lose_create_response = True
    pin = {"baseline": writer.baseline(service)}
    for exception in (TimeoutError, ValueError):
        with pytest.raises(exception):
            writer.activate(native, pin, release, sha="d" * 40, run="77", save=lambda *a, **k: None)
    assert len(native.writes) == 1


def test_failed_promoted_health_restores_only_owned_traffic(modules, monkeypatch, service, release):
    writer, _ = modules
    native = Native(service)
    calls = []

    def health(_url):
        calls.append(1)
        if len(calls) == 2:
            raise ValueError("Unhealthy promoted application")

    monkeypatch.setattr(writer, "health", health)
    with pytest.raises(ValueError, match="Unhealthy"):
        writer.activate(
            native,
            {"baseline": writer.baseline(service)},
            release,
            sha="d" * 40,
            run="77",
            save=lambda *a, **k: None,
        )
    assert len(native.writes) == 3 and native.writes[-1]["etag"] == "mutation-2"
    assert native.service["traffic"] == service["traffic"]


def test_evidence_is_exact_source_pinned_and_pairing_cannot_follow_new_app(
    modules, service, release, monkeypatch
):
    writer, _ = modules
    evidence = load(monkeypatch, "evidence_contract", "pod_publication_evidence.py")
    base = writer.baseline(service)
    pin = {
        "schemaVersion": 1,
        "release": {},
        "descriptorSourceRevision": "d" * 40,
        "baseline": base,
        "preparationBuildId": "a" * 8 + "-" + "b" * 27,
        "preparationManifestSha256": "a" * 64,
        "evidence": [],
    }
    values = {}
    for index, kind in enumerate(evidence.CHECKS):
        execution = (
            "projects/hushh-pda-dev/locations/us-central1/jobs/qualification/executions/qualification-"
            + str(index)
        )
        value = {
            "schemaVersion": 1,
            "kind": kind,
            "image": release["image"],
            "sourceRevision": release["sourceRevision"],
            "nativeExecutions": [execution],
            "probeSha256": "e" * 64,
            "checks": dict.fromkeys(evidence.CHECKS[kind], True),
        }
        if kind == "compatibility":
            value["baseline"] = base
        if kind == "recovery":
            value["predecessorImage"] = release["image"]
        raw = json.dumps(value).encode()
        object_name = f"pod-releases/{release['sourceRevision']}/{release['publisher']['runId']}/qualification-{kind}.json"
        values[object_name] = raw
        pin["evidence"].append(
            {
                "kind": kind,
                "object": object_name,
                "generation": "123",
                "sha256": hashlib.sha256(raw).hexdigest(),
                "nativeExecutions": [execution],
                "probeSha256": "e" * 64,
            }
        )
    evidence.validate_pin(pin)
    monkeypatch.setattr(evidence, "read_object", lambda session, name, **kwargs: values[name])
    assert len(evidence.verify_evidence(None, pin, release)) == 3
    changed = deepcopy(pin)
    changed["baseline"]["applicationSource"] = "f" * 40
    with pytest.raises(ValueError, match="stale"):
        evidence.verify_evidence(None, changed, release)
    changed = deepcopy(pin)
    changed["evidence"][0]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="bytes changed"):
        evidence.verify_evidence(None, changed, release)
    changed = deepcopy(release)
    changed["descriptor"]["supportedUpgradeDigests"] = ["sha256:" + "1" * 64]
    with pytest.raises(ValueError, match="predecessor"):
        evidence.verify_evidence(None, pin, changed)


def test_requested_promotion_without_observed_traffic_never_reports_activation(
    modules, monkeypatch, service, release
):
    writer, _ = modules
    native = Native(service)
    original_request = native.request

    def request(method, url, **kwargs):
        response = original_request(method, url, **kwargs)
        if method == "GET" and len(native.writes) == 2:
            response.value["trafficStatuses"] = service["trafficStatuses"]
        return response

    monkeypatch.setattr(native, "request", request)
    monkeypatch.setattr(writer, "health", lambda url: None)
    phases = []
    with pytest.raises(ValueError, match="Observed traffic"):
        writer.activate(
            native,
            {"baseline": writer.baseline(service)},
            release,
            sha="d" * 40,
            run="77",
            save=lambda phase, **fields: phases.append(phase),
        )
    assert "activated" not in phases


def test_browser_catalog_cannot_silently_change_application_enablement(modules, service, release):
    writer, _ = modules
    release["browserQualifications"] = [{"reviewed": "fixture"}]
    with pytest.raises(ValueError, match="Browser enablement"):
        writer.candidate_patch(service, release, sha="d" * 40, run="77")


def test_native_build_upload_generation_and_resolved_image_are_bound(monkeypatch, release):
    evidence = load(monkeypatch, "artifact_evidence", "pod_publication_evidence.py")
    spec = importlib.util.spec_from_file_location(
        "native_image_resolver", ROOT / "scripts/ci/resolve-cloud-run-image.py"
    )
    resolver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(resolver)
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": "sha256:" + "a" * 64,
                "size": 10,
            },
            "layers": [],
        }
    ).encode()
    release["image"] = (
        "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + hashlib.sha256(manifest).hexdigest()
    )
    archive = json.dumps(release).encode()
    provenance = {
        "status": "pinned",
        "image_reference": release["image"],
        "sha": release["sourceRevision"],
    }
    prefix = f"pod-preparations/{release['sourceRevision']}/{release['publisher']['runId']}/"
    files = {
        "pod-release.json": archive,
        "pod-image-manifest.json": manifest,
        "pod-image-provenance.json": json.dumps(provenance).encode(),
    }
    rows = [
        {"location": "gs://hushh-pda-dev_cloudbuild/" + prefix + name + "#123"} for name in files
    ]
    uploaded_manifest = b"\n".join(json.dumps(row).encode() for row in rows)
    pin = {
        "descriptorSourceRevision": release["sourceRevision"],
        "preparationBuildId": "a" * 36,
        "preparationManifestSha256": hashlib.sha256(uploaded_manifest).hexdigest(),
    }
    manifest_name = prefix + "artifacts-" + pin["preparationBuildId"] + ".json"
    build = {"results": {"artifactManifest": "gs://hushh-pda-dev_cloudbuild/" + manifest_name}}

    def read(session, name, **kwargs):
        if name == manifest_name:
            return uploaded_manifest
        assert kwargs["generation"] == "123"
        return files[name.removeprefix(prefix)]

    monkeypatch.setattr(evidence, "read_object", read)
    evidence.verify_build_artifacts(None, build, pin, release, archive, resolver)
    files["pod-image-provenance.json"] = json.dumps(
        {**provenance, "image_reference": "wrong-image"}
    ).encode()
    with pytest.raises(ValueError, match="another image"):
        evidence.verify_build_artifacts(None, build, pin, release, archive, resolver)
    files["pod-image-provenance.json"] = json.dumps(provenance).encode()
    files["pod-image-manifest.json"] = b"{}"
    with pytest.raises(ValueError, match="Manifest bytes"):
        evidence.verify_build_artifacts(None, build, pin, release, archive, resolver)
