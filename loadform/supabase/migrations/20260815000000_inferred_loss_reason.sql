-- Infer why a load was lost, instead of asking the person who lost it.
--
-- 20260814010000 introduced the loss taxonomy and asked the dispatcher to pick
-- from it. In use that question is answered badly or not at all, for reasons
-- that are structural rather than fixable by better copy:
--
--   * It arrives seconds before the next call, behind a Skip button.
--   * It asks someone to file a report on themselves. Of the seven reasons,
--     exactly one (lost_on_call) reflects on the answerer, so the honest rate on
--     that one option is the rate at which people volunteer their own mistakes —
--     which is to say roughly zero. Every other answer is free to give.
--
-- A taxonomy that collects reliable answers for six reasons and unreliable ones
-- for the seventh is worse than no taxonomy: the missing seventh is the entire
-- point of the split, and its absence reads as "nobody here ever loses a load on
-- the call", which an owner will believe.
--
-- The transcript already holds the answer. "It's already covered", "that's all
-- it pays", "I need a reefer" are the broker's own words, and they map onto the
-- taxonomy one-to-one. So the question moves to the scorer, the modal loses its
-- second step, and the dispatcher is asked only what they alone know: whether
-- the load came in.
--
-- ─── 1. Provenance ──────────────────────────────────────────────────────────
--
-- Who decided the reason. Never inferred from the other columns: a null reason
-- with source 'ai' ("the scorer looked and found nothing it could evidence") and
-- a null reason with source null ("nothing has looked yet") are different facts,
-- and the backlog sweep needs to tell them apart or it will re-score the same
-- unquotable calls forever.

alter table public.loads
  add column if not exists loss_reason_source text;

alter table public.loads
  drop constraint if exists loads_loss_reason_source_check;

alter table public.loads
  add constraint loads_loss_reason_source_check
  check (loss_reason_source is null or loss_reason_source in ('ai', 'dispatcher'));

-- The verbatim words that justify the reason, under the same rule as the rubric
-- quotes: a reason the scorer cannot quote is not recorded. This is what a
-- dispatcher reads to dispute a mark against them, and without it an inferred
-- reason is just an accusation with a robot's name on it.
alter table public.loads
  add column if not exists loss_reason_quote text;

comment on column public.loads.loss_reason_source is
  'Who decided loss_reason: ''ai'' (inferred from the transcript) or '
  '''dispatcher'' (entered by hand). NULL means nothing has decided yet.';

comment on column public.loads.loss_reason_quote is
  'Verbatim transcript words evidencing loss_reason. Empty for lost_on_call, '
  'which is derived from missed rubric steps rather than quoted — see rubric.ts.';

-- ─── 2. The reason is now written by the scorer, not the client ─────────────
--
-- 20260814010000 granted a dispatcher UPDATE on loss_reason and loss_note, with
-- the reasoning that "a reason they cannot correct is a reason they will stop
-- giving honestly". That reasoning applied to a field they were asked to fill
-- in. Now that nothing in the UI asks, the same grant only means the column is
-- writable by a client that has every incentive to write 'rate_too_low' over an
-- inferred 'lost_on_call' — which is precisely the substitution the whole split
-- exists to detect.
--
-- So the loss columns join the scoring columns as service-role-only. The
-- dispatcher's own account of the call survives as loss_note, still theirs to
-- write, because a free-text note cannot silently move a number on a chart.

revoke update on public.loads from authenticated;

grant update (
  title,
  status,
  outcome,
  loss_note,
  pickup_location,
  pickup_datetime,
  pickup_type,
  pickup_window,
  delivery_location,
  delivery_datetime,
  delivery_type,
  delivery_window,
  stops,
  commodity,
  equipment_type,
  trailer_instructions,
  rate,
  rate_usd,
  miles,
  weight,
  additional_notes,
  confidence,
  transcript,
  updated_at
) on public.loads to authenticated;

-- ─── 3. Keep the reason consistent with the outcome ─────────────────────────
--
-- Reopening a lost load, or booking it after all, must drop the reason it was
-- once lost for — otherwise the row contradicts itself and the loss breakdown
-- counts a reason for a load that was won.
--
-- This lived in setLoadOutcome() as part of the UPDATE payload. It cannot stay
-- there now that the client no longer holds the grant, and a trigger is the
-- better home anyway: the invariant is a property of the row, so it should hold
-- no matter which of the three writers (client, scorer, backfill) moved the
-- outcome.

create or replace function public.clear_loss_reason_on_win()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.outcome is distinct from 'lost' then
    new.loss_reason := null;
    new.loss_note := null;
    new.loss_reason_quote := null;
    -- Source clears too, so a load that swings lost → booked → lost is offered
    -- to the scorer again rather than keeping a verdict about a different
    -- version of its own history.
    new.loss_reason_source := null;
  end if;
  return new;
end;
$$;

drop trigger if exists loads_clear_loss_reason on public.loads;

create trigger loads_clear_loss_reason
  before insert or update of outcome on public.loads
  for each row
  execute function public.clear_loss_reason_on_win();

-- ─── 4. The scorer's other hot path ─────────────────────────────────────────
--
-- loads_unscored_idx covers "never looked at". This covers the second sweep:
-- calls whose steps were scored before this migration existed, which now need a
-- reason inferred and nothing else. Without it that query is a seq scan over
-- every load the org has ever recorded.

create index if not exists loads_unreasoned_idx
  on public.loads (org_id, created_at desc)
  where outcome = 'lost' and loss_reason is null and loss_reason_source is null;
