#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind UI review inheritance to the merge tree GitHub actually checked out."""
import json
import os
from pathlib import Path
import re
import subprocess


def git(*args):
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()


def resolve():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if os.environ["GITHUB_EVENT_NAME"] == "pull_request":
        # Event base.sha can lag the synthetic merge's first parent. Only use
        # the tested parent after proving this is the expected PR head's merge.
        head = event["pull_request"]["head"]["sha"]
        parents = git("show", "-s", "--format=%P", "HEAD").split()
        if (not re.fullmatch(r"[0-9a-f]{40}", head) or len(parents) != 2
                or parents[1] != head or git("rev-parse", "HEAD") != os.environ["GITHUB_SHA"]):
            raise ValueError("UI review base requires the exact checked-out PR merge")
        base = parents[0]
    else:
        base = event.get("merge_group", {}).get("base_sha", "")
        if os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch" and not base:
            return ""  # Preserve manual validation's requirement for its own receipts.
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("Missing valid UI review base")
    subprocess.run(["git", "merge-base", "--is-ancestor", base, "HEAD"], check=True)
    return base


if __name__ == "__main__":
    print(resolve())
