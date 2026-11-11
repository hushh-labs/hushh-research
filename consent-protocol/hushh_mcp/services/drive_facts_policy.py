"""Facts provenance excludes the independent query-planner instruction.

Compatibility anchors are digests only, never copied prompts. Unchanged facts
inputs retain their deployed policy, avoiding an unrelated re-extraction wave.
"""

import hashlib
import json
from functools import lru_cache

import yaml

# Filled from the pre-release authored manifest and its pinned facts inputs.
LEGACY_MANIFEST_PROJECTION = "ac53320307bc0e4ff265e8e34baf8101b08fe14569f2f1a3677827c1420d9db3"
LEGACY_POLICY_DIGESTS = {
    "065bb0ef8f1f2ce3155bda109cad97ddaee29c0936e81ff0eb819cbffee14a94": "9609c9693171402852147dcff4057212eda76fc6f69ad828ec59c51327aa5c02",
    "4885396e266bafe576b7bcb077229319ab88c0fb44c07cdd364e410563a6fe63": "d7f816775a4ef67f878e7562f175c56f93787c4638eda110b65d532ebba7e3bf",
}


@lru_cache(maxsize=4)
def manifest_projection_digest(manifest: bytes) -> str:
    value = yaml.safe_load(manifest)
    value["subagents"] = [
        agent for agent in value["subagents"] if agent["id"] != "agent_documents_request_search"
    ]
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def facts_policy_digest(manifest: bytes, tail: bytes) -> str:
    projection = manifest_projection_digest(manifest)
    previous = LEGACY_POLICY_DIGESTS.get(hashlib.sha256(tail).hexdigest())
    if projection == LEGACY_MANIFEST_PROJECTION and previous is not None:
        return previous
    return hashlib.sha256(
        b"facts-manifest-projection-v1\0" + projection.encode() + tail
    ).hexdigest()
