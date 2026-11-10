"""Request-scoped Stripe transport; no global credentials, retries or unbounded IO."""

from types import SimpleNamespace

import stripe


class Resource:
    def __init__(self, path):
        self.path = path

    def call(self, action, resource_id=None, **arguments):
        key = arguments.pop("api_key")
        options = {}
        for option in ("idempotency_key", "stripe_account"):
            if option in arguments:
                options[option] = arguments.pop(option)
        transport = stripe.RequestsClient(timeout=5)
        try:
            client = stripe.StripeClient(key, http_client=transport, max_network_retries=0)
            resource = client.v1
            for part in self.path:
                resource = getattr(resource, part)
            operation = getattr(resource, action)
            if resource_id is None:
                return operation(params=arguments, options=options)
            return operation(resource_id, params=arguments, options=options)
        finally:
            transport.close()

    def create(self, **arguments):
        return self.call("create", **arguments)

    def retrieve(self, resource_id, **arguments):
        return self.call("retrieve", resource_id, **arguments)

    def list(self, **arguments):
        return self.call("list", **arguments)

    def expire(self, resource_id, **arguments):
        return self.call("expire", resource_id, **arguments)

    def cancel(self, resource_id, **arguments):
        return self.call("cancel", resource_id, **arguments)

    def create_login_link(self, resource_id, **arguments):
        return Resource((*self.path, "login_links")).call("create", resource_id, **arguments)


def provider():
    return SimpleNamespace(
        Account=Resource(("accounts",)),
        AccountLink=Resource(("account_links",)),
        Payout=Resource(("payouts",)),
        Subscription=Resource(("subscriptions",)),
        checkout=SimpleNamespace(Session=Resource(("checkout", "sessions"))),
        Webhook=stripe.Webhook,
    )
