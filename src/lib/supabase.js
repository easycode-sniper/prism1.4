import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
    console.error(
        'Supabase is not configured. Create a .env file from .env.example ' +
        'with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the dev server.'
    );
}

export const supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder');