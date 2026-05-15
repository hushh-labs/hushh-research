"""
Tests for utils/privacy_engine.py — Laplace Mechanism and noisy_approval_count.

Differential Privacy Engine by Abdul Gaffar — verifies that:
  1. Invalid inputs are rejected with clear errors
  2. Output is a float that differs from the true value (noise is injected)
  3. The mechanism is statistically unbiased (sample mean ≈ true value)
  4. Smaller epsilon produces larger noise (stronger privacy)
  5. Larger epsilon produces smaller noise (higher utility)
  6. noisy_approval_count delegates correctly to laplace_mechanism
"""

from __future__ import annotations

import math
import statistics

import pytest

from hushh_mcp.consent.privacy_engine import laplace_mechanism, noisy_approval_count

# ---------------------------------------------------------------------------
# Constants used across tests
# ---------------------------------------------------------------------------

_TRUE_VALUE = 1_000.0
_N_SAMPLES = 500  # enough for stable statistical assertions without slowness


def _samples(value: float, epsilon: float, n: int = _N_SAMPLES) -> list[float]:
    return [laplace_mechanism(value, epsilon) for _ in range(n)]


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


class TestInputValidation:
    def test_epsilon_zero_raises(self):
        with pytest.raises(ValueError, match="epsilon"):
            laplace_mechanism(100.0, 0.0)

    def test_epsilon_negative_raises(self):
        with pytest.raises(ValueError, match="epsilon"):
            laplace_mechanism(100.0, -1.0)

    def test_sensitivity_zero_raises(self):
        with pytest.raises(ValueError, match="sensitivity"):
            laplace_mechanism(100.0, 1.0, sensitivity=0.0)

    def test_sensitivity_negative_raises(self):
        with pytest.raises(ValueError, match="sensitivity"):
            laplace_mechanism(100.0, 1.0, sensitivity=-0.5)

    def test_valid_call_does_not_raise(self):
        laplace_mechanism(0.0, 0.1)  # should not raise

    def test_zero_value_accepted(self):
        result = laplace_mechanism(0.0, 1.0)
        assert isinstance(result, float)

    def test_negative_value_accepted(self):
        result = laplace_mechanism(-500.0, 1.0)
        assert isinstance(result, float)

    def test_very_small_epsilon_accepted(self):
        result = laplace_mechanism(100.0, 1e-6)
        assert isinstance(result, float)

    def test_very_large_epsilon_accepted(self):
        result = laplace_mechanism(100.0, 1e6)
        assert math.isfinite(result)


# ---------------------------------------------------------------------------
# Noise injection — output is masked
# ---------------------------------------------------------------------------


class TestNoiseInjection:
    def test_returns_float(self):
        result = laplace_mechanism(_TRUE_VALUE, 1.0)
        assert isinstance(result, float)

    def test_output_is_finite(self):
        result = laplace_mechanism(_TRUE_VALUE, 1.0)
        assert math.isfinite(result)

    def test_output_consistently_masked(self):
        """
        With 100 calls, all outputs should differ from the true value.

        Pr(|Lap(0,1)| = 0) = 0 for a continuous distribution — with
        floating-point arithmetic the probability of exact equality is
        negligible (< 2^-53).  If this test fails, the RNG is broken.
        """
        results = [laplace_mechanism(_TRUE_VALUE, 1.0) for _ in range(100)]
        assert all(r != _TRUE_VALUE for r in results), (
            "All outputs equalled the true value — noise injection is broken"
        )

    def test_different_calls_produce_different_outputs(self):
        """Repeated calls must not return the same noisy value."""
        results = {laplace_mechanism(_TRUE_VALUE, 1.0) for _ in range(20)}
        assert len(results) > 1, "CSPRNG appears broken — all outputs identical"

    def test_noise_sign_varies(self):
        """Noise should be both positive and negative with many samples."""
        results = [laplace_mechanism(0.0, 1.0) for _ in range(200)]
        positives = sum(1 for r in results if r > 0)
        negatives = sum(1 for r in results if r < 0)
        assert positives > 10, "Noise is always negative — distribution is skewed"
        assert negatives > 10, "Noise is always positive — distribution is skewed"


# ---------------------------------------------------------------------------
# Statistical correctness
# ---------------------------------------------------------------------------


