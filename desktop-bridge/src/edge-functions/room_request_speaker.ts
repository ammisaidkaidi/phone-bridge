// Edge function: room-request-speaker
// During the "demand phase" (no current speaker), an agent calls this to
// demand the floor. The API keeps the request. After all members demand
// OR 1s timeout, the election runs (in room-get-speaker).
//
// POST body: {"room_id":"uuid", "agent_id":"uuid"}
// Response: {"ok": true, "queued": true, "demand_phase": true}

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
    const roomId  = String(body?.room_id ?? "");
    const agentId = String(body?.agent_id ?? "");
    if (!roomId || !agentId) {
      return new Response(JSON.stringify({ error: "room_id + agent_id required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Read current state.
    const { data: state, error } = await supabase
      .from("room_speaker_state")
      .select("current_speaker, demand_phase_started_at, demand_requests")
      .eq("room_id", roomId)
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    // If there's already a current speaker, the demand phase is over —
    // the request is too late.
    if (state.current_speaker) {
      return new Response(JSON.stringify({
        ok: true, queued: false, demand_phase: false,
        current_speaker: state.current_speaker,
        reason: "speaker already elected",
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // Add agent_id to demand_requests if not already there.
    const requests: string[] = Array.isArray(state.demand_requests) ? state.demand_requests : [];
    if (!requests.includes(agentId)) requests.push(agentId);
    await supabase
      .from("room_speaker_state")
      .update({ demand_requests: requests, updated_at: new Date().toISOString() })
      .eq("room_id", roomId);
    return new Response(JSON.stringify({
      ok: true, queued: true, demand_phase: true,
      requests_so_far: requests.length,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
