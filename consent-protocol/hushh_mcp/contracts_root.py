"""Where the generated `contracts/` tree lives, in a repo checkout AND in an image.

WHY THIS EXISTS. Three loaders -- the Kai action gateway, the route-orchestration
index, and One's persona/agent registry -- resolved
``Path(__file__).resolve().parents[3] / "contracts"``. In a repo checkout that is
the repo root and it is correct. Inside the built image it is not:

    repo checkout   consent-protocol/hushh_mcp/services/x.py -> parents[3] = <repo root>   OK
    image           /app/hushh_mcp/services/x.py             -> parents[3] = /             WRONG

Both images build with context ``consent-protocol/`` (`deploy/backend.cloudbuild.yaml`)
and ``COPY . .`` into ``/app``, so repo-root ``contracts/`` was never in the image at
all. Every one of those three loaders degrades SILENTLY on a missing file --
``load_action_gateway()`` returns ``{"actions": []}``, the route index returns ``{}``,
the persona catalogue returns ``""`` -- so nothing raised, nothing logged, and the
hub has been running with an empty action gateway, an empty delegate-admission index,
and no persona grounding. `agent_tree.py` builds that grounding at MODULE level, so it
is baked in at import.

That is the exact failure mode this repo argues against elsewhere: a surface that
reports success while carrying nothing.

RESOLUTION ORDER. First match wins:

  1. ``HUSHH_CONTRACTS_DIR`` -- explicit override, for a deployment that mounts the
     tree somewhere else entirely.
  2. **repo root** -- a checkout, and the local-dev path.
  3. **package root** -- inside the image, where ``/app`` is the package root and the
     build stages the tree to ``/app/contracts``.

Both are derived from THIS file's location, which sits at
``consent-protocol/hushh_mcp/contracts_root.py`` -- one level shallower than the
loaders it replaced, so the indices differ from the ones they used. That off-by-one
is exactly the class of mistake the old code made, so the candidates are named
rather than written as bare subscripts.

Returning None rather than raising is deliberate: a missing contracts tree must not
stop the process from importing. But callers should now say so out loud instead of
returning an empty structure that reads like a real answer -- see
``require_contracts_root``.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

CONTRACTS_DIR_ENV = "HUSHH_CONTRACTS_DIR"

# A file we know the real tree contains, so a stray empty `contracts/` directory is
# not mistaken for the generated tree.
_SENTINEL = Path("agents") / "product-agent-registry.v2.json"


def _candidates() -> list[Path]:
    override = (os.getenv(CONTRACTS_DIR_ENV) or "").strip()
    found: list[Path] = []
    if override:
        found.append(Path(override))
    here = Path(__file__).resolve()
    package_root = here.parents[1]  # consent-protocol/ in a checkout, /app in the image
    repo_root = here.parents[2]  # the repo root in a checkout; meaningless in the image
    found.append(repo_root / "contracts")
    found.append(package_root / "contracts")
    return found


@lru_cache(maxsize=1)
def contracts_root() -> Optional[Path]:
    """The generated contracts tree, or None when it is genuinely absent."""
    for candidate in _candidates():
        if (candidate / _SENTINEL).exists():
            return candidate
    return None


def contracts_path(*parts: str) -> Optional[Path]:
    """Resolve one file under the contracts tree, or None if the tree is missing."""
    root = contracts_root()
    return None if root is None else root.joinpath(*parts)


def require_contracts_root(consumer: str) -> Optional[Path]:
    """Same as :func:`contracts_root`, but LOUD about an absence.

    Callers keep their fail-soft behaviour -- an import must not die because a
    generated artifact is missing -- but the log line names the consumer, so a
    degraded runtime is diagnosable at the moment it degrades instead of surfacing
    later as an agent that mysteriously knows nothing.
    """
    root = contracts_root()
    if root is None:
        logger.warning(
            "contracts.tree_missing consumer=%s searched=%s -- this consumer is "
            "running with EMPTY contract data; set %s or ship contracts/ in the image",
            consumer,
            [str(path) for path in _candidates()],
            CONTRACTS_DIR_ENV,
        )
    return root
