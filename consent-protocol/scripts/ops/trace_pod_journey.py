#!/usr/bin/env python3
"""Where, exactly, did ONE person's 0->1 journey stop?

Read-only. Follows a single HusshID across every plane the journey touches and names
the first stage that is not satisfied, together with the next thing to look at.

    uv run python scripts/ops/trace_pod_journey.py --hushh-id ha1_XXXX
    uv run python scripts/ops/trace_pod_journey.py --service one-pod-ha1-xxxx

WHY THIS EXISTS RATHER THAN THE ONES ALREADY HERE
-------------------------------------------------
Three tools already look at pods, and none of them answers this question:

  * ``verify_pod_journey.py`` asks whether the SERVING HUB is capable of giving
    *anyone* a private agent. It is a pre-flight on the hub, and it passes happily
    while a particular person's pod is broken.
  * ``pod_fleet.py`` lists every pod in the project. It shows that a pod exists and
    whether it serves; it knows nothing about the registry row, the consent grant, or
    the feed, so it cannot tell "never created" from "created and never handshook".
  * ``pod_curl.py`` talks to one pod once it is addressable, which is the state this
    script exists to explain the absence of.

The journey crosses four planes -- Postgres (the registry row), the projection
(feed_events), GCP (the Cloud Run service and its IAM), and the pod's own runtime
(/health). A failure in ANY of them shows up to the person as the same spinner. The
only thing that joins the four is the HusshID, which is why it is the argument.

STAGES, IN THE ORDER THE JOURNEY ACTUALLY RUNS
----------------------------------------------
  1  registry row exists            phone verify -> register_pending
  2  a host was requested           provision() recorded a backend + external_agent_id
  3  the Cloud Run service exists   GcpBackend.provision actually called Cloud Run
  4  the service genuinely serves   Ready is not enough -- the startup probe must be HTTP
  5  the hub may call the pod       run.invoker binding; without it key collection 403s
  6  the pod published its key      the connecting -> provisioned handshake
  7  the standing read is live      status `provisioned`, agent activated
  8  the pod answers /health        runtime readiness

Each stage prints PASS / FAIL / SKIP with the evidence it read. The first FAIL stops
interpretation of everything below it, because a later stage's state is meaningless
once an earlier one is unsatisfied -- reporting six consecutive failures for one root
cause is how a diagnosis becomes noise.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It never writes. Not to the registry, not to Cloud Run, not to the pod. A row in
``connecting`` has a LIVE host mid-handshake, and the retry sweep excludes that state
precisely because acting on it would replace a running service. A diagnostic that
mutates the thing it is diagnosing is how an investigation becomes an outage.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Optional

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: E402

_ADMIN = "https://run.googleapis.com/apis/serving.knative.dev/v1"

# noqa on the next line: S105 matches the NAME `PASS` as a possible hardcoded
# password. It is a stage verdict. Renaming it to satisfy the lint would make the
# output worse to read, so the false positive is silenced where it occurs.
PASS = "PASS"  # noqa: S105
FAIL = "FAIL"
SKIP = "SKIP"
WARN = "WARN"


# The four stages that are all answered by a single registry row read.
_REGISTRY_STAGES = (
    "1 registry row exists",
    "2 a host was requested",
    "6 pod published its key",
    "7 standing read is live",
)


class Trace:
    """Accumulates stage verdicts and reports where the journey first stopped."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []

    def record(self, stage: str, verdict: str, evidence: str, next_step: str = "") -> None:
        self.rows.append((stage, verdict, evidence, next_step))

    @property
    def stopped_at(self) -> Optional[str]:
        """The first FAIL in JOURNEY order, which is not the order results arrive.

        The registry stages are gathered in one row read and then spliced around the
        GCP stages, so the sequence they were recorded in is not the sequence they
        happen in. Deriving this from ``rows`` rather than latching it during
        ``record`` is what keeps "first failure" meaning first-in-the-journey -- the
        latched version would have named a registry stage that runs AFTER a GCP stage
        that had already failed, and pointed the reader at the wrong cause.
        """
        for stage, verdict, _, _ in self.rows:
            if verdict == FAIL:
                return stage
        return None

    @property
    def blocked(self) -> bool:
        return self.stopped_at is not None

    @property
    def unread(self) -> list[str]:
        """Stages that were skipped rather than answered.

        `stopped_at` only knows about FAIL, so without this a trace where every single
        stage was SKIPPED -- no DB credential, an off-plane backend -- printed "the
        journey is complete: this person has a private agent that serves." That is the
        exact failure this tool exists to remove, committed by the tool itself: a green
        summary for a journey nobody looked at.
        """
        return [stage for stage, verdict, _, _ in self.rows if verdict == SKIP]

    def render(self) -> None:
        width = max(len(s) for s, _, _, _ in self.rows)
        for stage, verdict, evidence, _ in self.rows:
            print(f"  {verdict:4s}  {stage:{width}s}  {evidence}")
        print()
        if self.stopped_at is None:
            if self.unread:
                print(f"UNPROVEN: {len(self.unread)} of {len(self.rows)} stages were not read.")
                print("Nothing failed, and nothing was confirmed either. Unskipped stages:")
                for stage, verdict, _, _ in self.rows:
                    if verdict != SKIP:
                        print(f"  {verdict}  {stage}")
                return
            print("The journey is complete: this person has a private agent that serves.")
            return
        print(f"FIRST FAILURE: {self.stopped_at}")
        for stage, _verdict, _, next_step in self.rows:
            if stage == self.stopped_at and next_step:
                print(f"NEXT         : {next_step}")


