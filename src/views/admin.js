// Admin view — team user management. Server-only operations (creating
// auth users, changing roles) go through api/admin/users.js.
import { profile, ROLES } from '../auth/auth.js';
import { supabase } from '../lib/supabase.js';

const ROLE_LABELS = { admin: 'Admin', dispatcher: 'Dispatcher', viewer: 'Viewer' };

async function usersApi(path, options) {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch(`/api/admin/users${path || ''}`, {
        headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
        },
        ...options
    });
    let body;
    try { body = await resp.json(); } catch { body = null; }
    if (!resp.ok) throw new Error((body && (body.error || body.message)) || `Request failed (${resp.status})`);
    return body;
}

export async function renderAdminUsers() {
    const wrap = document.getElementById('admin-users-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-dim);">Loading users…</div>';
    try {
        const data = await usersApi('');
        const users = data.users || [];
        const meId = profile()?.id;
        if (users.length === 0) {
            wrap.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-dim);">No team members yet.</div>';
            return;
        }
        wrap.innerHTML = users.map(u => `
            <div class="geofence-row" style="padding:10px 12px;">
                <span style="flex:1;">${u.email}</span>
                <span style="color:var(--text-dim); font-size:.78rem;">${u.full_name || '—'}</span>
                <select class="admin-role-select" data-user-id="${u.id}" ${u.id === meId ? 'disabled' : ''}>
                    ${Object.values(ROLES).map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
                </select>
                ${u.id !== meId ? `<button class="geofence-remove-btn admin-delete-btn" data-user-id="${u.id}" title="Delete user">✕</button>` : ''}
            </div>`).join('');

        wrap.querySelectorAll('.admin-role-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                try {
                    await usersApi(`/${sel.dataset.userId}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ role: sel.value })
                    });
                    renderAdminUsers();
                } catch (err) {
                    alert(err.message);
                    renderAdminUsers();
                }
            });
        });
        wrap.querySelectorAll('.admin-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this user? Their account will be removed and they will lose access.')) return;
                try {
                    await usersApi(`/${btn.dataset.userId}`, { method: 'DELETE' });
                    renderAdminUsers();
                } catch (err) {
                    alert(err.message);
                }
            });
        });
    } catch (err) {
        wrap.innerHTML = `<div style="padding:20px; color:var(--red); text-align:center;">Failed to load users: ${err.message}</div>`;
    }
}

async function inviteUser() {
    const emailEl = document.getElementById('admin-user-email');
    const nameEl = document.getElementById('admin-user-fullname');
    const roleEl = document.getElementById('admin-user-role');
    const resultEl = document.getElementById('admin-invite-result');

    const email = emailEl?.value.trim();
    const fullName = nameEl?.value.trim();
    const role = roleEl?.value || 'viewer';

    if (!email) { if (resultEl) resultEl.innerHTML = '<div class="wialon-result error">Email is required.</div>'; return; }

    if (resultEl) resultEl.innerHTML = '<div class="wialon-result loading">Creating the account…</div>';
    try {
        await usersApi('', { method: 'POST', body: JSON.stringify({ email, fullName, role }) });
        if (resultEl) {
            resultEl.innerHTML = `<div class="wialon-result success">✅ ${email} invited as <b>${ROLE_LABELS[role]}</b>. Temporary password sent via Supabase email.</div>`;
        }
        if (emailEl) emailEl.value = '';
        if (nameEl) nameEl.value = '';
        renderAdminUsers();
    } catch (err) {
        if (resultEl) resultEl.innerHTML = `<div class="wialon-result error">${err.message}</div>`;
    }
}

export function setupAdminControls() {
    const inviteBtn = document.getElementById('admin-invite-btn');
    if (inviteBtn) inviteBtn.addEventListener('click', inviteUser);
    renderAdminUsers();
}