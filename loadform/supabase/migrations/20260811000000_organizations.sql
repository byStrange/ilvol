-- Organization accounts: teams of dispatchers billed and monitored together.
-- Purely additive — individual accounts keep working exactly as before.
-- A dispatcher who never joins an org is unaffected by any policy below.

-- ─── organizations ──────────────────────────────────────────────────────────

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  -- Reserved for the billing phase (per-seat plan, purchased seat count).
  -- Unused until that phase ships; present now so the schema doesn't need
  -- to change shape later.
  plan text,
  created_at timestamptz not null default now()
);

alter table organizations enable row level security;
grant select, update on public.organizations to authenticated;
-- No direct insert grant: orgs are created only via create_organization()
-- below, so every org is guaranteed to have a matching owner member row.

-- ─── organization_members ───────────────────────────────────────────────────
--
-- Rows represent both pending invites and active memberships:
--   invited -> user_id is null, invited_email identifies the invitee
--   active  -> user_id is set, the invite has been accepted
--   removed -> soft-removed; kept for history instead of deleted
--
-- A dispatcher can be an *active* member of at most one org at a time
-- (enforced by the partial unique index below) — keeps v1 simple.

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  invited_email text not null,
  role text not null default 'dispatcher' check (role in ('owner', 'admin', 'dispatcher')),
  status text not null default 'invited' check (status in ('invited', 'active', 'removed')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

alter table organization_members enable row level security;
grant select, insert, update, delete on public.organization_members to authenticated;

create unique index if not exists organization_members_one_active_org_per_user
  on organization_members (user_id)
  where status = 'active';

create index if not exists organization_members_org_idx
  on organization_members (org_id);

-- ─── is_org_admin() ──────────────────────────────────────────────────────────
--
-- Security-definer helper so RLS policies on organization_members can check
-- "is the caller an owner/admin of this org" without the policy querying its
-- own table under RLS (which would recurse).

create or replace function public.is_org_admin(check_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organization_members
    where org_id = check_org_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
      and status = 'active'
  );
$$;

grant execute on function public.is_org_admin(uuid) to authenticated;

-- ─── create_organization() ──────────────────────────────────────────────────
--
-- Atomically creates an org and its owner membership row. This is the only
-- way to create an organization (see the missing insert grant above), which
-- guarantees every org has exactly one owner member row from the start and
-- that a user already active elsewhere can't create a second org.

create or replace function public.create_organization(p_name text)
returns organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org organizations;
begin
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Organization name is required';
  end if;

  if exists (
    select 1 from organization_members
    where user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'You already belong to an organization';
  end if;

  insert into organizations (name, owner_user_id)
  values (trim(p_name), auth.uid())
  returning * into v_org;

  insert into organization_members (org_id, user_id, invited_email, role, status, invited_by, accepted_at)
  values (v_org.id, auth.uid(), coalesce(auth.jwt() ->> 'email', ''), 'owner', 'active', auth.uid(), now());

  return v_org;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;

-- ─── accept_invite() ─────────────────────────────────────────────────────────
--
-- The only way a pending invite becomes active. Runs as security definer so
-- it can set exactly user_id/status/accepted_at on a row the caller doesn't
-- otherwise have UPDATE access to (see the tightened update policy below) —
-- a generic client-side UPDATE would let an invitee set any column on their
-- own row, including role = 'admin', while "accepting".

create or replace function public.accept_invite(p_invite_id uuid)
returns organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row organization_members;
begin
  select * into v_row
  from organization_members
  where id = p_invite_id
    and status = 'invited'
    and invited_email = coalesce(auth.jwt() ->> 'email', '')
  for update;

  if not found then
    raise exception 'Invitation not found or already handled';
  end if;

  if exists (
    select 1 from organization_members
    where user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'You already belong to an organization';
  end if;

  update organization_members
  set user_id = auth.uid(), status = 'active', accepted_at = now()
  where id = p_invite_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.accept_invite(uuid) to authenticated;

-- ─── leave_organization() ───────────────────────────────────────────────────
--
-- Self-service leave for the caller's own active, non-owner membership.
-- A dedicated function rather than a raw UPDATE policy branch keeps "leave"
-- from being reachable as a general-purpose self-edit.
--
-- Leaving does not touch `loads`. This is the deliberate mirror image of the
-- forward-only join rule below: joining an org does not hand it your prior
-- loads, and leaving does not take the org's loads back out with you. Rows
-- written while the membership was active keep their org_id and stay readable
-- by org admins afterwards — the work was done on the org's behalf and its
-- record belongs to the org, not to whoever happened to type it.
--
-- The pairing is what makes org_id mean "written as a member of this org"
-- rather than "currently belongs to a member of this org", which is the only
-- reading under which a dashboard stays stable as people come and go.

create or replace function public.leave_organization()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update organization_members
  set status = 'removed'
  where user_id = auth.uid()
    and status = 'active'
    and role <> 'owner';
end;
$$;

grant execute on function public.leave_organization() to authenticated;

-- ─── organizations policies ──────────────────────────────────────────────────

create policy "org members can view their organization"
  on organizations for select
  to authenticated
  using (
    exists (
      select 1 from organization_members
      where org_id = organizations.id
        and (user_id = auth.uid() or invited_email = coalesce(auth.jwt() ->> 'email', ''))
    )
  );

create policy "org admins can update their organization"
  on organizations for update
  to authenticated
  using (public.is_org_admin(id))
  with check (public.is_org_admin(id));

-- ─── organization_members policies ──────────────────────────────────────────

create policy "see own membership, invites, or org roster as admin"
  on organization_members for select
  to authenticated
  using (
    user_id = auth.uid()
    or invited_email = coalesce(auth.jwt() ->> 'email', '')
    or public.is_org_admin(org_id)
  );

-- Admin-created rows can only ever start as a pending, unclaimed, non-owner
-- invite — activation happens exclusively through accept_invite() above, so
-- an admin can't directly insert an already-active member (bypassing the
-- invitee's consent) or a role = 'owner' row (there is exactly one owner,
-- created only by create_organization()).
create policy "org admins can invite members"
  on organization_members for insert
  to authenticated
  with check (
    public.is_org_admin(org_id)
    and role in ('admin', 'dispatcher')
    and status = 'invited'
    and user_id is null
  );

-- Admin-only. An invitee has no direct UPDATE path onto their own row —
-- accept_invite() (security definer) is the only way a pending invite
-- becomes active, so this policy can't be used to smuggle role = 'owner'
-- or role = 'admin' into an "acceptance". The owner's own row is excluded
-- from both using and with check, so it can't be touched via this policy
-- at all — there's no ownership-transfer flow yet.
create policy "org admins manage non-owner roster rows"
  on organization_members for update
  to authenticated
  using (public.is_org_admin(org_id) and role <> 'owner')
  with check (public.is_org_admin(org_id) and role in ('admin', 'dispatcher'));

-- Deleting is only ever for a *pending* invite — declined by the invitee or
-- revoked by an admin. An active membership is deactivated via UPDATE
-- (status = 'removed', see leave_organization() and the update policy
-- above), never deleted, which both preserves roster history and makes it
-- structurally impossible to delete the sole owner row.
create policy "decline or revoke a pending invite"
  on organization_members for delete
  to authenticated
  using (
    status = 'invited'
    and (
      invited_email = coalesce(auth.jwt() ->> 'email', '')
      or public.is_org_admin(org_id)
    )
  );

-- ─── loads: org visibility (read-only, forward-only) ────────────────────────
--
-- A dispatcher's own write access to `loads` is unchanged (see
-- 20260724000000_loads.sql). This only adds read access for org admins, and
-- only to loads carrying an org_id — existing rows have org_id null and stay
-- invisible to any org, which is what makes "forward only" the default
-- behavior rather than something the app has to enforce separately.

alter table loads add column if not exists org_id uuid references organizations(id) on delete set null;

create index if not exists loads_org_idx on loads (org_id) where org_id is not null;

create policy "org admins can view member loads"
  on loads for select
  to authenticated
  using (org_id is not null and public.is_org_admin(org_id));
