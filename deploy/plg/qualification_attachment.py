"""Check only the current deployer's attachment permission on the fixed runtime."""

import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request

from qualification_target import QualificationError, Target, require


def verify(cloud):
    target = cloud.target
    require(type(target) is Target, "qualification_runtime_attachment_target_invalid")
    path = f"v1/projects/{target.project}/serviceAccounts/{target.runtime_sa}:testIamPermissions"
    request = Request(
        "https://iam.googleapis.com/" + path,
        data=json.dumps({"permissions": ["iam.serviceAccounts.actAs"]}).encode(),
        method="POST",
        headers={
            "Authorization": "Bearer " + cloud._token,
            "Content-Type": "application/json",
            "x-goog-user-project": target.project,
        },
    )
    try:
        remaining = cloud._deadline - time.monotonic()
        require(remaining > 0, "iam_collection_deadline_exceeded")
        with cloud._opener.open(request, timeout=min(20, remaining)) as response:
            raw = response.read(65537)
        require(len(raw) <= 65536, "iam_response_too_large")
        result = json.loads(raw)
    except HTTPError as error:
        code = error.code
        error.close()
        raise ValueError(f"qualification_iam_iam_http_{code}") from None
    except QualificationError:
        raise
    except (TimeoutError, URLError, ValueError, TypeError):
        raise ValueError("qualification_iam_metadata_read_unavailable") from None
    require(
        isinstance(result, dict)
        and result.get("permissions") == ["iam.serviceAccounts.actAs"],
        "qualification_runtime_attachment_permission_missing",
    )
