"""Reviewed release evidence must not silently carry over to another dependency."""

from __future__ import annotations

import builtins
import hashlib
import importlib.util
import json
import sys
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts/licenses/generate_third_party_notices.py"
_SPEC = importlib.util.spec_from_file_location("third_party_license_evidence", _SCRIPT)
notices = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(notices)


@pytest.fixture
def reviewed_package(tmp_path, monkeypatch):
    content = b"Synthetic reviewed license\r\n"
    monkeypatch.setattr(
        notices,
        "REVIEWED_LICENSE_FILES",
        {("example", "1.0"): ("LICENSE", "MIT", hashlib.sha256(content).hexdigest())},
    )
    monkeypatch.setattr(notices, "WEB_LOCK", tmp_path / "package-lock.json")
    directory = tmp_path / "node_modules/example"
    directory.mkdir(parents=True)
    (directory / "LICENSE").write_bytes(content)
    (directory / "package.json").write_text(
        json.dumps({"name": "example", "version": "1.0", "licenses": [{"type": "MIT"}]})
    )
    return directory


def test_web_resolution_requires_the_reviewed_raw_bytes(reviewed_package):
    assert notices.installed_web_license("node_modules/example", "example", "1.0") == "MIT"
    license_file = reviewed_package / "LICENSE"
    license_file.write_bytes(license_file.read_bytes().replace(b"\r\n", b"\n"))
    assert notices.installed_web_license("node_modules/example", "example", "1.0") == "UNKNOWN"


@pytest.mark.parametrize(
    "metadata",
    [
        {"name": "another-package", "version": "1.0"},
        {"name": "example", "version": "1.1"},
        {"name": "example", "version": "1.0", "license": "GPL-3.0"},
        {"name": "example", "version": "1.0", "licenses": [{"type": "GPL-3.0"}]},
        {"name": "example", "version": "1.0", "licenses": "malformed"},
        [],
    ],
)
def test_web_mismatches_and_conflicts_remain_unknown(reviewed_package, metadata):
    (reviewed_package / "package.json").write_text(json.dumps(metadata))
    assert notices.installed_web_license("node_modules/example", "example", "1.0") == "UNKNOWN"


def test_missing_files_and_unreviewed_versions_remain_unknown(reviewed_package):
    assert notices.installed_web_license("node_modules/example", "example", "2.0") == "UNKNOWN"
    (reviewed_package / "LICENSE").unlink()
    assert notices.installed_web_license("node_modules/example", "example", "1.0") == "UNKNOWN"
    (reviewed_package / "package.json").unlink()
    assert notices.installed_web_license("node_modules/example", "example", "1.0") == "UNKNOWN"


@pytest.mark.parametrize(
    "failure",
    [None, "name", "version", "declaration", "missing", "digest", "conflict", "ambiguous"],
)
def test_python_distribution_evidence_is_bound_to_metadata_and_file(
    reviewed_package, monkeypatch, failure
):
    metadata = Message()
    metadata["Name"] = "elsewhere" if failure == "name" else "example"
    if failure != "declaration":
        metadata["License-File"] = "LICENSE"
    if failure == "conflict":
        metadata["License-Expression"] = "GPL-3.0"
    if failure == "digest":
        (reviewed_package / "LICENSE").write_bytes(b"changed license")
    if failure == "missing":
        (reviewed_package / "LICENSE").unlink()
    files = [Path("example-1.0.dist-info/licenses/LICENSE")]
    if failure == "ambiguous":
        files.append(Path("example-1.0.dist-info/LICENSE"))
    distribution = SimpleNamespace(
        metadata=metadata,
        version="2.0" if failure == "version" else "1.0",
        files=files,
        locate_file=lambda path: reviewed_package / path.name,
    )
    monkeypatch.setattr(notices.importlib.metadata, "distribution", lambda name: distribution)
    expected = [{"name": "example", "version": "1.0", "license": "MIT"}] if failure is None else []
    assert notices.python_license_evidence() == expected


def test_unreviewed_a2ui_release_has_no_fallback(tmp_path):
    path = tmp_path / "LICENSE"
    path.write_text("A source header is not distribution license evidence")
    assert notices.reviewed_license("a2ui-agent-sdk", "0.2.4", path) == "UNKNOWN"


