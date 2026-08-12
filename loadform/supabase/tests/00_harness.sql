-- Stubs the pieces Supabase provides, so the real migrations can run as-is.
create extension if not exists pgcrypto;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema if not exists auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Mimics Supabase's auth.uid(): reads the JWT claim from a session GUC.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Mimics Supabase's auth.jwt(). The organizations migration matches pending
-- invites on auth.jwt() ->> 'email', so without this stub the migration chain
-- cannot be applied here at all.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    jsonb_build_object(
      'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
      'email', nullif(current_setting('request.jwt.claim.email', true), '')
    )
  );
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
