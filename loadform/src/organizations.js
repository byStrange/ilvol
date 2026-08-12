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
 * Fails if the caller is already an active member elsewhere. Goes through
 * the accept_invite() RPC rather than a raw UPDATE — a direct client-side
 * update to the caller's own row would only be checked on user_id, letting
 * an invite "acceptance" also smuggle in role = 'admin' or similar. */
export async function acceptInvite(supabase, memberRowId) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } = await supabase.rpc('accept_invite', { p_invite_id: memberRowId });
  if (error) {
    console.error('acceptInvite failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Decline a pending invite (deletes the invite row; only pending invites
 * can be deleted at all — see the migration). */
export async function declineInvite(supabase, memberRowId) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } = await supabase.from('organization_members').delete().eq('id', memberRowId);
  if (error) {
    console.error('declineInvite failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Leave the caller's own active org membership. Goes through the
 * leave_organization() RPC — owners can't leave (no ownership-transfer flow
 * yet), which the function enforces itself rather than relying on the UI to
 * hide the button. */
export async function leaveOrganization(supabase) {
  if (!supabase) return { ok: false };
  const { error } = await supabase.rpc('leave_organization');
  if (error) {
    console.error('leaveOrganization failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
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

/** Remove a member (owner/admin only — RLS-enforced). A pending invite is
 * revoked outright (deleted); an active membership is deactivated
 * (status = 'removed') rather than deleted, so the roster history and the
 * dashboard's "left org" bucket stay intact — and so the owner row, which
 * the update policy refuses to touch, can never be removed this way. */
export async function removeMember(supabase, memberRowId, status) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } =
    status === 'invited'
      ? await supabase.from('organization_members').delete().eq('id', memberRowId)
      : await supabase.from('organization_members').update({ status: 'removed' }).eq('id', memberRowId);
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

/** Fetch the org's most recent loads with enough detail for the activity
 * feed (org admins may see full load content — RLS grants the whole row).
 * Capped rather than unbounded: the feed only ever shows the recent tail. */
export async function fetchOrgRecentLoads(supabase, orgId, limit = 40) {
  if (!supabase || !orgId) return [];
  const { data, error } = await supabase
    .from('loads')
    .select('id, user_id, title, status, pickup_location, delivery_location, rate, equipment_type, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('fetchOrgRecentLoads failed:', error);
    return [];
  }
  return data || [];
}

/** Rename an organization (owner/admin only — RLS-enforced). Only `name` is
 * updatable at all: the column-level grant in the follow-up migration keeps
 * this call from being widened into an ownership or plan change. */
export async function updateOrganizationName(supabase, orgId, name) {
  const trimmed = (name || '').trim();
  if (!supabase || !orgId) return { ok: false };
  if (!trimmed) return { ok: false, error: 'Organization name is required' };
  const { error } = await supabase.from('organizations').update({ name: trimmed }).eq('id', orgId);
  if (error) {
    console.error('updateOrganizationName failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
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
