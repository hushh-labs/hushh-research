"""Execute the reviewed schema stage with environment-local, memory-only secrets.

Temporary owner membership belongs to the canonical database administrator,
never the runtime role. Every membership added here is reconciled and restored.
"""

from __future__ import annotations

import base64
import os
import re
from contextlib import closing, contextmanager
from datetime import datetime, timezone

import qualification_bootstrap as bootstrap
import qualification_foundation as foundation
import qualification_resources as resources
import qualification_schema as schema
from qualification_database import _role, inspect_baseline
from qualification_target import (
    ABSENT_TABLES,
    DATABASE,
    MARKER,
    MIGRATOR_ROLE,
    MIGRATOR_SECRETS,
    PREFIX,
    RUNTIME_ROLE,
    RUNTIME_SECRETS,
    SOURCE,
    Target,
    require,
)


def read_secret(cloud, name: str, version: str = "latest") -> tuple[str, bytes]:
    """Resolve metadata, access that numeric version and recheck the alias."""
    require(
        re.fullmatch(r"[A-Z_]+", name) is not None, "qualification_secret_name_invalid"
    )
    path = f"projects/{cloud.target.project}/secrets/{name}/versions/{version}"
    metadata = cloud.request("secretmanager", path)
    resource = metadata.get("name", "")
    require(
        metadata.get("state") == "ENABLED"
        and re.fullmatch(
            rf"projects/(?:{cloud.target.project}|{cloud.project_number})/secrets/{name}/versions/[1-9][0-9]*",
            resource,
        )
        is not None,
        "qualification_numeric_secret_required",
    )
    accessed = cloud.request("secretmanager", resource + ":access")
    require(accessed.get("name") == resource, "qualification_secret_access_changed")
    encoded = accessed.get("payload", {}).get("data", "")
    require(
        isinstance(encoded, str) and len(encoded) <= 87384,
        "qualification_secret_payload_bound",
    )
    value = base64.b64decode(encoded, validate=True)
    require(len(value) <= 65536, "qualification_secret_payload_bound")
    require(
        cloud.request("secretmanager", path).get("name") == resource,
        "qualification_secret_alias_changed",
    )
    return resource.rsplit("/", 1)[1], value


def material(cloud, target: Target) -> tuple[str, str, dict, dict]:
    values, versions = {}, {}
    for name in (*RUNTIME_SECRETS, *MIGRATOR_SECRETS):
        version, value = read_secret(cloud, PREFIX + name)
        resources._check_value(target, name, value)
        values[name], versions[name] = value, version
    if target.environment == "dev":
        _, password = read_secret(cloud, PREFIX + "ADMIN_PASSWORD", "1")
        user = "postgres"
    else:
        _, raw_user = read_secret(cloud, "DB_USER")
        _, password = read_secret(cloud, "DB_PASSWORD")
        user = raw_user.decode().strip()
    require(
        re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", user) is not None
        and user not in {RUNTIME_ROLE, MIGRATOR_ROLE}
        and bool(password),
        "qualification_canonical_admin_required",
    )
    return user, password.decode(), values, versions


def admin_boundary(connection, target: Target, user: str) -> None:
    expected = foundation.CLUSTERS[target.environment]
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_database(),current_user,pg_has_role(current_user,'cloudsqlsuperuser','USAGE'),"
            "s.system_identifier::text,current_setting('server_version_num')::int/10000 "
            "FROM pg_control_system() s"
        )
        require(
            cursor.fetchone()
            == ("postgres", user, True, expected["systemIdentifier"], 15),
            "qualification_canonical_admin_cluster_mismatch",
        )
        require(
            _role(cursor, MIGRATOR_ROLE, 2) and _role(cursor, RUNTIME_ROLE, 8),
            "qualification_owned_roles_required",
        )
        cursor.execute(
            "SELECT pg_get_userbyid(datdba),shobj_description(oid,'pg_database') "
            "FROM pg_database WHERE datname=%s",
            (DATABASE,),
        )
        require(
            cursor.fetchone() == (MIGRATOR_ROLE, MARKER),
            "qualification_owned_database_required",
        )


