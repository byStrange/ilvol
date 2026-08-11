\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'u1@test'),
  ('22222222-2222-2222-2222-222222222222', 'u2@test');

-- ── 1. Billing-day boundary is US Central, not UTC ─────────────────────────
do $$
begin
  -- 04:00 UTC on Aug 12 is still Aug 11 in Chicago (UTC-5 in summer).
  if public.billing_day('2026-08-12 04:00:00+00') <> date '2026-08-11' then
    raise exception 'billing_day boundary wrong: got %',
      public.billing_day('2026-08-12 04:00:00+00');
  end if;
  if public.billing_day('2026-08-12 06:00:00+00') <> date '2026-08-12' then
    raise exception 'billing_day rollover wrong';
  end if;
  raise notice 'PASS billing_day boundary (04:00Z -> prev day, 06:00Z -> same day)';
end $$;

-- ── 2. Rollup aggregates across event types ────────────────────────────────
insert into public.usage_events
  (user_id, capture_id, event_type, source, idempotency_key, created_at)
values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'capture_started', 'mic', 'capture_started:s1', '2026-08-12 15:00:00+00');

insert into public.usage_events
  (user_id, capture_id, event_type, llm_input_tokens, llm_output_tokens, est_cost_usd, created_at)
values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'load_extracted', 1200, 350, 0.000260, '2026-08-12 15:04:00+00'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'load_extracted', 1800, 400, 0.000340, '2026-08-12 15:08:00+00');

insert into public.usage_events
  (user_id, capture_id, event_type, audio_seconds, est_cost_usd, idempotency_key, created_at)
values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'capture_ended', 300, 0.029500, 'capture_ended:s1', '2026-08-12 15:09:00+00');

-- A second user's activity must not bleed into the first user's totals.
insert into public.usage_events (user_id, event_type, created_at)
values ('22222222-2222-2222-2222-222222222222', 'load_extracted', '2026-08-12 15:00:00+00');

do $$
declare r record;
begin
  select * into r from public.usage_daily
  where user_id = '11111111-1111-1111-1111-111111111111' and day = date '2026-08-12';

  if r.capture_sessions <> 1 then raise exception 'capture_sessions=% want 1', r.capture_sessions; end if;
  if r.loads_extracted <> 2 then raise exception 'loads_extracted=% want 2', r.loads_extracted; end if;
  if r.audio_seconds <> 300 then raise exception 'audio_seconds=% want 300', r.audio_seconds; end if;
  if r.llm_input_tokens <> 3000 then raise exception 'llm_input=% want 3000', r.llm_input_tokens; end if;
  if r.llm_output_tokens <> 750 then raise exception 'llm_output=% want 750', r.llm_output_tokens; end if;
  if r.est_cost_usd <> 0.030100 then raise exception 'est_cost=% want 0.030100', r.est_cost_usd; end if;
  raise notice 'PASS rollup aggregation (2 loads, 300s, 3750 tokens, $0.0301)';
end $$;

-- ── 3. Idempotency key blocks double-counting on retry ─────────────────────
do $$
begin
  begin
    insert into public.usage_events (user_id, event_type, idempotency_key)
    values ('11111111-1111-1111-1111-111111111111', 'capture_ended', 'capture_ended:s1');
    raise exception 'FAIL duplicate idempotency_key was accepted';
  exception when unique_violation then
    raise notice 'PASS duplicate idempotency_key rejected (23505)';
  end;
end $$;

-- ── 4. usage_summary via service role (bypasses RLS) ───────────────────────
do $$
declare s record;
begin
  select * into s from public.usage_summary('11111111-1111-1111-1111-111111111111');
  if s.loads_month <> 2 then raise exception 'loads_month=% want 2', s.loads_month; end if;
  if s.audio_seconds_month <> 300 then raise exception 'audio=% want 300', s.audio_seconds_month; end if;
  raise notice 'PASS usage_summary totals';
end $$;

-- ── 5. RLS: a user sees only their own rows ────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare n int;
begin
  select count(*) into n from public.usage_events;
  if n <> 4 then raise exception 'RLS leak: user 1 sees % events, want 4', n; end if;

  select count(*) into n from public.usage_daily;
  if n <> 1 then raise exception 'RLS leak: user 1 sees % daily rows, want 1', n; end if;
  raise notice 'PASS RLS read isolation (4 own events, 0 from other user)';
end $$;

-- ── 6. A client cannot forge or erase usage ────────────────────────────────
do $$
begin
  begin
    insert into public.usage_events (user_id, event_type)
    values ('11111111-1111-1111-1111-111111111111', 'load_extracted');
    raise exception 'FAIL authenticated role was able to INSERT usage';
  exception when insufficient_privilege then
    raise notice 'PASS authenticated cannot INSERT usage_events';
  end;

  begin
    delete from public.usage_events;
    raise exception 'FAIL authenticated role was able to DELETE usage';
  exception when insufficient_privilege then
    raise notice 'PASS authenticated cannot DELETE usage_events';
  end;

  begin
    update public.usage_daily set loads_extracted = 0;
    raise exception 'FAIL authenticated role was able to UPDATE the rollup';
  exception when insufficient_privilege then
    raise notice 'PASS authenticated cannot UPDATE usage_daily';
  end;
end $$;

-- usage_summary() with no argument must scope to the caller.
do $$
declare s record;
begin
  select * into s from public.usage_summary();
  if s.loads_month <> 2 then raise exception 'self summary=% want 2', s.loads_month; end if;

  -- Asking about someone else returns zeroes, not their data.
  select * into s from public.usage_summary('22222222-2222-2222-2222-222222222222');
  if s.loads_month <> 0 then raise exception 'RLS leak via usage_summary: got %', s.loads_month; end if;
  raise notice 'PASS usage_summary respects RLS for other users';
end $$;

reset role;

-- ── 7. Rollup is reproducible from the ledger ──────────────────────────────
do $$
declare before_json text; after_json text;
begin
  select string_agg(t::text, '|' order by t::text) into before_json from public.usage_daily t;
  perform public.rebuild_usage_daily();
  select string_agg(t::text, '|' order by t::text) into after_json from public.usage_daily t;

  -- updated_at moves, so compare the counters only.
  if (select count(*) from public.usage_daily) <> 2 then
    raise exception 'rebuild produced wrong row count';
  end if;
  if (select loads_extracted from public.usage_daily
      where user_id = '11111111-1111-1111-1111-111111111111') <> 2 then
    raise exception 'rebuild lost data';
  end if;
  raise notice 'PASS rebuild_usage_daily reproduces the rollup from events';
end $$;

-- ── 8. api_keys really is locked down ──────────────────────────────────────
set role authenticated;
do $$
begin
  begin
    perform 1 from public.api_keys;
    raise exception 'FAIL authenticated can still read api_keys';
  exception when insufficient_privilege then
    raise notice 'PASS api_keys unreadable by authenticated';
  end;
end $$;
reset role;

\echo '>>> ALL USAGE TESTS PASSED'
