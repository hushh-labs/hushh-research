from __future__ import annotations

import os
import stat
import sys

import pytest

from hushh_mcp.services import local_mcp_keypair_service as svc


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    state_dir = tmp_path / "hushh-mcp-state"
    monkeypatch.setenv("HUSHH_MCP_STATE_DIR", str(state_dir))
    yield state_dir


def test_first_run_generates_and_persists_keypair(_isolated_state_dir):
    keypair = svc.get_or_create_local_connector_keypair()

    assert keypair.key_id.startswith("local-mcp-")
    assert keypair.wrapping_alg == "X25519-AES256-GCM"
    assert keypair.public_key_b64

    keypair_path = _isolated_state_dir / "connector_keypair.json"
    assert keypair_path.exists()


def test_repeated_calls_reuse_the_same_persisted_keypair(_isolated_state_dir):
    first = svc.get_or_create_local_connector_keypair()
    second = svc.get_or_create_local_connector_keypair()

    assert first.key_id == second.key_id
    assert first.public_key_b64 == second.public_key_b64


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file permissions only")
def test_persisted_keypair_file_and_directory_permissions_are_restrictive(_isolated_state_dir):
    svc.get_or_create_local_connector_keypair()

    keypair_path = _isolated_state_dir / "connector_keypair.json"
    file_mode = stat.S_IMODE(os.stat(keypair_path).st_mode)
    dir_mode = stat.S_IMODE(os.stat(_isolated_state_dir).st_mode)

    assert file_mode == 0o600
    assert dir_mode == 0o700


def test_corrupt_keypair_file_is_regenerated(_isolated_state_dir):
    _isolated_state_dir.mkdir(parents=True, exist_ok=True)
    keypair_path = _isolated_state_dir / "connector_keypair.json"
    keypair_path.write_text("not valid json", encoding="utf-8")

    keypair = svc.get_or_create_local_connector_keypair()

    assert keypair.key_id.startswith("local-mcp-")
    assert keypair_path.read_text(encoding="utf-8") != "not valid json"


def test_missing_directory_is_created_on_first_use(_isolated_state_dir):
    assert not _isolated_state_dir.exists()

    svc.get_or_create_local_connector_keypair()

    assert _isolated_state_dir.exists()
    assert (_isolated_state_dir / "connector_keypair.json").exists()


def test_state_dir_override_is_respected(tmp_path, monkeypatch):
    custom_dir = tmp_path / "custom-state-dir"
    monkeypatch.setenv("HUSHH_MCP_STATE_DIR", str(custom_dir))

    svc.get_or_create_local_connector_keypair()

    assert (custom_dir / "connector_keypair.json").exists()


def test_default_state_dir_is_under_home_when_no_override(monkeypatch):
    monkeypatch.delenv("HUSHH_MCP_STATE_DIR", raising=False)

    resolved = svc._state_dir()

    assert resolved == (svc.Path.home() / ".hushh" / "mcp")
