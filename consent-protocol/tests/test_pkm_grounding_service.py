"""Where the agent's knowledge of its owner comes from.

Two properties carry the weight:

  * with the flag OFF, the resolver is a pass-through -- the live client-mediated
    path must be byte-identical, or shipping this dark is a fiction; and
  * an EPHEMERAL pod key never produces an empty pod read. Sealed holdings that
    cannot be opened must not be reported as "this person has no records", which is
    a confident wrong answer rather than an absent one.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.pkm_grounding_service import (
    SOURCE_CLIENT,
    SOURCE_NONE,
    SOURCE_POD,
    resolve_grounding,
)

CLIENT_BLOB = "the owner's holdings, as the browser decrypted them"
POD_BLOB = "the owner's holdings, as the pod read them"


class _Store:
    def __init__(self, snapshot=POD_BLOB, *, boom: bool = False) -> None:
        self._snapshot = snapshot
        self._boom = boom
        self.reads = 0

    async def get_domain_snapshot(self, _params):
        self.reads += 1
        if self._boom:
            raise RuntimeError("sqlite is unhappy")
        return self._snapshot


# -- flag off: the live path is untouched -------------------------------------


async def test_with_the_flag_off_the_client_blob_passes_through_unchanged():
    result = await resolve_grounding(
        user_id="u1",
        client_context=CLIENT_BLOB,
        store=_Store(),
        pod_native_enabled=False,
    )
    assert result.text == CLIENT_BLOB
    assert result.source == SOURCE_CLIENT


async def test_with_the_flag_off_the_pod_store_is_never_read():
    """Shipping dark means dark: no read, no latency, no behaviour change."""
    store = _Store()
    await resolve_grounding(
        user_id="u1", client_context=CLIENT_BLOB, store=store, pod_native_enabled=False
    )
    assert store.reads == 0


# -- the ephemeral-key refusal ------------------------------------------------


async def test_an_ephemeral_key_never_produces_an_empty_pod_read():
    """Durable holdings are wrapped to a durable key. Reading with an ephemeral one
    would return nothing, and nothing reads as "you have no records"."""
    store = _Store()
    result = await resolve_grounding(
        user_id="u1",
        client_context=CLIENT_BLOB,
        store=store,
        pod_native_enabled=True,
        key_is_durable=False,
    )
    assert store.reads == 0
    assert result.source == SOURCE_CLIENT
    assert "ephemeral" in result.reason


async def test_an_ephemeral_key_with_no_client_blob_reports_ungrounded_not_empty():
    """The honest answer is "I could not read", never a silent empty set."""
    result = await resolve_grounding(
        user_id="u1",
        client_context=None,
        store=_Store(),
        pod_native_enabled=True,
        key_is_durable=False,
    )
    assert result.source == SOURCE_NONE
    assert result.is_grounded is False
    assert "ephemeral" in result.reason


# -- pod-native --------------------------------------------------------------


async def test_a_durable_pod_grounds_from_its_own_store():
    result = await resolve_grounding(
        user_id="u1",
        client_context=CLIENT_BLOB,
        store=_Store(),
        pod_native_enabled=True,
        key_is_durable=True,
    )
    assert result.text == POD_BLOB
    assert result.source == SOURCE_POD


async def test_the_pod_wins_over_the_client_and_the_two_are_never_mixed():
    """A merged context would make provenance meaningless and could double-count."""
    result = await resolve_grounding(
        user_id="u1",
        client_context=CLIENT_BLOB,
        store=_Store(),
        pod_native_enabled=True,
        key_is_durable=True,
    )
    assert CLIENT_BLOB not in result.text


async def test_an_empty_pod_falls_back_rather_than_downgrading_a_mid_migration_owner():
    """Records still client-side, pod not yet populated: keep the agent knowing."""
    result = await resolve_grounding(
        user_id="u1",
        client_context=CLIENT_BLOB,
        store=_Store(snapshot=""),
        pod_native_enabled=True,
        key_is_durable=True,
    )
    assert result.source == SOURCE_CLIENT
    assert result.text == CLIENT_BLOB


async def test_a_failed_pod_read_falls_back_instead_of_failing_the_turn():
    result = await resolve_grounding(
        user_id="u1",
        client_context=CLIENT_BLOB,
        store=_Store(boom=True),
        pod_native_enabled=True,
        key_is_durable=True,
    )
    assert result.source == SOURCE_CLIENT
    assert "RuntimeError" in result.reason


async def test_no_store_on_this_host_falls_back():
    """The hub has no pod store; it must keep working exactly as before."""
    result = await resolve_grounding(
        user_id="u1", client_context=CLIENT_BLOB, store=None, pod_native_enabled=True
    )
    assert result.source == SOURCE_CLIENT


# -- shape + budget ----------------------------------------------------------


async def test_grounding_is_capped_to_the_existing_client_budget():
    """Switching source must not silently change how much the agent is told."""
    result = await resolve_grounding(
        user_id="u1",
        client_context=None,
        store=_Store(snapshot="x" * 50_000),
        pod_native_enabled=True,
        key_is_durable=True,
    )
    assert len(result.text) == 20000


async def test_a_totally_ungrounded_turn_is_reported_as_such():
    result = await resolve_grounding(
        user_id="u1", client_context=None, store=None, pod_native_enabled=False
    )
    assert result.source == SOURCE_NONE
    assert result.is_grounded is False


@pytest.mark.parametrize("blank", ["", "   ", None])
async def test_a_blank_client_blob_is_not_mistaken_for_grounding(blank):
    result = await resolve_grounding(
        user_id="u1", client_context=blank, store=None, pod_native_enabled=False
    )
    assert result.source == SOURCE_NONE


async def test_every_result_carries_a_reason():
    """Provenance without a reason is a label; the reason is what makes it auditable."""
    for kwargs in (
        {"client_context": CLIENT_BLOB, "store": None, "pod_native_enabled": False},
        {"client_context": None, "store": None, "pod_native_enabled": True},
        {
            "client_context": None,
            "store": _Store(),
            "pod_native_enabled": True,
            "key_is_durable": True,
        },
    ):
        result = await resolve_grounding(user_id="u1", **kwargs)
        assert result.reason.strip()
