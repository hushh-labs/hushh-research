"""Finite inert PostgreSQL ownership graph; never connects or executes SQL."""


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
