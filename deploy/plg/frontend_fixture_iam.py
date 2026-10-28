"""Bounded allow-policy checks for the dedicated frontend workload identity.

Reuses the qualification metadata reader. This is not effective access or
cross-project/group/deny-policy analysis; runtime requests exercise the granted
native permissions separately. No policy or secret payload is written/read.
"""

from __future__ import annotations

import frontend_fixture_runtime as runtime
import frontend_secret_pins as pins
import frontend_release as release
import qualification_iam as iam
from qualification_iam_contract import PUBLIC, _bindings, _check_public
from qualification_target import Target


def verify(attempt, *, cloud=None):
    target = Target(attempt.environment)
    cloud = cloud or iam.ReadCloud(target)
    principal = runtime.iam_plan(attempt)["principal"]
    member = "serviceAccount:" + principal
    identity = cloud._read(
        "iam", f"v1/projects/{attempt.project}/serviceAccounts/{principal}"
    )
    release.require(
        identity.get("email") == principal and identity.get("disabled", False) is False,
        "Fixture runtime identity unavailable",
    )
    chain, cache, policies = _hierarchy(cloud, member)
    backend_policy, permissions = _backend_permissions(cloud, member, cache)
    secret_policies, found = {}, False
    inventory = cloud.secrets()
    for row in inventory:
        name = row["name"].rsplit("/", 1)[-1]
        policy = cloud.secret_policy(name)
        secret_policies[name] = policy
        _check_public(cloud, policy, cache, {iam.SECRET_ACCESS})
        direct = [entry for entry in _bindings(policy) if member in entry["members"]]
        if name == pins.FIXTURE_BACKEND:
            found = True
            release.require(
                row.get("labels") == target.labels
                and len(direct) == 1
                and direct[0]["role"] == "roles/secretmanager.secretAccessor"
                and "condition" not in direct[0],
                "Fixture backend secret permission missing",
            )
        else:
            release.require(not direct, "Fixture runtime unrelated secret access")
    release.require(
        found
        and cloud.ancestry() == chain
        and cloud.service_policy() == backend_policy,
        "Fixture backend IAM changed",
    )
    release.require(
        all(cloud.hierarchy_policy(key) == value for key, value in policies.items())
        and cloud.secrets() == inventory
        and all(
            cloud.secret_policy(name) == value
            for name, value in secret_policies.items()
        )
        and cloud._read(
            "iam", f"v1/projects/{attempt.project}/serviceAccounts/{principal}"
        )
        == identity,
        "Fixture runtime IAM changed",
    )
    return {
        "kind": "plg-fixture-allow-policy-check-v1",
        "principal": principal,
        "backendPermissions": sorted(permissions),
        "secretAccessor": [pins.FIXTURE_BACKEND],
        "policySnapshotSha256": runtime.digest(
            runtime.encode(
                {
                    "hierarchy": policies,
                    "backend": backend_policy,
                    "secrets": secret_policies,
                }
            )
        ),
        "effectiveAccessClaimed": False,
        "productionTrafficAuthorized": False,
    }


def _backend_permissions(cloud, member, cache):
    backend_policy = cloud.service_policy()
    _check_public(cloud, backend_policy, cache, {iam.INVOKE})
    permissions = set()
    for row in _bindings(backend_policy):
        if member not in row["members"]:
            continue
        release.require(
            "condition" not in row, "Fixture backend IAM condition unresolved"
        )
        role = cloud.role(row["role"])
        granted = role.get("includedPermissions")
        release.require(
            role.get("name") == row["role"] and isinstance(granted, list),
            "Fixture backend IAM role unresolved",
        )
        if row["role"] == "roles/run.invoker":
            # jobs.run in this predefined role does not apply to a Service.
            release.require(
                "run.routes.invoke" in granted
                and set(granted) <= {"run.routes.invoke", "run.jobs.run"},
                "Fixture invoker role changed",
            )
            permissions.add("run.routes.invoke")
        else:
            release.require(
                set(granted) == {"run.services.get", "run.revisions.get"},
                "Fixture read role not minimal",
            )
            permissions.update(granted)
    release.require(
        permissions == {"run.routes.invoke", "run.services.get", "run.revisions.get"},
        "Fixture backend permissions not minimal",
    )
    return backend_policy, permissions


def _hierarchy(cloud, member):
    chain = cloud.ancestry()
    cache, policies = {}, {}
    for resource in chain:
        policy = cloud.hierarchy_policy(resource)
        policies[resource] = policy
        _check_public(cloud, policy, cache, {iam.INVOKE, iam.SECRET_ACCESS})
        release.require(
            all(
                member not in row["members"] and not (set(row["members"]) & PUBLIC)
                for row in _bindings(policy)
            ),
            "Fixture runtime inherited authority unexpected",
        )
    return chain, cache, policies
