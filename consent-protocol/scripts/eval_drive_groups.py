"""Measure the Drive four-group organizing aid on labelled files and print counts only.

    python scripts/eval_drive_groups.py [--fixtures PATH] [--split eval] [--json]

The default is the held-out ``eval`` split of the synthetic fixtures, whose
template families the fit never saw. That number is a regression gate, not the
aid's accuracy on a real Drive. To measure real files, pass ``--fixtures`` a
JSONL file kept outside the repository, one object per file with ``id``,
``label`` (a group id or ``none``), ``name``, ``mime``, ``head`` (the text
start or null), ``shared_with_me`` and ``owned_by_me``. This script prints
aggregate counts and rates only: never a name, a head or an ID.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from itertools import combinations
from pathlib import Path

import numpy as np
from drive_group_lab import DEFAULT_CACHE, DEFAULT_FIXTURES, CachedEmbedder, evidence_of, load_rows

from hushh_mcp.services.drive_groups.contract import (
    GROUP_IDS,
    KEPT,
    NONE_CLASS,
    SIGNALS,
    SignalReading,
)
from hushh_mcp.services.drive_groups.fusion import fuse
from hushh_mcp.services.drive_groups.models import load_bundle
from hushh_mcp.services.drive_groups.placement import readings_for

BINS = 10


def summarize(results: list[tuple[str, str, float]]) -> dict:
    """results: (true label, shelf, confidence) per file."""
    positives = [r for r in results if r[0] != NONE_CLASS]
    nones = [r for r in results if r[0] == NONE_CLASS]
    placed = [r for r in results if r[1] != KEPT]
    right = [r for r in placed if r[0] == r[1]]
    return {
        "files": len(results),
        "positives": len(positives),
        "none": len(nones),
        "placed": len(placed),
        "placed_correct": len(right),
        "precision": len(right) / len(placed) if placed else None,
        "recall": len(right) / len(positives) if positives else None,
        "none_placed": sum(1 for r in nones if r[1] != KEPT),
        "positives_kept": sum(1 for r in positives if r[1] == KEPT),
    }


def calibration(results: list[tuple[str, str, float]]) -> dict:
    """Expected calibration error of the confidence on placed files."""
    placed = [r for r in results if r[1] != KEPT]
    if not placed:
        return {"ece": None, "bins": []}
    edges = np.linspace(0.5, 1.0, BINS + 1)
    total, ece, bins = len(placed), 0.0, []
    for low, high in zip(edges[:-1], edges[1:], strict=True):
        inside = [r for r in placed if low <= r[2] < high or (high == 1.0 and r[2] == 1.0)]
        if not inside:
            continue
        accuracy = sum(r[0] == r[1] for r in inside) / len(inside)
        confidence = sum(r[2] for r in inside) / len(inside)
        ece += len(inside) / total * abs(accuracy - confidence)
        bins.append(
            {
                "range": [round(float(low), 2), round(float(high), 2)],
                "n": len(inside),
                "accuracy": round(accuracy, 3),
                "confidence": round(confidence, 3),
            }
        )
    return {"ece": round(ece, 4), "bins": bins}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--split", default="eval", help="eval, train or all (synthetic fixtures)")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rows = load_rows(args.fixtures, args.split)
    bundle = load_bundle()
    embedder = CachedEmbedder(args.cache_dir)
    heads = [i for i, row in enumerate(rows) if row.get("head")]
    vectors: dict[int, tuple[float, ...]] = dict(
        zip(
            heads,
            map(tuple, embedder.passages([rows[i]["head"] for i in heads]).tolist()),
            strict=True,
        )
    )
    readings = [
        readings_for(evidence_of(row, vectors.get(i)), bundle) for i, row in enumerate(rows)
    ]

    def run(mask: set[str] | None):
        out = []
        for row, group in zip(rows, readings, strict=True):
            kept = tuple(
                r if mask is None or r.name in mask else SignalReading(r.name, None) for r in group
            )
            placement = fuse(kept, bundle.fusion, bundle.version)
            out.append((row["label"], placement.shelf, placement.confidence, placement.reason))
        return out

    full = run(None)
    triples = [(label, shelf, confidence) for label, shelf, confidence, _ in full]
    report = {
        "version": bundle.version,
        "split": args.split,
        "overall": summarize(triples),
        "with_head": summarize(
            [t for t, row in zip(triples, rows, strict=True) if row.get("head")]
        ),
        "without_head": summarize(
            [t for t, row in zip(triples, rows, strict=True) if not row.get("head")]
        ),
        "per_group": {
            group: {
                "precision": (
                    lambda p: None if not p else round(sum(t[0] == group for t in p) / len(p), 3)
                )([t for t in triples if t[1] == group]),
                "recall": (
                    lambda p: None if not p else round(sum(t[1] == group for t in p) / len(p), 3)
                )([t for t in triples if t[0] == group]),
            }
            for group in GROUP_IDS
        },
        "confusion": {
            label: dict(Counter(shelf for lab, shelf, _ in triples if lab == label))
            for label in (*GROUP_IDS, NONE_CLASS)
        },
        "kept_reasons": dict(Counter(reason for _, shelf, _, reason in full if shelf == KEPT)),
        "calibration": calibration(triples),
        "ablation_same_policy": {
            "+".join(sorted(mask)): summarize(
                [(label, shelf, confidence) for label, shelf, confidence, _ in run(set(mask))]
            )
            for size in (1, 2)
            for mask in combinations(SIGNALS, size)
        },
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return
    overall = report["overall"]
    print(
        f"version {report['version']} split {args.split}: {overall['files']} files "
        f"({overall['positives']} in a group, {overall['none']} fit none)"
    )
    precision, recall = overall["precision"], overall["recall"]
    print(
        f"placed {overall['placed']}: precision {precision if precision is None else round(precision, 3)}, "
        f"recall {recall if recall is None else round(recall, 3)}, "
        f"none placed in a group {overall['none_placed']}, group files kept {overall['positives_kept']}"
    )
    for name in ("with_head", "without_head"):
        part = report[name]
        print(
            f"  {name:12s} files {part['files']:4d} placed {part['placed']:4d} correct "
            f"{part['placed_correct']:4d} none_placed {part['none_placed']}"
        )
    print(
        "per group (precision / recall): "
        + ", ".join(
            f"{group.split('_')[0]} {v['precision']}/{v['recall']}"
            for group, v in report["per_group"].items()
        )
    )
    print("kept reasons:", report["kept_reasons"])
    print("expected calibration error on placed files:", report["calibration"]["ece"])
    print("confusion (true -> shelf):")
    for label, counts in report["confusion"].items():
        print(f"  {label:26s}", dict(sorted(counts.items())))
    print("signals masked, same policy (placed / correct / none placed):")
    for name, part in report["ablation_same_policy"].items():
        print(
            f"  {name:28s} {part['placed']:4d} / {part['placed_correct']:4d} / {part['none_placed']}"
        )


if __name__ == "__main__":
    main()
