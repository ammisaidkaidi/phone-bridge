// Edge function: update-result
// Phone POSTs {id, status, result?, error?, exec_session_id?, executor_pid?}
// -> this updates the matching row.
//
// Service-role key is used server-side; the phone never sees it.
//
// When status='processing', we also set last_heartbeat_at=now() so the AI agent
// can detect mid-execution crashes by comparing this against the
// phone_bridge_session.last_alive_at column (which the heartbeat edge function
// refreshes every ~10s).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-bridge-token",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id < 1) {
      return new Response(JSON.stringify({ error: "id (number) required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const status = String(body?.status ?? "completed");
    const patch: Record<string, unknown> = {
      status,
      executed_at: new Date().toISOString(),
    };
    if (body?.result !== undefined) patch.result = String(body.result);
    if (body?.error   !== undefined) patch.error   = String(body.error);
    if (body?.exec_session_id !== undefined && body?.exec_session_id !== null) {
      patch.exec_session_id = String(body.exec_session_id);
    }
    if (body?.executor_pid !== undefined && body?.executor_pid !== null) {
      patch.executor_pid = Number(body.executor_pid);
    }
    // When transitioning into "processing", stamp last_heartbeat_at so the AI
    // agent can compute liveness from this timestamp even before the first
    // 10s heartbeat tick arrives.
    if (status === "processing") {
      patch.last_heartbeat_at = new Date().toISOString();
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase
      .from("commands")
      .update(patch)
      .eq("id", id)
      .select("id, status, result, error, executed_at, exec_session_id, executor_pid, last_heartbeat_at")
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, command: data }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
