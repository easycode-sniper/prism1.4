// Serverless API for team user management (admins only).
// Vercel runs this with the SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY envs.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function error(res, status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function readToken(req) {
    const auth = req.headers.get('authorization') || '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

async function requireAdmin(req, adminClient) {
    if (!url || !serviceKey) {
        return { ok: false, message: 'Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.' };
    }
    const token = readToken(req);
    if (!token) return { ok: false, message: 'Not signed in.' };

    const anonClient = createClient(url, process.env.SUPABASE_ANON_KEY || '');
    const { data: { user }, error } = await anonClient.auth.getUser(token);
    if (error || !user) return { ok: false, message: 'Invalid session token.' };

    const { data: profile, error: profErr } = await adminClient
        .from('profiles').select('id, email, role').eq('id', user.id).single();
    if (profErr || !profile) return { ok: false, message: 'User profile not found.' };
    if (profile.role !== 'admin') return { ok: false, message: 'Admin privileges required.' };

    return { ok: true, userId: profile.id };
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'authorization, content-type'
            }
        });
    }

    if (!url || !serviceKey) return error(req, 500, 'Server is missing SUPABASE URL / service role configuration.');

    const adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });

    const authz = await requireAdmin(req, adminClient);
    if (!authz.ok) return error(req, 401, authz.message);

    const pathParts = new URL(req.url).pathname.split('/').filter(Boolean);

    try {
        if (req.method === 'GET') {
            const { data, error: listErr } = await adminClient
                .from('profiles').select('id, email, full_name, role, created_at').order('created_at');
            if (listErr) return error(req, 500, listErr.message);
            return new Response(JSON.stringify({ users: data }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (req.method === 'POST') {
            const body = await req.json();
            const email = (body.email || '').trim().toLowerCase();
            if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
                return error(req, 400, 'A valid email is required.');
            }
            const role = ['admin', 'dispatcher', 'viewer'].includes(body.role) ? body.role : 'viewer';
            const fullName = (body.fullName || '').trim() || null;

            const { data: existing } = await adminClient.from('profiles').select('id').eq('email', email).maybeSingle();
            if (existing) return error(req, 409, `An account for ${email} already exists.`);

            const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
                email,
                email_confirm: false,
                user_metadata: fullName ? { full_name: fullName } : {}
            });
            if (createErr) return error(req, 400, createErr.message);

            const { error: profileErr } = await adminClient.from('profiles').upsert({
                id: created.user.id,
                email,
                full_name: fullName,
                role
            }, { onConflict: 'id' });
            if (profileErr) return error(req, 500, profileErr.message);

            const { data: link } = await adminClient.auth.admin.generateLink({ type: 'invite', email });
            return new Response(JSON.stringify({
                user: { id: created.user.id, email, full_name: fullName, role },
                inviteLink: link?.properties?.action_link || null
            }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }

        const targetId = pathParts[pathParts.length - 1];

        if (req.method === 'PATCH') {
            const body = await req.json();
            const role = ['admin', 'dispatcher', 'viewer'].includes(body.role) ? body.role : null;
            if (!role) return error(req, 400, 'Unsupported role.');
            const { error: updErr } = await adminClient.from('profiles').update({ role }).eq('id', targetId);
            if (updErr) return error(req, 500, updErr.message);
            return new Response(JSON.stringify({ ok: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        if (req.method === 'DELETE') {
            const { error: delErr } = await adminClient.auth.admin.deleteUser(targetId);
            if (delErr) return error(req, 500, delErr.message);
            return new Response(JSON.stringify({ ok: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        return error(req, 405, 'Method not allowed.');
    } catch (err) {
        return error(req, 500, err.message || 'Unexpected server error.');
    }
}