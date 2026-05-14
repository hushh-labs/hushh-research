"""
Differential privacy engine for consent-protocol aggregate analytics.

Differential Privacy Engine by Abdul Gaffar — Beast Mode initiative.

This module implements the Laplace Mechanism (Dwork & Roth, 2014) to add
calibrated statistical noise to aggregate query results. The mechanism
ensures that no individual user's consent decision can be reverse-engineered
from any published aggregate, balancing big data utility with individual
user control — a core requirement of the Data Vital Tracker architecture.

Mathematical background
-----------------------

**Differential Privacy (ε-DP)**

A randomised mechanism M satisfies ε-differential privacy if, for any two
*adjacent* datasets D and D′ that differ by exactly one individual's record,
and for any measurable output set S:

    Pr[M(D) ∈ S]  ≤  exp(ε) × Pr[M(D′) ∈ S]

Intuitively: an observer who sees the output M(D) cannot determine, with
more than exp(ε) confidence, whether any individual is present in D.

**Epsilon (ε) — the privacy budget**

ε controls the privacy/utility trade-off:

    ε → 0  :  maximum privacy, maximum noise, minimal utility
    ε → ∞  :  no privacy guarantee, no noise, full utility

Practical guidance (Dwork & Roth, 2014 §2.3):
    ε ∈ (0, 0.1]   extremely strong — academic/research settings
    ε ∈ (0.1, 1]   strong — recommended for sensitive personal data
    ε ∈ (1,   10]  moderate — useful for lower-sensitivity aggregates
    ε > 10          provides little formal protection

**Global Sensitivity (Δf)**

The global sensitivity of a query function f is the maximum change in f's
output when one individual's record is added or removed:

    Δf = max_{D, D′ adjacent}  |f(D) − f(D′)|

For a counting query (e.g. total consent approvals): Δf = 1, because
adding or removing one user's approval changes the count by at most 1.

For a bounded sum query over values in [lo, hi]:  Δf = hi − lo.

**Laplace Mechanism**

Given a query f with sensitivity Δf and a privacy budget ε, the Laplace
Mechanism releases:

    M(D) = f(D) + Lap(0, Δf/ε)

where Lap(0, b) denotes a zero-mean Laplace distribution with scale b = Δf/ε.

Properties of Lap(0, b):
    Expected value          :  0   (unbiased estimator)
    Standard deviation      :  b√2
    Expected absolute error :  b = Δf/ε

**CSPRNG requirement**

Standard pseudo-random generators (Mersenne Twister, PCG) are NOT suitable
here: a compromised RNG seed can allow an adversary to reconstruct the noise
and recover the true value. This module uses ``os.urandom()`` (equivalent to
``/dev/urandom`` on Linux, ``CryptGenRandom`` on Windows) to sample the noise,
ensuring the privacy guarantee cannot be undermined by a weak RNG.

References
----------
Dwork, C. & Roth, A. (2014). *The Algorithmic Foundations of Differential
Privacy*. Foundations and Trends in Theoretical Computer Science, 9(3–4).
"""

from __future__ import annotations

import logging
import math
import os

logger = logging.getLogger(__name__)

_LABEL = "Differential Privacy Engine by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Cryptographically secure uniform sampling
# ---------------------------------------------------------------------------


def _csprng_uniform() -> float:
    """
    Sample a uniform float in (0, 1) from the OS CSPRNG.

    Uses ``os.urandom(8)`` to obtain 64 bits from the system entropy pool.
    The top 53 bits are used to fill the IEEE 754 double-precision mantissa,
    giving a uniform sample with 2^-53 granularity and no bias toward 0 or 1.

    The loop handles the astronomically unlikely (probability 2^-53 ≈ 10^-16)
    case where all 53 bits are zero, which would map to u = 0 and cause a
    domain error in the Laplace inverse-CDF.

    Returns
    -------
    float
        Uniform sample in (0, 1).  Never exactly 0 or 1.
    """
    while True:
        raw = os.urandom(8)
        n = int.from_bytes(raw, "big")
        f = (n >> 11) / (2**53)
        if f > 0.0:
            return f


