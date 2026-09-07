"""The zero-knowledge boundary of pod memory. Phase 4 security floor.

The promise: an agent's memory lives sealed in the OWNER's own space, and no
other party -- the hub included -- can read it. The one-time hub->pod history
import (the remaining Phase-4 wiring) must not weaken this, so the boundary is
pinned here first: it is the invariant the import will be measured against.

Three properties, each a probe against the real sealing, not a docstring:
  * a record sealed under a pod's key is opaque to any OTHER key (the hub holds a
    different key, so it cannot read pod memory even with the ciphertext in hand);
  * a record is bound to its owner (the owner is the seal's AAD), so a record
    lifted from one owner's log cannot be served as another's;
  * within the pod, add -> search round-trips, so the memory actually works.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.pod_memory_service import (
    PodMemoryError,
    PodMemoryStore,
    SealedMemory,
    _seal,
    _unseal,
)

_KEY_A = b"A" * 32
_KEY_B = b"B" * 32  # a DIFFERENT key -- stands in for the hub's key
_OWNER = "ha1_owner_x"
_OTHER_OWNER = "ha1_owner_y"


def test_a_different_key_cannot_open_a_pod_sealed_record():
    """The hub holds a different key from the pod (by design, pod_turn docstring).
    Even with the ciphertext, it cannot read the record."""
    blob = _seal(_KEY_A, "my portfolio is concentrated in tech", owner=_OWNER)
    assert _unseal(_KEY_A, blob, owner=_OWNER)  # the pod itself reads it
    with pytest.raises(PodMemoryError):
        _unseal(_KEY_B, blob, owner=_OWNER)  # a hub-held key cannot


def test_a_record_is_bound_to_its_owner():
    """The owner is the seal's AAD, so a record lifted from owner X's log fails to
    open as owner Y -- a pod cannot be tricked into serving another owner's memory."""
    blob = _seal(_KEY_A, "secret", owner=_OWNER)
    with pytest.raises(PodMemoryError):
        _unseal(_KEY_A, blob, owner=_OTHER_OWNER)


def test_a_sealed_payload_from_another_owner_is_refused_on_rebuild():
    store = PodMemoryStore(hushh_id=_OWNER, pod_key=_KEY_A)
    rec = store.add(text="I prefer index funds")
    assert rec is not None
    payload = rec.as_payload(_KEY_A)
    # Rebuilding with the right key + owner works; a mismatched owner raises.
    assert SealedMemory.from_payload(_KEY_A, payload).hushh_id == _OWNER
    tampered = {**payload, "hushh_id": _OTHER_OWNER}
    with pytest.raises(PodMemoryError):
        SealedMemory.from_payload(_KEY_A, tampered)


def test_pod_memory_add_then_search_round_trips():
    """The store actually remembers: what is added is found and opened."""
    store = PodMemoryStore(hushh_id=_OWNER, pod_key=_KEY_A)
    store.add(text="the user asked about NVIDIA earnings")
    hits = store.search(hushh_id=_OWNER, query="NVIDIA")
    assert hits, "a stored memory was not recalled"
    _rec, plaintext = hits[0]
    assert "NVIDIA" in plaintext


def test_search_refuses_another_owner():
    """Owner-scoped: a pod asked for a different owner's memory raises, never leaks."""
    store = PodMemoryStore(hushh_id=_OWNER, pod_key=_KEY_A)
    store.add(text="private note")
    with pytest.raises(PodMemoryError):
        store.search(hushh_id=_OTHER_OWNER, query="note")


def test_export_holds_no_plaintext():
    """The owner-facing export is ciphertext only -- proof the store holds no plaintext."""
    store = PodMemoryStore(hushh_id=_OWNER, pod_key=_KEY_A)
    store.add(text="a very distinctive secret phrase zubzub")
    assert "zubzub" not in store.export()


# ---- the double-count guard: history is read, never re-stored -----------------


class _FakeEvent:
    def __init__(self, text: str, *, invocation_id: str = "", author: str = "user"):
        self.invocation_id = invocation_id
        self.author = author

        class _Part:
            def __init__(self, t):
                self.text = t
                self.thought = False

        class _Content:
            def __init__(self, t):
                self.parts = [_Part(t)]

        self.content = _Content(text)


class _FakeSession:
    user_id = _OWNER

    def __init__(self, events):
        self.events = events


@pytest.mark.asyncio
async def test_history_events_are_not_re_stored_as_new_memory(monkeypatch):
    """The double-count bug: browser history turns are seeded with
    invocation_id='history_<n>'. add_session_to_memory must skip them, or the
    whole thread is re-sealed on every turn (and duplicated once the import owns
    it). Only the genuinely new turn of this invocation becomes memory."""
    from hushh_mcp.services import pod_memory_service as pms

    svc = pms.build_pod_memory_service(hushh_id=_OWNER, pod_key=_KEY_A, log=None)
    session = _FakeSession(
        [
            _FakeEvent("old turn one", invocation_id="history_0"),
            _FakeEvent("old turn two", invocation_id="history_1"),
            _FakeEvent("the brand new question", invocation_id="live-xyz"),
        ]
    )
    await svc.add_session_to_memory(session)
    # Only the non-history turn was stored -- assert via the public search API.
    new_hits = (
        await svc.search_memory(app_name="one", user_id=_OWNER, query="brand new question")
    ).memories
    old_hits = (
        await svc.search_memory(app_name="one", user_id=_OWNER, query="old turn one")
    ).memories
    assert new_hits, "the new turn should be remembered"
    assert not old_hits, "a history turn was re-sealed as new memory (double-count)"
