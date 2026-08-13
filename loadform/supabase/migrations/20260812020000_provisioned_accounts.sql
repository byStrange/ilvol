-- Owner-provisioned dispatcher accounts.
--
-- The invite flow assumes every dispatcher has an email they check and that we
-- can deliver mail to it. In a trucking office neither is reliably true, and
-- standing up an email provider to onboard five people in the same room is the
-- wrong shape of work. So an owner can instead create the login outright, hand
-- the credentials over in person, and let the dispatcher change the password
-- later. No mail is sent anywhere in that flow.
--
-- Invites are not removed: they remain the only way to add someone who already
-- has a LoadForm account of their own (auth emails are globally unique, so such
-- an account cannot be re-created).

-- ─── provisioned_at ─────────────────────────────────────────────────────────
--
-- Non-null means "this login exists because the org created it", which is what
-- authorizes the org to reset its password. That makes the column a security
-- boundary, not bookkeeping: if a client could set it, an admin could invite
-- someone's *personal* address, wait for them to accept, flag the row as
-- provisioned, and then reset the password on an account that was never theirs.
-- Both write paths are therefore closed below.

alter table public.organization_members
  add column if not exists provisioned_at timestamptz;

comment on column public.organization_members.provisioned_at is
  'Set only by the member-accounts Edge Function, for logins it created itself. '
  'Non-null authorizes the org to reset this account''s password, so it must '
  'never be client-writable.';

-- Close the INSERT path. The insert grant is table-wide, so without this an
-- admin could supply provisioned_at on the invite row they are allowed to
-- create.
drop policy if exists "org admins can invite members" on public.organization_members;
create policy "org admins can invite members"
  on public.organization_members for insert
  to authenticated
  with check (
    public.is_org_admin(org_id)
    and role in ('admin', 'dispatcher')
    and status = 'invited'
    and user_id is null
    and provisioned_at is null
  );

-- Close the UPDATE path. RLS has no column granularity, so the policy on this
-- table cannot express "role and status only" — column grants are the only
-- mechanism. `role` (change a member's role) and `status` (soft-remove) are the
-- sole columns the client ever legitimately writes here; accept_invite() and
-- leave_organization() are security definer and so are unaffected by grants.
--
-- This also closes a pre-existing hole: until now an admin could UPDATE
-- user_id or invited_email on any non-owner roster row, silently re-pointing a
-- seat at an arbitrary account.
revoke update on public.organization_members from authenticated;
grant update (role, status) on public.organization_members to authenticated;

-- ─── Seat cap ───────────────────────────────────────────────────────────────
--
-- Provisioning makes an extra account one click away, and every account carries
-- its own daily allowance. Without a cap, a free org could mint accounts until
-- the per-account limit stopped meaning anything. Pooling the allowance across
-- an org is the better long-run answer; a seat ceiling is the cheap version of
-- it and is the seat count billing needs anyway.

alter table public.plan_limits
  add column if not exists max_members integer;

comment on column public.plan_limits.max_members is
  'Maximum active + pending members per org, owner included. NULL = unlimited.';

update public.plan_limits set max_members = 3 where plan = 'free' and max_members is null;

-- ─── quota_status(): carry the seat cap ─────────────────────────────────────
--
-- The seat ceiling resolves through exactly the same plan lookup as the daily
-- limits, so it rides along here instead of in a second function that could
-- disagree about which plan applies. Recreated rather than replaced because the
-- return type changes.

-- Body is unchanged from 20260812010000 apart from the added column — in
-- particular it stays `security invoker`, so asking about another user still
-- returns zeroes under RLS rather than their real usage, and the plan lookup
-- keeps its "join the plan's own row, else free's row" shape. A coalesce
-- per column would look tidier and be wrong: it would turn a paid plan's NULL
-- (meaning unlimited) into free's numbers.

drop function if exists public.quota_status(uuid);

create or replace function public.quota_status(p_user_id uuid default auth.uid())
returns table (
  plan text,
  captures_used integer,
  captures_limit integer,
  extractions_used integer,
  extractions_limit integer,
  max_members integer
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
      l.daily_extractions,
      l.max_members
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
    limits.daily_extractions,
    limits.max_members
  from limits;
$$;

grant execute on function public.quota_status(uuid) to authenticated;

comment on function public.quota_status(uuid) is
  'Plan limits plus today''s usage for one user. Called by the Edge Functions '
  'before spending provider money, and by the app to display remaining quota.';
