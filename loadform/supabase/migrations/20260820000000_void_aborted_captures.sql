-- Void the quota cost of a capture that produced nothing.
--
-- The daily cap is spent at token-mint time, in deepgram-token, because that
-- is the only server-side chokepoint before Deepgram money is spent. The side
-- effect is that the counter measures orb presses rather than loads: press,
-- record nothing, stop, and a dispatcher is down one of three free "loads"
-- with nothing to show for it. Everything user-facing calls that number loads
-- — the usage pill, the 402 copy — so the mismatch reads as a bug, because it
-- is one.
--
-- What makes this fixable is that the two facts needed to recognise an
-- abandoned session are both server-observed:
--
--   * how long it ran — `created_at` on the capture_started and capture_ended
--     rows is a server default on both, so the wall clock between them is not
--     something a client can shade. usage_events.audio_seconds is the number a
--     client sends and is explicitly barred from gating access; this is not
--     that number.
--   * whether it produced anything — load_extracted rows are written by the
--     extract function from its own result, never by the client.
--
-- A capture that stopped within the grace window without extracting a single
-- load is therefore an abort, provably, and its quota cost is given back. The
-- Deepgram seconds it did burn stay on the ledger: we spent them, the
-- dispatcher just should not lose a load over it.
--
-- The exploit worth checking is "abort forever, transcribe free". It does not
-- pay: the refund is only reachable by actually stopping inside the grace
-- window, so each attempt buys a few seconds of audio and costs a round trip.
-- Streaming for ten minutes and *claiming* fifteen seconds earns nothing,
-- because the claim is not what is read.

-- ─── Ledger invariant, amended ──────────────────────────────────────────────
--
-- 20260811010000 opens with "usage_events — append-only truth. Never updated,
-- never deleted." The first half of that no longer holds literally, so state
-- the rule that replaces it: no row is ever deleted, and no *measured* column
-- is ever rewritten — tokens, seconds and costs are what they were when they
-- were observed. `voided_at` is an annotation the ledger keeps about its own
-- rows, and the only column any trigger is allowed to update.

alter table public.usage_events
  add column if not exists voided_at timestamptz;

comment on column public.usage_events.voided_at is
  'Set on a capture_started that turned out to be an abort, so it stops '
  'counting against the daily cap. The row itself is never removed — the '
  'session did happen and its cost was real.';

-- ─── Grace window ───────────────────────────────────────────────────────────
--
-- A function rather than a literal in the trigger body, for the reason
-- plan_limits exists: the number is a judgement call that will want retuning
-- once there is data on how long a real mis-start takes to notice, and this
-- way retuning it is one CREATE OR REPLACE instead of an edit inside branching
-- logic.
--
-- Fifteen seconds is long enough to cover "wrong input selected, stop, fix it"
-- and far short of any real broker call.

create or replace function public.aborted_capture_grace()
returns interval
language sql
immutable
as $$
  select interval '15 seconds';
$$;

comment on function public.aborted_capture_grace() is
  'How quickly a capture must stop, having extracted nothing, to be treated as '
  'an abort and refunded its quota cost.';

-- ─── Rollup, now with voiding ───────────────────────────────────────────────
--
-- Both directions live here because both are the same question asked at the
-- two moments it can be answered:
--
--   capture_ended  — did this session end fast enough, with nothing to show?
--   load_extracted — a session that was written off just produced a load
--                    after all, so put the charge back.
--
-- The second branch is not defensive padding. Auto-extract fires on a 4s
-- debounce, so a session can genuinely extract a load and end inside a 15s
-- grace window, and the extract call can land after the end report. Without
-- the reversal that ordering hands out a free load.

create or replace function public.usage_events_rollup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start_id  uuid;
  v_start_at  timestamptz;
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

  -- ── An ended session that never produced a load ──────────────────────────
  if new.event_type = 'capture_ended' and new.capture_id is not null then
    select e.id, e.created_at
      into v_start_id, v_start_at
      from public.usage_events e
     where e.capture_id = new.capture_id
       and e.user_id = new.user_id
       and e.event_type = 'capture_started'
       and e.voided_at is null
     limit 1;

    if v_start_id is not null
       and new.created_at - v_start_at <= public.aborted_capture_grace()
       and not exists (
         select 1
           from public.usage_events x
          where x.capture_id = new.capture_id
            and x.event_type = 'load_extracted'
       )
    then
      update public.usage_events
         set voided_at = now()
       where id = v_start_id;

      -- Credited against the day the session *started*, which is the day it
      -- was counted against. A 15-second capture can still straddle midnight
      -- US Central, and refunding tomorrow for something charged yesterday
      -- would leave both days wrong.
      update public.usage_daily
         set capture_sessions = greatest(capture_sessions - 1, 0),
             updated_at = now()
       where user_id = new.user_id
         and day = public.billing_day(v_start_at);
    end if;
  end if;

  -- ── A written-off session that produced a load after all ─────────────────
  if new.event_type = 'load_extracted' and new.capture_id is not null then
    -- The guard is the UPDATE's own WHERE, so the repeat load_extracted rows
    -- auto-extract emits during one call cannot each re-charge the session:
    -- only the first finds voided_at set.
    update public.usage_events
       set voided_at = null
     where capture_id = new.capture_id
       and user_id = new.user_id
       and event_type = 'capture_started'
       and voided_at is not null
    returning created_at into v_start_at;

    if v_start_at is not null then
      update public.usage_daily
         set capture_sessions = capture_sessions + 1,
             updated_at = now()
       where user_id = new.user_id
         and day = public.billing_day(v_start_at);
    end if;
  end if;

  return new;
end;
$$;

-- ─── Rebuild, now with voiding ──────────────────────────────────────────────
--
-- usage_daily stays a cache that the ledger can always reconstruct. voided_at
-- lives on the ledger, so the rebuild just has to respect it rather than
-- re-derive who was voided and when.

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
    count(*) filter (
      where event_type = 'capture_started' and voided_at is null
    ),
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
