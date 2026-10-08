#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
set -euo pipefail

# Explicit operator setup only; does not deploy code, migrate or enable delivery.
# See docs/reference/one/calendar-meeting-reminders.md before running.
case "${1:-}" in
  uat) project=hushh-pda-uat; audience=https://api.uat.hushh.ai ;;
  production) project=hushh-pda; audience=https://api.hushh.ai ;;
  *) echo 'Usage: configure_calendar_reminder_scheduler.sh <uat|production> <scheduler-region>' >&2; exit 2 ;;
esac
region="${2:?Supply the existing Cloud Scheduler region}"
account="calendar-meeting-reminders@${project}.iam.gserviceaccount.com"
job="calendar-meeting-reminders-${1}"
if ! gcloud iam service-accounts describe "$account" --project="$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create calendar-meeting-reminders --project="$project" --display-name='Calendar meeting reminder scheduler'
fi
action=create
if gcloud scheduler jobs describe "$job" --project="$project" --location="$region" >/dev/null 2>&1; then action=update; fi
gcloud scheduler jobs "$action" http "$job" --project="$project" --location="$region" \
  --schedule='* * * * *' --time-zone=UTC --uri="$audience/api/one/calendar/reminders/drain" \
  --http-method=POST --oidc-service-account-email="$account" --oidc-token-audience="$audience" \
  --attempt-deadline=55s --max-retry-attempts=0
# Leave prepared infrastructure paused until migration, credentials and device
# testing are complete. An operator explicitly resumes it for the test rollout.
gcloud scheduler jobs pause "$job" --project="$project" --location="$region"
