"""Frontend source admission cannot broaden scope or authorize live traffic."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "deploy/plg/frontend_source.py"
BACKEND_TESTS = ROOT / "consent-protocol/tests/test_plg_release_source.py"
ADDED = "hushh-webapp/app/api/plg-email/unsubscribe/[token]/route.ts"


@pytest.mark.parametrize(
    "old_sha",
    ["cfe8c062bd1c455249fc4626720d426edaf9668a", "73c207c423a3197c56ca9f5c3daf86911b0a1ad5"],
)
def test_old_candidates_cannot_reuse_current_source_admission(old_sha):
    module = _load("plg_frontend_fixed_source", SOURCE)
    record = dict(module.FIXED_RECORD, changes=[])
    module._check_record(module.SOURCE_SHA, record)
    with pytest.raises(module.Refused, match="not the recorded"):
        module._check_record(old_sha, record)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _entry(git, commit, path):
    try:
        git("cat-file", "-e", f"{commit}:{path}")
    except subprocess.CalledProcessError:
        return None
    blob = git("rev-parse", "--verify", f"{commit}:{path}")
    content = git("show", f"{commit}:{path}")
    # Fixture content is UTF-8 without a trailing newline. The existing Git
    # helper strips output, so the hash exactly represents those bytes.
    return {"blob": blob, "sha256": hashlib.sha256(content.encode()).hexdigest()}


@pytest.fixture(scope="module")
def git_source(tmp_path_factory):
    """Create only a disposable Git repository under pytest's temporary path."""
    parent = tmp_path_factory.mktemp("plg-frontend-admission")
    repository = parent / "synthetic-source"
    repository.mkdir()

    tools = _load("plg_existing_test_tools", BACKEND_TESTS)
    git, put, commit = tools._source_tools(repository)
    git("init", "--quiet")
    module = _load("plg_frontend_fixture", SOURCE)
    backend = module.backend
    policy = '{"version":1}'
    before = 'MEMORY_SQL = "SELECT 1"'
    after = 'MEMORY_SQL = "SELECT 1 FROM source CROSS JOIN LATERAL (SELECT 1) event"'
    for path, status in module.ALLOWED_CHANGES.items():
        if status == "M":
            put(path, f"baseline:{path}")
    for path in (
        "deploy/fixed.txt",
        ".github/fixed.txt",
        "hushh-webapp/lib/auth/fixed.ts",
        "hushh-webapp/android/fixed.txt",
        "hushh-webapp/ios/fixed.txt",
        "hushh-webapp/package.json",
        "hushh-webapp/package-lock.json",
        "hushh-webapp/contracts/kai/fixed.json",
        "contracts/kai/fixed.json",
    ):
        put(path, "unchanged")
    put(backend.RUNTIME, before)
    put(backend.POLICY, policy)
    put(backend.MANIFEST, "tests/existing.py")
    production = commit()
    put(backend.RUNTIME, after)
    put(backend.SOURCE_TEST, "def test_regression(): pass")
    put(
        backend.MANIFEST,
        "tests/existing.py\n" + backend.SOURCE_TEST.removeprefix("consent-protocol/"),
    )
    baseline = commit(production)
    for path in module.ALLOWED_CHANGES:
        put(path, f"candidate:{path}")
    candidate = commit(baseline)
    records = [
        {
            "path": path,
            "status": status,
            "before": _entry(git, baseline, path),
            "after": _entry(git, candidate, path),
        }
        for path, status in module.ALLOWED_CHANGES.items()
    ]
    return {
        "repository": repository,
        "parent": parent,
        "git": git,
        "put": put,
        "commit": commit,
        "production": production,
        "baseline": baseline,
        "candidate": candidate,
        "before_tree": git("rev-parse", f"{baseline}^{{tree}}"),
        "after_tree": git("rev-parse", f"{candidate}^{{tree}}"),
        "backend_policy": policy,
        "backend_before": before,
        "backend_after": after,
        "changes": records,
    }


