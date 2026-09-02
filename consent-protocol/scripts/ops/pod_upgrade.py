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
2 at least one upgrade failed, 3 nothing matched.
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

    failed = 0
    for row in rows[: args.limit]:
        user_id = str(row.get("user_id") or "")
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
    args = ap.parse_args()
    _load_env()
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
