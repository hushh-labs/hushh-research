"""The dashboard's one owner, read only from the eval's existing founder configuration.

``run-batch`` takes its owner from ``DRIVE_PACKET_EVAL_OWNER``; the founder's
private ``live-env.sh`` sets that variable from the incident evidence file's
``identities.owner.user_id``. The dashboard reads the same line the same way and
nothing else: there is no owner flag, picker or list, no lookup by name, and no
identity query. If the variable is also set in the environment it must be the
same id, otherwise the dashboard refuses to start.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_LIVE_ENV = Path("/Volumes/AnkitSSD/DevCache/p0-20261015/drive-eval-scratch/live-env.sh")
DEFAULT_EVAL_WORKDIR = Path(
    "/Volumes/AnkitSSD/DevCache/drive-packets-real-eval-20261014-private/batch-20261015"
)
DEFAULT_STATE_DIR = Path(
    "/Volumes/AnkitSSD/DevCache/drive-packets-real-eval-20261014-private/dashboard"
)
OWNER_ENV = "DRIVE_PACKET_EVAL_OWNER"
DISPLAY_NAME = "Manish"
OWNER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$")

_OWNER_LINE = re.compile(r"^\s*export\s+" + OWNER_ENV + r"=(?P<value>.*?)\s*$")
_WORKDIR_LINE = re.compile(r"^\s*export\s+W=(?P<value>/\S+?)\s*$")
# The one expression live-env.sh uses: the evidence file's owner identity.
_EVIDENCE = re.compile(
    r"""json\.load\(open\(["'](?P<path>/[^"']+\.json)["']\)\)"""
    r"""\[["']identities["']\]\[["']owner["']\]\[["']user_id["']\]"""
)
_LITERAL = re.compile(r"""^(["']?)(?P<value>[A-Za-z0-9][A-Za-z0-9_-]{5,127})\1$""")


class OwnerConfigError(RuntimeError):
    """The founder configuration does not name exactly one owner; a fixed code."""


@dataclass(frozen=True)
class OwnerConfig:
    owner_id: str
    display_name: str
    eval_workdir: Path
    sources: tuple[str, ...]

    def __repr__(self) -> str:  # the id stays out of logs and tracebacks
        return f"OwnerConfig(display_name={self.display_name!r}, sources={self.sources!r})"


def _from_evidence(path: Path) -> str:
    try:
        identities = json.loads(path.read_text())["identities"]
        value = identities["owner"]["user_id"]
    except (OSError, ValueError, KeyError, TypeError):
        raise OwnerConfigError("owner_evidence_unreadable") from None
    if not isinstance(value, str):
        raise OwnerConfigError("owner_id_invalid")
    return value.strip()


def _from_live_env(path: Path) -> tuple[str | None, Path | None]:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        raise OwnerConfigError("owner_config_unreadable") from None
    owners = [match.group("value") for match in map(_OWNER_LINE.match, lines) if match]
    workdirs = [match.group("value") for match in map(_WORKDIR_LINE.match, lines) if match]
    workdir = Path(workdirs[-1]) if workdirs else None
    if not owners:
        return None, workdir
    if len(owners) > 1:
        raise OwnerConfigError("owner_config_ambiguous")
    value = owners[0]
    evidence = _EVIDENCE.findall(value)
    if len(evidence) == 1:
        return _from_evidence(Path(evidence[0])), workdir
    literal = _LITERAL.fullmatch(value)
    if literal and not evidence:
        return literal.group("value"), workdir
    raise OwnerConfigError("owner_config_unsupported")


def resolve_owner(
    *, live_env: Path = DEFAULT_LIVE_ENV, environ: Mapping[str, str] | None = None
) -> OwnerConfig:
    """Exactly one owner id from the founder configuration, or OwnerConfigError."""
    environ = os.environ if environ is None else environ
    if not live_env.is_file():
        raise OwnerConfigError("owner_config_missing")
    configured, workdir = _from_live_env(live_env)
    if not configured:
        raise OwnerConfigError("owner_not_configured")
    found = {configured: ["live-env"]}
    exported = (environ.get(OWNER_ENV) or "").strip()
    if exported:
        found.setdefault(exported, []).append("env")
    if len(found) != 1:
        raise OwnerConfigError("owner_config_conflict")
    if not OWNER_ID.fullmatch(configured):
        raise OwnerConfigError("owner_id_invalid")
    return OwnerConfig(
        owner_id=configured,
        display_name=DISPLAY_NAME,
        eval_workdir=workdir or DEFAULT_EVAL_WORKDIR,
        sources=tuple(found[configured]),
    )
