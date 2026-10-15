"""Preregistered, seeded two-stage stratified cluster sample.

Stage 1 draws leaf folders (clusters) by simple random sampling inside design
strata keyed by the (HMAC'd) top-level folder; no top-level folder may supply
more than ``folder_cap`` of the batch. Stage 2 draws up to ``per_cluster`` files
per folder. Loose files (root or singleton folders) are a separate simple random
sample. Order comes from SHA-256(seed, key), so the same seed and frame always
give the same sample. Weights are (N_h/n_h)(M_i/m_i), ratio-calibrated so they
sum exactly to each sampled design stratum's frame population. Files sampled by
an earlier batch are excluded (no replacement across batches).
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path

from hushh_eval.drive_packets.contracts import (
    FrameRow,
    PlanRow,
    SampledItem,
    canonical_json,
)
from hushh_eval.drive_packets.strata import STRATA_VERSION

LOOSE = "loose"
ANCHOR = "anchor"
INELIGIBLE_FAMILIES = {"folder", "shortcut"}


class PlanError(ValueError):
    """The plan is invalid or was changed after preregistration."""


def _order(seed: int, key: str) -> str:
    return hashlib.sha256(f"{seed}\0{key}".encode()).hexdigest()


def default_eligible(row: FrameRow) -> bool:
    return (row.in_system or row.in_independent_listing) and (
        row.mime_family not in INELIGIBLE_FAMILIES
    )


def plan_sha256(plan: PlanRow) -> str:
    return hashlib.sha256(
        canonical_json(plan.model_dump(mode="json", exclude={"plan_sha256"})).encode()
    ).hexdigest()


def frame_sha256(rows: Iterable[FrameRow]) -> str:
    digest = hashlib.sha256()
    for row in sorted(rows, key=lambda item: item.file_key):
        digest.update(canonical_json(row.model_dump(mode="json")).encode() + b"\n")
    return digest.hexdigest()


def _largest_remainder(total: int, sizes: dict[str, int], capacity: dict[str, int]) -> dict:
    allocation = dict.fromkeys(sizes, 0)
    remaining = total
    active = {key for key in sizes if capacity[key] > 0}
    while remaining > 0 and active:
        weight = sum(sizes[key] for key in active)
        shares = {key: remaining * sizes[key] / weight for key in active}
        granted = 0
        for key in sorted(active, key=lambda item: (-(shares[item] % 1), item)):
            add = min(int(shares[key]), capacity[key] - allocation[key])
            allocation[key] += add
            granted += add
        leftovers = remaining - granted
        for key in sorted(active, key=lambda item: (-(shares[item] % 1), item)):
            if leftovers == 0:
                break
            if allocation[key] < capacity[key]:
                allocation[key] += 1
                leftovers -= 1
                granted += 1
        remaining -= granted
        active = {key for key in active if allocation[key] < capacity[key]}
        if granted == 0:
            break
    return allocation


def plan_batch(
    frame: list[FrameRow],
    *,
    batch_id: str,
    seed: int,
    n_clusters: int,
    n_loose: int,
    per_cluster: int = 15,
    folder_cap: float = 0.10,
    prior_keys: set[str] = frozenset(),
    anchor_keys: Iterable[str] = (),
    request_set_version: str,
    label_version: str,
    judge: dict,
    runtime: dict,
    budget_usd: float,
    eligible: Callable[[FrameRow], bool] = default_eligible,
) -> PlanRow:
    if not frame or len({row.frame_id for row in frame}) != 1:
        raise PlanError("frame_required")
    if n_clusters < 0 or n_loose < 0 or not 1 <= per_cluster <= 50 or not 0 < folder_cap <= 1:
        raise PlanError("invalid_design")
    anchors = list(dict.fromkeys(anchor_keys))
    population = [
        row
        for row in frame
        if eligible(row) and row.file_key not in prior_keys and row.file_key not in anchors
    ]
    folders: dict[str, list[FrameRow]] = defaultdict(list)
    for row in population:
        if row.folder_key:
            folders[row.folder_key].append(row)
    clustered = {key: rows for key, rows in folders.items() if len(rows) >= 2}
    loose = [row for row in population if not row.folder_key or row.folder_key not in clustered]

    strata: dict[str, list[str]] = defaultdict(list)
    files_in: dict[str, int] = defaultdict(int)
    for key, rows in clustered.items():
        stratum = f"top:{rows[0].top_folder_key or 'root'}"
        strata[stratum].append(key)
        files_in[stratum] += len(rows)
    target_files = n_clusters * per_cluster + n_loose
    cap_files = max(per_cluster, int(folder_cap * target_files))

    def under_cap(stratum: str, limit: int | None = None) -> list[str]:
        """Seed-ordered clusters of one stratum that fit under the folder cap."""
        chosen, taken = [], 0
        for key in sorted(strata[stratum], key=lambda key: _order(seed, key)):
            if limit is not None and len(chosen) >= limit:
                break
            size = min(per_cluster, len(clustered[key]))
            if taken + size > cap_files:
                continue
            chosen.append(key)
            taken += size
        return chosen

    # Capacity is what fits under the cap, so draws a capped folder cannot use
    # are reallocated to the other strata instead of being lost.
    allocation = _largest_remainder(
        n_clusters, dict(files_in), {key: len(under_cap(key)) for key in strata}
    )

    sample: list[SampledItem] = []
    realized: dict[str, int] = {}
    for stratum in sorted(strata):
        chosen = under_cap(stratum, allocation.get(stratum, 0))
        if not chosen:
            continue
        realized[stratum] = len(chosen)
        raw = []
        for key in chosen:
            rows = sorted(clustered[key], key=lambda row: _order(seed, row.file_key))
            picked = rows[:per_cluster]
            weight = (len(strata[stratum]) / len(chosen)) * (len(rows) / len(picked))
            raw.extend((row, key, weight) for row in picked)
        factor = files_in[stratum] / sum(weight for _, _, weight in raw)
        sample.extend(
            SampledItem(
                file_key=row.file_key,
                design_stratum=stratum,
                cluster_key=key,
                stage="cluster",
                design_weight=weight * factor,
            )
            for row, key, weight in raw
        )
    picked_loose = sorted(loose, key=lambda row: _order(seed, row.file_key))[:n_loose]
    if picked_loose:
        realized[LOOSE] = len(picked_loose)
        sample.extend(
            SampledItem(
                file_key=row.file_key,
                design_stratum=LOOSE,
                cluster_key=None,
                stage="loose",
                design_weight=len(loose) / len(picked_loose),
            )
            for row in picked_loose
        )
    sample.extend(
        SampledItem(
            file_key=key, design_stratum=ANCHOR, cluster_key=None, stage="anchor", design_weight=0
        )
        for key in anchors
    )
    plan = PlanRow(
        batch_id=batch_id,
        frame_id=frame[0].frame_id,
        frame_sha256=frame_sha256(frame),
        strata_version=STRATA_VERSION,
        seed=seed,
        design={
            "n_clusters": n_clusters,
            "per_cluster": per_cluster,
            "n_loose": n_loose,
            "folder_cap": folder_cap,
            "cap_files": cap_files,
            "population_files": len(population),
            "clustered_files": sum(files_in.values()),
            "loose_files": len(loose),
            "design_strata": len(strata) + (1 if loose else 0),
            "sampled_design_strata": len(realized),
        },
        allocation=dict(sorted(realized.items())),
        sample=sample,
        anchor_keys=anchors,
        excluded_prior=len(prior_keys),
        request_set_version=request_set_version,
        label_version=label_version,
        judge=judge,
        runtime=runtime,
        budget_usd=budget_usd,
    )
    return plan.model_copy(update={"plan_sha256": plan_sha256(plan)})


def verify_plan(plan: PlanRow) -> PlanRow:
    if not plan.plan_sha256 or plan.plan_sha256 != plan_sha256(plan):
        raise PlanError("plan_changed_after_preregistration")
    keys = [item.file_key for item in plan.sample]
    if len(keys) != len(set(keys)):
        raise PlanError("duplicate_sampled_file")
    return plan


def design_totals(plan: PlanRow) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    for item in plan.sample:
        totals[item.design_stratum] += item.design_weight
    return dict(totals)


def ledger_keys(path: Path) -> set[str]:
    """File keys preregistered by any earlier plan (sampling without replacement)."""
    if not path.exists():
        return set()
    keys = set()
    for line in path.read_text().splitlines():
        if line.strip():
            batch, _, key = line.partition(" ")
            if batch and key:
                keys.add(key)
    return keys


def ledger_lines(plan: PlanRow) -> list[str]:
    return [f"{plan.batch_id} {item.file_key}" for item in plan.sample if item.stage != "anchor"]
