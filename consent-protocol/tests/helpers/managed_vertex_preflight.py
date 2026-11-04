"""Isolated Vertex IAM preflight with the normal Cloud Build answer defaults.

The production preflight now checks independent answer draining before its
existing paid-credential block. Vertex cases keep that unrelated admission off;
the answer configuration tests exercise its own enabled/disabled matrix.
"""


def vertex_preflight_script(preflight: str) -> str:
    start = preflight.index("gcloud iam service-accounts describe")
    end = preflight.index('if [[ "${_PKM_ANSWER_PAYMENTS_ENABLED}"', start)
    decision = preflight[start:end]
    return (
        """set -euo pipefail
    _PKM_ANSWER_PAYMENTS_ENABLED=false
    _ANSWER_WORK_DRAIN_ENABLED=false
    gcloud() {
      printf 'CALL:%s\\n' "$*" >&2
      if [[ "$1 $2" == "iam service-accounts" ]]; then return 0; fi
      if [[ "${DENY_PROJECT_DISCOVERY}" == "true" ]]; then return 7; fi
      if [[ "$1 $2" == "services list" ]]; then
    printf 'aiplatform.googleapis.com\\n'
      elif [[ "$*" == *roles/aiplatform.user* ]]; then
    printf 'roles/aiplatform.user\\n'
      elif [[ "$*" == *roles/serviceusage.serviceUsageConsumer* ]]; then
    printf 'roles/serviceusage.serviceUsageConsumer\\n'
      else
    return 8
      fi
    }
    """
        + decision
    )
