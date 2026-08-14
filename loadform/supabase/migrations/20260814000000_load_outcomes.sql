-- Load outcomes and the numbers behind them.
--
-- Until now a `loads` row recorded that a call was captured, never how it
-- ended. That makes every owner-facing performance number a proxy: the closest
-- thing available was `status`, which is a manual archive toggle in the history
-- panel. Reporting completed/total as a success rate would rank dispatchers by
-- how tidy they keep their history, and an owner would make staffing decisions
-- on it.
--
-- These three columns are deliberately landing ahead of the dashboard that
-- reads them. None of them can be backfilled — an outcome not recorded at the
-- time is gone — and a booking rate over four days of history is noise. The
-- data has to start accumulating before the charts are worth drawing.

-- ─── outcome ────────────────────────────────────────────────────────────────
--
-- 'pending' is the default and a legitimate resting state, not a failure: loads
-- sit unresolved while a dispatcher waits on a broker. Counting unanswered
-- loads as losses would quietly corrupt the exact metric this exists to
-- produce, so the app asks and accepts "not yet" as an answer.
--
-- Kept separate from `status` rather than replacing it. They answer different
-- questions — "did we win this load" versus "am I done looking at it" — and a
-- dispatcher archiving their history is not making a claim about the business.

alter table public.loads
  add column if not exists outcome text not null default 'pending';

alter table public.loads
  drop constraint if exists loads_outcome_check;

alter table public.loads
  add constraint loads_outcome_check
  check (outcome in ('pending', 'booked', 'lost'));

comment on column public.loads.outcome is
  'How the call ended: pending (unresolved, the default), booked (we covered '
  'the load), lost (we did not). Distinct from status, which is the history '
  'panel''s archive toggle and says nothing about the business.';

-- ─── rate_usd ───────────────────────────────────────────────────────────────
--
-- `rate` stays exactly as it is: free text, because "$2.80/mile ($2,100 total)"
-- carries nuance a number would throw away, and it is what the driver-facing
-- output prints. This column is the summable form of the same fact, parsed on
-- write (see parseRateUsd in src/loads.js).
--
-- Null means "no total could be read from the text", which is different from
-- zero and has to stay different: averaging nulls as zeroes would drag every
-- dispatcher's average rate toward the floor based on transcription quality.

alter table public.loads
  add column if not exists rate_usd numeric(12, 2);

comment on column public.loads.rate_usd is
  'Total load rate in USD, parsed from the free-text rate column. NULL when no '
  'total could be read — never coalesce to 0, which would read as a $0 load.';

-- ─── miles ──────────────────────────────────────────────────────────────────
--
-- Trip mileage, extracted from the transcript rather than computed. Brokers say
-- it out loud on nearly every call ("it's 840 miles, twenty-four hundred"), so
-- the model can pick it up for free — no geocoder, no distance API, and no
-- city-name matching to get wrong.
--
-- With rate_usd this gives rate per mile, which is the quality half of
-- carrier-side dispatch performance. Loads booked alone rewards whoever takes
-- the cheapest freight fastest; the two columns are only meaningful together.

alter table public.loads
  add column if not exists miles integer;

comment on column public.loads.miles is
  'Trip miles as stated on the call. NULL when not mentioned. With rate_usd '
  'this yields rate per mile, the counterweight to raw booking volume.';

-- The dashboard's core query is "this org's loads over a window", already
-- served by loads_org_idx. This partial index covers the narrower question the
-- team screen asks constantly — what is still unresolved — without carrying the
-- majority of rows that have already been answered.
create index if not exists loads_org_pending_idx
  on public.loads (org_id, created_at desc)
  where org_id is not null and outcome = 'pending';
