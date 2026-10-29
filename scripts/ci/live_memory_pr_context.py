"""Choose PR impact evidence for the exact source tested by this CI attempt."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any


def _binding(pr: Any, repository: dict) -> tuple:
    if not isinstance(pr, dict) or pr.get("state") != "open":
        raise ValueError("Pull request is unavailable or closed")
    number = pr.get("number")
    if type(number) is not int or number < 1:
        raise ValueError("Pull request number is invalid")
    parts = []
    for side in ("base", "head"):
        endpoint = pr.get(side)
        if not isinstance(endpoint, dict) or not isinstance(endpoint.get("repo"), dict):
            raise ValueError("Pull request repository is unavailable")
        repo = endpoint["repo"]
        repo_id, name, ref, sha = (
            repo.get("id"),
            repo.get("full_name"),
            endpoint.get("ref"),
            endpoint.get("sha"),
        )
        if (
            type(repo_id) is not int
            or repo_id < 1
            or not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name)
            or not isinstance(ref, str)
            or not 0 < len(ref) <= 255
            or not isinstance(sha, str)
            or not re.fullmatch(r"[a-f0-9]{40}", sha)
        ):
            raise ValueError("Pull request source identity is invalid")
        if side == "base" and (repo_id, name) != (
            repository.get("id"),
            repository.get("full_name"),
        ):
            raise ValueError("Pull request base repository changed")
        parts.append((repo_id, name, ref, sha))
    return number, *parts


def impact_body(
    event: Any, attempt: str, repository_name: str, read: Callable[[str], Any] | None
) -> str:
    if not isinstance(attempt, str) or not re.fullmatch(r"[1-9][0-9]*", attempt):
        raise ValueError("CI attempt is unavailable")
    if not isinstance(event, dict) or not isinstance(event.get("pull_request"), dict):
        raise ValueError("Pull request event is unavailable")
    original = event["pull_request"]
    if attempt == "1":
        body = original.get("body")
    else:
        repository = event.get("repository")
        if (
            not isinstance(repository, dict)
            or type(repository.get("id")) is not int
            or repository["id"] < 1
            or repository.get("full_name") != repository_name
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository_name)
            or read is None
        ):
            raise ValueError("Pull request authority is unavailable")
        original_binding = _binding(original, repository)
        if (
            type(event.get("number")) is not int
            or event["number"] != original_binding[0]
        ):
            raise ValueError("Pull request number changed")
        try:
            current = read(f"repos/{repository_name}/pulls/{original_binding[0]}")
        except Exception:
            raise ValueError("Current pull request could not be read") from None
        if _binding(current, repository) != original_binding:
            raise ValueError("Pull request source or base changed since this attempt")
        body = current.get("body")
    if not isinstance(body, str):
        raise ValueError("Pull request body is unavailable")
    return body
