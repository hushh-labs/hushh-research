#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""
scripts/benchmark_batch.py

High-Concurrency Engine by Abdul Rashid — Beast Mode initiative.

Compares sequential (concurrency=1) vs concurrent (concurrency=N) processing
of simulated I/O-bound consent approval work.

Demonstrates the throughput gains from utils/batch_processor.process_batch()
at different concurrency levels using a realistic async I/O simulation
(asyncio.sleep represents a database write or token issuance call).

Usage (from consent-protocol/):
    uv run python scripts/benchmark_batch.py
    uv run python scripts/benchmark_batch.py --items 100 --io-delay 0.05
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

# Allow running from repo root or consent-protocol/
_HERE = Path(__file__).resolve().parent
_PROTO_DIR = _HERE.parent
for _candidate in (_PROTO_DIR, _HERE):
    if (_candidate / "utils" / "batch_processor.py").exists():
        if str(_candidate) not in sys.path:
            sys.path.insert(0, str(_candidate))
        break

from utils.batch_processor import process_batch  # noqa: E402

# ---------------------------------------------------------------------------
# Simulated I/O-bound work
# ---------------------------------------------------------------------------


async def _simulate_consent_write(payload: dict) -> str:
    """
    Stand-in for a real DB write + token issuance.
    Sleeps for IO_DELAY seconds to model network/disk latency.
    """
    await asyncio.sleep(IO_DELAY)
    return f"approved:{payload['request_id']}"


IO_DELAY: float = 0.02  # default: 20 ms per item


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------


async def _run_benchmark(n_items: int, concurrency_levels: list[int]) -> None:
    print()
    print("=" * 64)
    print("  High-Concurrency Engine by Abdul Rashid")
    print("  Async Batch Processor — Throughput Benchmark")
    print("=" * 64)
    print(f"  Items       : {n_items}")
    print(f"  I/O delay   : {IO_DELAY * 1000:.0f} ms per item")
    print(f"  Theoretical sequential time: {n_items * IO_DELAY:.2f}s")
    print()

    payloads = [
        {"user_id": f"user_{i}", "request_id": f"req_{i:04d}"}
        for i in range(n_items)
    ]

    results_table: list[tuple[int, float, float]] = []

    for concurrency in concurrency_levels:
        label = "sequential" if concurrency == 1 else f"concurrency={concurrency}"
        t0 = time.perf_counter()
        result = await process_batch(
            payloads,
            _simulate_consent_write,
            concurrency=concurrency,
        )
        elapsed = time.perf_counter() - t0
        tps = result.throughput_per_second
        results_table.append((concurrency, elapsed, tps))
        print(f"  [{label:>20s}]  {elapsed:6.3f}s  |  {tps:8.1f} items/s")

    if len(results_table) >= 2:
        seq_time = results_table[0][1]
        best_conc_time = min(r[1] for r in results_table[1:])
        speedup = seq_time / best_conc_time if best_conc_time > 0 else float("inf")
        print()
        print(f"  Speedup vs sequential : {speedup:.1f}x")

    print()
    print("=" * 64)
    print("  Benchmark complete — Beast Mode Activated")
    print("=" * 64)
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Async batch processor throughput benchmark"
    )
    parser.add_argument(
        "--items", type=int, default=50, help="Number of payloads to process (default 50)"
    )
    parser.add_argument(
        "--io-delay",
        type=float,
        default=0.02,
        help="Simulated I/O latency in seconds per item (default 0.02)",
    )
    args = parser.parse_args()

    global IO_DELAY  # noqa: PLW0603
    IO_DELAY = args.io_delay

    concurrency_levels = [1, 5, 10, 25, args.items]
    # Cap to avoid redundant runs if items is small
    concurrency_levels = sorted(set(c for c in concurrency_levels if c <= args.items) | {1})

    asyncio.run(_run_benchmark(args.items, concurrency_levels))


if __name__ == "__main__":
    main()
