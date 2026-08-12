-- LoadForm — restrict which organization columns an admin can write.
--
-- 20260811000000_organizations.sql granted table-wide UPDATE on
-- organizations, and the "org admins can update their organization" policy
-- only checks *which row* is being touched (is_org_admin(id)), not which
-- columns. RLS has no column granularity, so with that grant an org admin
-- could also rewrite owner_user_id (silently taking the org over from its
-- owner) or plan (self-upgrading once billing exists) — neither of which any
-- UI exposes, but both of which the client could send directly.
--
-- The admin console now exposes an org rename, so pin the grant to exactly
-- the column that needs to be writable. Column-level grants are what enforce
-- this; the row-level policy above still applies on top.

revoke update on public.organizations from authenticated;
grant update (name) on public.organizations to authenticated;
