import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | null = null;

function invariant(value: string | undefined, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

export function getSupabaseClient() {
  if (supabase) {
    return supabase;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  invariant(supabaseUrl, "SUPABASE_URL is not set");
  invariant(
    supabaseServiceRoleKey,
    "SUPABASE_SERVICE_ROLE_KEY is not set",
  );

  supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
    },
  });

  return supabase;
}
