"""The exact answer a pod's machine-route wall gives a caller with no hub identity.

One constant for both sides of one contract. The pod's ``PodIngressPolicy``
(``api/middlewares/pod_ingress.py``) answers every walled request with this body and a
404, and the hub's heartbeat admission (``pod_external_ingress_admission``) accepts a
wall as present only when it sees exactly these bytes. A 403 from Cloud Run IAM, a
provider's own 404 page or a proxy's error page are therefore never mistaken for the
pod's wall: only the pod writes this body.
"""

from __future__ import annotations

import json

POD_WALL_STATUS = 404
POD_WALL_NOT_FOUND_BODY: bytes = json.dumps({"detail": "not found"}).encode("utf-8")

__all__ = ["POD_WALL_NOT_FOUND_BODY", "POD_WALL_STATUS"]
