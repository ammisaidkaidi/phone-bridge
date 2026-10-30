// Edge function: TmpDB-dropTable
// Drops a table from the 'temporary' schema.
// POST body: {"table_name": "my_scratchpad"}
// Response: {"ok": true, "dropped": "temporary.my_scratchpad"}

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
    const sql = `DROP TABLE IF EXISTS temporary."${tableName}" CASCADE;`;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Try via rpc.
    const { error } = await supabase.rpc("exec_sql", { sql_text: sql }).maybeSingle();
    if (error) {
      // Fallback: return the SQL for manual execution.
      return new Response(JSON.stringify({
        ok: false,
        error: "Cannot execute DDL via edge function. Run this SQL manually:",
        sql,
      }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, dropped: `temporary.${tableName}` }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
