from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_uat_deploy_wires_the_personal_gmail_monitor_identity() -> None:
    workflow = (REPO_ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")

    assert (
        "GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SCHEDULER_SERVICE_ACCOUNT_ID: "
        "gmail-personal-monitor-sched"
    ) in workflow
    assert "_GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUTH_ENABLED=true" in workflow
    assert (
        "_GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUDIENCE=${{ env.CONSENT_API_PUBLIC_ORIGIN }}"
    ) in workflow
    assert (
        "_GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SERVICE_ACCOUNT_EMAIL=${{ "
        "env.GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SCHEDULER_SERVICE_ACCOUNT_ID "
        "}}@${{ env.GCP_PROJECT_ID }}.iam.gserviceaccount.com"
    ) in workflow
    assert "Activate personal Gmail monitor" in workflow
    assert "deploy/gmail/setup_personal_information_request_monitor_scheduler.sh" in workflow
