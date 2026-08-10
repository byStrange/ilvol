-- Adds Google Gemini as a second LLM provider for load extraction.
-- Purely additive: the api_keys table, its RLS and its read policy are
-- unchanged — this only seeds the new provider row.

-- The `provider` column is free-form text with a unique constraint, so no
-- schema change is needed to permit a new provider; the row itself is the
-- permission. Placeholder value matches the existing seed convention (admin
-- replaces it in the Supabase dashboard).
insert into api_keys (provider, key_value) values
    ('gemini', 'REPLACE_WITH_GEMINI_KEY')
on conflict (provider) do nothing;
