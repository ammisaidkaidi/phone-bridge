// Edge function: TmpDB-stream
// Enables live data streaming for a temporary table by adding it to the
// supabase_realtime publication. Returns the WebSocket URL + channel info
// so the agent can subscribe to INSERT/UPDATE/DELETE events in real time.
//
// POST body: {"table_name": "my_scratchpad"}
// Response: {
//   "ok": true,
//   "ws_url": "wss://<project>.supabase.co/realtime/v1/websocket?apikey=<key>&vsn=1.0.0",
//   "channel": "realtime:temporary:<table_name>",
//   "events": ["INSERT", "UPDATE", "DELETE"],
//   "join_message": { ... phx_join payload to send on connect ... }
// }

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
    const tableName = String(body?.table_name || "").replace(/[^a-zA-Z0-9_]/g, "_");
    if (!tableName) {
      return new Response(JSON.stringify({ error: "table_name required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Add the table to the supabase_realtime publication so changes are
    // broadcast via WebSocket.
    const sql = `ALTER PUBLICATION supabase_realtime ADD TABLE temporary."${tableName}";`;
    const { error } = await supabase.rpc("exec_sql", { sql_text: sql }).maybeSingle();
    // If exec_sql fails (function doesn't exist), return the SQL for manual
    // execution + still return the subscription info (streaming won't work
    // until the SQL is run, but the agent can try).
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    // The publishable key is what the caller sent in the apikey header.
    const publishableKey = req.headers.get("apikey") || "";
    const wsUrl = `${projectUrl.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(publishableKey)}&vsn=1.0.0`;
    const channel = `realtime:temporary:${tableName}`;
    // The phx_join message the agent should send after connecting to the WS.
    const joinMessage = {
      topic: channel,
      event: "phx_join",
      payload: {
        config: {
          broadcast: { self: false },
          presence: { key: "" },
          postgres_changes: [
            { event: "INSERT", schema: "temporary", table: tableName },
            { event: "UPDATE", schema: "temporary", table: tableName },
            { event: "DELETE", schema: "temporary", table: tableName },
          ],
        },
      },
      ref: "1",
    };
    return new Response(JSON.stringify({
      ok: true,
      ws_url: wsUrl,
      channel: channel,
      events: ["INSERT", "UPDATE", "DELETE"],
      join_message: joinMessage,
      note: error
        ? "Could not auto-add table to realtime publication. Run this SQL manually: " + sql
        : "Table added to supabase_realtime publication. Connect to the WebSocket URL + send the join_message to start receiving live events.",
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
