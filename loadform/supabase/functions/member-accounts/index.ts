/**
 * Owner-provisioned dispatcher accounts.
 *
 * Creating a login for someone else needs the service role, and the service
 * role can never ship in the desktop binary — so it has to happen here. The
 * function's whole job is to prove the caller is an owner/admin of an org and
 * then act on that org's behalf.
 *
 * Actions:
 *   create         — make a login for a new dispatcher and return the credentials
 *                    once, for the owner to hand over. Falls back to a classic
 *                    invite if that email already has a LoadForm account.
 *   reset_password — set a new password on an account this org created, for when
 *                    a dispatcher forgets theirs. With no email provider there
 *                    is no self-serve reset, so this is the only recovery path.
 *
 * Deliberately not here: disabling a login. Removing a member already revokes
 * their org access and their loads stay with the org; banning the auth user on
 * top of that is an irreversible action with no un-ban path in the UI, so it
 * needs its own design rather than being smuggled into the remove button.
 */

import { AuthError, json, requireUser, serveJson } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/usage.ts';

/**
 * Ambiguity-free alphabet. These passwords get read aloud across a desk and
 * typed by hand, so 0/O, 1/l/I are omitted: a password that is strong but gets
 * mistyped four times just becomes a support call.
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GENERATED_LENGTH = 14;

/** Matches supabase/config.toml's minimum_password_length, so a password we
 * accept here is never rejected by GoTrue a moment later. */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Rejection sampling rather than a bare `% alphabet.length`: 256 is not a
 * multiple of 56, so the naive version would over-weight the first characters
 * of the alphabet.
 */
function generatePassword(length = GENERATED_LENGTH): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  const ceiling = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < ceiling) out.push(PASSWORD_ALPHABET[buf[0] % PASSWORD_ALPHABET.length]);
  }
  return out.join('');
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  // Deliberately loose. Addresses here are often internal and never mailed to
  // (dispatch@acme.local is a perfectly good username for this flow), so the
  // only thing worth rejecting is something GoTrue itself won't store.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('Enter a valid email address', 400);
  }
  return email;
}

function resolvePassword(value: unknown): string {
  if (value === undefined || value === null || value === '') return generatePassword();
  const password = String(value);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  return password;
}

type RequestBody = {
  action?: string;
  email?: unknown;
  password?: unknown;
  role?: unknown;
  member_id?: unknown;
};

type AdminContext = { orgId: string; plan: string | null };

/**
 * Resolve which org the caller administers.
 *
 * Read from the caller's active membership rather than taken from the request
 * body: a body-supplied org_id would have to be authorized anyway, and a member
 * can only be active in one org, so there is nothing for the client to choose.
 */
async function requireAdminOrg(userId: string): Promise<AdminContext> {
  const { data, error } = await serviceClient()
    .from('organization_members')
    .select('org_id, role, organizations(plan)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    console.error('admin org lookup failed:', error.message);
    throw new AuthError('Could not verify your organization', 500);
  }
  if (!data || (data.role !== 'owner' && data.role !== 'admin')) {
    throw new AuthError('Only an organization owner or admin can manage accounts', 403);
  }

  // PostgREST returns a to-one embed as an object, but the untyped client can't
  // know that, so accept either shape rather than asserting one.
  const embedded = data.organizations as
    | { plan: string | null }
    | { plan: string | null }[]
    | null;
  const org = Array.isArray(embedded) ? embedded[0] : embedded;
  return { orgId: data.org_id as string, plan: org?.plan ?? null };
}

/**
 * Refuse a new seat once the org's plan ceiling is reached.
 *
 * Every account carries its own daily allowance, so without this a free org
 * could mint accounts until the per-account cap stopped meaning anything.
 * Pending invites count: they are seats already promised, and not counting them
 * would let an admin overshoot the ceiling and only discover it at accept time.
 */
