-- Close the provider-key leak.
--
-- 20250106000000_api_keys.sql granted every authenticated user SELECT on
-- api_keys with `using (true)`. Anyone who signed up could read the shared
-- Deepgram and Ollama keys and use them directly, outside the app, forever.
-- That makes any client-side quota enforcement decorative — so this has to be
-- shut before billing means anything.
--
-- Credentials now live in Edge Function secrets (`supabase secrets set`) and
-- are reachable only via the `deepgram-token` and `extract` functions, which
-- authenticate the caller and are where quota checks belong.

drop policy if exists "All authenticated users can read api_keys" on public.api_keys;

revoke select on public.api_keys from authenticated;
revoke all on public.api_keys from anon;

-- RLS stays on with no policies: service_role still bypasses it, every other
-- role is denied by default.
alter table public.api_keys enable row level security;

-- The rows themselves are now dead weight and are the thing that leaked.
-- Clear the secrets out; the table is kept so rollback stays trivial.
update public.api_keys set key_value = 'MOVED_TO_EDGE_FUNCTION_SECRETS';
