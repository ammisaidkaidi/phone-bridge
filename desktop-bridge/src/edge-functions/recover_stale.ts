// Edge function: recover-stale
// Phone calls this on every RealtimeService.onCreate() — BEFORE accepting any
// new commands. It marks every command targeted at THIS device from a
// PREVIOUS session (or with no session recorded at all) as failed, so the AI
// agent doesn't poll forever on rows whose executor definitely died
// (reboot / crash / OS kill).
//
// Body: { "device_id": "<uuid>", "current_session_id": "<uuid>" }
// Effect:
//   UPDATE commands
//     SET status='failed',
//         error='executor_restart: ...',
//         executed_at=now()
//   WHERE device_id = <this device_id>
//     AND status='processing'
//     AND (exec_session_id IS NULL OR exec_session_id != <current_session_id>)
//
// Also clears devices.currently_executing_id for this device (it was set by
// the heartbeat function when a command was mid-flight — must be NULL after
// restart since the old executor is gone).
//
// Returns: { "recovered_count": N, "device_id": "..." }

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
    const deviceId = body?.device_id;
    if (!deviceId || typeof deviceId !== "string") {
      return new Response(JSON.stringify({ error: "device_id (string) required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const currentSessionId = body?.current_session_id;
    if (!currentSessionId || typeof currentSessionId !== "string") {
      return new Response(JSON.stringify({ error: "current_session_id (string) required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const nowIso = new Date().toISOString();
    const recoveryError = `executor_restart: command was running when the bridge foreground service restarted. The previous executor (session mismatch) is definitely gone. Device ${deviceId}, current session ${currentSessionId}. Recovered at ${nowIso}.`;

    // Find stale 'processing' rows for THIS device whose session doesn't match.
    // Use OR so we catch NULL exec_session_id (legacy rows) too.
    let staleQuery = supabase
      .from("commands")
      .select("id, command, exec_session_id")
      .eq("status", "processing")
      .or(`device_id.is.null,device_id.eq.${deviceId}`);  // this device OR broadcast (NULL)

    // staleIds tracks the IDs we'll flip to failed.
    // For broadcast commands (device_id IS NULL), only flip if they have
    // a stale exec_session_id — we don't want to flip broadcast commands
    // that another device might still be processing.

    // First: commands targeted at THIS device with mismatched session
    const { data: ownRows, error: queryErr } = await supabase
      .from("commands")
      .select("id, command, exec_session_id")
      .eq("status", "processing")
      .eq("device_id", deviceId)
      .neq("exec_session_id", currentSessionId);

    // Also: commands targeted at THIS device with NULL exec_session_id
    // (legacy — pre-multi-device-format rows from a crashed prior session)
    const { data: nullSessionRows, error: queryErr2 } = await supabase
      .from("commands")
      .select("id, command, exec_session_id")
      .eq("status", "processing")
      .eq("device_id", deviceId)
      .is("exec_session_id", null);

    let staleIds: number[] = [];
    if (!queryErr && Array.isArray(ownRows)) {
      for (const r of ownRows) staleIds.push(Number(r.id));
    }
    if (!queryErr2 && Array.isArray(nullSessionRows)) {
      for (const r of nullSessionRows) staleIds.push(Number(r.id));
    }

    let recovered = 0;
    if (staleIds.length > 0) {
      const { error: updErr } = await supabase
        .from("commands")
        .update({
          status: "failed",
          error: recoveryError,
          executed_at: nowIso,
        })
        .in("id", staleIds)
        .eq("status", "processing");
      if (updErr) {
        return new Response(JSON.stringify({
          error: "recovery UPDATE failed: " + updErr.message,
          stale_ids: staleIds,
        }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      recovered = staleIds.length;
    }

    // Clear devices.currently_executing_id for this device — the new session
    // hasn't started dispatching anything yet.
    await supabase
      .from("devices")
      .update({ currently_executing_id: null })
      .eq("device_id", deviceId);

    return new Response(JSON.stringify({
      ok: true,
      device_id: deviceId,
      current_session_id: currentSessionId,
      recovered_count: recovered,
      recovered_ids: staleIds,
      recovered_at: nowIso,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
