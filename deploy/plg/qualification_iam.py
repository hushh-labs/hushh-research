"""Read bounded allow-binding evidence for the fixed private PLG candidate.

This is not effective-access, group-membership, deny/PAB, or cross-project
evidence. Runtime startup and health must independently exercise its identity.
There are no cloud mutations and no secret payload reads in this module.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from qualification_resources import Cloud
from qualification_iam_contract import PUBLIC, _bindings, _check_public, _refusal
from qualification_target import (
    PREFIX,
    RUNTIME_SECRETS,
    SERVICE,
    QualificationError,
    Target,
    require,
)

MAX_RESPONSE = 1024 * 1024
MAX_SECRETS = 1000
MAX_PAGES = 25
SECRET_ACCESS = "secretmanager.versions.access"
INVOKE = "run.routes.invoke"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class ReadCloud:
    """Use the existing current-identity token; expose only fixed metadata reads."""

    def __init__(self, target: Target):
        base = Cloud(target)
        self.target, self.project_number = target, base.project_number
        self._token = base._token
        self._opener = build_opener(_NoRedirect())
        self._deadline = time.monotonic() + 180

    def __repr__(self):
        return f"<PLG allow-binding metadata reader project={self.target.project}>"

    def _read(
        self,
        api: str,
        path: str,
        *,
        policy_body=False,
        attachment_permission=False,
        query=None,
        missing_service=False,
    ):
        require(
            api in {"cloudresourcemanager", "iam", "secretmanager", "run"},
            "iam_api_invalid",
        )
        require(
            isinstance(path, str)
            and ".." not in path
            and "?" not in path
            and ":access" not in path,
            "iam_path_invalid",
        )
        if policy_body:
            require(
                api == "cloudresourcemanager" and path.endswith(":getIamPolicy"),
                "iam_method_invalid",
            )
        if attachment_permission:
            require(
                api == "iam"
                and not policy_body
                and not query
                and path
                == f"v1/projects/{self.target.project}/serviceAccounts/{self.target.runtime_sa}:testIamPermissions",
                "iam_attachment_permission_path_invalid",
            )
        if missing_service:
            require(
                api == "run"
                and not policy_body
                and not query
                and path
                == f"v2/projects/{self.target.project}/locations/us-central1/services/{SERVICE}",
                "iam_missing_service_path_invalid",
            )
        params = "?" + urlencode(query) if query else ""
        request = Request(
            f"https://{api}.googleapis.com/{path}{params}",
            data=(
                json.dumps({"permissions": ["iam.serviceAccounts.actAs"]}).encode()
                if attachment_permission
                else json.dumps({"options": {"requestedPolicyVersion": 3}}).encode()
                if policy_body
                else None
            ),
            method="POST" if policy_body or attachment_permission else "GET",
            headers={
                "Authorization": "Bearer " + self._token,
                "Content-Type": "application/json",
                "x-goog-user-project": self.target.project,
            },
        )
        try:
            remaining = self._deadline - time.monotonic()
            require(remaining > 0, "iam_collection_deadline_exceeded")
            with self._opener.open(request, timeout=min(20, remaining)) as response:
                raw = response.read(MAX_RESPONSE + 1)
            require(len(raw) <= MAX_RESPONSE, "iam_response_too_large")
            value = json.loads(raw)
        except HTTPError as error:
            code = error.code
            error.close()
            if missing_service and code == 404:
                return None
            raise ValueError(f"qualification_iam_{api}_http_{code}") from None
        except QualificationError:
            raise
        except (TimeoutError, URLError) as error:
            timed_out = isinstance(error, TimeoutError) or isinstance(
                getattr(error, "reason", None), TimeoutError
            )
            if time.monotonic() >= self._deadline:
                raise QualificationError("iam_collection_deadline_exceeded") from None
            if timed_out:
                raise QualificationError("iam_metadata_request_timeout") from None
            raise ValueError("qualification_iam_metadata_read_unavailable") from None
        except Exception:
            raise ValueError("qualification_iam_metadata_read_unavailable") from None
        require(isinstance(value, dict), "iam_response_invalid")
        return value

    def ancestry(self):
        project = self._read(
            "cloudresourcemanager", f"v3/projects/{self.target.project}"
        )
        require(
            project.get("projectId") == self.target.project
            and project.get("name") == f"projects/{self.project_number}",
            "iam_project_identity_invalid",
        )
        chain = [f"projects/{self.project_number}"]
        parent = project.get("parent")
        while parent:
            require(
                isinstance(parent, str)
                and re.fullmatch(r"(?:folders|organizations)/[1-9][0-9]*", parent)
                and parent not in chain
                and len(chain) < 12,
                "iam_ancestry_invalid",
            )
            entry = self._read("cloudresourcemanager", "v3/" + parent)
            require(entry.get("name") == parent, "iam_ancestor_identity_invalid")
            chain.append(parent)
            if parent.startswith("organizations/"):
                require(not entry.get("parent"), "iam_organization_parent_invalid")
                parent = None
            else:
                parent = entry.get("parent")
                require(bool(parent), "iam_folder_parent_missing")
        return chain

    def hierarchy_policy(self, name):
        require(
            re.fullmatch(r"(?:projects|folders|organizations)/[1-9][0-9]*", name),
            "iam_parent_invalid",
        )
        return self._read(
            "cloudresourcemanager", f"v3/{name}:getIamPolicy", policy_body=True
        )

    def service(self):
        return self._read(
            "run",
            f"v2/projects/{self.target.project}/locations/us-central1/services/{SERVICE}",
            missing_service=True,
        )

    def service_policy(self):
        return self._read(
            "run",
            f"v2/projects/{self.target.project}/locations/us-central1/services/{SERVICE}:getIamPolicy",
            query={"options.requestedPolicyVersion": "3"},
        )

    def identity(self):
        return self._read(
            "iam",
            f"v1/projects/{self.target.project}/serviceAccounts/{self.target.runtime_sa}",
        )

    def verify_runtime_attachment(self):
        """Check the hosted caller's effective actAs on only the fixed runtime SA."""
        result = self._read(
            "iam",
            f"v1/projects/{self.target.project}/serviceAccounts/{self.target.runtime_sa}:testIamPermissions",
            attachment_permission=True,
        )
        require(
            result.get("permissions") == ["iam.serviceAccounts.actAs"],
            "qualification_runtime_attachment_permission_missing",
        )

    def role(self, role):
        require(
            re.fullmatch(r"roles/[A-Za-z0-9_.]+", role)
            or re.fullmatch(
                r"projects/(?:"
                + re.escape(self.target.project)
                + "|"
                + re.escape(self.project_number)
                + r")/roles/[A-Za-z0-9_.]+",
                role,
            )
            or re.fullmatch(r"organizations/[1-9][0-9]*/roles/[A-Za-z0-9_.]+", role),
            "iam_role_scope_invalid",
        )
        return self._read("iam", "v1/" + role)

    def secrets(self):
        names, seen_tokens, token = [], set(), None
        for _ in range(MAX_PAGES):
            query = {"pageSize": "100"}
            if token:
                query["pageToken"] = token
            page = self._read(
                "secretmanager",
                f"v1/projects/{self.target.project}/secrets",
                query=query,
            )
            rows = page.get("secrets", [])
            require(isinstance(rows, list), "iam_secret_inventory_invalid")
            names.extend(rows)
            require(len(names) <= MAX_SECRETS, "iam_secret_inventory_too_large")
            token = page.get("nextPageToken")
            if not token:
                return names
            require(
                isinstance(token, str)
                and 0 < len(token) <= 2048
                and token not in seen_tokens,
                "iam_secret_pagination_invalid",
            )
            seen_tokens.add(token)
        raise ValueError("qualification_iam_secret_pagination_incomplete")

    def secret_policy(self, secret_id):
        require(
            re.fullmatch(r"[A-Za-z0-9_-]{1,255}", secret_id), "iam_secret_name_invalid"
        )
        return self._read(
            "secretmanager",
            f"v1/projects/{self.target.project}/secrets/{secret_id}:getIamPolicy",
            query={"options.requestedPolicyVersion": "3"},
        )

    def latest(self, secret_id):
        require(
            re.fullmatch(r"[A-Za-z0-9_-]{1,255}", secret_id), "iam_secret_name_invalid"
        )
        return self._read(
            "secretmanager",
            f"v1/projects/{self.target.project}/secrets/{secret_id}/versions/latest",
        )


