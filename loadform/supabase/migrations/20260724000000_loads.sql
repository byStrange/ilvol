-- Per-user saved loads (load history).
-- Purely additive: does not touch api_keys or any existing data.
-- Mirrors the LoadFormData fields in src-tauri/src/lib.rs (all text).

create table if not exists loads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled load',
  status text not null default 'active',           -- 'active' | 'completed'
  -- LoadFormData fields
  pickup_location text,
  pickup_datetime text,
  pickup_type text,
  pickup_window text,
  delivery_location text,
  delivery_datetime text,
  delivery_type text,
  delivery_window text,
  stops text,
  commodity text,
  equipment_type text,
  trailer_instructions text,
  rate text,
  weight text,
  additional_notes text,
  confidence jsonb not null default '{}'::jsonb,
  transcript text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable + enforce RLS
alter table loads enable row level security;

-- Grant base table access to authenticated users
grant select, insert, update, delete on public.loads to authenticated;

-- Owners can do anything with their own loads
create policy "loads owner full access"
  on loads for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Helpful index for the history list (newest first, per user)
create index if not exists loads_user_created_idx
  on loads (user_id, created_at desc);