async function requireSeatAvailable(ctx: AdminContext): Promise<void> {
  const db = serviceClient();

  const { data: limits, error: limitError } = await db
    .from('plan_limits')
    .select('plan, max_members')
    .in('plan', [ctx.plan ?? 'free', 'free']);

  if (limitError) {
    // Consistent with checkQuota: a lookup failure must not block an org that
    // is probably within its limits anyway.
    console.error('plan_limits lookup failed:', limitError.message);
    return;
  }

  const rows = limits ?? [];
  // An unknown plan name falls back to free's ceiling, matching quota_status().
  const row = rows.find((r) => r.plan === ctx.plan) ?? rows.find((r) => r.plan === 'free');
  const maxMembers = row?.max_members ?? null;
  if (maxMembers === null) return;

  const { count, error: countError } = await db
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', ctx.orgId)
    .in('status', ['active', 'invited']);

  if (countError) {
    console.error('seat count failed:', countError.message);
    return;
  }

  if ((count ?? 0) >= maxMembers) {
    throw new AuthError(
      `Your plan includes ${maxMembers} seats and they're all in use. ` +
        `Remove a member to free one up.`,
      402,
    );
  }
}

function requireRole(value: unknown): 'admin' | 'dispatcher' {
  const role = String(value ?? 'dispatcher');
  // 'owner' is excluded on purpose: there is exactly one owner row per org and
  // only create_organization() makes it.
  if (role !== 'admin' && role !== 'dispatcher') {
    throw new AuthError('Role must be admin or dispatcher', 400);
  }
  return role;
}

/**
 * Create the login and attach it to the org as an already-active member.
 *
 * Uses the service role, which bypasses the RLS policy that restricts admins to
 * inserting *pending* rows. That restriction exists so an admin can't activate a
 * membership without the invitee's consent — which doesn't apply to an account
 * the admin is creating from scratch. The consent that matters here is the
 * owner's, and we've just verified it.
 */
