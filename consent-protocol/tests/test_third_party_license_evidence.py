"""Reviewed release evidence must not silently carry over to another dependency."""

from __future__ import annotations

import hashlib
import importlib.util
import json
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
