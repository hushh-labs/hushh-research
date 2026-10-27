"""Synthetic revision inventory for staged phone admission retirement."""

from tests.helpers.deployment_cli import cloudrun_revision


def lifecycle_retirement_revisions(
    expected_sha: str, *, invalid_candidate: bool = False
) -> tuple[dict, list[dict]]:
    revisions = []
    for name, sha in (
        ("current", "b" * 40 if invalid_candidate else expected_sha),
        ("legacy", "c" * 40),
        ("prephone", "d" * 40),
    ):
        revision = cloudrun_revision(
            name=f"consent-protocol-{name}", service="consent-protocol", sha=sha
        )
        revision["metadata"]["labels"]["account-deletion-contract"] = "v201"
        revision["metadata"]["uid"] = "fixture-" + name
        revisions.append(revision)
    revisions[0]["metadata"]["labels"]["github-run-id"] = "123"
    service = {
        "metadata": {"uid": "fixture-service"},
        "status": {
            "traffic": [
                {"revisionName": "consent-protocol-current", "percent": 100},
                {"revisionName": "consent-protocol-legacy", "tag": "legacy-test"},
                {"revisionName": "consent-protocol-prephone", "tag": "prephone-test"},
            ]
        },
    }
    return service, revisions