async function createMember(body: RequestBody, userId: string): Promise<Response> {
  const email = normalizeEmail(body.email);
  const role = requireRole(body.role);
  const password = resolvePassword(body.password);

  const ctx = await requireAdminOrg(userId);
  await requireSeatAvailable(ctx);

  const db = serviceClient();
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    // No mail is sent and none can be: confirming here is what makes the
    // account immediately usable without an email provider.
    email_confirm: true,
    user_metadata: { provisioned_by_org: ctx.orgId },
  });

  if (createError) {
    // Auth emails are globally unique, so an existing account can't be
    // re-created. Rather than dead-ending the owner, fall back to the flow that
    // does work for someone who already has their own LoadForm login.
    if (isAlreadyRegistered(createError)) {
      return await inviteExisting(db, ctx, email, role, userId);
    }
    console.error('createUser failed:', createError.message);
    throw new AuthError(createError.message || 'Could not create the account', 400);
  }

  const newUserId = created.user?.id;
  if (!newUserId) throw new AuthError('Account was created without an id', 500);

  const { data: member, error: memberError } = await db
    .from('organization_members')
    .insert({
      org_id: ctx.orgId,
      user_id: newUserId,
      invited_email: email,
      role,
      status: 'active',
      invited_by: userId,
      accepted_at: new Date().toISOString(),
      provisioned_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (memberError) {
    // Roll the auth user back. Otherwise a failure here leaves an account that
    // belongs to no org and whose email is now permanently taken — so the
    // owner's obvious next move (retry) would fail forever.
    await db.auth.admin.deleteUser(newUserId).catch((err) => {
      console.error('orphaned auth user, cleanup failed:', newUserId, err);
    });
    console.error('member insert failed:', memberError.message);
    throw new AuthError('Could not add them to your organization', 400);
  }

  return json({
    outcome: 'created',
    member_id: member.id,
    email,
    password,
    role,
  });
}

function isAlreadyRegistered(error: { message?: string; code?: string }): boolean {
  const message = (error.message ?? '').toLowerCase();
  return (
    error.code === 'email_exists' ||
    message.includes('already been registered') ||
    message.includes('already registered') ||
    message.includes('already exists')
  );
}

/** An email that already has an account can only be added by invitation. */
async function inviteExisting(
  db: ReturnType<typeof serviceClient>,
  ctx: AdminContext,
  email: string,
  role: 'admin' | 'dispatcher',
  invitedBy: string,
): Promise<Response> {
  const { data: existing } = await db
    .from('organization_members')
    .select('id, status')
    .eq('org_id', ctx.orgId)
    .eq('invited_email', email)
    .in('status', ['active', 'invited'])
    .maybeSingle();

  if (existing) {
    throw new AuthError(
      existing.status === 'active'
        ? 'They are already on your team.'
        : 'They already have a pending invitation.',
      409,
    );
  }

  // Same shape the RLS insert policy allows a client to create — pending,
  // unclaimed, and explicitly not provisioned, so this path can never grant the
  // org password-reset rights over an account it did not create.
  const { data: member, error } = await db
    .from('organization_members')
    .insert({
      org_id: ctx.orgId,
      invited_email: email,
      role,
      status: 'invited',
      invited_by: invitedBy,
      provisioned_at: null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('invite insert failed:', error.message);
    throw new AuthError('Could not invite that address', 400);
  }

  return json({ outcome: 'invited', member_id: member.id, email, role });
}

/**
 * Set a new password on an account this org provisioned.
 *
 * Note what this is and isn't: it restores access for someone who forgot their
 * password. It is not a lockout tool — GoTrue does not revoke existing refresh
 * tokens on an admin password change, so a session already open on the
 * dispatcher's machine keeps working until it expires.
 */
async function resetMemberPassword(body: RequestBody, userId: string): Promise<Response> {
  const memberId = String(body.member_id ?? '');
  if (!memberId) throw new AuthError('member_id is required', 400);
  const password = resolvePassword(body.password);

  const ctx = await requireAdminOrg(userId);
  const db = serviceClient();

  const { data: member, error } = await db
    .from('organization_members')
    .select('id, org_id, user_id, invited_email, role, status, provisioned_at')
    .eq('id', memberId)
    .maybeSingle();

  if (error) {
    console.error('member lookup failed:', error.message);
    throw new AuthError('Could not load that member', 500);
  }

  // Each of these is load-bearing, so they're checked separately rather than
  // folded into the query — the caller gets told which one they hit.
  if (!member || member.org_id !== ctx.orgId) {
    throw new AuthError('That member is not in your organization', 404);
  }
  if (member.role === 'owner') {
    throw new AuthError("The owner's password can't be reset from here", 403);
  }
  if (member.status !== 'active' || !member.user_id) {
    throw new AuthError('That member has no active login yet', 409);
  }
  // The check this whole feature rests on: an org may only reset passwords for
  // logins it created itself, never for a personal account that accepted an
  // invite. See the provisioned_at comment in the migration.
  if (!member.provisioned_at) {
    throw new AuthError(
      'That account was created by the dispatcher, not by your organization, ' +
        'so only they can change its password.',
      403,
    );
  }

  const { error: updateError } = await db.auth.admin.updateUserById(member.user_id, { password });
  if (updateError) {
    console.error('password reset failed:', updateError.message);
    throw new AuthError(updateError.message || 'Could not reset the password', 400);
  }

  return json({ outcome: 'reset', member_id: member.id, email: member.invited_email, password });
}

Deno.serve(
  serveJson(async (req: Request) => {
    const { user } = await requireUser(req);
    // Action travels in the body, not the query string: functions.invoke()
    // builds its URL from the function name, so a query string would have to be
    // smuggled into that name.
    const body = (await req.json().catch(() => ({}))) as RequestBody;

    switch (body.action) {
      case 'create':
        return await createMember(body, user.id);
      case 'reset_password':
        return await resetMemberPassword(body, user.id);
      default:
        return json({ error: `Unknown action: ${body.action || '(none)'}` }, 400);
    }
  }),
);
