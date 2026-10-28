"""Finite inert PostgreSQL ownership graph; never connects or executes SQL."""

import re


def bootstrap_objects(runtime, owner):
    objects = []
    for number, table in enumerate(runtime.TABLES, 1):
        for offset, catalog, schema, name, kind, relkind in (
            (0, "pg_class", "public", table, "table", "r"),
            (1, "pg_class", "public", table + "_pkey", "index", "i"),
            (2, "pg_class", "pg_toast", "pg_toast_" + str(number), "toast", "t"),
            (3, "pg_class", "pg_toast", "pg_toast_" + str(number) + "_index", "toast-index", "i"),
            (4, "pg_type", "public", table, "row-type", "c"),
            (5, "pg_type", "public", "_" + table, "array-type", "b"),
        ):
            objects.append(
                runtime.Object(
                    catalog,
                    number * 10 + offset,
                    schema,
                    name,
                    kind,
                    number * 10,
                    owner,
                    relkind,
                    1,
                )
            )
        if table == "fabric_receipts":
            objects.append(
                runtime.Object(
                    "pg_class",
                    number * 10 + 6,
                    "public",
                    "fabric_receipts_id_seq",
                    "sequence",
                    number * 10,
                    owner,
                    "S",
                    1,
                )
            )
    return sorted(objects, key=lambda o: (o.catalog, o.oid))


class Connection:
    autocommit = True

    def __init__(self, *, populated=False, authority=True, system_id="7612942862467162128"):
        self.populated, self.authority, self.system_id = populated, authority, system_id
        self.query, self.calls, self.readonly = "", [], False

    def get_dsn_parameters(self):
        return {
            "host": "127.0.0.1",
            "port": "6547",
            "dbname": "plg_qualification",
            "user": "synthetic_admin",
        }

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, parameters=None):
        self.query = str(query)
        self.calls.append((self.query, parameters))

    def fetchone(self):
        if self.query.startswith("SELECT rolcanlogin"):
            name = self.calls[-1][1][0]
            return (
                True,
                False,
                False,
                False,
                False,
                False,
                False,
                2 if name == "plg_qualification_migrator" else 8,
                "plg-isolated-qualification-v1:5de6ee29abe3b00642bd6b745c608279091810b3",
                False,
            )
        if "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datdba=" in self.query:
            return (False,)
        if "pg_control_system" in self.query:
            return (
                "plg_qualification",
                "synthetic_admin",
                "plg_qualification_migrator",
                "plg-isolated-qualification-v1:5de6ee29abe3b00642bd6b745c608279091810b3",
                self.system_id,
                15,
            )
        if self.query.startswith("SHOW"):
            return ("on" if self.readonly else "off",)
        if "cloudsqlsuperuser" in self.query:
            return (self.authority, True)
        if self.query.startswith("SELECT NOT EXISTS"):
            return (not self.populated,) * 5
        return (True,)

    def set_session(self, *, readonly):
        self.readonly = readonly

    def rollback(self):
        self.calls.append(("ROLLBACK", None))

    def close(self):
        pass


class RuntimeConnection(Connection):
    def __init__(self, runtime, *, installed=False, defect=None):
        super().__init__()
        self.runtime, self.create, self.defect = runtime, installed, defect
        self.readonly = installed and defect != "readonly"
        owner = runtime.RUNTIME_ROLE if installed else "synthetic_admin"
        self.objects = bootstrap_objects(runtime, owner)
        self.extra, self.saved = [], None
        self.admin_select = set(runtime.TABLES) if installed else set()
        self.temporary_owners = True
        if defect == "partial":
            first = self.objects[0].table_oid
            changed = "synthetic_admin" if installed else runtime.RUNTIME_ROLE
            self.objects = [
                o._replace(owner=changed) if o.table_oid == first else o for o in self.objects
            ]
        elif defect == "sequence-link":
            self.objects = [
                o._replace(links=2) if o.kind == "sequence" else o for o in self.objects
            ]
        elif defect == "missing-type":
            self.objects = [
                o for o in self.objects if not (o.kind == "row-type" and o.table_oid == 10)
            ]
        elif defect == "unrelated-owner":
            self.extra = [("pg_class", 999)]

    def get_dsn_parameters(self):
        values = super().get_dsn_parameters()
        if self.defect == "socket":
            values["port"] = "5432"
        return values

    @staticmethod
    def render(query):
        from psycopg2 import sql

        if isinstance(query, sql.SQL):
            return query.string
        if isinstance(query, sql.Identifier):
            return ".".join('"' + value + '"' for value in query.strings)
        if isinstance(query, sql.Composed):
            return "".join(RuntimeConnection.render(item) for item in query.seq)
        return str(query)

    def execute(self, query, parameters=None):
        text = self.render(query)
        super().execute(text, parameters)
        if text == "BEGIN":
            self.saved = (self.create, self.objects[:], self.extra[:], self.admin_select.copy())
        elif text == "ROLLBACK" and self.saved:
            self.create, self.objects, self.extra, self.admin_select = self.saved
        elif text.startswith("GRANT USAGE,CREATE ON SCHEMA"):
            self.create = True
        elif text.startswith("ALTER TABLE public."):
            name = re.search(r'public\."([^"]+)"', text)[1]
            oid = next(o.oid for o in self.objects if o.kind == "table" and o.name == name)
            self.objects = [
                o._replace(owner=self.runtime.RUNTIME_ROLE) if o.table_oid == oid else o
                for o in self.objects
            ]
            if self.defect == "post-drift":
                self.extra = [("pg_class", 999)]
        elif text.startswith("GRANT SELECT ON TABLE public.") and self.defect != "admin-post":
            name = re.search(r'public\."([^"]+)"', text)[1]
            assert text.endswith('TO "synthetic_admin"') and name in self.runtime.TABLES
            self.admin_select.add(name)

    def fetchall(self):
        if self.query == self.runtime.GRAPH_SQL:
            return list(self.objects)
        if self.query == self.runtime.OWNED_SQL:
            return [
                (o.catalog, o.oid) for o in self.objects if o.owner == self.runtime.RUNTIME_ROLE
            ] + self.extra
        raise AssertionError("unrecognized inert metadata query")

    def fetchone(self):
        if "preserved_admin_select" in self.query:
            direct = self.admin_select == set(self.runtime.TABLES)
            effective = (not self.create or self.temporary_owners or direct) and (
                self.defect != "admin-read" or direct
            )
            return True, effective, direct
        if self.query == self.runtime.RIGHTS_SQL:
            return True, self.create, self.defect == "ledger-dml", self.defect != "other-object"
        if "cloudsqlsuperuser" in self.query and self.calls[-1][1] == (
            self.runtime.MIGRATOR_ROLE,
            self.runtime.RUNTIME_ROLE,
        ):
            return (self.defect != "authority", True, True)
        if self.query.startswith("SELECT rolcanlogin") and self.defect == "membership":
            return super().fetchone()[:-1] + (True,)
        return super().fetchone()