def _read_registry_row(hushh_id: str) -> tuple[Optional[dict], Optional[str]]:
    """The registry row, or the reason it could not be read.

    Returns ``(row, None)`` on a successful read -- including ``(None, None)`` when the
    query ran and matched nothing, which is a real finding rather than a failure to
    look. Returns ``(None, reason)`` when the DB itself was unreachable, so the caller
    can SKIP honestly instead of reporting "no row" for a query that never ran. Those
    two are opposite diagnoses and must never be collapsed.
    """
    try:
        from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    except Exception as exc:  # pragma: no cover - import shape, not behaviour
        return None, f"repo import failed: {type(exc).__name__}"
    try:
        import asyncio

        repo = PersonalAgentRegistryRepo()
        return asyncio.run(repo.get_by_hushh_id(hushh_id)), None
    except Exception as exc:
        # Short, because it is repeated on all four registry stages. The full remedy
        # goes in the next_step once rather than four times.
        return None, type(exc).__name__


def _trace_registry(trace: Trace, hushh_id: Optional[str]) -> Optional[dict]:
    """Stages 1-2 and 6-7, which all read the one registry row."""
    query = (
        "SELECT status, backend, external_agent_id, pod_pubkey, created_at "
        f"FROM personal_agent_registry WHERE hushh_id = '{hushh_id or '<id>'}';"
    )
    if not hushh_id:
        for stage in _REGISTRY_STAGES:
            trace.record(stage, SKIP, "no --hushh-id given", query)
        return None

    row, unreachable = _read_registry_row(hushh_id)
    if unreachable:
        for stage in _REGISTRY_STAGES:
            trace.record(stage, SKIP, f"registry unreachable ({unreachable})", query)
        return None

    if not row:
        trace.record(
            _REGISTRY_STAGES[0],
            FAIL,
            "no row for this HusshID",
            "Nothing was ever reserved for this person. The journey stopped before "
            "provisioning: phone verification did not reach register_pending. Check "
            "PERSONAL_AGENT_ENABLED on the serving hub and the phone-verify seam.",
        )
        for stage in _REGISTRY_STAGES[1:]:
            trace.record(stage, SKIP, "no row to read")
        return None

    status = str(row.get("status") or "").strip()
    trace.record(_REGISTRY_STAGES[0], PASS, f"status={status} created_at={row.get('created_at')}")

    external = row.get("external_agent_id")
    if external:
        trace.record(_REGISTRY_STAGES[1], PASS, f"backend={row.get('backend')} host={external}")
    elif status in ("pending", "reserved"):
        trace.record(
            _REGISTRY_STAGES[1],
            FAIL,
            f"status={status}, no host recorded",
            "The person is reserved but provisioning never ran. On the managed lane that "
            "means the autoprovision hook did not fire or failed -- grep the hub for "
            "`personal_agent.autoprovision_failed hushh_id=` with this HusshID.",
        )
    else:
        trace.record(
            _REGISTRY_STAGES[1],
            FAIL,
            f"status={status} but external_agent_id is empty",
            "provision() recorded a status without a handle, which means the backend "
            "returned nothing -- the classic shape is GcpBackend still in PLAN mode. "
            "Check HUSSH_GCP_BACKEND_LIVE on the serving revision.",
        )

    # Stage 6: the handshake. `connecting` means the host exists and the key has not
    # landed -- the one state nothing else in the system watches.
    if row.get("pod_pubkey"):
        trace.record(_REGISTRY_STAGES[2], PASS, "pod public key recorded")
    elif status == "connecting":
        trace.record(
            _REGISTRY_STAGES[2],
            FAIL,
            "status=connecting, no pod public key",
            "The host exists and the pod never published its key. Nothing retries this "
            "by design (re-provisioning would replace a running service), so it will sit "
            "here forever. Check stage 5 below first -- a missing run.invoker binding "
            "makes key collection 403 -- then the pod's own `pod.startup` log line.",
        )
    else:
        trace.record(_REGISTRY_STAGES[2], SKIP, f"status={status}, handshake not reached")

    if status == "provisioned":
        trace.record(_REGISTRY_STAGES[3], PASS, "status=provisioned (standing read minted)")
    elif status == "provisioning_failed":
        trace.record(
            _REGISTRY_STAGES[3],
            FAIL,
            "status=provisioning_failed",
            "provision() raised and recorded its own defeat. The traceback is in the hub "
            "log as `personal_agent.autoprovision_failed hushh_id=` for this HusshID.",
        )
    else:
        trace.record(_REGISTRY_STAGES[3], SKIP, f"status={status}, activation not reached")
    return row


