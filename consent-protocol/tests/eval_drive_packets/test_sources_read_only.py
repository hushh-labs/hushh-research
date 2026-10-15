"""Live sources are read-only by construction: one read-only database connection
and a GET-only Drive client that refuses anything else before network I/O."""

import pytest

from hushh_eval.drive_packets import sources
from hushh_eval.drive_packets.sources import (
    DriveReadOnly,
    LiveOptInRequired,
    ReadOnlyViolation,
    UatReadOnlySource,
    assert_read_only,
    read_only_engine,
)

PASSWORD = "not-a-real-password"


def test_engine_has_one_read_only_connection(monkeypatch):
    import sqlalchemy

    captured = {}

    class Engine:
        pass

    def fake_create_engine(url, **kwargs):
        captured.update(kwargs, url=url)
        return Engine()

    monkeypatch.setattr(sqlalchemy, "create_engine", fake_create_engine)
    monkeypatch.setattr(sqlalchemy.event, "listens_for", lambda *_a, **_k: lambda fn: fn)
    read_only_engine(user="u", password=PASSWORD, database="d", host="127.0.0.1", port=6655)
    assert captured["pool_size"] == 1 and captured["max_overflow"] == 0
    options = captured["connect_args"]["options"]
    assert "default_transaction_read_only=on" in options
    assert "statement_timeout=20000" in options
    with pytest.raises(ReadOnlyViolation, match="database_must_use_local_proxy"):
        read_only_engine(user="u", password=PASSWORD, database="d", host="10.0.0.5", port=5432)


def test_writable_session_aborts():
    class Result:
        def __init__(self, value):
            self.value = value

        def scalar_one(self):
            return self.value

    class Connection:
        def __init__(self, value):
            self.value = value

        def execute(self, _statement):
            return Result(self.value)

    assert_read_only(Connection("on"))
    with pytest.raises(ReadOnlyViolation, match="transaction_read_only_off"):
        assert_read_only(Connection("off"))


class RecordingClient:
    def __init__(self):
        self.calls = []

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url))
        raise AssertionError("network must not be reached")

    async def aclose(self):
        return None


@pytest.mark.parametrize("operation", ["update", "delete", "create_permission"])
async def test_drive_mutations_raise_before_any_http_call(operation):
    client = RecordingClient()
    drive = DriveReadOnly(lambda: "token", client=client)
    with pytest.raises(ReadOnlyViolation, match="drive_method_refused"):
        await getattr(drive, operation)("file-id")
    assert client.calls == []


async def test_drive_refuses_non_get_methods_and_foreign_urls():
    client = RecordingClient()
    drive = DriveReadOnly(lambda: "token", client=client)
    for method in ("POST", "PATCH", "PUT", "DELETE"):
        with pytest.raises(ReadOnlyViolation):
            await drive.request(method, "files")
    with pytest.raises(ReadOnlyViolation, match="drive_url_refused"):
        await drive.request("GET", "https://example.com/files")
    assert client.calls == []
    with pytest.raises(ValueError, match="drive_concurrency"):
        DriveReadOnly(lambda: "token", client=client, concurrency=5)


def test_live_source_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv(sources.LIVE_ENV, raising=False)
    calls = []

    def command(*args):
        calls.append(args)
        return "{}"

    with pytest.raises(LiveOptInRequired):
        UatReadOnlySource(owner_user_id="owner", db_port=6655, command=command)
    assert calls == []


class IdentityConnection:
    """A read-only connection whose schema has, or lacks, the identity cache."""

    def __init__(self, names):
        self.names, self.statements = names, []

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, statement, params=None):
        from unittest.mock import MagicMock

        sql = " ".join(str(statement).split())
        self.statements.append(sql)
        result = MagicMock()
        if "transaction_read_only" in sql:
            result.scalar_one.return_value = "on"
        elif "to_regclass('actor_identity_cache')" in sql:
            result.scalar_one.return_value = self.names is not None
        elif "FROM actor_identity_cache" in sql:
            name = (self.names or {}).get(params["owner"])
            result.mappings.return_value.first.return_value = (
                {"display_name": name} if name is not None else None
            )
        return result


@pytest.mark.parametrize(
    ("names", "expected"),
    [
        ({"owner": "  Avery Quill "}, ["Avery Quill"]),
        ({"owner": " "}, []),
        ({}, []),
        (None, []),
    ],
    ids=["name_on_file", "blank_name", "no_row", "no_identity_cache"],
)
def test_owner_identity_is_read_read_only(names, expected):
    from types import SimpleNamespace

    connection = IdentityConnection(names)
    source = UatReadOnlySource.__new__(UatReadOnlySource)
    source.owner = "owner"
    source.engine = SimpleNamespace(connect=lambda: connection)
    assert source.owner_identity() == {"names": expected}
    assert connection.statements and all(sql.startswith("SELECT") for sql in connection.statements)
