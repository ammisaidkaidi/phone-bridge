// Edge function: send-command
// AI agent POSTs {command, args, device_id?} -> this inserts a row with
// status='pending'. If device_id is provided, the command is targeted at
// that specific device (only that device's realtime listener will pick it
// up). If device_id is null/missing, the command is a broadcast — any
// online device will pick it up.
//
// Service-role key is used server-side; the AI never sees it.

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
    const command = body?.command;
    const args = body?.args ?? {};
    const deviceId = body?.device_id;  // optional: target a specific device
    if (!command || typeof command !== "string") {
      return new Response(JSON.stringify({ error: "command (string) required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const insertRow: Record<string, unknown> = { command, args, status: "pending" };
    if (deviceId !== undefined && deviceId !== null && typeof deviceId === "string" && deviceId.length > 0) {
      insertRow.device_id = deviceId;
    }
    const { data, error } = await supabase
      .from("commands")
      .insert([insertRow])
      .select("id, command, args, status, created_at, device_id")
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 201,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
