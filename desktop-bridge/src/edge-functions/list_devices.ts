// Edge function: list-devices
// AI agent GET -> returns all devices that have ever registered with this
// Supabase project, along with their current status, last heartbeat, and
// session info. The AI agent uses this to decide which device to target
// with send-command's optional device_id field.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

// Same threshold as get-result — used to compute the "online" vs "offline"
// status dynamically (regardless of what's stored in the status column).
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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase
      .from("devices")
      .select("device_id, name, model, manufacturer, product, device_codename, android_version, sdk_int, privilege_level, shizuku_uid, status, session_id, started_at, last_alive_at, pid, currently_executing_id, last_seen_at")
      .order("last_alive_at", { ascending: false });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    // Enrich each row with a computed "alive" boolean (heartbeat < 30s ago)
    // and stale_for_seconds. The stored status column reflects the phone's
    // last known intent ('online' when it last sent a heartbeat), but the
    // computed alive field reflects the actual current state.
    const now = Date.now();
    const enriched = (data ?? []).map((d: Record<string, unknown>) => {
      const lastAliveMs = d.last_alive_at ? new Date(d.last_alive_at as string).getTime() : 0;
      const staleSecs = Math.floor((now - lastAliveMs) / 1000);
      return {
        ...d,
        stale_for_seconds: staleSecs,
        alive: staleSecs <= HEARTBEAT_DEAD_SECS,
      };
    });
    return new Response(JSON.stringify({
      devices: enriched,
      count: enriched.length,
      heartbeat_dead_threshold_secs: HEARTBEAT_DEAD_SECS,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
