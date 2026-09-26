"""find_by_project is the reverse index the cross-project orphan sweep needs.

A fleet-first sweep sees a bare service name in a user's project and must map it back
to an owner before it can propose adoption; ``byoc_setup_jobs.project_id`` is the only
stored link from a project to the user who named it. These pin the query shape without a
database.
"""

from __future__ import annotations

from types import SimpleNamespace

from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows
        self.filtered_by = None

    def table(self, _name):
        return self

    def select(self, *_cols):
        return self

    def eq(self, column, value):
        self.filtered_by = (column, value)
        return self

    def execute(self):
        col, val = self.filtered_by
        return SimpleNamespace(data=[r for r in self._rows if r.get(col) == val])


async def test_find_by_project_returns_the_jobs_that_named_the_project():
    db = _FakeDB(
        [
            {"user_id": "uid-1", "project_id": "hussh-one-aaa"},
            {"user_id": "uid-2", "project_id": "hussh-one-bbb"},
        ]
    )
    repo = ByocSetupJobRepo(client=db)
    out = await repo.find_by_project("hussh-one-aaa")
    assert out == [{"user_id": "uid-1", "project_id": "hussh-one-aaa"}]
    assert db.filtered_by == ("project_id", "hussh-one-aaa")


async def test_find_by_project_is_empty_for_an_unknown_project():
    repo = ByocSetupJobRepo(client=_FakeDB([{"user_id": "uid-1", "project_id": "hussh-one-aaa"}]))
    assert await repo.find_by_project("hussh-one-nope") == []


async def test_find_by_project_refuses_a_blank_id_without_querying():
    # A blank project id must never fan out to 'every job' -- it returns nothing.
    db = _FakeDB([{"user_id": "uid-1", "project_id": "hussh-one-aaa"}])
    repo = ByocSetupJobRepo(client=db)
    assert await repo.find_by_project("  ") == []
    assert db.filtered_by is None  # never reached the query
