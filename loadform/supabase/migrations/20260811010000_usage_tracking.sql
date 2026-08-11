-- Usage metering.
--
-- Ships BEFORE any payment system on purpose: every price in the plan is
-- currently a guess, and a few weeks of real events replaces guessing with
-- measurement (actual loads/day distribution, actual minutes per load).
--
-- Two tables:
--   usage_events — append-only truth. Never updated, never deleted.
--   usage_daily  — a derived rollup, purely a cache for fast quota checks.
--
-- If the two ever disagree, usage_events wins; rebuild_usage_daily() restores
-- the cache from scratch.
--
-- Writes come only from Edge Functions using the service role. Clients get
-- SELECT on their own rows and nothing else — a user who could INSERT could
-- forge usage, and a user who could DELETE could erase what they owe.

-- ─── Billing day ────────────────────────────────────────────────────────────
--
-- A daily cap needs a reset boundary, and UTC is the wrong one here. Midnight
-- UTC is 05:00 in Tashkent and ~19:00 US Central — which would slice a US
-- working day in half and reset a dispatcher's quota mid-shift. The work
-- follows US freight hours, so the billing day does too.
--
-- STABLE, not IMMUTABLE: the timezone database can change under us, so this
-- cannot be used in an index expression (we don't need it to be).
create or replace function public.billing_day(ts timestamptz)
returns date
language sql
stable
as $$
  select (ts at time zone 'America/Chicago')::date;
$$;

comment on function public.billing_day(timestamptz) is
  'Billing-day boundary for quotas. US Central so a daily reset never lands mid US working day.';

-- ─── usage_events — append-only ledger ──────────────────────────────────────

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Correlates every event belonging to one capture session, so a session's
  -- cost can be totalled across the token grant, its extractions, and its end.
  capture_id uuid,

  event_type text not null check (
    event_type in ('capture_started', 'capture_ended', 'load_extracted')
  ),

  load_id uuid references public.loads(id) on delete set null,
  source text check (source in ('mic', 'system', 'mixed')),

  -- Server-observed. Trustworthy — these come from the provider's own response
  -- inside an Edge Function and are safe to bill on.
  llm_input_tokens integer,
  llm_output_tokens integer,

  -- CLIENT-REPORTED. Analytics only. A user controls this number, so it must
  -- never gate access or compute a charge. It exists to answer "how many audio
  -- minutes does an average load actually take?", which is what sets the
  -- price. For real Deepgram spend, reconcile against Deepgram's usage API.
  audio_seconds integer,

  -- Cost snapshotted at write time, so historical rows stay accurate when
  -- provider rates change later.
  est_cost_usd numeric(12, 6) not null default 0,

  -- Edge Functions can be retried. A repeated call with the same key is
  -- rejected by this constraint rather than double-counted.
  idempotency_key text unique,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

create index if not exists usage_events_capture_idx
  on public.usage_events (capture_id)
  where capture_id is not null;

alter table public.usage_events enable row level security;

-- Read-only for the owner. No insert/update/delete grant to `authenticated`
-- at all — the service role bypasses RLS and is the only writer.
grant select on public.usage_events to authenticated;

create policy "usage_events owner read"
  on public.usage_events for select
  to authenticated
  using (auth.uid() = user_id);

-- ─── usage_daily — derived rollup ───────────────────────────────────────────
--
-- Quota is checked on every capture start and every extraction. Aggregating
-- usage_events on each of those gets slower as history grows; this makes the
-- daily check a single primary-key lookup and the monthly check a scan of at
-- most 31 rows.

create table if not exists public.usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  capture_sessions integer not null default 0,
  loads_extracted integer not null default 0,
  audio_seconds bigint not null default 0,
  llm_input_tokens bigint not null default 0,
  llm_output_tokens bigint not null default 0,
  est_cost_usd numeric(12, 6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.usage_daily enable row level security;

grant select on public.usage_daily to authenticated;

create policy "usage_daily owner read"
  on public.usage_daily for select
  to authenticated
  using (auth.uid() = user_id);

-- ─── Rollup maintenance ─────────────────────────────────────────────────────

create or replace function public.usage_events_rollup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.usage_daily as d (
    user_id, day, capture_sessions, loads_extracted,
    audio_seconds, llm_input_tokens, llm_output_tokens, est_cost_usd
  )
  values (
    new.user_id,
    public.billing_day(new.created_at),
    case when new.event_type = 'capture_started' then 1 else 0 end,
    case when new.event_type = 'load_extracted' then 1 else 0 end,
    coalesce(new.audio_seconds, 0),
    coalesce(new.llm_input_tokens, 0),
    coalesce(new.llm_output_tokens, 0),
    new.est_cost_usd
  )
  on conflict (user_id, day) do update set
    capture_sessions  = d.capture_sessions  + excluded.capture_sessions,
    loads_extracted   = d.loads_extracted   + excluded.loads_extracted,
    audio_seconds     = d.audio_seconds     + excluded.audio_seconds,
    llm_input_tokens  = d.llm_input_tokens  + excluded.llm_input_tokens,
    llm_output_tokens = d.llm_output_tokens + excluded.llm_output_tokens,
    est_cost_usd      = d.est_cost_usd      + excluded.est_cost_usd,
    updated_at        = now();

  return new;
end;
$$;

-- `create trigger if not exists` does not exist in Postgres, so drop first to
-- keep this migration re-runnable.
drop trigger if exists usage_events_rollup_trg on public.usage_events;

create trigger usage_events_rollup_trg
  after insert on public.usage_events
  for each row execute function public.usage_events_rollup();

-- The rollup is a cache. This rebuilds it from the ledger — run it after any
-- backfill, or if you ever suspect drift.
create or replace function public.rebuild_usage_daily()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.usage_daily;

  insert into public.usage_daily (
    user_id, day, capture_sessions, loads_extracted,
    audio_seconds, llm_input_tokens, llm_output_tokens, est_cost_usd, updated_at
  )
  select
    user_id,
    public.billing_day(created_at) as day,
    count(*) filter (where event_type = 'capture_started'),
    count(*) filter (where event_type = 'load_extracted'),
    coalesce(sum(audio_seconds), 0),
    coalesce(sum(llm_input_tokens), 0),
    coalesce(sum(llm_output_tokens), 0),
    coalesce(sum(est_cost_usd), 0),
    now()
  from public.usage_events
  group by user_id, public.billing_day(created_at);
end;
$$;

revoke all on function public.rebuild_usage_daily() from public, anon, authenticated;

-- ─── Quota / display summary ────────────────────────────────────────────────
--
-- SECURITY INVOKER on purpose: it reads usage_daily through RLS, so a user
-- passing someone else's id simply gets zeroes. Edge Functions calling with
-- the service role bypass RLS and can summarise any user.

create or replace function public.usage_summary(p_user_id uuid default auth.uid())
returns table (
  loads_today integer,
  loads_month integer,
  capture_sessions_month integer,
  audio_seconds_month bigint,
  est_cost_usd_month numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(loads_extracted) filter (
      where day = public.billing_day(now())
    ), 0)::integer,
    coalesce(sum(loads_extracted), 0)::integer,
    coalesce(sum(capture_sessions), 0)::integer,
    coalesce(sum(audio_seconds), 0)::bigint,
    coalesce(sum(est_cost_usd), 0)::numeric
  from public.usage_daily
  where user_id = p_user_id
    and day >= date_trunc('month', public.billing_day(now()))::date;
$$;

grant execute on function public.usage_summary(uuid) to authenticated;
grant execute on function public.billing_day(timestamptz) to authenticated;
