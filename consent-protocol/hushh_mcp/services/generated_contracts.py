"""Resolve generated contract artifacts both in a checkout and inside the image.

``deploy/backend.cloudbuild.yaml`` builds the backend with Docker build context
``consent-protocol`` (``docker buildx build --file consent-protocol/Dockerfile
... consent-protocol``), and ``consent-protocol/Dockerfile`` is ``WORKDIR /app``
plus ``COPY . .``. So in the running container ``/app`` *is* ``consent-protocol/``
and nothing above it exists — the repo root is simply not part of the image.

The loaders used to resolve ``Path(__file__).resolve().parents[3] / "contracts"``.
That is the repo root in a checkout and ``/`` in the image, so every deployed
backend read a path that could not exist and fell back to an empty gateway
*silently*. Voice actions were dead in UAT and production while localhost worked,
and the only symptom was One answering ``status=unknown_action`` for every id.

The generators therefore mirror each artifact into ``consent-protocol/contracts/``
— the same reason ``hushh-webapp/contracts/`` has always existed, since the
frontend image is built with context ``hushh-webapp``. That in-context copy is
what ships. The repo-root copy remains the canonical original and is kept here as
a fallback so a checkout that regenerated only the root still resolves.

THIS IS THE ONLY CONTRACTS RESOLVER. A second one (``hushh_mcp/contracts_root.py``)
was developed in parallel on the pod branch and diagnosed the identical bug; the two
were merged into this module on 2026-08-12 rather than left as competing lanes,
because two resolvers disagreeing about where a contract lives is the same class of
defect as the bug they both fix. What came across from that side:

  * ``HUSHH_CONTRACTS_DIR`` — an explicit override, searched first. A pod running in
    a user's own GCP project (BYOC) may mount the tree somewhere neither default
    describes, and it must be able to say so without a code change.
  * Loud degradation in every loader, not just the action gateway. All three fall
    back to an empty structure that reads exactly like a real answer, which is how
    this shipped to UAT and production unnoticed in the first place.

Belt and braces on packaging, deliberately: the mirror is COMMITTED (so any build
context has it, and CI can assert it matches canonical) *and*
``deploy/backend.cloudbuild.yaml`` re-stages it from the repo-root original before
each image build (so a stale mirror cannot reach an image). Each catches a failure
the other does not.
"""

from __future__ import annotations

import os
from pathlib import Path

# ``consent-protocol/`` in a checkout, ``/app`` in the image. Both are the
# directory the backend image is built from, which is the whole point.
BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent

CONTRACTS_DIR_ENV = "HUSHH_CONTRACTS_DIR"


def contracts_root_override() -> Path | None:
    """The ``HUSHH_CONTRACTS_DIR`` tree, or None when it is unset or blank."""
    raw = (os.getenv(CONTRACTS_DIR_ENV) or "").strip()
    return Path(raw) if raw else None


def generated_contract_path(*parts: str) -> Path:
    """Return the readable path for ``contracts/<parts>``.

    Order: ``HUSHH_CONTRACTS_DIR``, then the in-context copy, then the repo-root
    original. Falls back to the in-context path when none exists, so callers keep a
    stable, log-worthy path to report rather than ``None`` -- an absence has to be
    reportable, and a caller cannot name a path it was never given.

    Read per call rather than cached at import: the override is environment state,
    and a module constant would freeze whichever layout happened to be current when
    the module was first imported. That off-by-one on import time is the same shape
    as the ``parents[3]`` bug this module exists to fix.
    """
    relative = Path("contracts", *parts)
    override = contracts_root_override()
    candidates = [BACKEND_ROOT / relative, REPO_ROOT / relative]
    if override is not None:
        candidates.insert(0, override / Path(*parts))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return BACKEND_ROOT / relative
