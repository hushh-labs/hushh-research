#!/usr/bin/env bash
# Public native OAuth configuration; sourced by the two image-build resolvers.
# The caller validates deployment origin/prefix and supplies an ephemeral error
# file. Missing optional pins disable their feature; denied access fails closed.

resolve_google_native_public_clients() {
  local native_config_dir="$4"
  local google_contacts_secret_error="$5"
  local deploy_env="$1" secret_prefix="$2" project_id="$3"
  local name target value
  local -a native_names
  mkdir -p "${native_config_dir}"
  chmod 700 "${native_config_dir}"
  native_names=(
    NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI
    NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED
  )
  for name in "${native_names[@]}"; do
    : > "${native_config_dir}/${name}"
    chmod 600 "${native_config_dir}/${name}"
  done
  printf '%s' false > "${native_config_dir}/NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED"
  if [[ "${deploy_env}" == "dev" ]]; then
    for name in "${native_names[@]}"; do
      target="${native_config_dir}/${name}"
      if gcloud secrets versions access latest --secret="${secret_prefix}${name}" --project="${project_id}" \
        > "${target}" 2> "${google_contacts_secret_error}"; then
        value="$(tr -d '\r\n' < "${target}")"
        case "${name}" in
          *_CLIENT_ID)
            [[ "${value}" =~ ^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$ ]] || {
              echo "Invalid native Google public-client configuration: ${name}." >&2; exit 1;
            } ;;
          *_REDIRECT_URI)
            [[ "${value}" == "com.hussh.app:/oauth2redirect" ]] || {
              echo "Invalid native Google redirect configuration." >&2; exit 1;
            } ;;
          *_DEV_ENABLED)
            [[ "${value}" == "true" || "${value}" == "false" ]] || {
              echo "Invalid native Google dev gate configuration." >&2; exit 1;
            } ;;
        esac
        printf '%s' "${value}" > "${target}"
      elif grep -Eq '(^|[[:space:]])NOT_FOUND(:|[[:space:]])' "${google_contacts_secret_error}"; then
        : > "${target}"
        echo "Optional native Google configuration ${name} is absent; keeping that feature unavailable."
      else
        echo "Unable to access native Google public-client configuration: ${name}." >&2
        exit 1
      fi
    done
    if [[ ! -s "${native_config_dir}/NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID" \
      || ! -s "${native_config_dir}/NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI" \
      || ! -s "${native_config_dir}/NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED" ]]; then
      printf '%s' false > "${native_config_dir}/NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED"
    fi
  fi
}
