"""In-memory research checkpoint ports preserving CAS and ciphertext identity."""

import copy


class MemoryStore:
    def __init__(self):
        self.rows = {}
        self.generation = 0

    async def get(self, owner):
        return copy.deepcopy(self.rows.get(owner))

    async def write(self, owner, state, expected):
        row = self.rows.get(owner)
        if (expected is None and row is not None) or (
            expected is not None
            and (row is None or any(row[k] != expected[k] for k in ("revision", "fence")))
        ):
            return None
        self.generation += 1
        receipt = {"revision": (row["revision"] if row else 0) + 1, "fence": str(self.generation)}
        self.rows[owner] = {**copy.deepcopy(state), **receipt}
        return receipt


class FakeConnection:
    def __init__(self):
        self.rows = {}
        self.queries = []

    async def fetchrow(self, sql, *params, **kwargs):
        self.queries.append((sql, params))
        key = params[:3]
        row = self.rows.get(key)
        if sql.strip().startswith("SELECT"):
            return (
                copy.deepcopy(row)
                if row and row["payload_ciphertext"].startswith(params[3].removesuffix("%"))
                else None
            )
        if sql.strip().startswith("INSERT"):
            if row:
                return None
            revision = 1
        else:
            if (
                not row
                or row["revision"] != params[7]
                or row["payload_ciphertext"] != params[8]
                or not row["payload_ciphertext"].startswith(params[9].removesuffix("%"))
            ):
                return None
            revision = row["revision"] + 1
        self.rows[key] = dict(
            zip(
                ("payload_ciphertext", "payload_iv", "payload_tag", "payload_algorithm"),
                params[3:7],
                strict=True,
            )
        )
        self.rows[key]["revision"] = revision
        return {"revision": revision}

    async def execute(self, sql, *params, **kwargs):
        self.queries.append((sql, params))


class FakePool:
    def __init__(self):
        self.conn = FakeConnection()

    def acquire(self, **kwargs):
        return self

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args):
        pass