def _identity_and_service(target, cloud, require_service):
    identity = cloud.identity()
    require(
        identity.get("email") == target.runtime_sa
        and identity.get("projectId") == target.project
        and identity.get("displayName") == "PLG isolated qualification runtime"
        and identity.get("disabled", False) is False,
        "iam_runtime_identity_invalid",
    )
    service = cloud.service()
    require(service is not None or not require_service, "iam_service_missing")
    if service is not None:
        require(
            isinstance(service, dict)
            and service.get("name")
            in {
                f"projects/{target.project}/locations/us-central1/services/{SERVICE}",
                f"projects/{cloud.project_number}/locations/us-central1/services/{SERVICE}",
            }
            and service.get("invokerIamDisabled", False) is False
            and isinstance(service.get("labels"), dict)
            and all(
                service["labels"].get(key) == value
                for key, value in target.labels.items()
            )
            and service.get("template", {}).get("serviceAccount") == target.runtime_sa,
            "iam_service_private_check_invalid",
        )

    return identity, service


def _hierarchy(target, cloud, service):
    member = "serviceAccount:" + target.runtime_sa
    chain = cloud.ancestry()
    require(
        isinstance(chain, list)
        and chain
        and chain[0] == f"projects/{cloud.project_number}"
        and len(chain) <= 12
        and len(set(chain)) == len(chain),
        "iam_ancestry_invalid",
    )
    cache, project_client = {}, False
    policies = [cloud.hierarchy_policy(resource) for resource in chain]
    for i, policy in enumerate(policies):
        _check_public(cloud, policy, cache, {INVOKE, SECRET_ACCESS})
        for row in _bindings(policy):
            # Both public principals include the runtime SA; any project-wide
            # grant is additional runtime authority, even when it cannot invoke.
            require(not (set(row["members"]) & PUBLIC), "iam_public_runtime_authority")
            if member in row["members"]:
                if not row["role"].startswith("roles/"):
                    role = cloud.role(row["role"])
                    require(
                        role.get("name") == row["role"]
                        and isinstance(role.get("includedPermissions"), list),
                        "iam_runtime_custom_role_unresolved",
                    )
                require(
                    i == 0
                    and row["role"] == "roles/cloudsql.client"
                    and "condition" not in row,
                    "iam_additional_runtime_binding",
                )
                project_client = True
    require(project_client, "iam_runtime_cloudsql_client_missing")
    service_policy = cloud.service_policy() if service is not None else None
    if service_policy is not None:
        _check_public(cloud, service_policy, cache, {INVOKE})

    return chain, policies, service_policy, cache


