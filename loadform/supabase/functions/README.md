# LoadForm Edge Functions

Provider credentials live **only** here, as Edge Function secrets. The desktop
app never receives a Deepgram or Ollama key.

## Why two different shapes

| | `deepgram-token` | `extract` |
|---|---|---|
| Pattern | credential **broker** | true **proxy** |
| Provider traffic | client → Deepgram, direct | client → us → Ollama |
| Why | Edge Functions hard-cap at **150s (Free) / 400s (Pro)** wall clock, and that cap applies to WebSockets. A proxied 5–15 min call would be severed mid-sentence. | One short request/response — fits a function perfectly. |

The Deepgram token only has to be valid at **handshake** time. Once the socket
is open it stays open for the whole call, so a 60-second TTL comfortably covers
an hour-long conversation while making a leaked token worthless.

Both functions are still the server-side chokepoint where quota gets enforced —
see the `TODO(billing)` markers.

## Auth

Callers authenticate with the signed-in user's Supabase access token, attached
automatically by `supabase.functions.invoke()` (see `src/api.js`).

⚠️ **`verify_jwt` alone is not enough.** It only proves the token was signed by
this project — and the anon key is itself such a JWT, embedded in the shipped
desktop binary. Anyone could replay it. So `_shared/auth.ts:requireUser()`
always resolves a real end user via `getUser()` and rejects anything else. Do
not remove that check; it is the whole point of this refactor.

## Deploy

⚠️ **The Deepgram key must have at least `Member` scope.** A key that can
transcribe cannot necessarily mint tokens — `/v1/auth/grant` returns 403
`INSUFFICIENT_PERMISSIONS` for lower-scoped keys. Create one via Deepgram
Console → API Keys → Create Key → **Advanced** → Permissions: `Member`.

```bash
# One-time: set the secrets (these replace the rows in the api_keys table)
supabase secrets set DEEPGRAM_API_KEY=...
supabase secrets set OLLAMA_API_KEY=...
supabase secrets set OLLAMA_BASE_URL=https://ollama.com
supabase secrets set OLLAMA_MODEL=gemma4:31b-cloud

supabase functions deploy deepgram-token
supabase functions deploy extract

# Close the leak (revokes the old client-readable api_keys grant)
supabase db push
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected by the platform — you do not
set those.

## Local development

```bash
supabase functions serve      # reads secrets from supabase/.env
deno check deepgram-token/index.ts extract/index.ts
```

To skip the cloud LLM entirely while developing, set
`OLLAMA_BASE_URL=http://localhost:11434` in the **desktop** environment — that
routes extraction through the local-only `extract_load_data` Rust command
instead of this function.

## Rotate the keys

The old Deepgram and Ollama keys were readable by every registered user for as
long as the `api_keys` grant existed. **Treat them as compromised and rotate
them at the provider** before setting the secrets above — revoking the grant
does not invalidate a key someone already copied.
