"""Metadata concurrency must preserve complete, ordered, fail-closed inventory."""

import json
import subprocess
import sys
from threading import Event, Lock, Thread

import pytest

from tests.test_verify_env_secrets_parity import parity


@pytest.mark.parametrize(
    ("code", "stdout", "stderr", "expected"),
    [
        (0, "projects/example/secrets/EXAMPLE", "", True),
        (1, "", "NOT_FOUND: Secret missing", False),
        (1, "", "Reauthentication failed: sensitive marker", None),
        (0, "", "", None),
    ],
)
def test_metadata_describe_distinguishes_absence_from_unknown(
    monkeypatch, code, stdout, stderr, expected
):
    def run(command, **kwargs):
        assert command == [
            "gcloud",
            "secrets",
            "describe",
            "EXAMPLE",
            "--project",
            "example",
            "--format=value(name)",
        ]
        assert kwargs == {"capture_output": True, "text": True, "timeout": 30}
        return subprocess.CompletedProcess(command, code, stdout, stderr)

    monkeypatch.setattr(parity.subprocess, "run", run)
    if expected is None:
        with pytest.raises(parity.CloudReadUnavailable, match="secret_inventory_unverifiable"):
            parity._has_secret("example", "EXAMPLE")
    else:
        assert parity._has_secret("example", "EXAMPLE") is expected


def test_metadata_inventory_overlaps_three_reads_and_keeps_input_order():
    names = ("third", "first", "second", "fourth", "fifth", "sixth", "seventh")
    lock, ready, release, overflow = Lock(), Event(), Event(), Event()
    active, peak, reads, result = 0, 0, [], []

    def describe(project, name):
        nonlocal active, peak
        with lock:
            reads.append((project, name))
            active += 1
            peak = max(peak, active)
            if active == 3:
                ready.set()
            if active > 3:
                overflow.set()
        try:
            assert release.wait(5)
            return name not in {"third", "second", "fifth"}
        finally:
            with lock:
                active -= 1

    worker = Thread(
        target=lambda: result.extend(parity._missing_secrets("example", names, describe))
    )
    worker.start()
    try:
        assert ready.wait(5), "Three independent metadata reads must overlap"
        assert not overflow.wait(0.1), "Metadata fan-out must remain bounded at three"
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive()
    assert peak == 3
    assert sorted(reads) == sorted(("example", name) for name in names)
    assert result == ["third", "second", "fifth"]


def test_metadata_failure_waits_for_started_reads_before_propagating():
    started, failed, release, returned = Event(), Event(), Event(), Event()
    errors = []

    def describe(_project, name):
        if name == "slow":
            started.set()
            assert release.wait(5)
            return True
        if name == "unknown":
            assert started.wait(5)
            failed.set()
            raise parity.CloudReadUnavailable("sensitive marker")
        return False

    def collect():
        try:
            parity._missing_secrets("example", ("missing", "unknown", "slow"), describe)
        except parity.CloudReadUnavailable as error:
            errors.append(error)
        finally:
            returned.set()

    worker = Thread(target=collect)
    worker.start()
    try:
        assert failed.wait(5)
        assert not returned.wait(0.1), "A failed inventory must join started reads"
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive()
    assert len(errors) == 1


def test_unverifiable_inventory_report_omits_partial_missing_and_provider_error(
    monkeypatch, tmp_path, capsys
):
    report = tmp_path / "report.json"
    monkeypatch.setattr(
        sys, "argv", ["verify", "--project", "example", "--report-path", str(report)]
    )

    def describe(_project, name):
        if name == parity.BACKEND_REQUIRED[0]:
            return False
        raise parity.CloudReadUnavailable("sensitive marker")

    monkeypatch.setattr(parity, "_has_secret", describe)
    assert parity.main() == 1
    payload = json.loads(report.read_text())
    assert payload["missing_secrets"] is None
    assert payload["classifications"] == ["secret_inventory_unverifiable"]
    assert "sensitive marker" not in report.read_text() + capsys.readouterr().out