# ---------------------------------------------------------------------------
# Laplace Mechanism
# ---------------------------------------------------------------------------


def laplace_mechanism(
    value: float,
    epsilon: float,
    sensitivity: float = 1.0,
) -> float:
    """
    Apply the Laplace Mechanism: release ``value + Lap(0, sensitivity/epsilon)``.

    This is the canonical building block for ε-differential privacy on
    real-valued query results.  The noise is sampled via the inverse-CDF
    method applied to a cryptographically secure uniform sample, so the
    privacy guarantee cannot be weakened by RNG prediction.

    Parameters
    ----------
    value : float
        True query result (e.g. a consent approval count or aggregate sum).
    epsilon : float
        Privacy budget ε > 0.  Smaller values → stronger privacy, more noise.
        See module docstring for practical guidance on choosing ε.
    sensitivity : float
        Global sensitivity Δf of the query (default 1.0).
        For counting queries Δf = 1; for bounded sums Δf = upper − lower.
        Must be > 0.

    Returns
    -------
    float
        Noisy output: ``value + Lap(0, sensitivity / epsilon)``.

    Raises
    ------
    ValueError
        If ``epsilon ≤ 0`` or ``sensitivity ≤ 0``.

    Notes
    -----
    The noise scale is ``b = sensitivity / epsilon``.
    Expected absolute noise E[|noise|] = b = sensitivity / epsilon.

    Inverse-CDF formula (Devroye, 1986):
    If U ~ Uniform(0, 1), then:
        X = −b · sign(U − 0.5) · ln(1 − 2·|U − 0.5|)
    is distributed as Lap(0, b).

    Signed: Differential Privacy Engine by Abdul Gaffar
    """
    if epsilon <= 0.0:
        raise ValueError(
            f"epsilon must be strictly positive, got {epsilon!r}. "
            "Use a small positive value (e.g. 0.1–1.0) for strong privacy."
        )
    if sensitivity <= 0.0:
        raise ValueError(
            f"sensitivity must be strictly positive, got {sensitivity!r}. "
            "For a counting query use sensitivity=1."
        )

    scale = sensitivity / epsilon
    u = _csprng_uniform()
    u_shifted = u - 0.5

    # Inverse CDF of Laplace(0, scale)
    noise = (
        -scale
        * math.copysign(1.0, u_shifted)
        * math.log(1.0 - 2.0 * abs(u_shifted))
    )

    noisy_value = value + noise
    logger.debug(
        "[%s] mechanism=laplace epsilon=%.6f sensitivity=%.6f scale=%.6f",
        _LABEL,
        epsilon,
        sensitivity,
        scale,
    )
    return noisy_value


# ---------------------------------------------------------------------------
# Consent-specific aggregate with built-in DP
# ---------------------------------------------------------------------------


def noisy_approval_count(
    raw_count: int,
    *,
    epsilon: float = 1.0,
    sensitivity: float = 1.0,
) -> float:
    """
    Return a differentially private estimate of the consent approval count.

    Wraps :func:`laplace_mechanism` with consent-specific defaults and
    logging.  Individual consent decisions cannot be reverse-engineered from
    the returned value.

    Parameters
    ----------
    raw_count : int
        True number of consent approvals in the query window.
    epsilon : float
        Privacy budget (default 1.0 — strong DP guarantee for most use cases).
        Reduce toward 0.1 for maximum privacy; increase toward 10 for datasets
        where statistical accuracy matters more than privacy.
    sensitivity : float
        Query sensitivity (default 1.0 for counting queries — one user's
        participation changes the count by at most 1).

    Returns
    -------
    float
        Differentially private approval count.  Treat as approximate:
        rounding to int is valid, but the original count is not recoverable.

    Signed: Differential Privacy Engine by Abdul Gaffar
    """
    logger.info(
        "[%s] noisy_approval_count raw=%d epsilon=%.4f sensitivity=%.4f",
        _LABEL,
        raw_count,
        epsilon,
        sensitivity,
    )
    return laplace_mechanism(float(raw_count), epsilon=epsilon, sensitivity=sensitivity)
