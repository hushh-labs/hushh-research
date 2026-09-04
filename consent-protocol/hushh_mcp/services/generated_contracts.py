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
"""

from __future__ import annotations

from pathlib import Path

# ``consent-protocol/`` in a checkout, ``/app`` in the image. Both are the
# directory the backend image is built from, which is the whole point.
BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent


def generated_contract_path(*parts: str) -> Path:
    """Return the readable path for ``contracts/<parts>``, in-context copy first.

    Falls back to the in-context path when neither exists so callers keep a
    stable, log-worthy path to report rather than ``None``.
    """
    relative = Path("contracts", *parts)
    candidates = (BACKEND_ROOT / relative, REPO_ROOT / relative)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]
