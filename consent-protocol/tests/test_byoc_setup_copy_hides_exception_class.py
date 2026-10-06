"""An unexpected stop in the Google Cloud setup job reads in plain words.

The person read "... press Try again. (KeyError)"; the exception's class name is for
support, so it stays in the log's traceback and never reaches the setup record.
"""

from __future__ import annotations

import logging

import pytest

from hushh_mcp.services import byoc_setup_job_service as jobs_mod


class _JobRepo:
    def __init__(self) -> None:
        self.finished: list[dict] = []

    async def retain_authorization(self, **_kwargs):
        return True

    async def advance(self, **_kwargs):
        return None

    async def finish(self, **kwargs):
        self.finished.append(kwargs)


@pytest.mark.asyncio
async def test_an_unexpected_stop_names_no_exception_class(caplog):
    repo = _JobRepo()

    def broken_project(**_kwargs):
        raise KeyError("surprise")

    async def never(*_a, **_k):
        raise AssertionError("the chain stopped before this step")

    with caplog.at_level(logging.ERROR, logger=jobs_mod.logger.name):
        await jobs_mod.run_setup_job(
            user_id="uid-1",
            job_id="job-1",
            project="hussh-one-abc",
            token="tok",  # noqa: S106 - a placeholder, not a credential
            display_name="Agent One",
            caller_sa="consent-protocol-runtime@hushh.iam.gserviceaccount.com",
            bootstrap_account_id="one-bootstrap",
            ensure_project=broken_project,
            ensure_billing=lambda **_k: {"linked": True},
            apply_authorization=lambda **_k: {"services": 0},
            wait_for_grant=never,
            save=never,
            repo=repo,
            settle_delays=(0.0,),
        )
    assert repo.finished and repo.finished[-1]["error_code"] == "UNEXPECTED"
    message = repo.finished[-1]["error_message"]
    assert "KeyError" not in message and "(" not in message
    assert message.startswith("Something unexpected stopped the setup.")
    assert "KeyError" in caplog.text  # support still sees which exception it was
