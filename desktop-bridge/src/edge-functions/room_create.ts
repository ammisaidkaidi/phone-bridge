// Edge function: room-create
// Create a "room" where many agents can talk/listen with each other.
// Floor control: only one agent speaks at a time. If the current speaker
// asked a question to a specific agent → that agent is next. Otherwise,
// all agents demand permission → 1s timeout or all demanded → lottery →
// API picks one + notifies all.
//
// POST body: {"name":"...", "agent_ids":["uuid", ...]}
// Response: {"room_id":"uuid", "name":"...", "members":[...]}

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
    const name = body?.name ? String(body.name) : null;
    const agentIds: string[] = Array.isArray(body?.agent_ids) ? body.agent_ids.map(String) : [];
    if (agentIds.length < 2) {
      return new Response(JSON.stringify({ error: "at least 2 agent_ids required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Create the room.
    const { data: room, error: roomErr } = await supabase
      .from("rooms")
      .insert({ name, status: "active" })
      .select("id, name, created_at")
      .single();
    if (roomErr) {
      return new Response(JSON.stringify({ error: roomErr.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    // Add members.
    const memberRows = agentIds.map((id) => ({ room_id: room.id, agent_id: id }));
    const { error: mErr } = await supabase.from("room_members").insert(memberRows);
    if (mErr) {
      await supabase.from("rooms").delete().eq("id", room.id);
      return new Response(JSON.stringify({ error: mErr.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    // Initialize speaker state (no current speaker — floor is open).
    await supabase.from("room_speaker_state").insert({
      room_id: room.id,
      current_speaker: null,
      demand_requests: [],
    });
    return new Response(JSON.stringify({
      room_id: room.id, name: room.name, created_at: room.created_at,
      members: agentIds,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
