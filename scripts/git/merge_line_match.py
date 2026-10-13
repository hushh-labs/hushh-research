"""Literal, batched implementation of the merge guard's existing line heuristic."""

import sys
from pathlib import Path


def signals(base: str, upstream: str, target: str, diff: str, minimum: int):
    additions, deletions = [], []
    sources = {"+": upstream.splitlines(), "-": base.splitlines()}
    for line in diff.splitlines():
        if not line.startswith(("+", "-")) or line.startswith(("+++", "---")):
            continue
        sign, content = line[0], line[1:].lstrip()
        if len(content) < minimum or content.startswith(("//", "*", "#")):
            continue
        if sum(content in source for source in sources[sign]) != 1:
            continue
        (additions if sign == "+" else deletions).append(content)
    target_lines = target.splitlines()
    missing = [line for line in additions if not any(line in source for source in target_lines)]
    restored = [line for line in deletions if any(line in source for source in target_lines)]
    return len(additions), len(deletions), missing, restored


if __name__ == "__main__":
    directory, minimum = Path(sys.argv[1]), int(sys.argv[2])
    values = [directory.joinpath(name).read_text() for name in ("base", "upstream", "target", "diff")]
    added, deleted, missing, restored = signals(*values, minimum)
    print(f"added\t{added}\ndeleted\t{deleted}")
    for line in missing:
        print(f"missing\t{line}")
    for line in restored:
        print(f"restored\t{line}")
