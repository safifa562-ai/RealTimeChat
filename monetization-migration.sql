-- RealTimeChat optional website checkout migration.
-- Run in Supabase SQL Editor for the SAME project used by Render.
-- This migration creates a one-time Supporter purchase ledger, not a subscription.

CREATE TABLE IF NOT EXISTS public.premium_purchases (
  order_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), -- smallest currency unit (paise)
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
  payment_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.user_premium (
  user_id BIGINT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'supporter' CHECK (plan = 'supporter'),
  purchase_order_id TEXT NOT NULL UNIQUE,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.premium_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_premium ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are added. The server accesses these tables with
-- the service-role secret held only in Render Environment.
REVOKE ALL ON TABLE public.premium_purchases FROM anon, authenticated;
REVOKE ALL ON TABLE public.user_premium FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.premium_purchases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_premium TO service_role;

CREATE INDEX IF NOT EXISTS premium_purchases_user_created_idx
  ON public.premium_purchases (user_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
