// Edge function: get-result
// AI agent GET ?id=N -> returns the current state of a command row.
//
// CRASH RECOVERY: when the row is still status='processing', this function
// checks the devices table for liveness. If either:
//   - devices.last_alive_at (for the command's device_id) is older than 30s
//     (phone died / lost network / OS killed the foreground service), OR
//   - the row's exec_session_id != devices.session_id (the phone restarted
//     for this device and the session that started this command is no longer
//     active)
// then we automatically mark the row as status='failed' with an error
// explaining what happened, and return the failed state. This prevents the
// AI agent from polling forever on a row whose executor is gone.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-bridge-token",
};

// Threshold: if the phone hasn't sent a heartbeat in this many seconds, we
// presume the executor is dead (rebooted, crashed, network-lost, OS-killed).
const HEARTBEAT_DEAD_SECS = 30;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return new Response(JSON.stringify({ error: "?id=<n> required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: cmd, error } = await supabase
      .from("commands")
      .select("id, command, args, status, result, error, created_at, executed_at, exec_session_id, executor_pid, last_heartbeat_at, device_id")
      .eq("id", id)
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 404,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // If the command is still "processing", probe the devices table for the
    // device that started it (or any online device if device_id is null).
    if (cmd.status === "processing") {
      // Look up the device row by the command's device_id. If device_id is
      // null (broadcast command), there's no specific executor to check —
      // fall back to ANY online device with a fresh heartbeat.
      let deviceQuery = supabase.from("devices").select("device_id, name, model, session_id, started_at, last_alive_at, pid, currently_executing_id");
      if (cmd.device_id) {
        deviceQuery = deviceQuery.eq("device_id", cmd.device_id);
      } else {
        // Broadcast: pick the device with the most recent last_alive_at
        deviceQuery = deviceQuery.order("last_alive_at", { ascending: false }).limit(1);
      }
      const { data: device, error: deviceErr } = await deviceQuery.maybeSingle();

      let liveness: Record<string, unknown> | null = null;
      let presumedDead = false;
      let deadReason = "";
      let staleForSecs = 0;

      if (!deviceErr && device) {
        const now = Date.now();
        const lastAliveMs = device.last_alive_at ? new Date(device.last_alive_at).getTime() : 0;
        staleForSecs = Math.floor((now - lastAliveMs) / 1000);
        liveness = {
          device_id: device.device_id,
          device_name: device.name,
          device_model: device.model,
          current_session_id: device.session_id,
          current_session_started_at: device.started_at,
          last_alive_at: device.last_alive_at,
          currently_executing_id: device.currently_executing_id,
          stale_for_seconds: staleForSecs,
          heartbeat_dead_threshold_secs: HEARTBEAT_DEAD_SECS,
        };
        // Condition 1: heartbeat is too old → phone is gone
        if (staleForSecs > HEARTBEAT_DEAD_SECS) {
          presumedDead = true;
          deadReason = `executor_dead: heartbeat stale for ${staleForSecs}s (threshold ${HEARTBEAT_DEAD_SECS}s). The bridge foreground service likely crashed, the phone rebooted, or the network was lost mid-execution.`;
        }
        // Condition 2: executor session changed → phone restarted and forgot about this command
        else if (cmd.exec_session_id && device.session_id && cmd.exec_session_id !== device.session_id) {
          presumedDead = true;
          deadReason = `session_changed: command was started in session ${cmd.exec_session_id} but the active session for device ${device.device_id} is now ${device.session_id}. The bridge foreground service restarted (crash / reboot / OS kill) before completing this command.`;
        }
      } else {
        // No device row found → no phone has ever registered with this device_id
        // (or no devices at all, for broadcast commands).
        presumedDead = true;
        deadReason = "executor_dead: no devices row found for this command's device_id (or no devices have ever registered). The bridge has never been started on the target device.";
      }

      if (presumedDead) {
        // Mark the row as failed so future polls return canonical failed state
        // (instead of synthesizing a failed response every poll).
        const { error: updErr } = await supabase
          .from("commands")
          .update({
            status: "failed",
            error: deadReason,
            executed_at: new Date().toISOString(),
          })
          .eq("id", id)
          .eq("status", "processing");  // race-safe: only flip if still processing
        if (updErr) {
          // Even if the update failed, return the synthesized failed state so
          // the AI agent stops polling.
          return new Response(JSON.stringify({
            ...cmd,
            status: "failed",
            error: deadReason,
            executed_at: new Date().toISOString(),
            liveness,
            synthesized: true,
            recovery_update_failed: updErr.message,
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        }
        // Re-read the row so the response reflects the canonical failed state
        const { data: refreshed } = await supabase
          .from("commands")
          .select("id, command, args, status, result, error, created_at, executed_at, exec_session_id, executor_pid, last_heartbeat_at, device_id")
          .eq("id", id)
          .single();
        if (refreshed) {
          return new Response(JSON.stringify({
            ...refreshed,
            liveness,
            recovered_by_get_result: true,
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          ...cmd,
          status: "failed",
          error: deadReason,
          executed_at: new Date().toISOString(),
          liveness,
          recovered_by_get_result: true,
        }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // Executor is alive — return processing + liveness info so the AI agent
      // can make its own decisions (e.g. give up after some absolute timeout).
      return new Response(JSON.stringify({
        ...cmd,
        liveness,
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // Status is completed/failed — return canonical row
    return new Response(JSON.stringify(cmd), {
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
