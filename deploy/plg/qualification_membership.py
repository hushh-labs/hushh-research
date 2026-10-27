"""One fixed, generation-bound recovery journal for temporary owner membership.

Only the existing canonical administrator receives membership. The journal has
no credentials and cannot authorize another database, principal or role. A
crashed runner leaves enough durable state for the next locked reconciliation.
"""

from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

import qualification_foundation as foundation
import qualification_resources as resources
from qualification_target import DATABASE, MIGRATOR_ROLE, RUNTIME_ROLE, SOURCE, require

ROLES = (MIGRATOR_ROLE, RUNTIME_ROLE)
OBJECT = "plg-qualification/owner-membership-v1.json"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class Journal:
    def __init__(self, target, *, cloud=None):
        self.target, self.cloud = target, cloud or resources.Cloud(target)
        self.bucket = target.project + "_cloudbuild"
        self.path = f"/storage/v1/b/{self.bucket}/o/{quote(OBJECT, safe='')}"
        bucket = self.request("GET", f"/storage/v1/b/{self.bucket}")
        require(
            str(bucket.get("projectNumber")) == self.cloud.project_number,
            "qualification_membership_bucket_mismatch",
        )

    def request(self, method, path, *, body=None, missing=False):
        request = Request(  # noqa: S310 -- fixed Google storage host and internal paths only.
            "https://storage.googleapis.com" + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + self.cloud._token,
                "Content-Type": "application/json",
                "x-goog-user-project": self.target.project,
            },
        )
        try:
            with build_opener(NoRedirect()).open(request, timeout=30) as response:
                raw = response.read(32769)
        except HTTPError as error:
            try:
                if missing and method == "GET" and error.code == 404:
                    return None
            finally:
                error.close()
            raise ValueError("qualification_membership_journal_unverified") from None
        require(len(raw) <= 32768, "qualification_membership_journal_bound")
        value = json.loads(raw) if raw else {}
        require(isinstance(value, dict), "qualification_membership_journal_shape")
        return value

    def read(self):
        metadata = self.request("GET", self.path, missing=True)
        if metadata is None:
            return None
        generation = metadata.get("generation", "")
        require(
            metadata.get("bucket") == self.bucket
            and metadata.get("name") == OBJECT
            and re.fullmatch(r"[1-9][0-9]*", generation) is not None
            and int(metadata.get("size", 32769)) <= 32768,
            "qualification_membership_journal_metadata",
        )
        body = self.request("GET", self.path + f"?alt=media&generation={generation}")
        return generation, body

    def create(self, body):
        self.request(
            "POST",
            f"/upload/storage/v1/b/{self.bucket}/o?uploadType=media"
            f"&ifGenerationMatch=0&name={quote(OBJECT, safe='')}",
            body=body,
        )
        record = self.read()
        require(
            record is not None and record[1] == body,
            "qualification_membership_intent_not_observed",
        )
        return record

    def delete(self, record):
        generation, body = record
        require(
            self.read() == (generation, body),
            "qualification_membership_journal_changed",
        )
        self.request(
            "DELETE",
            self.path + f"?generation={generation}&ifGenerationMatch={generation}",
        )
        require(self.read() is None, "qualification_membership_journal_not_removed")


def subject(target, user):
    return {
        "schemaVersion": 1,
        "kind": "plg-owner-membership-intent-v1",
        "sourceSha": SOURCE,
        "project": target.project,
        "database": DATABASE,
        "systemIdentifier": foundation.CLUSTERS[target.environment]["systemIdentifier"],
        "administrator": user,
        "originalMemberships": {role: [] for role in ROLES},
    }


def validate(record, target, user):
    generation, body = record
    expected = subject(target, user)
    require(
        set(body) == {*expected, "runId", "runAttempt", "workflowSha"}
        and all(body.get(key) == value for key, value in expected.items())
        and all(
            isinstance(body.get(key), str) and re.fullmatch(r"[1-9][0-9]*", body[key])
            for key in ("runId", "runAttempt")
        )
        and isinstance(body.get("workflowSha"), str)
        and re.fullmatch(r"[0-9a-f]{40}", body["workflowSha"]),
        "qualification_membership_intent_wrong_subject",
    )
    require(
        isinstance(generation, str) and re.fullmatch(r"[1-9][0-9]*", generation),
        "qualification_membership_generation_invalid",
    )


def restore(cursor, user, membership):
    from psycopg2 import sql

    for role in reversed(ROLES):
        rows = membership(cursor, role)
        require(
            rows in ([], [(False, True)]), "qualification_membership_recovery_unowned"
        )
        if rows:
            cursor.execute(
                sql.SQL("REVOKE {} FROM {}").format(
                    sql.Identifier(role), sql.Identifier(user)
                )
            )
        require(
            membership(cursor, role) == [],
            "qualification_membership_recovery_incomplete",
        )


@contextmanager
def temporary_owners(
    connection, target, user, *, needed, boundary, membership, journal=None
):
    from psycopg2 import sql

    connection.autocommit = True
    boundary(connection, target, user)
    journal = journal or Journal(target)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(173734,20261030)")
        require(cursor.fetchone() == (True,), "qualification_owner_membership_busy")
        try:
            previous = journal.read()
            if previous is not None:
                validate(previous, target, user)
                require(
                    journal.read() == previous,
                    "qualification_membership_journal_changed",
                )
                restore(cursor, user, membership)
                journal.delete(previous)
            require(
                all(membership(cursor, role) == [] for role in ROLES),
                "qualification_membership_without_owned_intent",
            )
            record = None
            try:
                if needed:
                    body = subject(target, user) | {
                        key: os.environ.get(env, "")
                        for key, env in (
                            ("runId", "GITHUB_RUN_ID"),
                            ("runAttempt", "GITHUB_RUN_ATTEMPT"),
                            ("workflowSha", "GITHUB_SHA"),
                        )
                    }
                    validate(("1", body), target, user)
                    record = journal.create(body)
                    for role in ROLES:
                        require(
                            journal.read() == record,
                            "qualification_membership_journal_changed",
                        )
                        cursor.execute(
                            sql.SQL("GRANT {} TO {}").format(
                                sql.Identifier(role), sql.Identifier(user)
                            )
                        )
                        require(
                            membership(cursor, role) == [(False, True)],
                            "qualification_owner_membership_not_observed",
                        )
                yield
            finally:
                if record is not None:
                    require(
                        journal.read() == record,
                        "qualification_membership_journal_changed",
                    )
                    restore(cursor, user, membership)
                    journal.delete(record)
        finally:
            cursor.execute("SELECT pg_advisory_unlock(173734,20261030)")
            require(
                cursor.fetchone() == (True,), "qualification_owner_lock_not_released"
            )
