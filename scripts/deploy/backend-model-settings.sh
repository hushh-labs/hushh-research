#!/usr/bin/env bash
# Sourced by backend-deploy.sh: decode its packed model selectors into the
# existing runtime variables. No cloud calls, credentials or deployment authority.

# The optional Puppy transport settings travel with the model selectors so this
# lane stays below Cloud Build's 100-entry step limit. Puppy eligibility is
# owner/device consent, never a deployment-wide switch.
_HUSHH_ONE_CHAT_VERTEX_PROJECT=""
_HUSHH_ONE_VOICE_VERTEX_PROJECT=""
IFS=',' read -r -a _model_pairs <<< "${_MODEL_SETTINGS:-puppy_relay_url=,puppy_model=local,puppy_timeout=120,gemini_text=,chat_vertex_project=,voice_enabled=,calendar_narration=false,voice_model=,voice_location=}"
for _pair in "${_model_pairs[@]}"; do
  _key="${_pair%%=*}"; _value="${_pair#*=}"
  case "${_key}" in
    puppy_relay_url) _PUPPY_INFERENCE_RELAY_URL="${_value}" ;;
    puppy_model) _PUPPY_INFERENCE_MODEL="${_value}" ;;
    puppy_timeout) _PUPPY_INFERENCE_TIMEOUT_SECONDS="${_value}" ;;
    gemini_text) _HUSSH_GEMINI_TEXT_MODEL="${_value}" ;;
    chat_vertex_project) _HUSHH_ONE_CHAT_VERTEX_PROJECT="${_value}" ;;
    voice_vertex_project) _HUSHH_ONE_VOICE_VERTEX_PROJECT="${_value}" ;;
    voice_enabled) _ONE_VOICE_LIVE_ENABLED="${_value}" ;;
    calendar_narration) _ONE_VOICE_CALENDAR_NARRATION_ENABLED="${_value}" ;;
    voice_model) _VERTEX_LIVE_MODEL_ID="${_value}" ;;
    voice_location) _VERTEX_LIVE_LOCATION="${_value}" ;;
    *) echo "_MODEL_SETTINGS carries an unknown key: ${_key}" >&2; exit 1 ;;
  esac
done
export _PUPPY_INFERENCE_RELAY_URL _PUPPY_INFERENCE_MODEL _PUPPY_INFERENCE_TIMEOUT_SECONDS _HUSSH_GEMINI_TEXT_MODEL
