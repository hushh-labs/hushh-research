"""Static shell-upload dependencies shared by current and older-release fixtures."""

import re
from pathlib import Path


def cloudbuild_sourced_shell_helpers(root: Path, build: dict) -> set[str]:
    referenced: set[str] = set()
    sources: list[tuple[Path, str]] = []
    for step in build["steps"]:
        for argument in step.get("args", []):
            if re.fullmatch(r"(?:deploy|scripts/deploy)/[A-Za-z0-9_./-]+\.sh", argument):
                referenced.add(argument)
                sources.append((Path(argument), (root / argument).read_text()))
            else:
                sources.append((Path("."), argument))
    while sources:
        parent, source = sources.pop()
        helpers = re.findall(
            r"(?m)^\s*source\s+((?:deploy|scripts/deploy)/[A-Za-z0-9_./-]+\.sh)\b",
            source,
        )
        helpers.extend(
            (parent.parent / name).as_posix()
            for name in re.findall(r'\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/([\w.-]+\.sh)', source)
        )
        for helper in helpers:
            if helper not in referenced:
                referenced.add(helper)
                sources.append((Path(helper), (root / helper).read_text()))
    return referenced
