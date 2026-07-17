# SPDX-License-Identifier: Apache-2.0
"""Characterization tests for heap allocation-delta diagnostics.

Truth-first scope note
----------------------
This module is a *self-contained developer instrumentation harness*. It does
NOT import, patch, or depend on any consent-protocol runtime, storage server,
vault, or IAM surface. It exercises the Python standard library's own
``tracemalloc`` accounting to pin down the observable behaviour that any local
memory-diagnostics helper relies on:

1. A heap allocation performed while tracing is active produces a *positive*
   measured size delta between two snapshots.
2. Releasing the allocation and forcing a collection returns the traced size
   back toward the baseline (no stale residual growth is reported).
3. Snapshot diffing is order-consistent: the reverse diff of a growth is a
   symmetric negative, so the accounting does not leak phantom bytes.

These assertions characterize existing, already-shipped CPython behaviour.
They are pinning tests: they document current truth, they do not introduce a
new production contract.
"""

from __future__ import annotations

import gc
import tracemalloc

import pytest


@pytest.fixture()
def tracing():
    """Provide a clean tracemalloc frame and guarantee teardown.

    Ensures no tracing state leaks into the surrounding test execution frame,
    regardless of assertion outcome inside the body.
    """
    already_tracing = tracemalloc.is_tracing()
    if not already_tracing:
        tracemalloc.start()
    try:
        yield tracemalloc
    finally:
        if not already_tracing:
            tracemalloc.stop()
    # Post-condition: we restored the frame to its pre-test tracing state.
    assert tracemalloc.is_tracing() is already_tracing


def test_allocation_produces_positive_heap_delta(tracing):
    """A live allocation registers a positive traced-memory delta."""
    baseline = tracing.take_snapshot()

    # Allocate a non-trivial, retained payload so the delta is measurable.
    payload = [bytearray(4096) for _ in range(256)]
    assert len(payload) == 256  # keep a live reference during measurement

    after = tracing.take_snapshot()
    diff = after.compare_to(baseline, "filename")
    total_delta = sum(stat.size_diff for stat in diff)

    assert total_delta > 0, "expected positive heap growth while payload is live"

    # Retain until here so the optimizer cannot elide the allocation early.
    del payload


def test_release_returns_toward_baseline_without_stale_residual(tracing):
    """Releasing the payload + GC returns traced size toward the baseline."""
    baseline = tracing.take_snapshot()

    payload = [bytearray(4096) for _ in range(256)]
    grown = tracing.take_snapshot()
    grown_delta = sum(
        stat.size_diff for stat in grown.compare_to(baseline, "filename")
    )
    assert grown_delta > 0

    # Drop the only reference and force a deterministic collection cycle.
    del payload
    gc.collect()

    released = tracing.take_snapshot()
    residual_delta = sum(
        stat.size_diff for stat in released.compare_to(baseline, "filename")
    )

    # The freed cycle must not report growth larger than what remained live at
    # peak: no stale residual pointer inflates the post-release accounting.
    assert residual_delta < grown_delta


def test_snapshot_diff_is_order_symmetric(tracing):
    """Forward and reverse diffs of the same growth are sign-symmetric."""
    baseline = tracing.take_snapshot()

    payload = [bytearray(2048) for _ in range(128)]
    after = tracing.take_snapshot()

    forward = sum(
        stat.size_diff for stat in after.compare_to(baseline, "filename")
    )
    reverse = sum(
        stat.size_diff for stat in baseline.compare_to(after, "filename")
    )

    assert forward > 0
    assert reverse == -forward, "diff accounting must be symmetric, not leaky"

    del payload


def test_tracing_frame_is_active_inside_fixture(tracing):
    """Sanity: the diagnostics frame is genuinely tracing during the test."""
    assert tracing.is_tracing() is True
    current, peak = tracing.get_traced_memory()
    assert current >= 0
    assert peak >= current
