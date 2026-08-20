-- Tests for 20260820000000_void_aborted_captures.sql.
--
-- Not part of `npm test`: everything else in that script is self-contained,
-- and this needs a database with the migrations applied. Run it against a
-- local stack —
--
--     supabase db reset
--     npm run test:sql
--
-- The whole file runs inside a transaction that always rolls back, so it is
-- safe to point at a dev database with real rows in it.
--
-- Sessions are written with explicit `created_at` values. In production those
-- are server defaults, which is the entire basis of the feature; here they are
-- set by hand so a ten-minute session can be tested in a millisecond.

\set ON_ERROR_STOP on

begin;

create function pg_temp.t_user() returns uuid language plpgsql as $$
declare u uuid := gen_random_uuid();
begin insert into auth.users(id) values (u); return u; end $$;

create function pg_temp.ev(p_user uuid, p_cap uuid, p_type text, p_at timestamptz)
returns void language sql as $$
  insert into public.usage_events(user_id, capture_id, event_type, created_at)
  values (p_user, p_cap, p_type, p_at);
$$;

-- What quota_status() would read for this user: the number of loads today.
create function pg_temp.used(p_user uuid) returns integer language sql as $$
  select coalesce(sum(capture_sessions), 0)::int
    from public.usage_daily where user_id = p_user;
$$;

do $$
declare
  u uuid; c uuid; i int;
  t0 timestamptz := now();
  results text[] := '{}';
  failures int := 0;
begin
  -- Local assert. Collects rather than aborting, so one broken case does not
  -- hide the state of the other fifteen.
  create temp table assertions (label text, got int, want int) on commit drop;

  -- 1. Press the orb, record nothing, stop after 3s.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  insert into assertions values ('the press itself costs a load up front', pg_temp.used(u), 1);
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '3 seconds');
  insert into assertions values ('...and the abort gives it back', pg_temp.used(u), 0);

  -- 2. A real call.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '30 seconds');
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '4 minutes');
  insert into assertions values ('a real call still costs one load', pg_temp.used(u), 1);

  -- 3. Short, but it produced a load. Auto-extract runs on a 4s debounce, so
  --    this is not a hypothetical.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '8 seconds');
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '10 seconds');
  insert into assertions values ('a short call that extracted is charged', pg_temp.used(u), 1);

  -- 4. The ordering hazard: usage-report goes out the moment stop is pressed,
  --    so an extraction still waiting on the model lands after it.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '10 seconds');
  insert into assertions values ('voided while an extract is in flight', pg_temp.used(u), 0);
  perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '11 seconds');
  insert into assertions values ('the late extract re-charges the session', pg_temp.used(u), 1);

  -- 5. One call emits many load_extracted rows. Only one charge.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '5 seconds');
  perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '6 seconds');
  perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '7 seconds');
  perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '8 seconds');
  insert into assertions values ('repeat extracts do not re-charge', pg_temp.used(u), 1);

  -- 6/7. The window boundary.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '16 seconds');
  insert into assertions values ('past the grace window is charged', pg_temp.used(u), 1);

  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '15 seconds');
  insert into assertions values ('exactly at the boundary is refunded', pg_temp.used(u), 0);

  -- 8. The abuse case. A ten-minute session cannot buy a refund by lying about
  --    its duration, because the duration read here is not the one it sends.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '10 minutes');
  insert into assertions values ('a long stream cannot claim a refund', pg_temp.used(u), 1);

  -- 9. A crash reports no end at all, and is indistinguishable from silence.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', t0);
  insert into assertions values ('a session with no end stays charged', pg_temp.used(u), 1);

  -- 10. The reported case: fumbling the start a few times costs nothing.
  u := pg_temp.t_user();
  for i in 1..3 loop
    c := gen_random_uuid();
    perform pg_temp.ev(u, c, 'capture_started', t0);
    perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '2 seconds');
  end loop;
  insert into assertions values ('three aborts in a row cost nothing', pg_temp.used(u), 0);

  -- 11. A realistic day.
  u := pg_temp.t_user();
  for i in 1..2 loop
    c := gen_random_uuid();
    perform pg_temp.ev(u, c, 'capture_started', t0);
    perform pg_temp.ev(u, c, 'load_extracted', t0 + interval '1 minute');
    perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '3 minutes');
  end loop;
  for i in 1..3 loop
    c := gen_random_uuid();
    perform pg_temp.ev(u, c, 'capture_started', t0);
    perform pg_temp.ev(u, c, 'capture_ended', t0 + interval '4 seconds');
  end loop;
  insert into assertions values ('a mixed day counts only the real calls', pg_temp.used(u), 2);

  -- 12. A session can straddle the billing boundary. The refund has to land on
  --     the day that was charged, or both days end up wrong.
  u := pg_temp.t_user(); c := gen_random_uuid();
  perform pg_temp.ev(u, c, 'capture_started', '2026-08-19 23:59:55 America/Chicago');
  perform pg_temp.ev(u, c, 'capture_ended',   '2026-08-20 00:00:03 America/Chicago');
  insert into assertions values ('a refund across midnight nets to zero', pg_temp.used(u), 0);
  insert into assertions values ('...and leaves no day negative',
    (select coalesce(min(capture_sessions), 0)::int
       from public.usage_daily where user_id = u), 0);

  -- 13. usage_daily is a cache. Rebuilding it from the ledger has to produce
  --     exactly what the trigger maintained incrementally.
  create temp table before_rebuild on commit drop as
    select user_id, day, capture_sessions, loads_extracted from public.usage_daily;
  perform public.rebuild_usage_daily();
  insert into assertions values ('rebuild reproduces what the trigger wrote',
    (select count(*)::int
       from before_rebuild b
       full join public.usage_daily d on d.user_id = b.user_id and d.day = b.day
      where b.capture_sessions is distinct from d.capture_sessions
         or b.loads_extracted  is distinct from d.loads_extracted), 0);

  -- Report ------------------------------------------------------------------
  select array_agg(
           case when got = want then 'PASS  ' else 'FAIL  ' end
           || label
           || case when got = want then '' else '  (got ' || got || ', want ' || want || ')' end
           order by ctid
         ),
         count(*) filter (where got <> want)
    into results, failures
    from assertions;

  raise notice E'\n%\n', array_to_string(results, E'\n');

  if failures > 0 then
    raise exception '% of % assertions failed', failures, array_length(results, 1);
  end if;
end $$;

rollback;
