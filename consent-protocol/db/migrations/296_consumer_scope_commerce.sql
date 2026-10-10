-- Canonical scope-commerce accounting. No keys, credentials, payload plaintext,
-- filenames or provider customer PII belong here. Identity mappings can be
-- detached; opaque financial obligations and the immutable journal survive.
-- Postgres is the money authority; Redis may cache projections, never balances.
BEGIN;

CREATE TABLE IF NOT EXISTS scope_commerce_environment (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 platform_account_id TEXT NOT NULL CHECK(platform_account_id LIKE 'acct_%'),
 livemode BOOLEAN NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_wallets (
 wallet_id UUID PRIMARY KEY, payer_user_id TEXT, buyer_app_id TEXT NOT NULL,
 erased_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(payer_user_id,buyer_app_id)
);
CREATE TABLE IF NOT EXISTS scope_commerce_sellers (
 seller_id UUID PRIMARY KEY, owner_user_id TEXT UNIQUE, erased_at TIMESTAMPTZ,
 account_id TEXT,country TEXT,livemode BOOLEAN,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_tariffs (
 tariff_id UUID PRIMARY KEY, owner_user_id TEXT, scope_handle TEXT NOT NULL,
 machine_scope TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 0 AND 100000),
 base_duration_seconds INTEGER NOT NULL CHECK(base_duration_seconds BETWEEN 1 AND 31536000),
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id,scope_handle,machine_scope,revision), UNIQUE(owner_user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS scope_commerce_quotes (
 quote_id UUID PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
 tariff_id UUID NOT NULL REFERENCES scope_commerce_tariffs(tariff_id),
 seller_id UUID NOT NULL REFERENCES scope_commerce_sellers(seller_id),
 wallet_id UUID NOT NULL REFERENCES scope_commerce_wallets(wallet_id),
 owner_user_id TEXT, payer_user_id TEXT, buyer_app_id TEXT NOT NULL,
 machine_scope TEXT NOT NULL, scope_handle TEXT NOT NULL,
 recipient_key_fingerprint TEXT NOT NULL CHECK(recipient_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
 scope_manifest_revision TEXT NOT NULL, purpose TEXT, refresh_policy TEXT NOT NULL
 CHECK(refresh_policy IN ('snapshot','continuous_until_expiry')),
 duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 31536000),
 price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 0 AND 100000),
 fee_policy JSONB NOT NULL DEFAULT '{"policy_version":1,"commission_basis_points":0,"processing_costs_consumer":true,"payout_costs_consumer":true,"nonreturned_costs_consumer":true}'::jsonb,
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,request_deadline TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(wallet_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS scope_commerce_purchases (
 purchase_id UUID PRIMARY KEY, quote_id UUID NOT NULL UNIQUE REFERENCES scope_commerce_quotes(quote_id),
 request_id TEXT NOT NULL UNIQUE, consent_token_hash TEXT UNIQUE,
 owner_user_id TEXT, payer_user_id TEXT, buyer_app_id TEXT NOT NULL,
 seller_id UUID NOT NULL REFERENCES scope_commerce_sellers(seller_id),
 wallet_id UUID NOT NULL REFERENCES scope_commerce_wallets(wallet_id),
 machine_scope TEXT NOT NULL, scope_handle TEXT NOT NULL,
 recipient_key_fingerprint TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('awaiting_payment','reserved','preparing','staged','revoked','expired')),
 price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 0 AND 100000),
 fee_policy JSONB NOT NULL DEFAULT '{"policy_version":1,"commission_basis_points":0,"processing_costs_consumer":true,"payout_costs_consumer":true,"nonreturned_costs_consumer":true}'::jsonb,
 duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 31536000),
 fee_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(fee_micro_usd>=0),
 refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(refunded_cents BETWEEN 0 AND price_cents),
 preparation_id UUID, activation_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
 export_id TEXT, export_revision INTEGER, aad_sha256 TEXT, ciphertext_sha256 TEXT,
 staged_export JSONB, source_revisions JSONB,
 fulfillment_deadline TIMESTAMPTZ NOT NULL,
 earnings_settled_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, erased_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((activation_at IS NULL)=(expires_at IS NULL)),
 CHECK(expires_at IS NULL OR expires_at=activation_at+duration_seconds*interval '1 second'),
 CHECK(status<>'staged' OR (consent_token_hash IS NOT NULL AND preparation_id IS NOT NULL
 AND export_id IS NOT NULL AND export_revision IS NOT NULL AND aad_sha256 IS NOT NULL
 AND ciphertext_sha256 IS NOT NULL AND activation_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS scope_commerce_purchases_due ON scope_commerce_purchases(expires_at)
 WHERE status='staged' AND earnings_settled_at IS NULL;
CREATE TABLE IF NOT EXISTS scope_commerce_journal (
 entry_id UUID PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 reference_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_postings (
 entry_id UUID NOT NULL REFERENCES scope_commerce_journal(entry_id),
 account TEXT NOT NULL, micro_usd BIGINT NOT NULL CHECK(micro_usd<>0),
 PRIMARY KEY(entry_id,account)
);
CREATE INDEX IF NOT EXISTS scope_commerce_postings_account ON scope_commerce_postings(account);
CREATE TABLE IF NOT EXISTS scope_commerce_funding_lots (
 lot_id UUID PRIMARY KEY, wallet_id UUID NOT NULL REFERENCES scope_commerce_wallets(wallet_id),
 source_lot_id UUID REFERENCES scope_commerce_funding_lots(lot_id),
 funding_id UUID NOT NULL UNIQUE, payment_intent_id TEXT UNIQUE, charge_id TEXT UNIQUE,
 balance_transaction_id TEXT UNIQUE,
 gross_micro_usd BIGINT NOT NULL CHECK(gross_micro_usd>0),
 available_micro_usd BIGINT NOT NULL CHECK(available_micro_usd>=0),
 fee_total_micro_usd BIGINT NOT NULL CHECK(fee_total_micro_usd>=0),
 fee_remaining_micro_usd BIGINT NOT NULL CHECK(fee_remaining_micro_usd BETWEEN 0 AND fee_total_micro_usd),
 fee_basis_remaining_micro_usd BIGINT NOT NULL CHECK(fee_basis_remaining_micro_usd>=0),
 refunded_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(refunded_micro_usd>=0),
 refund_reserved_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(refund_reserved_micro_usd>=0),
 frozen BOOLEAN NOT NULL DEFAULT FALSE, livemode BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS scope_commerce_funding_fifo ON scope_commerce_funding_lots(wallet_id,created_at,lot_id);
CREATE TABLE IF NOT EXISTS scope_commerce_fundings (
 funding_id UUID PRIMARY KEY,wallet_id UUID NOT NULL REFERENCES scope_commerce_wallets(wallet_id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 50 AND 100000),
 status TEXT NOT NULL CHECK(status IN ('reserved','paid','cancelled','refund_pending','refunded')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_reservations (
 purchase_id UUID PRIMARY KEY REFERENCES scope_commerce_purchases(purchase_id),
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('held','consumed','released')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_allocations (
 purchase_id UUID NOT NULL REFERENCES scope_commerce_reservations(purchase_id),
 lot_id UUID NOT NULL REFERENCES scope_commerce_funding_lots(lot_id),
 gross_micro_usd BIGINT NOT NULL CHECK(gross_micro_usd>0),
 fee_micro_usd BIGINT NOT NULL CHECK(fee_micro_usd>=0),
 PRIMARY KEY(purchase_id,lot_id)
);
CREATE TABLE IF NOT EXISTS scope_commerce_financial_events (
 event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, reference_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_obligations (
 obligation_id UUID PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN
 ('source_refund','transfer','payout','transfer_reversal','recovery')),
 wallet_id UUID REFERENCES scope_commerce_wallets(wallet_id),
 seller_id UUID REFERENCES scope_commerce_sellers(seller_id),
 funding_lot_id UUID REFERENCES scope_commerce_funding_lots(lot_id),
 amount_micro_usd BIGINT NOT NULL CHECK(amount_micro_usd>0),
 fee_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(fee_micro_usd>=0),
 status TEXT NOT NULL CHECK(status IN ('queued','dispatching','unknown','pending','succeeded','failed','manual_review')),
 idempotency_key TEXT NOT NULL UNIQUE, provider_id TEXT UNIQUE,
 source_id TEXT, first_dispatch_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
 next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_withdrawals (
 withdrawal_id UUID PRIMARY KEY,user_id TEXT,seller_id UUID NOT NULL REFERENCES scope_commerce_sellers(seller_id),
 net_cents INTEGER NOT NULL CHECK(net_cents>=50),gross_micro_usd BIGINT NOT NULL CHECK(gross_micro_usd>0),
 fee_micro_usd BIGINT NOT NULL CHECK(fee_micro_usd>=0),transfer_id TEXT UNIQUE,payout_id TEXT UNIQUE,
 settled_micro_usd BIGINT CHECK(settled_micro_usd>=0),
 account_id TEXT,country TEXT,livemode BOOLEAN,
 status TEXT NOT NULL CHECK(status IN ('queued','transferred','pending','succeeded','failed','unknown')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_withdrawal_allocations (
 withdrawal_id UUID NOT NULL REFERENCES scope_commerce_withdrawals(withdrawal_id),
 purchase_id UUID NOT NULL REFERENCES scope_commerce_purchases(purchase_id),
 amount_micro_usd BIGINT NOT NULL CHECK(amount_micro_usd>=0),
 debt_micro_usd BIGINT NOT NULL CHECK(debt_micro_usd>=0),PRIMARY KEY(withdrawal_id,purchase_id)
);
CREATE TABLE IF NOT EXISTS scope_commerce_transfer_recoveries (
 recovery_id UUID PRIMARY KEY,dispute_id TEXT NOT NULL,
 funding_lot_id UUID NOT NULL REFERENCES scope_commerce_funding_lots(lot_id),
 withdrawal_id UUID NOT NULL REFERENCES scope_commerce_withdrawals(withdrawal_id),
 seller_id UUID NOT NULL REFERENCES scope_commerce_sellers(seller_id),
 amount_micro_usd BIGINT NOT NULL CHECK(amount_micro_usd>0),
 recovered_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(recovered_micro_usd BETWEEN 0 AND amount_micro_usd),
 next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 restored_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(dispute_id,withdrawal_id)
);
CREATE INDEX IF NOT EXISTS scope_commerce_transfer_recoveries_due
 ON scope_commerce_transfer_recoveries(next_check_at,recovery_id)
 WHERE recovered_micro_usd<amount_micro_usd;
CREATE INDEX IF NOT EXISTS scope_commerce_obligations_due ON scope_commerce_obligations(next_check_at)
 WHERE status IN ('queued','unknown','pending');
CREATE TABLE IF NOT EXISTS scope_commerce_source_refund_allocations (
 refund_id UUID NOT NULL REFERENCES scope_commerce_obligations(obligation_id) DEFERRABLE INITIALLY DEFERRED,
 lot_id UUID NOT NULL REFERENCES scope_commerce_funding_lots(lot_id),
 amount_micro_usd BIGINT NOT NULL CHECK(amount_micro_usd>0),
 fee_micro_usd BIGINT NOT NULL CHECK(fee_micro_usd>=0),PRIMARY KEY(refund_id,lot_id)
);

CREATE TABLE IF NOT EXISTS scope_commerce_provider_operations (
 operation_id UUID PRIMARY KEY,user_id TEXT,kind TEXT NOT NULL,request_hash TEXT NOT NULL,
 request_json JSONB NOT NULL,status TEXT NOT NULL CHECK(status IN
 ('prepared','submitted','succeeded','failed','reconciliation_required')),
 provider_id TEXT,provider_response JSONB,lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(kind,operation_id)
);
CREATE TABLE IF NOT EXISTS scope_commerce_stripe_customers (
 user_id TEXT PRIMARY KEY,customer_id TEXT UNIQUE NOT NULL,livemode BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS scope_commerce_seller_accounts (
 user_id TEXT PRIMARY KEY,account_id TEXT UNIQUE NOT NULL,country TEXT NOT NULL,
 livemode BOOLEAN NOT NULL,eligible BOOLEAN NOT NULL DEFAULT FALSE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS scope_commerce_provider_events (
 event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,livemode BOOLEAN NOT NULL,
 status TEXT NOT NULL DEFAULT 'received',created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS scope_commerce_provider_events_due
 ON scope_commerce_provider_events(next_check_at,event_id) WHERE status='received';

CREATE OR REPLACE FUNCTION scope_commerce_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Privacy detachment alone is permitted; immutable tariff/quote money and
 -- authority bindings cannot be changed along with an identity scrub.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('scope_commerce_tariffs','scope_commerce_quotes')
 AND to_jsonb(NEW)-ARRAY['owner_user_id','payer_user_id','purpose']=to_jsonb(OLD)-ARRAY['owner_user_id','payer_user_id','purpose']
 AND (to_jsonb(NEW)->>'purpose' IS NULL OR to_jsonb(NEW)->>'purpose'=to_jsonb(OLD)->>'purpose')
 AND (to_jsonb(NEW)->>'owner_user_id' IS NULL OR to_jsonb(NEW)->>'owner_user_id'=to_jsonb(OLD)->>'owner_user_id')
 AND (to_jsonb(NEW)->>'payer_user_id' IS NULL OR to_jsonb(NEW)->>'payer_user_id'=to_jsonb(OLD)->>'payer_user_id') THEN
 RETURN NEW;
 END IF;
 RAISE EXCEPTION 'scope commerce immutable record' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION scope_commerce_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT COALESCE(sum(micro_usd),0) FROM scope_commerce_postings WHERE entry_id=NEW.entry_id)<>0
 OR (SELECT count(*) FROM scope_commerce_postings WHERE entry_id=NEW.entry_id)<2 THEN
 RAISE EXCEPTION 'scope commerce unbalanced journal' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION scope_commerce_posting_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_xid xid8;
BEGIN
 SELECT xmin::text::xid8 INTO journal_xid FROM scope_commerce_journal WHERE entry_id=NEW.entry_id;
 IF journal_xid IS NULL OR pg_xact_status(journal_xid) IS DISTINCT FROM 'in progress' THEN
 RAISE EXCEPTION 'cannot append to committed scope commerce entry' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['scope_commerce_environment','scope_commerce_journal','scope_commerce_postings','scope_commerce_tariffs','scope_commerce_quotes','scope_commerce_financial_events'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=t||'_immutable' AND tgrelid=t::regclass) THEN
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION scope_commerce_immutable()',t||'_immutable',t);
 END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='scope_commerce_journal_balanced' AND tgrelid='scope_commerce_journal'::regclass) THEN
 CREATE CONSTRAINT TRIGGER scope_commerce_journal_balanced AFTER INSERT ON scope_commerce_journal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scope_commerce_balanced();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='scope_commerce_postings_balanced' AND tgrelid='scope_commerce_postings'::regclass) THEN
 CREATE CONSTRAINT TRIGGER scope_commerce_postings_balanced AFTER INSERT ON scope_commerce_postings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scope_commerce_balanced();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='scope_commerce_posting_admission' AND tgrelid='scope_commerce_postings'::regclass) THEN
 CREATE TRIGGER scope_commerce_posting_admission BEFORE INSERT ON scope_commerce_postings
 FOR EACH ROW EXECUTE FUNCTION scope_commerce_posting_admission();
 END IF;
END $$;
COMMENT ON TABLE scope_commerce_journal IS 'Scope commerce owns immutable financial metadata; opaque references only, no personal information payload. Append-only obligations survive erasure; retain per financial retention policy.';
COMMENT ON TABLE scope_commerce_purchases IS 'Scope commerce owns workflow and encrypted-only temporary export staging, never PKM. Direct asyncpg locks; scope/consent authority stays with canonical caller. Clear ciphertext on revoke/expiry/erasure; retain opaque financial references.';

-- Extend the existing account-deletion write barrier to these identity rows.
DO $$ BEGIN
 IF to_regprocedure('install_account_deletion_write_guards()') IS NOT NULL THEN
  PERFORM install_account_deletion_write_guards();
 END IF;
END $$;

-- A paid export can stage after the caller enumerates refresh inputs but before
-- its PKM mutation commits. Catch up inside that same source transaction, also
-- for terms awaiting their fixed activation time. This schedules owner work;
-- it never exposes a token/export or changes the purchased expiry.
CREATE OR REPLACE FUNCTION scope_commerce_queue_continuous_refresh_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 v_tokens TEXT[];
 v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
 IF NEW.domain='source_library' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
   IF TG_TABLE_NAME='pkm_manifests' THEN
     IF NEW.manifest_version IS NOT DISTINCT FROM OLD.manifest_version THEN RETURN NEW; END IF;
   ELSE
     IF NEW.content_revision IS NOT DISTINCT FROM OLD.content_revision
        AND NEW.manifest_revision IS NOT DISTINCT FROM OLD.manifest_revision THEN RETURN NEW; END IF;
   END IF;
 END IF;
 -- Canonical PKM writers already own this lock before touching source rows.
 -- Never acquire the commerce gate here: staging orders gate -> source lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id||':'||NEW.domain,0));
 SELECT array_agg(e.consent_token ORDER BY e.consent_token) INTO v_tokens
 FROM scope_commerce_purchases p JOIN consent_exports e
   ON e.user_id=p.owner_user_id AND e.grant_id=p.request_id
  AND e.scope=p.machine_scope AND e.scope_handle=p.scope_handle
  AND e.app_id=p.buyer_app_id
  AND replace(e.export_id::text,'-','')=replace(p.export_id,'-','')
  AND e.recipient_key_fingerprint=p.recipient_key_fingerprint
  AND e.expires_at=p.expires_at
  AND encode(sha256(convert_to(e.consent_token,'UTF8')),'hex')=p.consent_token_hash
 WHERE p.owner_user_id=NEW.user_id AND p.status='staged' AND p.erased_at IS NULL
   AND split_part(p.machine_scope,'.',1)='attr'
   AND split_part(p.machine_scope,'.',2)=NEW.domain AND p.expires_at>v_now
   AND e.envelope_version=2 AND e.refresh_policy='continuous_until_expiry'
   AND NULLIF(e.wrapped_key_bundle->>'wrapped_export_key','') IS NOT NULL AND e.export_key IS NULL
   AND EXISTS(SELECT 1 FROM consent_audit a WHERE a.token_id=e.consent_token
     AND a.user_id=p.owner_user_id AND a.request_id=p.request_id AND a.scope=p.machine_scope
     AND a.action='CONSENT_GRANTED' AND a.metadata->>'commercial_required'='true'
     AND a.metadata->>'commerce_purchase_id'=p.purchase_id::text);
 IF COALESCE(cardinality(v_tokens),0)=0 THEN RETURN NEW; END IF;
 INSERT INTO consent_export_refresh_jobs(
   user_id,consent_token,granted_scope,status,trigger_domain,trigger_paths,
   requested_at,last_error,attempt_count,claim_id,claimed_at,claim_expires_at,
   expected_export_revision,created_at,updated_at)
 SELECT NEW.user_id,e.consent_token,e.scope,'pending',NEW.domain,'[]'::jsonb,
   v_now,NULL,COALESCE(j.attempt_count,0),NULL,NULL,NULL,e.export_revision,v_now,v_now
 FROM consent_exports e LEFT JOIN consent_export_refresh_jobs j
   ON j.consent_token=e.consent_token
 WHERE e.consent_token=ANY(v_tokens)
 ON CONFLICT(consent_token) DO UPDATE SET status='pending',
   trigger_domain=EXCLUDED.trigger_domain,requested_at=EXCLUDED.requested_at,
   last_error=NULL,claim_id=NULL,claimed_at=NULL,claim_expires_at=NULL,
   expected_export_revision=EXCLUDED.expected_export_revision,updated_at=EXCLUDED.updated_at;
 UPDATE consent_exports SET refresh_status='refresh_pending' WHERE consent_token=ANY(v_tokens);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scope_commerce_pkm_manifest_refresh ON pkm_manifests;
CREATE CONSTRAINT TRIGGER scope_commerce_pkm_manifest_refresh
 AFTER INSERT OR UPDATE ON pkm_manifests DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION scope_commerce_queue_continuous_refresh_v1();
DROP TRIGGER IF EXISTS scope_commerce_pkm_content_refresh ON pkm_blobs;
CREATE CONSTRAINT TRIGGER scope_commerce_pkm_content_refresh
 AFTER INSERT OR UPDATE ON pkm_blobs DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION scope_commerce_queue_continuous_refresh_v1();
COMMIT;