def _configure_backend(module, data, record_path):
    backend, git = module.backend, data["git"]
    policy_sha = hashlib.sha256(data["backend_policy"].encode()).hexdigest()
    backend.ROOT = data["repository"]
    backend.RECORD = record_path
    backend.BASELINE_SHA = data["production"]
    backend.POLICY_SHA256 = policy_sha
    backend.RUNTIME_SHA256 = {
        "before": hashlib.sha256(data["backend_before"].encode()).hexdigest(),
        "after": hashlib.sha256(data["backend_after"].encode()).hexdigest(),
    }
    backend.FIXED_RECORD = {
        **backend.FIXED_RECORD,
        "baselineSha": data["production"],
        "frontendSha": data["production"],
        "authorityPolicySha256": policy_sha,
    }
    changes = []
    for path, status in backend.ALLOWED_CHANGES.items():
        changes.append(
            {
                "path": path,
                "status": status,
                "beforeBlob": None
                if status == "A"
                else git("rev-parse", f"{data['production']}:{path}"),
                "afterBlob": git("rev-parse", f"{data['baseline']}:{path}"),
            }
        )
    record_path.write_text(
        json.dumps({**backend.FIXED_RECORD, "sourceSha": data["baseline"], "changes": changes}),
        encoding="utf-8",
    )


@pytest.fixture
def admission(git_source, tmp_path, monkeypatch):
    module = _load("plg_frontend_source_test", SOURCE)
    _configure_backend(module, git_source, tmp_path / "trusted-backend.json")
    monkeypatch.setattr(module, "BASELINE_SHA", git_source["baseline"])
    monkeypatch.setattr(module, "SOURCE_SHA", git_source["candidate"])
    monkeypatch.setattr(module, "PRODUCTION_BASELINE_SHA", git_source["production"])
    monkeypatch.setattr(module, "BASELINE_TREE", git_source["before_tree"])
    monkeypatch.setattr(module, "SOURCE_TREE", git_source["after_tree"])
    fixed = {
        **module.FIXED_RECORD,
        "sourceSha": git_source["candidate"],
        "baselineSha": git_source["baseline"],
        "productionBaselineSha": git_source["production"],
        "sourceTree": git_source["after_tree"],
        "baselineTree": git_source["before_tree"],
    }
    monkeypatch.setattr(module, "FIXED_RECORD", fixed)
    record = {**fixed, "changes": copy.deepcopy(git_source["changes"])}
    monkeypatch.setattr(module, "RECORD", tmp_path / "trusted-frontend.json")

    def write(value):
        module.RECORD.write_text(json.dumps(value), encoding="utf-8")

    write(record)
    return module, git_source, record, write, monkeypatch


def _candidate_with_change(data, path, content):
    """Commit a tampered object only inside the disposable test repository."""
    target = data["repository"] / path
    original = target.read_bytes() if target.exists() else None
    data["put"](path, content)
    candidate = data["commit"](data["candidate"])
    if original is None:
        target.unlink()
    else:
        target.write_bytes(original)
    data["git"]("add", "--all")
    assert data["git"]("write-tree") == data["after_tree"]
    return candidate


def _rebind_candidate(module, record, write, monkeypatch, data, candidate):
    tree = data["git"]("rev-parse", f"{candidate}^{{tree}}")
    monkeypatch.setattr(module, "SOURCE_SHA", candidate)
    monkeypatch.setattr(module, "SOURCE_TREE", tree)
    fixed = {**module.FIXED_RECORD, "sourceSha": candidate, "sourceTree": tree}
    monkeypatch.setattr(module, "FIXED_RECORD", fixed)
    write({**record, **fixed})


def test_real_git_source_proof_never_authorizes_traffic_or_environments(admission):
    module, data, _, _, _ = admission
    proof = module.qualify_source(data["candidate"])
    assert len(proof["changes"]) == 19
    assert proof["sourceQualified"] is True
    assert proof["trafficAuthorized"] is False
    assert proof["environmentAccepted"] is False
    assert proof["customerSendingAuthorized"] is False
    assert len(proof["backendRecordSha256"]) == 64
    with pytest.raises(module.Refused):
        module.qualify_source("0" * 40)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schemaVersion", True),
        ("replacementAccounts", False),
        ("sourceSha", "0" * 40),
        ("baselineSha", "0" * 40),
        ("productionBaselineSha", "0" * 40),
        ("sourceTree", "0" * 40),
        ("scope", "all"),
        ("services", ["consent-protocol"]),
        ("migrations", "replay"),
        ("allowedPaths", ["consent-protocol/server.py"]),
    ],
)
def test_record_cannot_reseal_or_expand_fixed_authority(admission, field, value):
    module, data, record, write, _ = admission
    altered = copy.deepcopy(record)
    altered[field] = value
    write(altered)
    with pytest.raises(module.Refused):
        module.qualify_source(data["candidate"])


