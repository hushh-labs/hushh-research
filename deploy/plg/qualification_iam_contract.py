"""Pure allow-policy interpretation; no cloud reads or effective-access claims."""

from __future__ import annotations

import re

from qualification_target import QualificationError, require

PUBLIC = frozenset({"allUsers", "allAuthenticatedUsers"})


def _bindings(policy):
    require(
        isinstance(policy, dict) and policy.get("version", 1) in (1, 3),
        "iam_policy_invalid",
    )
    rows = policy.get("bindings", [])
    require(isinstance(rows, list) and len(rows) <= 10000, "iam_policy_invalid")
    for row in rows:
        require(
            isinstance(row, dict)
            and isinstance(row.get("role"), str)
            and isinstance(row.get("members"), list)
            and all(isinstance(x, str) for x in row["members"]),
            "iam_binding_invalid",
        )
        # A version-one projection must not conceal a condition in a decorated role.
        require("_withcond_" not in row["role"], "iam_condition_projection_invalid")
        yield row


def _public_permissions(cloud, row, cache):
    require("condition" not in row, "iam_public_condition_unresolved")
    name = row["role"]
    require(
        re.fullmatch(r"roles/[A-Za-z0-9_.]+", name), "iam_public_custom_role_unresolved"
    )
    if name not in cache:
        role = cloud.role(name)
        perms = role.get("includedPermissions")
        require(
            role.get("name") == name
            and isinstance(perms, list)
            and all(isinstance(p, str) for p in perms),
            "iam_public_role_unresolved",
        )
        cache[name] = set(perms)
    return cache[name]


def _external_workload_identity(member: str) -> bool:
    """Recognize only documented external workload-pool principal formats.

    These are distinct principals from the Google runtime service account. This
    does not establish group membership, effective permissions, or whether an
    external principal can impersonate any service account.
    """
    if len(member) > 2048:
        return False
    prefix = r"iam\.googleapis\.com/projects/[1-9][0-9]*/locations/global/workloadIdentityPools/[a-z0-9][a-z0-9-]{0,62}/"
    value = r"[^\s?#]+"
    return bool(
        re.fullmatch(r"principal://" + prefix + "subject/" + value, member)
        or re.fullmatch(
            r"principalSet://"
            + prefix
            + r"(?:\*|group/"
            + value
            + r"|attribute\.[a-zA-Z0-9_]+/"
            + value
            + r")",
            member,
        )
    )


def _agent_project_set(member: str) -> bool:
    """Recognize Google's documented project-scoped Agent Identity set only."""
    return bool(
        re.fullmatch(
            r"principalSet://agents\.global\.org-[1-9][0-9]*\.system\.id\.goog/"
            r"attribute\.platformContainer/aiplatform/projects/[1-9][0-9]*",
            member,
        )
    )


def _check_public(cloud, policy, cache, forbidden):
    for row in _bindings(policy):
        members = set(row["members"])
        # Unknown principal sets can include public or runtime identities.
        # Valid external workload identities are distinct from the runtime SA.
        require(
            not any(
                member.startswith(("principalSet:", "principal:"))
                and not (
                    _external_workload_identity(member) or _agent_project_set(member)
                )
                for member in members
            ),
            "iam_principal_set_unresolved",
        )
        if members & PUBLIC:
            require(
                not (_public_permissions(cloud, row, cache) & forbidden),
                "iam_public_binding_forbidden",
            )


def _refusal(error: Exception) -> str:
    if isinstance(error, (QualificationError, ValueError)) and error.args:
        code = error.args[0]
        if isinstance(code, str) and re.fullmatch(
            r"(?:iam|qualification_iam)_[a-z0-9_]{1,96}", code
        ):
            return code
    return "qualification_iam_evidence_unavailable"
