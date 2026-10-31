#!/usr/bin/env bash
# Validate the selected Connect account and webhook before changing Cloud Run.
project="${1:?deploy project required}"
live_enabled="${_DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED:-false}"
if [[ "${live_enabled}" != true && "${live_enabled}" != false ]]; then
  echo "Live Hashcoin redemption flag must be true or false." >&2
  exit 1
fi
if [[ "${live_enabled}" == true && "${_DRIVE_REQUEST_HASHCOINS_ENABLED:-false}" != true ]]; then
  echo "Live Hashcoin redemption requires the Hashcoin rollout switch." >&2
  exit 1
fi

# A live Connect account can be verified while redemption remains off. Checkout
# and Connect must belong to the same Stripe platform before either API or
# worker receives the live key. Secret values are never read into this shell.
if [[ "${_STRIPE_CONNECT_MODE:-}" == live ]]; then
  if [[ "${_STRIPE_MODE:-}" != live \
    || "${_STRIPE_SECRET_KEY_SECRET:-}" != STRIPE_LIVE_SECRET_KEY \
    || "${_STRIPE_CONNECT_SECRET_KEY_SECRET:-}" != "${_STRIPE_SECRET_KEY_SECRET}" \
    || "${_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET:-}" != STRIPE_LIVE_CONNECT_WEBHOOK_SECRET ]]; then
    echo "Live Connect requires live Checkout, its same-platform key, and the live Connect webhook." >&2
    exit 1
  fi
  for required_secret in "${_STRIPE_CONNECT_SECRET_KEY_SECRET}" "${_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET}"; do
    state="$(gcloud secrets versions describe latest --secret="${required_secret}" \
      --project="${project}" --format='value(state)' 2>/dev/null)" || state=""
    if [[ "${state}" != ENABLED ]]; then
      echo "Live Connect requires enabled key and webhook secret versions in the deploy project." >&2
      exit 1
    fi
  done
elif [[ "${live_enabled}" == true ]]; then
  echo "Live Hashcoin redemption requires live Connect." >&2
  exit 1
fi

if [[ "${_DRIVE_REQUEST_HASHCOINS_ENABLED:-false}" == true \
  && "${_STRIPE_CONNECT_MODE:-}" == test ]]; then
  if [[ "${_STRIPE_CONNECT_SECRET_KEY_SECRET:-}" != STRIPE_SECRET_KEY \
    || "${_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET:-}" != STRIPE_CONNECT_WEBHOOK_SECRET ]]; then
    echo "Hashcoin sandbox requires its isolated Connect key and webhook." >&2
    exit 1
  fi
  for required_secret in "${_STRIPE_CONNECT_SECRET_KEY_SECRET}" "${_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET}"; do
    if ! gcloud secrets describe "${required_secret}" --project="${project}" >/dev/null 2>&1; then
      echo "Hashcoin sandbox requires its isolated Connect secrets." >&2
      exit 1
    fi
  done
elif [[ "${_DRIVE_REQUEST_HASHCOINS_ENABLED:-false}" == true \
  && "${_STRIPE_CONNECT_MODE:-}" != live ]]; then
  echo "Hashcoin redemption requires test or live Connect." >&2
  exit 1
fi
