/**
 * LoadForm — Organization accounts
 *
 * Helpers for creating an organization, inviting/managing dispatchers, and
 * accepting/declining invites. Mirrors loads.js: the Supabase client is
 * passed in by main.js (it already has the session attached, so RLS
 * resolves auth.uid() / the caller's email automatically).
 *
 * See supabase/migrations/20260811000000_organizations.sql for the schema
 * and the RLS policies these calls rely on.
 */

/** Create a new org with the caller as its owner. Returns the org row, or
 * { error } if creation failed (e.g. already belongs to an org). */
export async function createOrganization(supabase, name) {
  const trimmed = (name || '').trim();
  if (!supabase || !trimmed) return { error: 'Organization name is required' };
  const { data, error } = await supabase.rpc('create_organization', { p_name: trimmed });
  if (error) {
    console.error('createOrganization failed:', error);
    return { error: error.message };
  }
  return { organization: data };
}

/** Fetch the caller's own active membership (org + role), or null if they
 * don't belong to one. */
export async function fetchMyMembership(supabase, userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, org_id, role, status, organizations(id, name, owner_user_id)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    console.error('fetchMyMembership failed:', error);
    return null;
  }
  return data;
}

/** Fetch pending invites addressed to the caller's email. */
export async function fetchMyInvites(supabase, email) {
  if (!supabase || !email) return [];
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, org_id, role, created_at, organizations(id, name)')
    .eq('invited_email', email.trim().toLowerCase())
    .eq('status', 'invited');
  if (error) {
    console.error('fetchMyInvites failed:', error);
    return [];
  }
  return data || [];
}

/** Accept a pending invite: attaches it to the caller and activates it.
 * Fails if the caller is already an active member elsewhere. */
export async function acceptInvite(supabase, memberRowId, userId) {
  if (!supabase || !memberRowId || !userId) return { ok: false };
  const { error } = await supabase
    .from('organization_members')
    .update({ user_id: userId, status: 'active', accepted_at: new Date().toISOString() })
    .eq('id', memberRowId);
  if (error) {
    console.error('acceptInvite failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Decline a pending invite (deletes the invite row). */
export async function declineInvite(supabase, memberRowId) {
  return removeMember(supabase, memberRowId);
}

/** Fetch the full member roster for an org (owner/admin only — RLS-enforced). */
export async function fetchOrgMembers(supabase, orgId) {
  if (!supabase || !orgId) return [];
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, user_id, invited_email, role, status, created_at, accepted_at')
    .eq('org_id', orgId)
    .neq('status', 'removed')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('fetchOrgMembers failed:', error);
    return [];
  }
  return data || [];
}

/** Invite a dispatcher by email (owner/admin only — RLS-enforced). */
export async function inviteMember(supabase, orgId, email, role, invitedByUserId) {
  const trimmed = (email || '').trim().toLowerCase();
  if (!supabase || !orgId || !trimmed) return { ok: false, error: 'Email is required' };
  const { error } = await supabase.from('organization_members').insert({
    org_id: orgId,
    invited_email: trimmed,
    role: role || 'dispatcher',
    status: 'invited',
    invited_by: invitedByUserId,
  });
  if (error) {
    console.error('inviteMember failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Remove a member, or revoke a pending invite (owner/admin only for someone
 * else's row — RLS-enforced; also usable by an invitee declining their own).
 * A removed member's already-created loads keep their org_id and stay
 * visible on the dashboard — only the membership row goes away. */
export async function removeMember(supabase, memberRowId) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } = await supabase.from('organization_members').delete().eq('id', memberRowId);
  if (error) {
    console.error('removeMember failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Change a member's role between 'admin' and 'dispatcher' (owner/admin only
 * — RLS-enforced). The owner's role is fixed and never passed here. */
export async function updateMemberRole(supabase, memberRowId, role) {
  if (!supabase || !memberRowId || !role) return { ok: false };
  const { error } = await supabase
    .from('organization_members')
    .update({ role })
    .eq('id', memberRowId);
  if (error) {
    console.error('updateMemberRole failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Fetch every load tagged with this org (owner/admin only — RLS-enforced).
 * Only the columns the dashboard aggregates, not full load detail. */
export async function fetchOrgLoads(supabase, orgId) {
  if (!supabase || !orgId) return [];
  const { data, error } = await supabase
    .from('loads')
    .select('user_id, status, created_at')
    .eq('org_id', orgId);
  if (error) {
    console.error('fetchOrgLoads failed:', error);
    return [];
  }
  return data || [];
}

/**
 * Roll raw org loads up into one row of stats per dispatcher: total loads,
 * loads in the last 7/30 days, and active/completed counts. Members with no
 * loads yet still appear (at zero); loads from a dispatcher who has since
 * left the org are grouped under a synthetic "former member" bucket instead
 * of being dropped, so historical activity isn't silently lost from view.
 */
export function aggregateDispatcherStats(loads, members) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const byUser = new Map();

  for (const m of members) {
    if (m.status !== 'active' || !m.user_id) continue;
    byUser.set(m.user_id, {
      userId: m.user_id,
      email: m.invited_email,
      role: m.role,
      total: 0,
      last7d: 0,
      last30d: 0,
      active: 0,
      completed: 0,
    });
  }

  for (const load of loads || []) {
    let stat = byUser.get(load.user_id);
    if (!stat) {
      const key = `former:${load.user_id}`;
      stat = byUser.get(key);
      if (!stat) {
        stat = {
          userId: load.user_id,
          email: 'Former member',
          role: null,
          total: 0,
          last7d: 0,
          last30d: 0,
          active: 0,
          completed: 0,
        };
        byUser.set(key, stat);
      }
    }
    stat.total += 1;
    const ageMs = now - new Date(load.created_at).getTime();
    if (ageMs <= 7 * DAY_MS) stat.last7d += 1;
    if (ageMs <= 30 * DAY_MS) stat.last30d += 1;
    if (load.status === 'completed') stat.completed += 1;
    else stat.active += 1;
  }

  return Array.from(byUser.values()).sort((a, b) => b.total - a.total);
}
