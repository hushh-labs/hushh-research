# Commerce provider secrets are independent and survive admission rollback.
append_payment_provider_secrets() {
append_optional_secret "${_STRIPE_SECRET_KEY_SECRET}" "STRIPE_SECRET_KEY"
append_optional_secret "${_STRIPE_WEBHOOK_SECRET_SECRET}" "STRIPE_WEBHOOK_SECRET"

# Consumer scope commerce is a separate Stripe account and webhook trust lane.
# Keep these literal, independent mounts through flag-off rollback so existing
# funding, refunds, payouts and the OIDC drain can finish reconciliation.
append_optional_secret "SCOPE_COMMERCE_STRIPE_SECRET_KEY" "SCOPE_COMMERCE_STRIPE_SECRET_KEY"
append_optional_secret "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET" "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET"
append_optional_secret "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET" "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET"
}
