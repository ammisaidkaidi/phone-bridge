// Edge function: agent-list
// Returns all alive agents (last_alive_at within 60s). Also marks
// stale agents (older than 60s) as alive=false inline so the registry
// stays clean without a pg_cron job.
//
// GET (no query params)
// Response: {"agents":[...],"count":N}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const STALE_MS = 60_000;

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
    // Mark stale agents as not alive (cleanup pass).
    const staleThreshold = new Date(Date.now() - STALE_MS).toISOString();
    await supabase.from("agents")
      .update({ alive: false, updated_at: new Date().toISOString() })
      .lt("last_alive_at", staleThreshold)
      .eq("alive", true);

    // Return only alive agents.
    const { data, error } = await supabase
      .from("agents")
      .select("id, name, description, capabilities, metadata, alive, last_alive_at, session_id, created_at, updated_at")
      .eq("alive", true)
      .order("name", { ascending: true });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ agents: data ?? [], count: data?.length ?? 0 }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
