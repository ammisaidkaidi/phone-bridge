// Edge function: agent-register
// An AI agent announces itself: name + description + capabilities.
// Returns its agent_id + session_id. The agent must call agent-heartbeat
// every ~30s to stay "alive" in the registry.
//
// POST body: {"name":"planner","description":"...","capabilities":["plan","reason"],"metadata":{...}}
// Response:   {"agent_id":"uuid","name":"planner","session_id":"uuid","is_new":true|false}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const name = String(body?.name ?? "").trim();
    if (!name) {
      return new Response(JSON.stringify({ error: "name (string) required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const description  = body?.description  !== undefined ? String(body.description)  : null;
    const capabilities = Array.isArray(body?.capabilities)
      ? body.capabilities.map((c: unknown) => String(c))
      : [];
    const metadata = (body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata))
      ? body.metadata : {};
    const session_id = crypto.randomUUID();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Upsert by name (UNIQUE constraint). On conflict, update everything
    // except the original created_at — so re-registering the same agent
    // is idempotent and just refreshes its identity + session_id.
    const { data, error } = await supabase
      .from("agents")
      .upsert({
        name,
        description,
        capabilities,
        metadata,
        alive: true,
        last_alive_at: new Date().toISOString(),
        session_id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "name" })
      .select("id, name, session_id, created_at")
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      agent_id: data.id,
      name: data.name,
      session_id: data.session_id,
      created_at: data.created_at,
      is_new: Date.now() - new Date(data.created_at).getTime() < 5000,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
