-- LoadForm — plan limits and the quota a request is checked against.
--
-- 20260811010000_usage_tracking.sql built the ledger and the rollup but left
-- enforcement out ("Once quota enforcement goes in..."). This adds the limits
-- and the single function both Edge Functions call to decide whether to serve
-- a request.
--
-- Two deliberate choices:
--
-- 1. Limits live in a table, not in function code, so tightening the free cap
--    is an UPDATE rather than a redeploy of every function. Same reasoning as
--    the overridable RATES in _shared/usage.ts.
--
-- 2. The cap applies to EVERY user until real subscriptions exist, including
--    org members. Exempting orgs would be a one-step bypass: org creation is
--    self-serve, so anyone could sign up, create an org, and uncap themselves.
--    The seam for billing is organizations.plan — when a plan is set, its row
--    here governs. Crucially, `plan` is not user-writable: 20260812000000
--    revoked table-wide UPDATE on organizations and re-granted only (name),
--    so an org admin cannot promote their own org onto a bigger plan.

-- ─── plan_limits ────────────────────────────────────────────────────────────

create table if not exists public.plan_limits (
  plan text primary key,

  -- Capture sessions per billing day. NULL means unlimited.
  --
  -- Capture sessions, not extractions, is the unit that matches both the user's
  -- mental model ("a load") and the cost driver (a session is one Deepgram
  -- token grant and its audio minutes). Enforcing on loads_extracted would be
  -- wrong by two orders of magnitude: auto-extract re-runs every 4s during a
  -- live call, so a single 3-minute call produces ~45 load_extracted rows and a
  -- cap of 3 would cut a dispatcher off seconds into their first call.
  daily_captures integer,

  -- Extractions per billing day. NULL means unlimited.
  --
  -- A cost backstop, not a product limit — it has to sit well above what a
  -- legitimate long call needs (~15/minute of conversation). It bounds two
  -- things the capture cap alone doesn't: a runaway auto-extract loop, and
  -- someone calling the extract function directly without ever capturing.
  daily_extractions integer,

  created_at timestamptz not null default now()
);

alter table public.plan_limits enable row level security;

-- Readable so the app can show "2 of 3 loads left today" without guessing the
-- number. No write grant at all: service role only.
grant select on public.plan_limits to authenticated;

create policy "plan limits are readable by any signed-in user"
  on public.plan_limits for select
  to authenticated
  using (true);

-- 3 captures/day is enough to evaluate LoadForm on real broker calls and not
-- enough to run a shift on. At ~$0.03 of provider spend per load, that caps a
-- non-paying account near $2.70/month.
insert into public.plan_limits (plan, daily_captures, daily_extractions)
values ('free', 3, 500)
on conflict (plan) do nothing;

-- ─── quota_status() ─────────────────────────────────────────────────────────
--
-- One round trip for "what is this user allowed, and what have they used
-- today". Keeps the billing-day boundary in SQL for the same reason
-- usage_summary() does: America/Chicago is defined once and nothing
-- reimplements it.
--
-- security invoker: the Edge Functions call this with the service role, which
-- bypasses RLS and therefore reads true totals. A signed-in user calling it
-- for themselves reads their own rows under RLS. Passing someone else's id
-- returns zeros rather than their data.

create or replace function public.quota_status(p_user_id uuid default auth.uid())
returns table (
  plan text,
  captures_used integer,
  captures_limit integer,
  extractions_used integer,
  extractions_limit integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with resolved_plan as (
    select coalesce(
      (
        select coalesce(o.plan, 'free')
        from public.organization_members m
        join public.organizations o on o.id = m.org_id
        where m.user_id = p_user_id
          and m.status = 'active'
        limit 1
      ),
      'free'
    ) as plan
  ),
  limits as (
    select
      r.plan,
      l.daily_captures,
      l.daily_extractions
    from resolved_plan r
    -- An unknown plan name falls back to the free row rather than to
    -- unlimited, so a typo in organizations.plan can't hand out free capacity.
    left join public.plan_limits l
      on l.plan = coalesce(
        (select plan from public.plan_limits where plan = r.plan),
        'free'
      )
  ),
  today as (
    select
      coalesce(capture_sessions, 0) as captures,
      coalesce(loads_extracted, 0) as extractions
    from public.usage_daily
    where user_id = p_user_id
      and day = public.billing_day(now())
  )
  select
    limits.plan,
    coalesce((select captures from today), 0)::integer,
    limits.daily_captures,
    coalesce((select extractions from today), 0)::integer,
    limits.daily_extractions
  from limits;
$$;

grant execute on function public.quota_status(uuid) to authenticated;

comment on function public.quota_status(uuid) is
  'Plan limits plus today''s usage for one user. Called by the Edge Functions '
  'before spending provider money, and by the app to display remaining quota.';

-- ─── usage_summary(): report loads as capture sessions ──────────────────────
--
-- The original version reported loads_today as sum(loads_extracted). That
-- counts *extractions*, and auto-extract re-runs every ~4s during a live call,
-- so a single 3-minute call displayed as ~45 "loads today". Harmless while
-- nothing enforced a limit; actively confusing now that the cap is 3 captures a
-- day, because the number on screen would contradict the number being enforced.
--
-- Capture sessions is the unit the cap uses, so it is the unit shown. The
-- extraction counts stay available as separate columns for cost analysis.
--
-- Dropped rather than replaced: Postgres will not let CREATE OR REPLACE change
-- a function's return type, and this adds columns.

drop function if exists public.usage_summary(uuid);

create or replace function public.usage_summary(p_user_id uuid default auth.uid())
returns table (
  -- "Loads" as the user understands them, and as the quota counts them.
  captures_today integer,
  captures_month integer,
  -- Extractions. Cost telemetry, not a user-facing load count.
  extractions_today integer,
  extractions_month integer,
  audio_seconds_month bigint,
  est_cost_usd_month numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(capture_sessions) filter (
      where day = public.billing_day(now())
    ), 0)::integer,
    coalesce(sum(capture_sessions), 0)::integer,
    coalesce(sum(loads_extracted) filter (
      where day = public.billing_day(now())
    ), 0)::integer,
    coalesce(sum(loads_extracted), 0)::integer,
    coalesce(sum(audio_seconds), 0)::bigint,
    coalesce(sum(est_cost_usd), 0)::numeric
  from public.usage_daily
  where user_id = p_user_id
    and day >= date_trunc('month', public.billing_day(now()))::date;
$$;

grant execute on function public.usage_summary(uuid) to authenticated;
