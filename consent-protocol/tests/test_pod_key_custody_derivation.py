"""A pod's sealing keys must be the same after it dies as before.

The property under test is resumability: an economy pod (`min-instances=0`) is
*expected* to go cold and wake again, and if its keys change on the way it cannot
decrypt its own commit log. That is indistinguishable from data loss, and it is
discovered only when someone needs the data.

Also asserted: separation. Two pods never share a key, and within one pod the
commit-log key and the memory key are different, so the two subsystems cannot
interact through their cipher.
"""

from __future__ import annotations

import base64

import pytest

from hushh_mcp.services import pod_key_custody
from hushh_mcp.services.pod_key_custody import (
    POD_KEY_MASTER_ENV,
    custody_configured,
    derive_pod_log_key,
    derive_pod_memory_key,
    pod_log_key_b64,
    pod_memory_key_b64,
)

MASTER = base64.b64encode(b"m" * 48).decode("ascii")
OWNER = "HA1SIM0000"
OTHER = "HA1SIM0001"


@pytest.fixture
def master(monkeypatch):
    monkeypatch.setenv(POD_KEY_MASTER_ENV, MASTER)


def test_the_same_pod_derives_the_same_key_every_time(master) -> None:
    """The whole point: a re-provisioned pod can still read what it wrote."""
    first = derive_pod_log_key(OWNER)
    second = derive_pod_log_key(OWNER)

    assert first == second
    assert len(first) == 32


def test_keys_survive_a_full_process_restart(master, monkeypatch) -> None:
    """Nothing about the derivation depends on process state or on when it ran."""
    before = derive_pod_log_key(OWNER)

    # Simulate teardown: clear the env, reload the module, restore the master.
    import importlib

    monkeypatch.delenv(POD_KEY_MASTER_ENV, raising=False)
    importlib.reload(pod_key_custody)
    monkeypatch.setenv(POD_KEY_MASTER_ENV, MASTER)
    importlib.reload(pod_key_custody)

    assert pod_key_custody.derive_pod_log_key(OWNER) == before


def test_two_pods_never_share_a_key(master) -> None:
    assert derive_pod_log_key(OWNER) != derive_pod_log_key(OTHER)
    assert derive_pod_memory_key(OWNER) != derive_pod_memory_key(OTHER)


def test_log_and_memory_keys_are_separated_within_one_pod(master) -> None:
    """Distinct info labels, so the commit log and the memory index share no cipher key."""
    assert derive_pod_log_key(OWNER) != derive_pod_memory_key(OWNER)


def test_a_different_master_yields_different_keys(monkeypatch) -> None:
    monkeypatch.setenv(POD_KEY_MASTER_ENV, MASTER)
    under_first = derive_pod_log_key(OWNER)

    monkeypatch.setenv(POD_KEY_MASTER_ENV, base64.b64encode(b"n" * 48).decode("ascii"))
    assert derive_pod_log_key(OWNER) != under_first


def test_derived_material_is_accepted_by_the_commit_log(master) -> None:
    """The b64 form must be exactly what `log_key_from_env` will take back."""
    import os

    from hushh_mcp.services.pod_commit_log import POD_LOG_KEY_ENV, log_key_from_env

    os.environ[POD_LOG_KEY_ENV] = pod_log_key_b64(OWNER)
    try:
        assert log_key_from_env() == derive_pod_log_key(OWNER)
    finally:
        os.environ.pop(POD_LOG_KEY_ENV, None)


def test_memory_key_b64_round_trips(master) -> None:
    assert base64.b64decode(pod_memory_key_b64(OWNER)) == derive_pod_memory_key(OWNER)


def test_a_missing_master_fails_loud_rather_than_guessing(monkeypatch) -> None:
    monkeypatch.delenv(POD_KEY_MASTER_ENV, raising=False)

    with pytest.raises(RuntimeError) as excinfo:
        derive_pod_log_key(OWNER)

    assert POD_KEY_MASTER_ENV in str(excinfo.value)


def test_a_short_master_is_refused(monkeypatch) -> None:
    """HKDF will stretch 4 bytes to 32 and hand back a key with 4 bytes of entropy."""
    monkeypatch.setenv(POD_KEY_MASTER_ENV, "short")

    with pytest.raises(RuntimeError):
        derive_pod_log_key(OWNER)


def test_an_empty_owner_is_refused(master) -> None:
    with pytest.raises(ValueError):
        derive_pod_log_key("")


def test_custody_configured_reports_absence_without_raising(monkeypatch) -> None:
    """Absence is today's behaviour (ephemeral pod), not a provisioning failure."""
    monkeypatch.delenv(POD_KEY_MASTER_ENV, raising=False)
    assert custody_configured() is False

    monkeypatch.setenv(POD_KEY_MASTER_ENV, MASTER)
    assert custody_configured() is True