# -- which plane the pod actually lives on --------------------------------------------
#
# Stages 3-5 and 8 read Cloud Run. That is true for exactly one of the three backends
# by default, and the honest answers for the other two are DIFFERENT answers, not
# failures:
#
#   gcp        hushh's own project. The operator credential can read it. Full trace.
#   user_gcp   the person's OWN project. hushh holds no standing credential there by
#              design -- that absence IS the BYOC promise -- so this cannot be read
#              from here and must say so rather than reporting a missing service.
#   anypoint   a Mule application on CloudHub 2.0. Not a Cloud Run service at all, so
#              "not found in Cloud Run" would be true and completely misleading.
#
# Reporting either of the last two as FAIL would send an operator hunting for a
# service that was never supposed to exist.

_PLANE_NOTE = {
    "user_gcp": (
        "this pod runs in the person's OWN GCP project. hushh holds no standing "
        "credential there -- that absence is the BYOC promise, not an outage. Re-run "
        "with --project <their-project> using a consent-gated impersonated token, or "
        "read it from inside their project."
    ),
    "anypoint": (
        "this pod is a Mule application on CloudHub 2.0, not a Cloud Run service. "
        "Check it in Anypoint Runtime Manager; the equivalent of stages 3-5 is the "
        "application's deployment status and its private-endpoint binding."
    ),
}

_CLOUD_RUN_STAGES = (
    "3 cloud run service exists",
    "4 service genuinely serves",
    "5 hub may invoke the pod",
)


def _resolve_backend(row: Optional[dict], override: Optional[str]) -> str:
    """The row is the authority; --backend is for when the row cannot be read."""
    if override:
        return override
    return str((row or {}).get("backend") or "").strip() or "gcp"


def _skip_off_plane(trace: Trace, backend: str) -> None:
    note = _PLANE_NOTE[backend]
    for stage in _CLOUD_RUN_STAGES:
        trace.record(stage, SKIP, f"backend={backend}: not on the Cloud Run plane", note)


