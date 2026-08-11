/**
 * Shared auth + CORS helpers for LoadForm Edge Functions.
 *
 * Every provider credential (Deepgram, Ollama) now lives ONLY in Edge Function
 * secrets. The desktop app never sees them — it authenticates to us with the
 * user's Supabase access token, and we call the provider on its behalf.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

/**
 * Resolve the calling user from the request's Authorization header.
 *
 * IMPORTANT: Supabase's built-in `verify_jwt` only proves the token was signed
 * by this project — and the anon key is itself such a JWT. Since the anon key
 * is embedded in the shipped desktop binary, `verify_jwt` alone would let
 * anyone replay it and get free provider access, which is the exact hole this
 * whole refactor exists to close. So we always resolve an actual end user via
 * getUser() and reject anything that isn't one.
 */
export async function requireUser(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    throw new AuthError('Missing Authorization header');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError('Invalid or expired session');
  }

  return { user: data.user, supabase, token };
}

/**
 * Wrap a handler with CORS preflight + uniform error handling so each function
 * body can stay focused on its provider call.
 */
export function serveJson(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof AuthError) {
        return json({ error: err.message }, err.status);
      }
      console.error('Unhandled error:', err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  };
}
