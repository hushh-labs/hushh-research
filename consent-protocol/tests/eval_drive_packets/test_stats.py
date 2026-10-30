"""Confidence numbers must be exact and honest (reference values from the eval spec)."""

import random

import pytest

from hushh_eval.drive_packets import stats


@pytest.mark.parametrize(
    ("target", "needed"), [(0.90, 29), (0.95, 59), (0.99, 299), (0.995, 598), (0.999, 2995)]
)
def test_zero_failure_sample_sizes(target, needed):
    assert stats.zero_failure_sample_size(target) == needed


def test_exact_bounds_and_display_bounds():
    assert round(stats.exact_lower_bound(30, 30), 3) == 0.905
    assert round(stats.exact_lower_bound(60, 60), 3) == 0.951
    assert round(stats.exact_lower_bound(300, 300), 3) == 0.990
    # The seven-source packet result and the 36/36 synthetic run.
    assert round(stats.exact_lower_bound(2, 7), 3) == 0.053
    assert round(stats.exact_lower_bound(36, 36), 3) == 0.920
    # Wilson is display-only and more optimistic: 2,703 instead of 2,995.
    assert stats.wilson_zero_failure_sample_size(0.999) == 2703
    assert stats.wilson_lower(0, 10) == 0.0
    # One failure moves the 99.9% requirement from 2,995 to 4,742.
    assert stats.failures_sample_size(0.999, 1) == 4742


def test_calibration_is_near_zero_on_calibrated_data_and_large_when_overconfident():
    generator = random.Random(4)  # noqa: S311 - reproducible synthetic data
    probabilities = [generator.random() for _ in range(4000)]
    outcomes = [int(generator.random() < p) for p in probabilities]
    assert stats.expected_calibration_error(probabilities, outcomes) < 0.03
    overconfident = [0.99] * 200
    coin = [index % 2 for index in range(200)]
    assert stats.expected_calibration_error(overconfident, coin) == pytest.approx(0.49)
    # Fewer than 10 rows per bin: not reported.
    assert stats.expected_calibration_error([0.5] * 50, [1] * 50) is None
    assert stats.brier([1.0, 0.0, 0.5], [1, 0, 1]) == pytest.approx(0.25 / 3)
    assert stats.auroc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]) == 1.0


def test_agreement_and_paired_anchor_statistics_match_textbook_values():
    # Cohen's kappa: observed 0.75, expected 0.5 -> 0.5.
    assert stats.cohen_kappa(list("aabb"), list("aaba")) == pytest.approx(0.5)
    # McNemar exact: b=1, c=9 -> two-sided p = 2 * (1 + 10) / 1024.
    result = stats.mcnemar(1, 9)
    assert result["exact_p"] == pytest.approx(22 / 1024)
    assert result["chi2_cc"] == pytest.approx(4.9)
    assert stats.mcnemar(0, 0)["exact_p"] == 1.0


def test_only_one_ready_packet_per_family_counts_toward_gates():
    rows = [
        {"packet_key": "p1", "family_key": "f1"},
        {"packet_key": "p2", "family_key": "f1"},
        {"packet_key": "p3", "family_key": "f2"},
        {"packet_key": "p4", "family_key": None},
    ]
    kept = stats.one_per_family(rows)
    assert len(kept) == 3
    assert len({row["family_key"] for row in kept if row["family_key"]}) == 2


def test_cluster_bootstrap_resamples_families_not_rows():
    rows = [{"family": "a", "ok": 1}] * 50 + [{"family": "b", "ok": 0}]
    interval = stats.cluster_bootstrap(
        rows,
        cluster="family",
        statistic=lambda sample: sum(row["ok"] for row in sample) / len(sample),
        replicates=200,
    )
    # Two families: the interval must reach both extremes, unlike a row bootstrap.
    assert interval["clusters"] == 2
    assert interval["low"] == 0.0 and interval["high"] == 1.0
