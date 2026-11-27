"""Offline receipt consistency cannot become a live deployment verdict."""

import hashlib
import json

import pytest

from tests.pod_qualification_support import pin_case, qualification_case
from tests.test_pod_publication import release as release
from tests.test_pod_publication import service as service


@pytest.fixture
def case(monkeypatch, tmp_path, release, service):
    return qualification_case(monkeypatch, tmp_path, release, service)


def test_missing_failed_or_unpurged_receipts_are_not_live_acceptance(case):
    result = case.inspector.inspect(case.args)
    assert result["status"] == "INCOMPLETE"
    assert result["adapterAcceptance"] == "unchecked" and not result["physicalPurgeVerified"]
    case.platform["receipts"][0]["completedPrivateTurnWarmup"] = False
    case.platform_path.write_text(json.dumps(case.platform))
    with pytest.raises(ValueError, match="platform evidence"):
        case.inspector.inspect(case.args)
    case.platform["receipts"][0]["completedPrivateTurnWarmup"] = True
    case.platform["nativeExecution"]["succeededCount"] = 0
    case.platform_path.write_text(json.dumps(case.platform))
    with pytest.raises(ValueError, match="platform evidence"):
        case.inspector.inspect(case.args)
    case.platform["nativeExecution"]["succeededCount"] = 1
    case.platform_path.write_text(json.dumps(case.platform))
    case.recovery.update(cleanup="FAILED_FIXTURE_STILL_PRESENT", physicalPurgeVerified=True)
    case.recovery_path.write_text(json.dumps(case.recovery))
    with pytest.raises(ValueError, match="recovery evidence"):
        case.inspector.inspect(case.args)


def test_reviewed_pairing_rejects_changed_baseline(case):
    pin_case(case)
    case.pin["baseline"] = {**case.baseline, "applicationSource": "f" * 40}
    case.pin_path.write_text(json.dumps(case.pin))
    with pytest.raises(ValueError, match="baseline differs"):
        case.inspector.inspect(case.args)
    case.pin["baseline"] = case.baseline
    ref = next(item for item in case.pin["evidence"] if item["kind"] == "compatibility")
    path = case.root / ref["object"]
    value = json.loads(path.read_text())
    value["baseline"] = {**case.baseline, "applicationSource": "f" * 40}
    raw = json.dumps(value).encode()
    path.write_bytes(raw)
    ref["sha256"] = hashlib.sha256(raw).hexdigest()
    case.pin_path.write_text(json.dumps(case.pin))
    with pytest.raises(ValueError, match="stale"):
        case.inspector.inspect(case.args)


@pytest.mark.parametrize(
    "kind,field,wrong",
    [
        ("platform", "probeSha256", "f" * 64),
        (
            "recovery",
            "nativeExecutions",
            [
                "projects/hushh-pda-dev/locations/us-central1/jobs/qualification/executions/qualification-1"
            ],
        ),
    ],
)
def test_pinned_envelope_must_join_retained_executions(case, kind, field, wrong):
    pin_case(case)
    ref = next(item for item in case.pin["evidence"] if item["kind"] == kind)
    path = case.root / ref["object"]
    value = json.loads(path.read_text())
    value[field] = ref[field] = wrong
    raw = json.dumps(value).encode()
    path.write_bytes(raw)
    ref["sha256"] = hashlib.sha256(raw).hexdigest()
    case.pin_path.write_text(json.dumps(case.pin))
    with pytest.raises(ValueError, match=f"{kind} envelope differs"):
        case.inspector.inspect(case.args)


def test_metadata_republication_retains_original_image_proof(case, monkeypatch):
    case.recovery["physicalPurgeVerified"] = True
    pin_case(case)
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *_a, **_k: pytest.fail("offline check used network")
    )
    result = case.inspector.inspect(case.args)
    assert result["status"] == "LOCAL_EVIDENCE_CONSISTENT"
    assert result["nativeFreshness"] == result["archiveGeneration"] == "unchecked"
    assert not result["physicalPurgeVerified"]
    original_preparation = case.root / "image-preparation.json"
    original_release = case.root / "image-release.json"
    original_preparation.write_bytes(case.prep_path.read_bytes())
    original_release.write_bytes(case.release_path.read_bytes())
    case.args.image_preparation_json, case.args.image_release_json = (
        original_preparation,
        original_release,
    )
    published = json.loads(case.release_path.read_bytes())
    published["publisher"]["runId"] = str(int(published["publisher"]["runId"]) + 1)
    raw = json.dumps(published).encode()
    case.release_path.write_bytes(raw)
    case.preparation["release"].update(
        runId=published["publisher"]["runId"], archiveSha256=hashlib.sha256(raw).hexdigest()
    )
    case.preparation["descriptorSourceRevision"] = "d" * 40
    case.prep_path.write_text(json.dumps(case.preparation))
    case.pin.update(release=case.preparation["release"], descriptorSourceRevision="d" * 40)
    case.pin_path.write_text(json.dumps(case.pin))
    reuse = case.inspector._reuse_contract()
    unchanged = []
    monkeypatch.setattr(
        reuse, "require_unchanged_image_context", lambda *args: unchanged.append(args)
    )
    monkeypatch.setattr(case.inspector, "_reuse_contract", lambda: reuse)
    assert case.inspector.inspect(case.args)["status"] == "LOCAL_EVIDENCE_CONSISTENT"
    assert len(unchanged) == 1
    original_release.write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum"):
        case.inspector.inspect(case.args)


def test_changed_pinned_envelope_bytes_are_refused(case):
    pin_case(case)
    ref = next(item for item in case.pin["evidence"] if item["kind"] == "compatibility")
    (case.root / ref["object"]).write_text("changed")
    with pytest.raises(ValueError, match="bytes changed"):
        case.inspector.inspect(case.args)


@pytest.mark.parametrize(
    "object_url",
    [
        "https://example.test/evidence.json",
        "https://storage.googleapis.com/storage/v1/b/hushh-pda-dev_cloudbuild/o/..%2Fescape.json",
    ],
)
def test_offline_transport_refuses_other_hosts_and_path_escape(case, object_url):
    session = case.inspector._local_session(case.root)
    with pytest.raises(ValueError):
        with session.get(
            object_url,
            params={"alt": "media", "generation": "1"},
            timeout=30,
            stream=True,
            allow_redirects=False,
        ):
            pytest.fail("invalid offline evidence path was accepted")


def test_offline_transport_refuses_oversized_archive(case):
    (case.root / "oversized.json").write_bytes(b"x" * 65537)
    session = case.inspector._local_session(case.root)
    url = "https://storage.googleapis.com/storage/v1/b/hushh-pda-dev_cloudbuild/o/oversized.json"
    with pytest.raises(ValueError, match="size bound"):
        with session.get(
            url,
            params={"alt": "media", "generation": "1"},
            timeout=30,
            stream=True,
            allow_redirects=False,
        ):
            pytest.fail("oversized offline evidence was accepted")
