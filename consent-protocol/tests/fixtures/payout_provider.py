"""Synthetic payout provider with explicit current facts and recorded intents."""

import json
import time

import stripe


class _FakePayoutAccount:
    def __init__(self, provider):
        self.provider = provider

    def create(self, **kw):
        outer = self.provider
        outer.accounts.append(kw)
        outer.unconfigured_account = True
        return {
            "id": f"acct_{len(outer.accounts)}",
            "country": outer.country,
            "details_submitted": False,
            **outer.account_extra,
        }

    def modify(self, acct, **kw):
        outer = self.provider
        outer.preparations.append({"account": acct, **kw})
        outer.account_extra.update(business_type=kw["business_type"])
        return {"id": acct, "country": outer.country, "business_type": kw["business_type"]}

    def retrieve(self, acct, **_kw):
        outer = self.provider
        outer.retrieves.append(acct)
        return {
            "id": acct,
            "country": outer.country,
            "deleted": outer.deleted,
            "details_submitted": not outer.unconfigured_account,
            "payouts_enabled": outer.payouts_enabled,
            "capabilities": {"transfers": outer.transfers_capability},
            "requirements": {
                "disabled_reason": outer.disabled_reason,
                **outer.requirements,
            },
            **(
                {"external_accounts": outer.external_accounts}
                if outer.external_accounts_visible
                else {}
            ),
            **outer.account_extra,
        }

    def create_login_link(self, account, **kw):
        outer = self.provider
        outer.links.append({"account": account, **kw})
        return {"url": "https://connect.stripe.com/express/test"}


class _Stripe:
    def __init__(self):
        self.accounts, self.links, self.transfers, self.refunds = [], [], [], []
        self.retrieves, self.preparations = [], []
        self.payouts_enabled = False
        self.transfers_capability = "inactive"
        self.disabled_reason = None
        self.country = "US"
        self.deleted = False
        self.unconfigured_account = False
        self.external_accounts = {
            "data": [
                {
                    "object": "bank_account",
                    "country": "US",
                    "currency": "usd",
                    "default_for_currency": True,
                    "bank_name": "Example Bank",
                    "last4": "6789",
                    "status": "new",
                }
            ],
            "has_more": False,
        }
        self.external_accounts_visible = True
        # Extra Account fields a test sets, e.g. requirements lists or settings.
        self.requirements, self.account_extra = {}, {}
        outer = self

        class _AccountLink:
            @staticmethod
            def create(**kw):
                outer.links.append(kw)
                outer.unconfigured_account = False
                return {
                    "object": "account_link",
                    "url": "https://connect.stripe.com/setup/x",
                    "expires_at": int(time.time()) + 300,
                }

        class _PaymentIntent:
            @staticmethod
            def retrieve(pi, **_kw):
                return {"id": pi, "latest_charge": "ch_1"}

        class _Transfer:
            @staticmethod
            def create(**kw):
                outer.transfers.append(kw)
                return {"id": f"tr_{len(outer.transfers)}"}

        class _Refund:
            @staticmethod
            def create(**kw):
                outer.refunds.append(kw)
                return {"id": "re_1"}

        self.Account, self.AccountLink, self.PaymentIntent = (
            _FakePayoutAccount(self),
            _AccountLink,
            _PaymentIntent,
        )
        self.Transfer, self.Refund = _Transfer, _Refund


def _provider_response(monkeypatch, *, payload, status=200):
    """Keep Stripe's real SDK parsing; replace only the outbound HTTP transport."""

    class RecordedStripeHTTP(stripe.HTTPClient):
        name = "recorded_stripe_response"

        def request(self, method, url, headers, post_data=None):
            return json.dumps(payload), status, {"request-id": "req_synthetic"}

    monkeypatch.setattr(stripe, "default_http_client", RecordedStripeHTTP())
    monkeypatch.setattr(stripe, "max_network_retries", 0)


def payout_tables():
    """Fresh document-order fixtures; no records shared between test worlds."""
    return {
        "marketplace_access_requests": [
            {"id": "r1", "status": "approved", "latest_envelope_id": "env1"},
            {"id": "r2", "status": "pending", "latest_envelope_id": None},
        ],
        "pkm_packet_orders": [
            {
                "id": "o1",
                "owner_user_id": "owner",
                "buyer_user_id": "b",
                "status": "paid",
                "stripe_mode": "test",
                "access_request_id": "r1",
                "amount_cents": 500,
                "platform_fee_cents": 50,
                "payment_method": "card",
                "stripe_payment_intent_id": "pi_1",
                "owner_earning_status": "none",
            },
            {
                "id": "o2",
                "owner_user_id": "owner",
                "buyer_user_id": "b",
                "status": "paid",
                "stripe_mode": "test",
                "access_request_id": "r2",
                "amount_cents": 300,
                "platform_fee_cents": 0,
                "payment_method": "card",
                "stripe_payment_intent_id": "pi_2",
                "owner_earning_status": "none",
            },
        ],
    }
