import { supabase } from '../lib/supabase.js';

export const ROLES = Object.freeze({
    ADMIN: 'admin',
    DISPATCHER: 'dispatcher',
    VIEWER: 'viewer'
});

// Current profile cache for the signed-in user.
let profileCache = null;

export function profile() {
    return profileCache;
}

export async function refreshProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { profileCache = null; return null; }

    const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, role')
        .eq('id', user.id)
        .single();

    if (error) {
        // If the profile row is missing (e.g. signup trigger race), rebuild it.
        profileCache = {
            id: user.id,
            email: user.email,
            full_name: user.user_metadata?.full_name || null,
            role: 'viewer'
        };
        return profileCache;
    }
    profileCache = data;
    return data;
}

export function isAdmin()   { return profileCache?.role === ROLES.ADMIN; }
export function isOps()     { return profileCache && profileCache.role !== ROLES.VIEWER; }
export function canDispatch() { return profileCache ? profileCache.role !== ROLES.VIEWER : false; }

export async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    profileCache = null;
    return data;
}

export async function signOut() {
    profileCache = null;
    await supabase.auth.signOut();
}

export function onAuthChange(cb) {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        cb(event, session);
    });
    return subscription;
}