# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""CLI command classification, scrubbed worker environment, and credential gates (#9511)."""

from __future__ import annotations

import posixpath
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping

CLI_WORKER_BOUNDARY_REQUIRED = "CLI_WORKER_BOUNDARY_REQUIRED"
CLI_CREDENTIAL_APPROVAL_REQUIRED = "CLI_CREDENTIAL_APPROVAL_REQUIRED"
CLI_COMMAND_INVALID = "CLI_COMMAND_INVALID"

CliBoundaryMode = Literal["ephemeral_task_worker", "restricted_builtin_only"]
CommandCategory = Literal["builtin_file_op", "general_cli", "credentialed_cli"]

# Option B curated non-package inspection builtins permitted when Option A worker is absent.
_SAFE_BUILTIN_BINARIES = frozenset({"ls", "cat", "head", "tail", "wc", "stat", "pwd", "diff"})
_CREDENTIALED_BINARIES = frozenset({"gh", "gcloud", "az", "aws", "kubectl", "docker"})
_CREDENTIALED_GIT_SUBCOMMANDS = frozenset({"push", "fetch", "pull", "clone", "ls-remote"})
_SHELL_INTERPRETERS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})

METADATA_NO_PROXY = (
    "169.254.169.254,metadata.google.internal,metadata.goog,169.254.170.2,localhost,127.0.0.1"
)
SAFE_WORKER_PATH = "/usr/local/bin:/usr/bin:/bin"


@dataclass(frozen=True)
class CommandAdmissionDecision:
    admitted: bool
    category: CommandCategory
    code: str | None = None
    reason: str | None = None


def build_scrubbed_worker_env(
    *,
    workspace_dir: Path,
    scratch_tmp_dir: Path,
    extra_public_env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Construct a secret-free environment (`env={}` base) for CLI execution (#9511)."""
    env: dict[str, str] = {
        "PATH": SAFE_WORKER_PATH,
        "HOME": str(workspace_dir),
        "TMPDIR": str(scratch_tmp_dir),
        "TEMP": str(scratch_tmp_dir),
        "TMP": str(scratch_tmp_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "NO_PROXY": METADATA_NO_PROXY,
        "no_proxy": METADATA_NO_PROXY,
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "NPM_CONFIG_FUND": "false",
        "NPM_CONFIG_AUDIT": "false",
    }
    for key, val in (extra_public_env or {}).items():
        clean_key = str(key or "").strip()
        upper = clean_key.upper()
        if (
            not clean_key
            or not clean_key.isidentifier()
            or upper.startswith(
                (
                    "HUSSH_",
                    "POD_",
                    "GOOGLE_",
                    "AWS_",
                    "AZURE_",
                    "APP_",
                    "SECRET",
                    "VAULT",
                    "OPENAI_",
                    "ANTHROPIC_",
                )
            )
            or any(tok in upper for tok in ("TOKEN", "SECRET", "PASSWORD", "KEY", "CREDENTIAL"))
        ):
            continue
        env[clean_key] = str(val)
    return env


def classify_cli_command(
    argv: list[str] | tuple[str, ...],
    *,
    boundary_mode: CliBoundaryMode,
    credential_approval_verified: bool = False,
) -> CommandAdmissionDecision:
    """Enforce Option A vs Option B CLI boundary and protected credential reference rules."""
    if not argv or not all(isinstance(part, str) and "\x00" not in part for part in argv):
        return CommandAdmissionDecision(
            admitted=False,
            category="general_cli",
            code=CLI_COMMAND_INVALID,
            reason="Command argv must be a non-empty list of NUL-free strings.",
        )

    first = argv[0].strip()
    if not first:
        return CommandAdmissionDecision(
            admitted=False,
            category="general_cli",
            code=CLI_COMMAND_INVALID,
            reason="Executable name cannot be empty.",
        )
    exe = posixpath.basename(first).lower()

    # 1. Credentialed cloud / GitHub / remote git operations require explicit approval
    is_cred_git = exe == "git" and any(
        arg.strip().lower() in _CREDENTIALED_GIT_SUBCOMMANDS for arg in argv[1:]
    )
    if exe in _CREDENTIALED_BINARIES or is_cred_git:
        if boundary_mode != "ephemeral_task_worker":
            return CommandAdmissionDecision(
                admitted=False,
                category="credentialed_cli",
                code=CLI_WORKER_BOUNDARY_REQUIRED,
                reason=(
                    f"Command '{exe}' requires an isolated Option A task worker; "
                    "shared_owner_container refuses credentialed CLI execution."
                ),
            )
        if not credential_approval_verified:
            return CommandAdmissionDecision(
                admitted=False,
                category="credentialed_cli",
                code=CLI_CREDENTIAL_APPROVAL_REQUIRED,
                reason=(
                    f"Command '{exe}' requires an explicit owner action-ledger approval "
                    "and unlocked vault session before brokered credential mediation."
                ),
            )
        return CommandAdmissionDecision(admitted=True, category="credentialed_cli")

    # 2. Curated Option B non-package file inspection operations (no shell, no absolute escape)
    is_safe_builtin = (
        exe in _SAFE_BUILTIN_BINARIES
        and exe not in _SHELL_INTERPRETERS
        and not any(
            part.startswith("/") or ".." in part.split("/")
            for part in argv[1:]
            if not part.startswith("-")
        )
    )
    if is_safe_builtin:
        return CommandAdmissionDecision(admitted=True, category="builtin_file_op")

    # 3. Arbitrary CLI, shell pipelines, compilers, and package managers (`npm`, `pip`, `uv`, etc.)
    if boundary_mode != "ephemeral_task_worker":
        return CommandAdmissionDecision(
            admitted=False,
            category="general_cli",
            code=CLI_WORKER_BOUNDARY_REQUIRED,
            reason=(
                f"Command '{exe}' requires Option A ephemeral_task_worker isolation; "
                "refused fail-closed inside shared_owner_container."
            ),
        )

    return CommandAdmissionDecision(admitted=True, category="general_cli")
