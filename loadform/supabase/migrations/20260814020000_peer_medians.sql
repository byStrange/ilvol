-- The two numbers a dispatcher needs to read their own scorecard against the
-- team, and nothing else.
--
-- A regular dispatcher cannot read peer loads or the roster: the loads SELECT
-- policy is admin-only, and organization_members is visible only as your own
-- row. The quadrant verdict (performing / easy freight / not their fault /
-- needs coaching) is a comparison to the team median, so without a server-side
-- read it simply could not exist for the person it is about.
--
-- This returns only aggregates — the median process score and median booking
-- rate across qualifying peers, plus how many peers qualified. No per-person
-- row, no per-person revenue, nothing that lets one dispatcher see another's
-- numbers. The comparison is the product; the individuals behind it are not.
--
-- "Qualifying" mirrors aggregateDispatcherStats in src/organizations.js exactly:
-- an active member with at least MIN_SCORED_CALLS (10) scored calls and at least
-- one resolved outcome. The dispatcher being viewed is themselves counted among
-- their peers — that is what the admin readPerformance does too, so a dispatcher
-- sees the same verdict an owner would.

create or replace function public.peer_medians()
returns table (
  median_process_score numeric,
  median_booking_rate numeric,
  peer_count integer
)
language sql
security definer
set search_path = public
as $$
  with caller as (
    -- The signed-in user's active membership, which gives us their org.
    select org_id
    from organization_members
    where user_id = auth.uid()
      and status = 'active'
    limit 1
  ),
  peer_stats as (
    select
      om.user_id,
      -- processScore = avg(call_score) over scored calls, shown only past the
      -- sample floor (organizations.js: MIN_SCORED_CALLS = 10).
      count(*) filter (where l.call_score is not null)             as scored_calls,
      avg(l.call_score) filter (where l.call_score is not null)    as avg_score,
      count(*) filter (where l.outcome = 'booked')                 as booked,
      count(*) filter (where l.outcome = 'lost')                   as lost
    from organization_members om
    left join loads l
      on l.org_id = om.org_id
     and l.user_id = om.user_id
    where om.org_id = (select org_id from caller)
      and om.status = 'active'
      and om.user_id is not null
    group by om.user_id
  ),
  qualifying as (
    select
      avg_score                                                as process_score,
      booked::numeric / nullif(booked + lost, 0)               as booking_rate
    from peer_stats
    where scored_calls >= 10
      and (booked + lost) > 0
  )
  -- percentile_cont returns double precision; cast back explicitly so the
  -- result matches the declared numeric columns rather than relying on an
  -- implicit coercion at return time.
  --
  -- percentile_cont(0.5) averages the two middle values on an even count,
  -- which is exactly what median() in src/organizations.js does — the two must
  -- agree or a dispatcher and their owner would read the same person
  -- differently.
  select
    percentile_cont(0.5) within group (order by process_score)::numeric as median_process_score,
    percentile_cont(0.5) within group (order by booking_rate)::numeric  as median_booking_rate,
    count(*)::integer                                                   as peer_count
  from qualifying;
$$;

grant execute on function public.peer_medians() to authenticated;
