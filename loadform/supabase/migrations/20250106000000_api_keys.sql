-- API keys shared by all users (one row per provider)
-- Managed by admin, read by all authenticated users

create table if not exists api_keys (
    id uuid primary key default gen_random_uuid(),
    provider text not null unique, -- 'deepgram', 'ollama'
    key_value text not null,
    created_at timestamptz default now()
);

-- Enable RLS
alter table api_keys enable row level security;

-- Grant base table access to authenticated users
grant select on public.api_keys to authenticated;

-- Allow all authenticated users to read (shared keys)
create policy "All authenticated users can read api_keys"
on api_keys for select
to authenticated
using (true);

-- Only service_role or admin can insert/update/delete
-- (No user-facing policies for write — admin manages via dashboard or API)

-- Seed with placeholder values (admin replaces these in dashboard)
insert into api_keys (provider, key_value) values
    ('deepgram', 'REPLACE_WITH_DEEPGRAM_KEY'),
    ('ollama',   'REPLACE_WITH_OLLAMA_KEY')
on conflict (provider) do nothing;
