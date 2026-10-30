// Edge function: TmpDB-deleteRow
// Deletes rows from a table in the 'temporary' schema.
// POST body: {"table_name":"my_scratchpad", "where":{"status":"done"}}
// Response: {"ok": true, "deleted": N}

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
    const where = body?.where || {};
    if (!tableName) {
      return new Response(JSON.stringify({ error: "table_name required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    let q = supabase.schema("temporary").from(tableName).delete();
    for (const [col, val] of Object.entries(where)) {
      q = q.eq(col, val);
    }
    const { data: deleted, error } = await q.select("id");
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, deleted: deleted?.length || 0 }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