def _service_name_for(hushh_id: str) -> str:
    """Mirror of GcpBackend._service_name. Imported rather than copied where possible."""
    from hushh_mcp.services.gcp_backend import _service_name

    return _service_name(hushh_id)


def _session(credentials: Any) -> requests.Session:
    from google.auth.transport.requests import AuthorizedSession

    return AuthorizedSession(credentials)


def _condition(obj: dict[str, Any], name: str) -> Optional[str]:
    for c in (obj.get("status") or {}).get("conditions") or []:
        if c.get("type") == name:
            return c.get("status")
    return None


def _probe_kind(svc: dict[str, Any]) -> str:
    containers = (((svc.get("spec") or {}).get("template") or {}).get("spec") or {}).get(
        "containers"
    ) or []
    if not containers:
        return "none"
    probe = containers[0].get("startupProbe") or {}
    if probe.get("httpGet"):
        return f"http {probe['httpGet'].get('path', '/')}"
    if probe.get("tcpSocket"):
        return "tcp (explicit)"
    return "tcp (default)"


def _trace_gcp(trace: Trace, *, project: str, region: str, service: str) -> Optional[str]:
    """Stages 3-5 and 8. Returns the service URL when the pod is addressable."""
    creds = load_operator_credentials()
    session = _session(creds)
    url = f"{_ADMIN}/namespaces/{project}/services/{service}"
    response = session.get(url, headers={"Content-Type": "application/json"}, timeout=30)

    if response.status_code == 404:
        trace.record(
            "3 cloud run service exists",
            FAIL,
            f"{service} not found in {project}/{region}",
            "The row claims a host that GCP does not have. Either provision() never "
            "reached Cloud Run (check HUSSH_GCP_BACKEND_LIVE and the dev simulation "
            "guard on the serving revision) or the service was deleted underneath it.",
        )
        return None
    if response.status_code != 200:
        trace.record(
            "3 cloud run service exists",
            FAIL,
            f"admin API returned {response.status_code}",
            "Operator credential problem, not a pod problem. Check GCP_DEPLOY_SA_KEY_B64.",
        )
        return None

    svc = response.json()
    trace.record("3 cloud run service exists", PASS, service)

    ready = _condition(svc, "Ready")
    probe = _probe_kind(svc)
    serving_url = None
    from hushh_mcp.services.gcp_run_client import GcpRunClient

    serving_url = GcpRunClient.service_url(svc)

    # Ready=True is NOT proof of serving: gunicorn binds its port before its workers
    # boot, so a default TCP probe passes while every request 503s. The explicit HTTP
    # probe on /health is what makes this condition mean what it says.
    if ready == "True" and probe.startswith("http"):
        trace.record("4 service genuinely serves", PASS, f"Ready=True probe={probe}")
    elif ready == "True":
        trace.record(
            "4 service genuinely serves",
            WARN,
            f"Ready=True but probe={probe}",
            "Ready is satisfied by a TCP connect, which gunicorn answers before its "
            "workers boot. This pod may be returning 503 to everything. Confirm with "
            "stage 8 rather than trusting Ready.",
        )
    else:
        trace.record(
            "4 service genuinely serves",
            FAIL,
            f"Ready={ready} probe={probe}",
            "The container never came up. Read the pod's own Cloud Run logs for an "
            "import-time crash -- `pod.startup` should be the first line it writes.",
        )
        return serving_url

    # The hub calls the pod to collect its key. Without run.invoker the call 403s and
    # the row parks in `connecting` with nothing naming the cause.
    try:
        policy = session.get(
            f"{_ADMIN}/projects/{project}/locations/{region}/services/{service}:getIamPolicy".replace(
                _ADMIN, "https://run.googleapis.com/v1"
            ),
            timeout=30,
        )
        members: list[str] = []
        if policy.status_code == 200:
            for binding in policy.json().get("bindings") or []:
                if binding.get("role") == "roles/run.invoker":
                    members.extend(binding.get("members") or [])
        if members:
            trace.record("5 hub may invoke the pod", PASS, f"run.invoker: {', '.join(members)}")
        else:
            trace.record(
                "5 hub may invoke the pod",
                FAIL,
                "no run.invoker binding",
                "The hub is not permitted to call this pod, so key collection can only "
                "403 and the row will stay in `connecting` forever. Check "
                "HUSSH_POD_INVOKER_MEMBER on the serving hub revision -- when it is "
                "unset the backend logs `gcp_backend.no_invoker_member`.",
            )
    except requests.RequestException as exc:
        trace.record("5 hub may invoke the pod", SKIP, f"IAM read failed: {type(exc).__name__}")

    return serving_url