def _inventory(target, cloud, cache):
    member = "serviceAccount:" + target.runtime_sa
    expected = {PREFIX + name for name in RUNTIME_SECRETS}
    rows = cloud.secrets()
    require(
        isinstance(rows, list) and len(rows) <= MAX_SECRETS,
        "iam_secret_inventory_invalid",
    )
    seen, secret_policies = set(), {}
    for row in rows:
        require(
            isinstance(row, dict) and isinstance(row.get("name"), str),
            "iam_secret_inventory_invalid",
        )
        parts = row["name"].split("/")
        require(
            len(parts) == 4
            and parts[0] == "projects"
            and parts[1] in {target.project, cloud.project_number}
            and parts[2] == "secrets"
            and re.fullmatch(r"[A-Za-z0-9_-]{1,255}", parts[3])
            and parts[3] not in seen,
            "iam_secret_inventory_invalid",
        )
        name = parts[3]
        seen.add(name)
        policy = cloud.secret_policy(name)
        secret_policies[name] = policy
        direct = []
        for binding in _bindings(policy):
            if member in binding["members"]:
                direct.append(binding)
        if name in expected:
            require(
                row.get("labels") == target.labels
                and len(direct) == 1
                and direct[0]["role"] == "roles/secretmanager.secretAccessor"
                and "condition" not in direct[0],
                "iam_expected_secret_binding_invalid",
            )
        else:
            require(not direct, "iam_unexpected_secret_binding")
        _check_public(cloud, policy, cache, {SECRET_ACCESS})
    require(expected <= seen, "iam_runtime_secrets_missing")
    return rows, seen, secret_policies, expected


