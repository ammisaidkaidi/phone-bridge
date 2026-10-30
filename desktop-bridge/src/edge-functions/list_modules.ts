// Edge function: list-modules
// Returns the list of modules the phone has registered as available.
//
// The phone pushes its module catalog to the `phone_capabilities` table when it
// loads modules at boot. This endpoint reads from that table and returns the
// catalog so the AI agent knows what extra commands are available beyond the
// built-in ones from list-functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase
      .from("phone_capabilities")
      .select("module_name, version, type, status, commands, sha256, storage_path, download_url, manifest, last_seen_at")
      .order("module_name", { ascending: true });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      modules: data ?? [],
      count: data?.length ?? 0,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
