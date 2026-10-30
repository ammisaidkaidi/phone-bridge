// Edge function: room-ask-next
// The current speaker designates the next speaker (e.g. asked a question
// to a specific agent). The designated agent becomes the speaker when
// room-release-speaker is called (or immediately if no current speaker).
//
// POST body: {"room_id":"uuid", "to_agent":"uuid"}
// Response: {"ok": true, "next_speaker": "uuid"}

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
    const toAgent = String(body?.to_agent ?? "");
    if (!roomId || !toAgent) {
      return new Response(JSON.stringify({ error: "room_id + to_agent required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: state, error } = await supabase
      .from("room_speaker_state")
      .select("current_speaker")
      .eq("room_id", roomId)
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const now = new Date().toISOString();
    if (state.current_speaker) {
      // Just designate — actual handover happens on release.
      await supabase
        .from("room_speaker_state")
        .update({ next_speaker: toAgent, updated_at: now })
        .eq("room_id", roomId);
      return new Response(JSON.stringify({
        ok: true, next_speaker: toAgent,
        note: "designated — will become speaker when current speaker releases",
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    } else {
      // No current speaker → elect immediately.
      await supabase
        .from("room_speaker_state")
        .update({
          current_speaker: toAgent,
          speaker_started_at: now,
          next_speaker: null,
          demand_requests: [],
          demand_phase_started_at: null,
          updated_at: now,
        })
        .eq("room_id", roomId);
      return new Response(JSON.stringify({
        ok: true, next_speaker: toAgent, elected_now: true,
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