@pytest.mark.parametrize(
    "path",
    [
        "consent-protocol/api/routes/new.py",
        "consent-protocol/hushh_mcp/services/app_intelligence_runtime.py",
        "hushh-webapp/lib/auth/session-owner.ts",
        "hushh-webapp/package-lock.json",
        "hushh-webapp/android/app/src/main/AndroidManifest.xml",
        ".github/workflows/ci.yml",
        "hushh-webapp/lib/services/unreviewed.ts",
    ],
)
def test_real_unlisted_git_changes_fail_even_for_a_rebound_candidate(admission, path):
    module, data, record, write, monkeypatch = admission
    candidate = _candidate_with_change(data, path, "unreviewed")
    _rebind_candidate(module, record, write, monkeypatch, data, candidate)
    with pytest.raises(module.Refused):
        module.qualify_source(candidate)


@pytest.mark.parametrize("field", ["blob", "sha256"])
def test_real_git_blob_and_sha256_pins_cannot_be_resealed(admission, field):
    module, data, record, write, _ = admission
    altered = copy.deepcopy(record)
    altered["changes"][0]["after"][field] = "0" * (40 if field == "blob" else 64)
    write(altered)
    with pytest.raises(module.Refused, match="blob or SHA256"):
        module.qualify_source(data["candidate"])


def test_real_git_symlink_mode_is_refused(admission):
    module, data, record, write, monkeypatch = admission
    git = data["git"]
    blob = git("hash-object", "-w", "--stdin", input="elsewhere")
    git("update-index", "--cacheinfo", f"120000,{blob},{ADDED}")
    tree = git("write-tree")
    candidate = git("commit-tree", tree, "-p", data["candidate"], "-m", "Synthetic mode change")
    git("read-tree", data["candidate"])
    _rebind_candidate(module, record, write, monkeypatch, data, candidate)
    with pytest.raises(module.Refused, match="mode or object type"):
        module.qualify_source(candidate)


def test_real_git_oversized_blob_is_refused_before_read(admission, monkeypatch):
    module, data, record, write, rebind = admission
    # Lower the bound while leaving every reviewed fixture blob under it.
    limit = max(
        int(data["git"]("cat-file", "-s", f"{sha}:{row['path']}"))
        for row in record["changes"]
        for sha, present in ((data["baseline"], row["before"]), (data["candidate"], row["after"]))
        if present is not None
    )
    monkeypatch.setattr(module, "MAX_BLOB_BYTES", limit)
    candidate = _candidate_with_change(data, ADDED, "x" * (limit + 1))
    _rebind_candidate(module, record, write, rebind, data, candidate)
    calls = []
    original = module.backend._git

    def bounded(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(module.backend, "_git", bounded)
    with pytest.raises(module.Refused, match="exceeds its bound"):
        module.qualify_source(candidate)
    assert ("show", f"{candidate}:{ADDED}") not in calls


def test_tree_and_ancestry_are_independent_source_boundaries(admission, monkeypatch):
    module, data, record, write, _ = admission
    monkeypatch.setattr(module, "SOURCE_TREE", "0" * 40)
    with pytest.raises(module.Refused, match="tree changed"):
        module.qualify_source(data["candidate"])
    monkeypatch.setattr(module, "SOURCE_TREE", data["after_tree"])
    sibling = data["git"](
        "commit-tree", data["after_tree"], "-p", data["production"], "-m", "Synthetic sibling"
    )
    _rebind_candidate(module, record, write, monkeypatch, data, sibling)
    with pytest.raises(module.Refused):
        module.qualify_source(sibling)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sourceSha", "0" * 40),
        ("frontendSha", "0" * 40),
        ("sourceQualified", False),
        ("trafficAuthorized", True),
        ("recordSha256", "bad"),
    ],
)
def test_unqualified_or_traffic_authorized_backend_proof_is_refused(
    admission, monkeypatch, field, value
):
    module, data, _, _, _ = admission
    valid = module.backend.qualify_source(data["baseline"])
    monkeypatch.setattr(module.backend, "qualify_source", lambda sha: {**valid, field: value})
    with pytest.raises(module.Refused, match="backend source predecessor"):
        module.qualify_source(data["candidate"])


def test_duplicate_record_fields_and_oversized_record_fail_closed(tmp_path, monkeypatch):
    module = _load("plg_frontend_duplicate_test", SOURCE)
    monkeypatch.setattr(module, "RECORD", tmp_path / "record.json")
    for raw in (
        '{"sourceSha":"a","sourceSha":"b"}',
        '{"changes":[{"path":"a","path":"b"}]}',
    ):
        module.RECORD.write_text(raw, encoding="utf-8")
        with pytest.raises(module.Refused, match="Duplicate"):
            module._load_record()
    module.RECORD.write_bytes(b" " * (module.MAX_RECORD_BYTES + 1))
    with pytest.raises(module.Refused, match="exceeds its bound"):
        module._load_record()
