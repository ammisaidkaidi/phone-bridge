// Edge function: room-get-speaker
// LONG-POLL: returns the current elected speaker. If no speaker yet AND
// the demand phase conditions are met (all members requested OR 1s since
// demand_phase_started_at), runs the election: picks a random agent from
// demand_requests, sets as current_speaker, notifies all.
//
// POST body: {"room_id":"uuid", "agent_id":"uuid", "timeout_ms":10000}
// Response: {"speaker":"<agent_id>", "elected_at":"..."}
//        OR  {"timeout": true}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const POLL_INTERVAL_MS = 200;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEMAND_PHASE_TIMEOUT_MS = 1000;  // 1s after demand phase starts → election

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
    let timeoutMs = Number(body?.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
    timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
    if (!roomId) {
      return new Response(JSON.stringify({ error: "room_id required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { data: state, error } = await supabase
        .from("room_speaker_state")
        .select("current_speaker, speaker_started_at, next_speaker, demand_phase_started_at, demand_requests")
        .eq("room_id", roomId)
        .single();
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      // 1. If there's a current speaker → return immediately.
      if (state.current_speaker) {
        return new Response(JSON.stringify({
          speaker: state.current_speaker,
          elected_at: state.speaker_started_at,
          is_you: state.current_speaker === agentId,
        }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      // 2. If next_speaker is designated (via room-ask-next) → elect them.
      if (state.next_speaker) {
        const now = new Date().toISOString();
        const { error: electErr } = await supabase
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
        if (!electErr) {
          return new Response(JSON.stringify({
            speaker: state.next_speaker,
            elected_at: now,
            is_you: state.next_speaker === agentId,
            method: "designated",
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }
      // 3. Demand phase: check if election should run.
      if (state.demand_phase_started_at) {
        // Get room member count.
        const { count } = await supabase
          .from("room_members")
          .select("agent_id", { count: "exact", head: true })
          .eq("room_id", roomId);
        const memberCount = count ?? 0;
        const requests: string[] = Array.isArray(state.demand_requests) ? state.demand_requests : [];
        const demandAgeMs = Date.now() - new Date(state.demand_phase_started_at).getTime();
        // Election conditions: all members demanded OR 1s timeout.
        if (requests.length >= memberCount || demandAgeMs >= DEMAND_PHASE_TIMEOUT_MS) {
          if (requests.length > 0) {
            // Lottery: pick random from requests.
            const winner = requests[Math.floor(Math.random() * requests.length)];
            const now = new Date().toISOString();
            await supabase
              .from("room_speaker_state")
              .update({
                current_speaker: winner,
                speaker_started_at: now,
                demand_requests: [],
                demand_phase_started_at: null,
                updated_at: now,
              })
              .eq("room_id", roomId);
            return new Response(JSON.stringify({
              speaker: winner,
              elected_at: now,
              is_you: winner === agentId,
              method: "lottery",
              candidates: requests.length,
            }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
          }
          // No requests after 1s → keep waiting (someone will demand).
        }
      }
      // Wait + retry.
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return new Response(JSON.stringify({ timeout: true }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