@pytest.mark.parametrize(
    "change", [None, "payload", "extra", "missing", "license", "version", "conflict"]
)
def test_source_review_requires_exact_distribution_payload(tmp_path, monkeypatch, change):
    package = tmp_path / "example"
    package.mkdir()
    payload = package / "schema.json"
    payload.write_bytes(b'{"synthetic": true}')
    license_file = tmp_path / "LICENSE"
    license_file.write_bytes(b"Synthetic reviewed permission")
    manifest = f"{hashlib.sha256(payload.read_bytes()).hexdigest()}  schema.json\n"
    review = {
        "package": "example",
        "license": "MIT",
        "license_file": "LICENSE",
        "license_sha256": hashlib.sha256(license_file.read_bytes()).hexdigest(),
        "payload_count": 1,
        "payload_sha256": hashlib.sha256(manifest.encode()).hexdigest(),
    }
    metadata = Message()
    metadata["Name"] = "example"
    if change == "conflict":
        metadata["License-Expression"] = "GPL-3.0"
    if change == "payload":
        payload.write_bytes(b"modified")
    if change == "extra":
        (package / "extra.json").write_bytes(b"new unreviewed asset")
    if change == "missing":
        payload.unlink()
    if change == "license":
        license_file.write_bytes(b"different permission")
    distribution = SimpleNamespace(
        metadata=metadata,
        version="2.0" if change == "version" else "1.0",
        locate_file=lambda path: tmp_path / path,
    )
    monkeypatch.setattr(notices, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(notices, "REVIEWED_LICENSE_FILES", {})
    monkeypatch.setattr(notices, "REVIEWED_SOURCE_DISTRIBUTIONS", {("example", "1.0"): review})
    monkeypatch.setattr(notices.importlib.metadata, "distribution", lambda name: distribution)
    expected = [{"name": "example", "version": "1.0", "license": "MIT"}] if change is None else []
    assert notices.python_license_evidence() == expected


def test_absent_email_runtime_preserves_existing_notice_outputs(tmp_path, monkeypatch):
    monkeypatch.setattr(notices, "REPO_ROOT", tmp_path)
    assert notices.load_email_runtime_resources() == []
    packages = [{"name": "synthetic", "version": "1", "license": "MIT"}]
    for name in (
        "load_web_packages",
        "load_python_packages",
        "load_vendored_packages",
        "load_pod_runtime_resources",
    ):
        monkeypatch.setattr(notices, name, lambda: packages)
    monkeypatch.setattr(notices, "ROOT_NOTICES", tmp_path / "root.md")
    monkeypatch.setattr(notices, "PROTOCOL_NOTICES", tmp_path / "protocol.md")
    expected_root, expected_protocol = (
        tmp_path / "expected-root.md",
        tmp_path / "expected-protocol.md",
    )
    notices.write_markdown(
        expected_root,
        "Third-Party Notices",
        "Third-party dependency inventory for the hushh-research monorepo.",
        [
            (heading, packages)
            for heading in (
                "Frontend npm packages",
                "Backend Python packages",
                "Vendored engineering resources",
                "Private pod runtime resources",
            )
        ],
    )
    notices.write_markdown(
        expected_protocol,
        "Third-Party Notices",
        "Third-party dependency inventory for the Hushh Consent Protocol.",
        [("Python packages", packages), ("Private pod runtime resources", packages)],
    )
    assert notices.main() == 0
    assert notices.ROOT_NOTICES.read_bytes() == expected_root.read_bytes()
    assert notices.PROTOCOL_NOTICES.read_bytes() == expected_protocol.read_bytes()


@pytest.mark.parametrize(
    "failure",
    [
        None,
        "vendor_missing",
        "provenance_missing",
        "invalid_json",
        "empty_sources",
        "notice_missing",
        "license_missing",
        "digest",
        "path_escape",
    ],
)
def test_present_email_runtime_requires_complete_provenance(tmp_path, monkeypatch, failure):
    monkeypatch.setattr(notices, "REPO_ROOT", tmp_path)
    runtime = tmp_path / "consent-protocol/hushh_mcp/services/email_oss"
    directory = runtime / "vendor"
    directory.mkdir(parents=True)
    license_file = directory / "LICENSE"
    license_file.write_bytes(b"Synthetic GPL license evidence")
    notice = directory / "PROVENANCE.md"
    notice.write_text("Synthetic upstream notice")
    inventory = {
        "schema_version": "email_oss_vendor.v1",
        "sources": [
            {
                "repository": "https://github.com/synthetic/example",
                "commit": "a" * 40,
                "license": "GPL-3.0-only",
                "files": [
                    {
                        "path": "LICENSE",
                        "upstream_path": "LICENSE",
                        "sha256": hashlib.sha256(license_file.read_bytes()).hexdigest(),
                    }
                ],
            }
        ],
    }
    if failure == "empty_sources":
        inventory["sources"] = []
    if failure == "path_escape":
        outside = runtime / "outside"
        outside.write_bytes(license_file.read_bytes())
        inventory["sources"][0]["files"][0]["path"] = "../outside"
    provenance = directory / "PROVENANCE.json"
    provenance.write_text("{" if failure == "invalid_json" else json.dumps(inventory))
    if failure in {"vendor_missing", "provenance_missing"}:
        provenance.unlink()
    if failure in {"vendor_missing", "notice_missing"}:
        notice.unlink()
    if failure in {"vendor_missing", "license_missing"}:
        license_file.unlink()
    if failure == "vendor_missing":
        directory.rmdir()
    if failure == "digest":
        license_file.write_bytes(b"Changed license")
    if failure is not None:
        with pytest.raises((OSError, ValueError)):
            notices.load_email_runtime_resources()
        return
    assert notices.load_email_runtime_resources() == [
        {
            "name": "synthetic/example",
            "version": "a" * 40,
            "license": "GPL-3.0-only",
            "license_file": str(license_file.relative_to(tmp_path)),
            "notice_file": str(notice.relative_to(tmp_path)),
        }
    ]


def test_email_model_bake_import_needs_only_standard_library(monkeypatch):
    script = _SCRIPT.parents[2] / "consent-protocol/scripts/ops/bake_email_router_model.py"
    original_import = builtins.__import__

    def standard_library_only(name, *args, **kwargs):
        if name.split(".", 1)[0] not in sys.stdlib_module_names:
            raise AssertionError("Bake script imported a runtime dependency before execution")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", standard_library_only)
    spec = importlib.util.spec_from_file_location("email_router_bake_import_safety", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert callable(module.bake_model) and callable(module.verify_model) and callable(module.main)
