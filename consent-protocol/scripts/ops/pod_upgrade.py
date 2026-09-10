#!/usr/bin/env python3
"""Move running pods onto the hub's current image, one person or the whole fleet.

The operator's hand on the same path the reconcile worker sweeps automatically
(``PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED``). Use it when a fix has to reach a pod
NOW rather than on the next bounded pass, or from a hub that runs the sweep dark.

Runs INSIDE a hub environment: it needs the hub's registry (``DB_*``), the pod
image the hub ships (``HUSSH_ONE_POD_IMAGE``) and, for user-owned pods, the
consent-plane identity that may write into the person's registry. From a local
hybrid stack that is the worktree's ``.env`` plus the impersonated ADC file.

    uv run python scripts/ops/pod_upgrade.py --list
    uv run python scripts/ops/pod_upgrade.py --user-id <firebase uid>
    uv run python scripts/ops/pod_upgrade.py --all --limit 3
    uv run python scripts/ops/pod_upgrade.py --all --image gcr.io/.../consent-protocol-pod:dev-<sha>

``--image`` overrides the hub's own tag: it is how a pod is ROLLED BACK to a known
digest (the tag is resolved fresh, so name a tag that still exists).

Exit codes: 0 every requested pod ended on the target image (or was already there),
2 at least one upgrade failed OR was refused by the rollback guard (a pod that
reports memory tombstones never moves onto an image that predates them without
the exact ``--acknowledge-tombstone-rollback`` sentence), 3 nothing matched.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    try:
        from dotenv import load_dotenv  # type: ignore[import-not-found]
    except ImportError:
        return
    load_dotenv(env, override=False)


def _short(image: str | None) -> str:
    return (image or "-").rsplit("/", 1)[-1]


# -- the rollback guard -------------------------------------------------------------
#
# Memory schema 2 (this commit) made a revocation a log record that hydration
# applies in order. An image built BEFORE it replays the same log and knows none
# of the new kinds: it skips them, so every revoked or superseded fact comes back
# as if the owner had never removed it. Rolling a pod that holds tombstones onto
# such an image is therefore not a rollback, it is an un-revocation, and the
# operator must say so in words before it happens. The count is read from the
# POD (its memory status), never from the registry row: only the running pod
# knows what its own log holds.

# The first commit whose image applies tombstones on hydration.
MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT = "da1dfc5943bf9a26d5aeea89da645056548366b7"
ROLLBACK_ACKNOWLEDGEMENT = (
    "I understand this image predates memory tombstones and revoked facts may return"
)
EXIT_REFUSED = 2


def _image_sha(image: str) -> str | None:
    """The commit a pod image tag names (``…:dev-<sha>`` or ``…:<sha>``), if any."""
    tag = str(image or "").rsplit(":", 1)[-1].strip()
    if "-" in tag:
        tag = tag.rsplit("-", 1)[-1]
    return tag if len(tag) >= 7 and all(c in "0123456789abcdef" for c in tag.lower()) else None


def image_predates_tombstones(
    target_image: str,
    *,
    min_commit: str | None = None,
    repo_root: Path | None = None,
) -> bool | None:
    """True when ``target_image`` names a commit that is NOT a descendant of ``min_commit``.

    ``None`` when the tag carries no commit or git cannot answer: the caller
    treats unknown as predating, because an image nobody can place in history
    is not one to trust with an owner's revocations.
    """
    import subprocess  # noqa: PLC0415

    sha = _image_sha(target_image)
    if sha is None:
        return None
    try:
        probe = subprocess.run(  # noqa: S603 - fixed argv, validated hex sha
            [
                "git",
                "merge-base",
                "--is-ancestor",
                min_commit if min_commit is not None else MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT,
                sha,
            ],
            cwd=repo_root if repo_root is not None else ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if probe.returncode == 0:
        return False
    if probe.returncode == 1:
        return True
    return None


async def pod_tombstone_count(row: dict, *, reader: object | None = None) -> int | None:
    """How many tombstones the POD reports, via its own memory status. None when unknown."""
    read = reader
    if read is None:
        read = _read_pod_memory_status
    try:
        status = await read(row)  # type: ignore[operator]
    except Exception as exc:  # noqa: BLE001 - unknown is reported, never guessed at
        print(f"  tombstone count unavailable for {row.get('hushh_id')}: {type(exc).__name__}")
        return None
    if not isinstance(status, dict):
        return None
    value = status.get("tombstones")
    return int(value) if isinstance(value, int) else None


async def _read_pod_memory_status(row: dict) -> dict:
    """GET the pod's ``/api/one/pod/memory/status`` as the hub, with the owner's grant."""
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    from hushh_mcp.services.operator_identity import mint_operator_id_token  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
        PersonalAgentGrantService,
    )

    metadata = row.get("backend_metadata") or {}
    url = str(metadata.get("url") or "").rstrip("/")
    if not url.startswith("https://"):
        raise RuntimeError("pod url unavailable")
    grant = await PersonalAgentGrantService().issue_or_reuse_standing_pkm_read(
        str(row.get("user_id") or "")
    )
    response = requests.get(
        f"{url}/api/one/pod/memory/status",
        headers={
            "Authorization": f"Bearer {mint_operator_id_token(url)}",
            "X-Consent-Token": str(grant.get("token") or ""),
        },
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise RuntimeError(f"memory status HTTP {response.status_code}")
    return dict(response.json() or {})


def rollback_refusal(
    *, tombstones: int | None, predates: bool | None, acknowledgement: str | None
) -> str | None:
    """The sentence that refuses this upgrade, or None when it may proceed.

    Refuses when the pod reports tombstones (or the count is unknown) and the
    target predates the tombstone-aware commit (or cannot be placed), unless the
    operator typed the exact acknowledgement.
    """
    if predates is False:
        return None
    if tombstones == 0:
        return None
    if acknowledgement == ROLLBACK_ACKNOWLEDGEMENT:
        return None
    held = "an unknown number of" if tombstones is None else str(tombstones)
    placement = "cannot be placed relative to" if predates is None else "predates"
    return (
        f"refused: the pod reports {held} memory tombstone(s) and the target image "
        f"{placement} the tombstone-aware commit {MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT[:12]}; "
        "moving it would resurrect revoked facts. Re-run with "
        f'--acknowledge-tombstone-rollback "{ROLLBACK_ACKNOWLEDGEMENT}" to override.'
    )


async def _main(args: argparse.Namespace) -> int:
    from hushh_mcp.services.compute_backend import resolve_compute_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
        running_image,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    target = str(args.image or os.environ.get("HUSSH_ONE_POD_IMAGE") or "").strip()
    if not target:
        print("no target image: set HUSSH_ONE_POD_IMAGE or pass --image", file=sys.stderr)
        return 3

    registry = PersonalAgentRegistryRepo()
    service = PersonalAgentProvisioningService(registry=registry, backend=resolve_compute_backend())

    if args.user_id:
        row = await registry.get(args.user_id)
        rows = [row] if row else []
    else:
        rows = await service.list_upgrade_candidates(current_image=target, limit=args.limit)

    if not rows:
        print(f"nothing to upgrade against {_short(target)}")
        return 3

    print(f"target image: {target}")
    for row in rows:
        print(
            f"  {str(row.get('hushh_id') or '-')[:40]:40}  status={row.get('status') or '-':12}  "
            f"built_from={_short(running_image(row))}"
        )
    if args.list or args.dry_run:
        return 0

    # The rollback guard runs ONCE per target, before any pod moves: if the target
    # predates the tombstone-aware commit, every pod holding tombstones is refused
    # unless the operator typed the acknowledgement. The sweep never needs this:
    # it only moves forward onto the hub's current image.
    predates = image_predates_tombstones(target)
    acknowledgement = getattr(args, "acknowledge_tombstone_rollback", None)

    failed = 0
    for row in rows[: args.limit]:
        user_id = str(row.get("user_id") or "")
        if predates is not False:
            tombstones = await pod_tombstone_count(row)
            refusal = rollback_refusal(
                tombstones=tombstones, predates=predates, acknowledgement=acknowledgement
            )
            if refusal:
                failed += 1
                print(f"REFUSED {row.get('hushh_id')}: {refusal}")
                continue
        try:
            result = await service.upgrade_pod(user_id=user_id, current_image=target)
        except Exception as exc:  # noqa: BLE001 - reported per pod, never aborts the batch
            failed += 1
            print(f"FAILED  {row.get('hushh_id')}: {type(exc).__name__}: {str(exc)[:200]}")
            continue
        verb = "upgraded" if result.get("upgraded") else "already current"
        print(
            f"{verb:16} {result.get('hushhId')}  {_short(result.get('previousImage'))} -> {_short(result.get('image'))}"
        )
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
    return 2 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--user-id", help="one person's Firebase uid")
    who.add_argument("--all", action="store_true", help="every stale provisioned pod")
    who.add_argument("--list", action="store_true", help="show stale pods and exit")
    ap.add_argument("--image", help="target image (default: the hub's HUSSH_ONE_POD_IMAGE)")
    ap.add_argument("--limit", type=int, default=3, help="max pods to move in this run")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--acknowledge-tombstone-rollback",
        metavar="SENTENCE",
        help=(
            "required, verbatim, to move a pod that reports memory tombstones onto an "
            f"image that predates them: {ROLLBACK_ACKNOWLEDGEMENT!r}"
        ),
    )
    args = ap.parse_args()
    _load_env()
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
