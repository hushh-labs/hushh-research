"""A batch is a fair, repeatable, preregistered sample."""

import json

import pytest

from hushh_eval.drive_packets.contracts import FrameRow, PlanRow
from hushh_eval.drive_packets.sampling import (
    PlanError,
    design_totals,
    plan_batch,
    verify_plan,
)


def frame(top_folders=6, folders_per_top=5, files_per_folder=20, loose=200):
    rows = []
    for top in range(top_folders):
        for folder in range(folders_per_top):
            for index in range(files_per_folder):
                rows.append(
                    row(f"{top:02d}{folder:02d}{index:04d}", f"folder-{top}-{folder}", f"top-{top}")
                )
    for index in range(loose):
        rows.append(row(f"ff{index:06d}", None, None))
    return rows


def row(suffix, folder, top):
    return FrameRow(
        frame_id="frame-1",
        file_key=(suffix + "0" * 32)[:32],
        mime_family="pdf",
        size_bucket="lt100k",
        age_bucket="2024_2026",
        modified_year=2026,
        created_year=2026,
        folder_key=folder,
        top_folder_key=top,
        system_stage="pending",
        in_system=True,
        in_independent_listing=True,
    )


def plan(rows, **overrides):
    arguments = dict(
        batch_id="B001",
        seed=20261015,
        n_clusters=8,
        n_loose=20,
        per_cluster=15,
        folder_cap=0.10,
        request_set_version="requests.v1",
        label_version="labels.v1",
        judge={"j1": "a", "j2": "b"},
        runtime={"code_sha": "x"},
        budget_usd=50,
    )
    arguments.update(overrides)
    return plan_batch(rows, **arguments)


def test_same_seed_and_frame_give_the_same_sample_and_hash():
    rows = frame()
    first, second = plan(rows), plan(list(reversed(rows)))
    assert first.plan_sha256 == second.plan_sha256
    assert [item.file_key for item in first.sample] == [item.file_key for item in second.sample]
    assert plan(rows, seed=7).plan_sha256 != first.plan_sha256


def test_weights_sum_to_each_sampled_design_stratum_population():
    rows = frame()
    result = plan(rows)
    totals = design_totals(result)
    population = {}
    for item in rows:
        key = f"top:{item.top_folder_key}" if item.folder_key else "loose"
        population[key] = population.get(key, 0) + 1
    for stratum, total in totals.items():
        assert total == pytest.approx(population[stratum])


def test_folder_cap_and_cluster_size_hold():
    result = plan(frame(top_folders=2, folders_per_top=10))
    per_top, per_folder = {}, {}
    for item in result.sample:
        if item.stage == "cluster":
            per_top[item.design_stratum] = per_top.get(item.design_stratum, 0) + 1
            per_folder[item.cluster_key] = per_folder.get(item.cluster_key, 0) + 1
    assert max(per_top.values()) <= result.design["cap_files"]
    assert max(per_folder.values()) <= 15


def test_files_from_earlier_batches_are_never_redrawn():
    rows = frame()
    first = plan(rows)
    used = {item.file_key for item in first.sample}
    second = plan(rows, batch_id="B002", prior_keys=used)
    assert used.isdisjoint(item.file_key for item in second.sample)
    assert second.excluded_prior == len(used)


def test_anchors_are_kept_and_carry_no_design_weight():
    rows = frame()
    anchor = rows[0].file_key
    result = plan(rows, anchor_keys=[anchor])
    anchors = [item for item in result.sample if item.stage == "anchor"]
    assert [item.file_key for item in anchors] == [anchor]
    assert anchors[0].design_weight == 0


def test_a_changed_plan_is_refused():
    result = plan(frame())
    verify_plan(result)
    tampered = json.loads(result.model_dump_json())
    tampered["sample"] = tampered["sample"][1:]
    with pytest.raises(PlanError, match="plan_changed_after_preregistration"):
        verify_plan(PlanRow.model_validate(tampered))


def test_draws_a_capped_folder_cannot_use_go_to_other_folders():
    rows = []
    for folder in range(50):
        rows += [row(f"aa{folder:03d}{i:03d}", f"big-{folder}", "big") for i in range(20)]
    for top in range(10):
        for folder in range(2):
            rows += [
                row(f"b{top:02d}{folder}{i:03d}", f"small-{top}-{folder}", f"small-{top}")
                for i in range(20)
            ]
    result = plan(rows, n_clusters=12, n_loose=0, per_cluster=15, folder_cap=0.10)
    clusters = {item.cluster_key for item in result.sample}
    # cap = 10% of 180 = 18 files: one 15-file cluster per top folder, 11 top folders.
    assert len(clusters) == 11
    assert sum(item.design_stratum == "top:big" for item in result.sample) == 15
