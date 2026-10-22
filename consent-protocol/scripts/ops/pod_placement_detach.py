#!/usr/bin/env python3
"""Detach one person's active agent placement, keeping the host and its data.

Dry run by default: prints what would be released and why it may or may not run.
Executing needs ``--execute``, ``--confirm-user`` repeating the user id, and a
stated ``--reason``. Nothing in the person's cloud is touched; resuming is that
cloud's existing adopt flow. See hushh_mcp/services/personal_agent_placement_detach.py.

    uv run python scripts/ops/pod_placement_detach.py --user-id <uid>
    uv run python scripts/ops/pod_placement_detach.py --user-id <uid> \\
        --execute --confirm-user <uid> --reason "moving to Azure"

Database settings come from the environment (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD),
never from arguments, so nothing secret lands in shell history.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hushh_mcp.services.personal_agent_placement_detach import (  # noqa: E402
    detach_placement,
    plan_as_json,
    plan_detach,
)
from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: E402
    PersonalAgentRegistryRepo,
)


def _parse() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-user", default="")
    parser.add_argument("--reason", default="")
    return parser.parse_args()


async def _main(args: argparse.Namespace) -> int:
    row = await PersonalAgentRegistryRepo().get(args.user_id)
    plan = plan_detach(row)
    if plan is None:
        print("no agent record for that user")
        return 2
    print(plan_as_json(plan))
    if plan.refusal:
        print(f"refused: {plan.refusal}")
        return 3
    if not args.execute:
        print("dry run: nothing changed (add --execute --confirm-user <uid> --reason ...)")
        return 0
    if args.confirm_user != args.user_id:
        print("refused: --confirm-user must repeat --user-id exactly")
        return 4
    result = await detach_placement(row=row, reason=args.reason)
    if result is None:
        print("fenced out: the row changed since it was read; nothing was changed")
        return 5
    print(json.dumps({"detached": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main(_parse())))