def _versions(target, cloud, expected):
    versions = {}
    for name in sorted(expected):
        version = cloud.latest(name)
        match = re.fullmatch(
            r"projects/([^/]+)/secrets/" + re.escape(name) + r"/versions/([1-9][0-9]*)",
            version.get("name", ""),
        )
        require(
            match is not None
            and match.group(1) in {target.project, cloud.project_number}
            and version.get("state") == "ENABLED",
            "iam_secret_version_invalid",
        )
        versions[name] = match.group(2)
    return versions


def _recheck(
    target,
    cloud,
    identity,
    service,
    chain,
    policies,
    service_policy,
    rows,
    seen,
    secret_policies,
    versions,
):
    require(
        cloud.ancestry() == chain
        and cloud.identity() == identity
        and cloud.service() == service
        and (service is None or cloud.service_policy() == service_policy),
        "iam_identity_or_service_changed",
    )
    require(
        [cloud.hierarchy_policy(resource) for resource in chain] == policies,
        "iam_ancestor_policy_changed",
    )
    final_rows = cloud.secrets()
    require(
        isinstance(final_rows, list)
        and sorted(final_rows, key=lambda item: item.get("name", ""))
        == sorted(rows, key=lambda item: item.get("name", "")),
        "iam_secret_inventory_changed",
    )
    for name in sorted(seen):
        require(
            cloud.secret_policy(name) == secret_policies[name],
            "iam_secret_policy_changed",
        )
    for name, number in versions.items():
        current = cloud.latest(name)
        require(
            current.get("state") == "ENABLED"
            and current.get("name", "").split("/")[-1] == number
            and current.get("name", "").rsplit("/versions/", 1)[0]
            in {
                f"projects/{target.project}/secrets/{name}",
                f"projects/{cloud.project_number}/secrets/{name}",
            },
            "iam_secret_version_changed",
        )


def verify(target: Target, *, require_service=True, cloud=None) -> dict:
    require(type(require_service) is bool, "iam_service_requirement_invalid")
    cloud = cloud or ReadCloud(target)
    identity, service = _identity_and_service(target, cloud, require_service)
    chain, policies, service_policy, cache = _hierarchy(target, cloud, service)
    rows, seen, secret_policies, expected = _inventory(target, cloud, cache)
    versions = _versions(target, cloud, expected)
    _recheck(
        target,
        cloud,
        identity,
        service,
        chain,
        policies,
        service_policy,
        rows,
        seen,
        secret_policies,
        versions,
    )
    return {
        "project": target.project,
        "service": SERVICE,
        "runtimePrincipal": target.runtime_sa,
        "serviceExists": service is not None,
        "invokerIamDisabled": False if service is not None else None,
        "publicInvokerBindings": [] if service is not None else None,
        "ancestorPoliciesComplete": True,
        "runtimeCloudSqlClient": True,
        "runtimeSecretsOnly": True,
        "migratorSecretAccess": False,
        "additionalRuntimeAuthority": False,
        "runtimeSecretVersions": versions,
        "iamEvidenceKind": "allow-policy-bindings",
        "authorityScope": "target-project-and-ancestors",
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=("dev", "uat"))
    args = parser.parse_args()
    try:
        print(json.dumps(verify(Target(args.environment)), sort_keys=True))
    except Exception as error:
        print(_refusal(error), file=sys.stderr)
        raise SystemExit(1) from None