def _trace_pod_runtime(trace: Trace, *, url: Optional[str]) -> None:
    """Stage 8. Unauthenticated by design: pods have `internal` ingress, so a 404 from
    the Google front end is the EXPECTED answer from outside the perimeter and must not
    be read as a broken pod -- that misreading once produced ten fabricated sub-second
    'cold starts' that were really GFE 404s."""
    if not url:
        trace.record("8 pod answers /health", SKIP, "no service URL to call")
        return
    try:
        response = requests.get(f"{url}/health", timeout=20)
    except requests.RequestException as exc:
        trace.record("8 pod answers /health", SKIP, f"unreachable from here ({type(exc).__name__})")
        return
    if response.status_code == 200:
        trace.record("8 pod answers /health", PASS, f"200 from {url}")
    elif response.status_code == 404 and "run.app" in url:
        trace.record(
            "8 pod answers /health",
            SKIP,
            "404 from the Google front end -- expected: pods use `internal` ingress, so "
            "this says nothing about the pod. Run from inside the perimeter to check.",
        )
    else:
        trace.record(
            "8 pod answers /health",
            FAIL,
            f"{response.status_code} from {url}",
            "The service is Ready but its app is not answering. This is the gunicorn-"
            "bound-but-workers-dead shape; read the pod's logs for an import crash.",
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="Trace one person's 0->1 pod journey.")
    ap.add_argument("--hushh-id", help="The person's opaque HusshID (ha1_...).")
    ap.add_argument("--service", help="Cloud Run service name, if the HusshID is unknown.")
    ap.add_argument("--project", default="hushh-pda-dev")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument(
        "--backend",
        choices=("gcp", "user_gcp", "anypoint"),
        help=(
            "Override the host plane. Normally read from the registry row, which is "
            "the authority; pass this only when the row cannot be read."
        ),
    )
    args = ap.parse_args()

    if not args.hushh_id and not args.service:
        ap.error("one of --hushh-id or --service is required")

    service = args.service or _service_name_for(args.hushh_id)

    trace = Trace()
    # The registry stages are recorded first because that is the order the journey
    # runs, but they are all one row read -- so they are gathered in one pass and the
    # GCP stages are spliced in afterwards at their real positions.
    registry_rows_start = len(trace.rows)
    row = _trace_registry(trace, args.hushh_id)
    registry_rows = trace.rows[registry_rows_start:]
    trace.rows = trace.rows[:registry_rows_start]

    backend = _resolve_backend(row, args.backend)
    print(f"hushh id : {args.hushh_id or '<derived from service>'}")
    print(f"backend  : {backend}")
    print(f"service  : {service}  ({args.project}/{args.region})")
    print()

    # 1-2 (row, host requested), then 3-5 (host plane), then 6-7 (handshake,
    # activation), then 8.
    trace.rows.extend(registry_rows[:2])
    if backend in _PLANE_NOTE:
        _skip_off_plane(trace, backend)
        url = None
    else:
        url = _trace_gcp(trace, project=args.project, region=args.region, service=service)
    trace.rows.extend(registry_rows[2:])
    if backend in _PLANE_NOTE:
        trace.record("8 pod answers /health", SKIP, _PLANE_NOTE[backend])
    else:
        _trace_pod_runtime(trace, url=url)

    print("-" * 78)
    trace.render()
    print("-" * 78)
    # Three outcomes, three codes. Collapsing "unproven" into 0 would let a caller
    # gate on this tool and get a pass for a trace that read nothing.
    if trace.blocked:
        return 1
    return 2 if trace.unread else 0


if __name__ == "__main__":
    raise SystemExit(main())