class TestStatisticalProperties:
    def test_unbiased_estimator(self):
        """
        The Laplace mechanism is an unbiased estimator.

        With N=500 samples and scale b=1, the standard error of the mean is
        b/sqrt(N) ≈ 0.045.  The assertion window ±0.5 has z-score ≈ 11,
        giving failure probability < 10^-27.
        """
        samples = _samples(_TRUE_VALUE, epsilon=1.0)
        sample_mean = statistics.mean(samples)
        assert abs(sample_mean - _TRUE_VALUE) < 0.5, (
            f"Sample mean {sample_mean:.3f} too far from true value {_TRUE_VALUE}"
        )

    def test_smaller_epsilon_produces_larger_noise(self):
        """
        Lower ε → larger scale b = 1/ε → larger expected absolute noise.

        Expected |noise|: ε=0.1 → b=10; ε=1.0 → b=1.
        With N=500 samples the difference is easily detectable.
        """
        high_privacy = [abs(laplace_mechanism(0.0, 0.1)) for _ in range(_N_SAMPLES)]
        low_privacy  = [abs(laplace_mechanism(0.0, 10.0)) for _ in range(_N_SAMPLES)]
        mean_high = statistics.mean(high_privacy)
        mean_low  = statistics.mean(low_privacy)
        assert mean_high > mean_low, (
            f"Expected high-privacy noise ({mean_high:.2f}) > "
            f"low-privacy noise ({mean_low:.2f})"
        )

    def test_larger_epsilon_output_closer_to_true_value(self):
        """
        Higher ε means smaller noise, so outputs should be closer to truth.
        """
        precise = [abs(laplace_mechanism(_TRUE_VALUE, 100.0) - _TRUE_VALUE) for _ in range(_N_SAMPLES)]
        noisy   = [abs(laplace_mechanism(_TRUE_VALUE, 0.01) - _TRUE_VALUE) for _ in range(_N_SAMPLES)]
        assert statistics.mean(precise) < statistics.mean(noisy), (
            "High-epsilon outputs should be closer to the true value on average"
        )

    def test_noise_scale_matches_theory(self):
        """
        For Laplace(0, b), E[|X|] = b = sensitivity/epsilon.

        For sensitivity=1, epsilon=1: E[|noise|] should be ≈ 1.
        Assert the sample mean is within 30 % of the theoretical value —
        this tolerance is ≫ the statistical variation at N=500.
        """
        theoretical_b = 1.0 / 1.0  # sensitivity / epsilon
        abs_noise = [abs(laplace_mechanism(0.0, 1.0)) for _ in range(_N_SAMPLES)]
        empirical_mean = statistics.mean(abs_noise)
        assert abs(empirical_mean - theoretical_b) < 0.30 * theoretical_b, (
            f"Empirical E[|noise|]={empirical_mean:.3f}, "
            f"theoretical b={theoretical_b:.3f}"
        )

    def test_sensitivity_scales_noise_linearly(self):
        """
        Doubling sensitivity doubles the expected absolute noise.
        """
        noise_s1 = [abs(laplace_mechanism(0.0, 1.0, sensitivity=1.0)) for _ in range(_N_SAMPLES)]
        noise_s2 = [abs(laplace_mechanism(0.0, 1.0, sensitivity=2.0)) for _ in range(_N_SAMPLES)]
        ratio = statistics.mean(noise_s2) / statistics.mean(noise_s1)
        assert 1.5 < ratio < 2.5, f"Sensitivity scaling ratio={ratio:.2f}, expected ≈ 2"


# ---------------------------------------------------------------------------
# noisy_approval_count
# ---------------------------------------------------------------------------


class TestNoisyApprovalCount:
    def test_returns_float(self):
        result = noisy_approval_count(500)
        assert isinstance(result, float)

    def test_output_differs_from_input(self):
        results = [noisy_approval_count(1_000) for _ in range(50)]
        assert any(r != 1_000.0 for r in results)

    def test_invalid_epsilon_raises(self):
        with pytest.raises(ValueError, match="epsilon"):
            noisy_approval_count(100, epsilon=0.0)

    def test_invalid_sensitivity_raises(self):
        with pytest.raises(ValueError, match="sensitivity"):
            noisy_approval_count(100, sensitivity=-1.0)

    def test_zero_count(self):
        result = noisy_approval_count(0)
        assert isinstance(result, float)

    def test_unbiased_over_many_calls(self):
        true_count = 200
        estimates = [noisy_approval_count(true_count, epsilon=1.0) for _ in range(_N_SAMPLES)]
        assert abs(statistics.mean(estimates) - true_count) < 1.0

    def test_identity_label_in_docstring(self):
        assert "Abdul Gaffar" in (noisy_approval_count.__doc__ or "")
        assert "Differential Privacy Engine" in (noisy_approval_count.__doc__ or "")

    def test_laplace_mechanism_docstring_has_epsilon_explanation(self):
        doc = laplace_mechanism.__doc__ or ""
        assert "epsilon" in doc.lower()
        assert "sensitivity" in doc.lower()
        assert "privacy" in doc.lower()
