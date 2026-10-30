// Edge function: room-release-speaker
// The current speaker releases the floor. If room-ask-next was called
// before release → next_speaker becomes the new speaker. Otherwise,
// start a demand phase (set demand_phase_started_at = now, clear
// current_speaker). The election runs lazily in room-get-speaker.
//
// POST body: {"room_id":"uuid", "agent_id":"uuid"}
// Response: {"ok": true, "released": true, "next": "designated"|"demand_phase"}

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
    const { data: state, error } = await supabase
      .from("room_speaker_state")
      .select("current_speaker, next_speaker")
      .eq("room_id", roomId)
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    // Only the current speaker may release.
    if (state.current_speaker !== agentId) {
      return new Response(JSON.stringify({
        ok: false, released: false,
        error: "you are not the current speaker",
        current_speaker: state.current_speaker,
      }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const now = new Date().toISOString();
    if (state.next_speaker) {
      // Designated next speaker → elect them directly.
      await supabase
        .from("room_speaker_state")
        .update({
          current_speaker: state.next_speaker,
          speaker_started_at: now,
          next_speaker: null,
          demand_requests: [],
          demand_phase_started_at: null,
          updated_at: now,
        })
        .eq("room_id", roomId);
      return new Response(JSON.stringify({
        ok: true, released: true, next: "designated",
        new_speaker: state.next_speaker,
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // No designated next → start demand phase.
    await supabase
      .from("room_speaker_state")
      .update({
        current_speaker: null,
        speaker_started_at: null,
        demand_phase_started_at: now,
        demand_requests: [],
        updated_at: now,
      })
      .eq("room_id", roomId);
    return new Response(JSON.stringify({
      ok: true, released: true, next: "demand_phase",
      demand_phase_started_at: now,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