def membership(cursor, role: str) -> list:
    cursor.execute(
        "SELECT m.admin_option,pg_get_userbyid(m.grantor)=current_user "
        "FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid "
        "WHERE r.rolname=%s AND m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
        (role,),
    )
    rows = cursor.fetchall()
    require(rows in ([], [(False, True)]), "qualification_existing_membership_unowned")
    return rows


@contextmanager
def owner_memberships(connection, target: Target, user: str, *, needed: bool):
    from qualification_membership import temporary_owners

    with temporary_owners(
        connection,
        target,
        user,
        needed=needed,
        boundary=admin_boundary,
        membership=membership,
    ):
        yield


@contextmanager
def administrator_environment(user: str, password: str):
    keys = {
        "PLG_QUALIFICATION_ADMIN_USER": user,
        "PLG_QUALIFICATION_ADMIN_PASSWORD": password,
    }
    original = {key: os.environ.get(key) for key in keys}
    try:
        os.environ.update(keys)
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        keys.clear()


def runtime_boundary(target: Target, user: str, password: str, values: dict) -> dict:
    with closing(
        bootstrap.connect(target, database=DATABASE, user=user, password=password)
    ) as admin:
        admin.autocommit = True
        admin.set_session(readonly=True)
        schema.identity(admin, target, user)
        privilege_model = schema.verify_runtime_grants(admin)
    with closing(
        bootstrap.connect(
            target,
            database=DATABASE,
            user=RUNTIME_ROLE,
            password=values["DB_PASSWORD"].decode(),
        )
    ) as runtime:
        runtime.autocommit = True
        runtime.set_session(readonly=True)
        with runtime.cursor() as cursor:
            cursor.execute(
                "SELECT current_user,rolconnlimit FROM pg_roles WHERE rolname=current_user"
            )
            require(
                cursor.fetchone() == (RUNTIME_ROLE, 8),
                "qualification_runtime_role_limit_changed",
            )
        inspect_baseline(runtime, target)
    require(
        isinstance(privilege_model, dict),
        "qualification_runtime_privilege_proof_required",
    )
    return privilege_model


def execute(
    target: Target, root, folder, action: str, *, cloud=None
) -> tuple[dict, dict]:
    require(
        action in {"initialize", "preflight", "reconcile-bootstrap"},
        "qualification_schema_action_invalid",
    )
    cloud = cloud or resources.Cloud(target)
    user = password = None
    values = {}
    try:
        user, password, values, versions = material(cloud, target)
        with bootstrap.owned_proxy(target):
            with closing(
                bootstrap.connect(
                    target, database="postgres", user=user, password=password
                )
            ) as admin:
                with owner_memberships(
                    admin, target, user, needed=action != "preflight"
                ):
                    with administrator_environment(user, password):
                        report = schema.execute(
                            target,
                            root,
                            folder / "schema-operation.json",
                            action=action,
                        )
                    privileges = runtime_boundary(target, user, password, values)
        boundary = report["schemaBoundary"]
        proof = {
            "sourceSha": SOURCE,
            "foundationSha256": foundation.load_contract()[1],
            "instance": target.instance,
            "database": DATABASE,
            "runtimeRole": RUNTIME_ROLE,
            "runtimeRoleConnectionLimit": 8,
            "systemIdentifier": foundation.CLUSTERS[target.environment][
                "systemIdentifier"
            ],
            "providerContractVersion": boundary["providerContractVersion"],
            "requiredAbsentTables": list(ABSENT_TABLES),
            "sourceSchemaVerified": boundary["sourceSchemaVerified"],
            "sourceCatalogsVerified": True,
            "replacementAccounts": boundary["replacementAccounts"],
            "ownerRowsCopied": boundary["ownerRowsCopied"],
            "runtimeEmptyRead": True,
            "runtimeGrantsVerified": True,
            "runtimeBootstrapDDL": privileges,
            "memoryIndexDefinitionSha256": boundary["memoryIndexDefinitionSha256"],
            "observedAt": datetime.now(timezone.utc).isoformat(),
        }
        return proof, {name: versions[name] for name in RUNTIME_SECRETS}
    finally:
        user = password = None
        values.clear()
