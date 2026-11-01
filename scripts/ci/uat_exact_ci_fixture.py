# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""In-memory GitHub run, job and producer fixtures for exact UAT admission."""

import uat_exact_ci as subject


def attempt_run(candidate: str) -> dict:
    run = {
        "id": 123,
        "head_sha": candidate,
        "head_branch": "uat",
        "event": "workflow_dispatch",
        "run_attempt": 1,
        "workflow_id": 9,
        "path": ".github/workflows/ci.yml",
        "repository": {"id": 7, "full_name": subject.REPOSITORY},
        "head_repository": {"id": 7, "full_name": subject.REPOSITORY},
        "status": "completed",
        "conclusion": "success",
        "run_started_at": "2026-10-28T00:00:00Z",
        "updated_at": "2026-10-28T00:00:30Z",
        "check_suite_id": 77,
    }
    return run

def attempt_jobs(candidate: str, base: str, exact_name: str | None = None) -> list[dict]:
    exact_name = exact_name or f"Exact UAT Candidate ({base})"
    jobs = [
        {
            "name": name,
            "run_id": 123,
            "head_sha": candidate,
            "status": "completed",
            "conclusion": "success",
            "steps": [],
        }
        for name in sorted(
            subject.REQUIRED_JOBS | {exact_name}
        )
    ]
    for job in jobs:
        name = job["name"]
        step = (
            "Verify the exact UAT checkout"
            if name in {"Exact UAT Candidate", f"Exact UAT Candidate ({base})"}
            else "Run targeted web contract checks"
            if name.startswith("Web Targeted Contracts (")
            else "Run serial database contracts"
            if name.startswith("Protocol Database (")
            else "Resolve change-aware verification plan"
            if name == "Integration"
            else None
        )
        if step:
            job["steps"] = [{"name": step, "conclusion": "success"}]
        if name == "Branch Validation Gate":
            job["check_run_url"] = (
                f"https://api.github.com/repos/{subject.REPOSITORY}/check-runs/10"
            )
    return jobs


class AttemptAPI:
    def __init__(self, run: dict, jobs: list[dict], runs: list[dict], check: dict) -> None:
        self.run, self.jobs, self.runs, self.check = run, jobs, runs, check

    def read(self, path: str) -> dict:
        if path == f"repos/{subject.REPOSITORY}":
            return {"id": 7, "full_name": subject.REPOSITORY}
        if path.endswith("/actions/workflows/ci.yml"):
            return {"id": 9, "path": ".github/workflows/ci.yml"}
        if path.endswith("/check-runs/10"):
            return self.check
        if "/attempts/1/jobs?" in path:
            return {"jobs": self.jobs, "total_count": len(self.jobs)}
        if "/workflows/ci.yml/runs?" in path:
            return {"workflow_runs": self.runs, "total_count": len(self.runs)}
        for item in self.runs:
            if path.endswith(f"/runs/{item['id']}") or f"/runs/{item['id']}/attempts/" in path:
                return item
        return self.run
