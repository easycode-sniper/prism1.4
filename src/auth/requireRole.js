import { ROLES, isAdmin, isOps } from './auth.js';

/**
 * UI-level role gating. Server-side RLS enforces the same rules, so this
 * is about hiding controls/views, not securing data.
 */

/** Hide any element with [data-perm="..."] unless the user has permission. */
export function applyViewPermissions() {
    document.querySelectorAll('[data-perm]').forEach(el => {
        const perm = el.dataset.perm;
        const allowed =
            perm === 'viewer'   ? true :
            perm === 'dispatcher' ? isOps() :
            perm === 'admin'      ? isAdmin() : false;
        el.classList.toggle('hidden', !allowed);
    });
}

export function canDispatch() {
    return isOps();
}

/** Short label used around the UI (e.g. the user menu). */
export function roleLabel(role) {
    switch (role) {
        case ROLES.ADMIN: return 'Admin';
        case ROLES.DISPATCHER: return 'Dispatcher';
        case ROLES.VIEWER: return 'Viewer';
        default: return role;
    }
}