"""The pod keeps the same identity across restarts, or admits it cannot.

`HUSSH_POD_PRIVATE_KEY` has been read by `pod_self_registration` since it was
written and set by nothing in this repository, so every pod mints a fresh
keypair on every boot. The founder's live pod reported `podKeyDurable: False`
on 2026-08-25, which is the north star's Identity requirement failing in public.

These pin the store that closes it. The load-bearing assertions are:

  * a restart recovers the SAME key (the entire point);
  * a corrupt stored key is REFUSED rather than replaced, because minting over
    it would silently orphan everything already wrapped to the real one;
  * a lost create race ADOPTS the winner, because two live processes disagreeing
    about who this agent is would be worse than either outcome;
  * every ordinary failure degrades to ephemeral, because a pod that cannot
    persist its identity must still boot and serve.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.pod_commit_log import LocalObjectStore
from hushh_mcp.services.pod_identity_store import (
    IDENTITY_KEY_OBJECT,
    PodIdentityStoreError,
    load_or_create_private_key,
    open_private_key,
    seal_private_key,
)

_DEK = b"D" * 32
_OTHER_DEK = b"E" * 32


def _store(tmp_path, name="state"):
    return LocalObjectStore(str(tmp_path / name))


# --------------------------------------------------------------------------- #
# The point: the same identity across restarts
# --------------------------------------------------------------------------- #


async def test_a_restart_recovers_the_same_key(tmp_path):
    """One boot generates, the next reads. This is the whole requirement."""
    store = _store(tmp_path)

    first, created_first = await load_or_create_private_key(store, _DEK)
    second, created_second = await load_or_create_private_key(store, _DEK)

    assert created_first is True
    assert created_second is False
    assert first == second
    assert len(first) == 32


async def test_a_fresh_pod_generates_exactly_once(tmp_path):
    """Three boots, one generation. A pod that re-generated on every read would
    look durable while being ephemeral, which is worse than being honestly
    ephemeral."""
    store = _store(tmp_path)

    keys = [(await load_or_create_private_key(store, _DEK)) for _ in range(3)]

    assert [created for _, created in keys] == [True, False, False]
    assert len({raw for raw, _ in keys}) == 1


async def test_the_key_is_stored_where_the_pod_already_has_access(tmp_path):
    """Beside the log's own wrapped key, in the pod's own prefix. That location
    is the reason this needs no new IAM and no new bootstrap step."""
    store = _store(tmp_path)
    await load_or_create_private_key(store, _DEK)

    assert await store.get(IDENTITY_KEY_OBJECT) is not None
    assert IDENTITY_KEY_OBJECT.startswith("keys/")


# --------------------------------------------------------------------------- #
# It is sealed, and sealed under its OWN key
# --------------------------------------------------------------------------- #


async def test_the_private_key_is_never_stored_in_the_clear(tmp_path):
    store = _store(tmp_path)
    raw, _ = await load_or_create_private_key(store, _DEK)

    stored = await store.get(IDENTITY_KEY_OBJECT)

    assert stored is not None
    assert raw not in stored, "the private key is readable in the stored object"


def test_the_log_key_cannot_open_the_identity_key():
    """Derived with its own HKDF label, so compromise of the key that seals the
    log does not also hand over the thing that proves who the pod is."""
    from hushh_mcp.services.byoc_key_custody import derive_memory_key

    raw = b"P" * 32
    blob = seal_private_key(_DEK, raw)

    # The memory key is derived from the same DEK with a different label; it must
    # not open this either.
    with pytest.raises(PodIdentityStoreError):
        open_private_key(derive_memory_key(_DEK), blob)


def test_another_pods_dek_cannot_open_it():
    blob = seal_private_key(_DEK, b"P" * 32)

    with pytest.raises(PodIdentityStoreError):
        open_private_key(_OTHER_DEK, blob)


def test_a_round_trip_returns_the_same_bytes():
    raw = b"Q" * 32
    assert open_private_key(_DEK, seal_private_key(_DEK, raw)) == raw


def test_sealing_refuses_a_key_that_is_not_an_x25519_private_key():
    with pytest.raises(PodIdentityStoreError):
        seal_private_key(_DEK, b"too-short")


def test_sealing_refuses_a_dek_of_the_wrong_length():
    with pytest.raises(PodIdentityStoreError):
        seal_private_key(b"short", b"P" * 32)


# --------------------------------------------------------------------------- #
# A corrupt stored key is refused, never replaced
# --------------------------------------------------------------------------- #


async def test_a_corrupted_stored_key_is_refused_rather_than_reminted(tmp_path):
    """Minting a replacement would silently orphan everything already wrapped to
    the real key, and the pod would present a public key nobody recognises while
    reporting itself healthy. Refusing is the louder and safer failure."""
    store = _store(tmp_path)
    await load_or_create_private_key(store, _DEK)

    stored = bytearray(await store.get(IDENTITY_KEY_OBJECT))
    stored[-1] ^= 0x01
    await store.put_if_generation(IDENTITY_KEY_OBJECT, bytes(stored), 1)

    with pytest.raises(PodIdentityStoreError):
        await load_or_create_private_key(store, _DEK)


async def test_a_truncated_stored_key_is_refused(tmp_path):
    store = _store(tmp_path)
    await load_or_create_private_key(store, _DEK)
    await store.put_if_generation(IDENTITY_KEY_OBJECT, b"tiny", 1)

    with pytest.raises(PodIdentityStoreError):
        await load_or_create_private_key(store, _DEK)


# --------------------------------------------------------------------------- #
# The concurrent-boot race converges
# --------------------------------------------------------------------------- #


async def test_the_loser_of_a_create_race_adopts_the_winners_key(tmp_path):
    """`maxScale` is 1, but a revision switch briefly overlaps two instances and
    both would find no key. Keeping our own would leave two live processes
    disagreeing about who this agent is."""
    store = _store(tmp_path)

    # Another instance wins the create between our read and our write.
    other_key = b"W" * 32
    real_put = store.put_if_generation
    calls = {"n": 0}

    async def _racing_put(key, data, expected):
        if key == IDENTITY_KEY_OBJECT and calls["n"] == 0:
            calls["n"] += 1
            # The winner's write lands first, so ours must fail the CAS.
            await real_put(key, seal_private_key(_DEK, other_key), 0)
            return None
        return await real_put(key, data, expected)

    store.put_if_generation = _racing_put  # type: ignore[method-assign]

    raw, created = await load_or_create_private_key(store, _DEK)

    assert created is False
    assert raw == other_key, "the loser kept its own key instead of adopting the winner's"


async def test_a_lost_race_with_nothing_readable_afterwards_is_a_fault(tmp_path):
    """Claimed by another writer and then unreadable is not a state to shrug at."""
    store = _store(tmp_path)

    async def _claim_then_vanish(key, data, expected):
        return None

    store.put_if_generation = _claim_then_vanish  # type: ignore[method-assign]

    with pytest.raises(PodIdentityStoreError):
        await load_or_create_private_key(store, _DEK)


# --------------------------------------------------------------------------- #
# It ships dark, and every ordinary failure degrades to ephemeral
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off"])
async def test_the_flag_is_off_by_default(monkeypatch, value):
    from hushh_mcp.services.pod_identity_store import resolve_durable_private_key_b64

    monkeypatch.setenv("POD_DURABLE_IDENTITY_ENABLED", value)
    assert await resolve_durable_private_key_b64() is None


async def test_no_durable_storage_degrades_to_ephemeral(monkeypatch):
    """A pod that cannot persist its identity must still boot and serve, and
    report `podKeyDurable: False` honestly rather than claiming otherwise."""
    import hushh_mcp.services.pod_storage as pod_storage
    from hushh_mcp.services.pod_identity_store import resolve_durable_private_key_b64

    monkeypatch.setenv("POD_DURABLE_IDENTITY_ENABLED", "1")

    class _Null:
        backend_id = "null"

    monkeypatch.setattr(pod_storage, "resolve_pod_storage", lambda: _Null())

    assert await resolve_durable_private_key_b64() is None


async def test_unreachable_kms_degrades_to_ephemeral(monkeypatch):
    import hushh_mcp.services.byoc_key_custody as custody
    from hushh_mcp.services.pod_identity_store import resolve_durable_private_key_b64

    monkeypatch.setenv("POD_DURABLE_IDENTITY_ENABLED", "1")

    def _boom(*_a, **_k):
        raise RuntimeError("KMS unreachable")

    monkeypatch.setattr(custody, "resolve_pod_log_key", _boom)

    assert await resolve_durable_private_key_b64() is None


# --------------------------------------------------------------------------- #
# The wiring: it must run BEFORE the keypair is cached
# --------------------------------------------------------------------------- #


def test_startup_fills_the_key_before_the_keypair_is_resolved():
    """Ordering is the whole correctness of the wiring.

    `pod_keypair()` caches for the process lifetime, so filling
    HUSSH_POD_PRIVATE_KEY after it would be a no-op that looks like it worked --
    the pod would log a durable key and serve an ephemeral one.
    """
    from pathlib import Path

    source = Path("pod_server.py").read_text(encoding="utf-8")
    fill = source.index("resolve_durable_private_key_b64()")
    resolve = source.index("    pod_keypair()")

    assert fill < resolve, "the durable key is recovered after the keypair is cached"


def test_startup_never_overwrites_an_explicitly_provided_key():
    """A BYOC pod handed its key by secretKeyRef must keep it. That mount is the
    documented durable source, and the pod's own store is the fallback for pods
    that have no such mount."""
    from pathlib import Path

    source = Path("pod_server.py").read_text(encoding="utf-8")

    assert 'not os.getenv("HUSSH_POD_PRIVATE_KEY")' in source


def test_the_pod_reports_whether_its_identity_is_durable_at_boot():
    """The fleet answered this wrongly and silently for the whole of its life."""
    from pathlib import Path

    source = Path("pod_server.py").read_text(encoding="utf-8")

    assert "pod.identity durable=" in source
