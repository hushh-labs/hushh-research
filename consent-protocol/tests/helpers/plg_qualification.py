"""Inert cloud and database fixtures for PLG qualification safety contracts."""

import base64


class ExistingSecret:
    project_number = "1234"

    def __init__(
        self,
        target,
        name,
        data,
        *,
        state="ENABLED",
        public=False,
        runtime_access=None,
        conditioned=False,
    ):
        self.target, self.name, self.data = target, name, data
        self.state, self.public, self.posts = state, public, []
        self.runtime_access = (
            not name.startswith("MIGRATOR_") if runtime_access is None else runtime_access
        )
        self.conditioned, self.policy_reads, self.value_reads = conditioned, 0, 0
        self.path = f"projects/1234/secrets/PLG_QUALIFICATION_{name}"

    def request(self, _api, path, *, method="GET", **kwargs):
        if method != "GET":
            self.posts.append((path, kwargs))
            return {}
        if path.endswith(":getIamPolicy"):
            self.policy_reads += 1
            if not self.public and not self.runtime_access:
                return {"bindings": []}
            member = "allUsers" if self.public else "serviceAccount:" + self.target.runtime_sa
            binding = {"role": "roles/secretmanager.secretAccessor", "members": [member]}
            if self.conditioned:
                binding["condition"] = {"title": "synthetic", "expression": "true"}
            return {"bindings": [binding]}
        if path.endswith(":access"):
            self.value_reads += 1
            return {
                "name": self.path + "/versions/7",
                "payload": {"data": base64.b64encode(self.data).decode()},
            }
        if path.endswith("/versions/latest"):
            if self.state == "MISSING":
                return None
            return {"name": self.path + "/versions/7", "state": self.state}
        return {"name": self.path, "labels": self.target.labels}


class SyntheticBaseline:
    def __init__(self, target, database, foundation, owner_rows):
        self.target, self.database, self.foundation = target, database, foundation
        self.owner_rows, self.query = owner_rows, ""

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, *_args):
        self.query = str(query)

    def fetchone(self):
        if self.query == "SELECT current_database()":
            return (self.target.DATABASE,)
        if self.query == "SHOW transaction_read_only":
            return ("on",)
        if "pg_get_userbyid" in self.query:
            return (self.target.MIGRATOR_ROLE, self.target.MARKER)
        if "SELECT to_regclass" in self.query:
            return (None,)
        if "SELECT to_regprocedure" in self.query:
            return ("account_provider_cleanup_contract_version()",)
        if self.query == "SELECT public.account_provider_cleanup_contract_version()":
            return (2,)
        if "FROM pg_trigger" in self.query:
            return (True,)
        return (self.owner_rows,)

    def fetchall(self):
        if self.query.startswith("SELECT tablename"):
            return [
                (name,)
                for name in sorted(
                    {"consent_audit", "pkm_events", "pkm_domain_commits", *self.foundation.CATALOGS}
                )
            ]
        for relation, definition in self.foundation.CATALOGS.items():
            if f"Identifier('{relation}')" in self.query:
                return definition["rows"]
        raise AssertionError("Unexpected synthetic catalog query")
