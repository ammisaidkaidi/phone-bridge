// Edge function: TmpDB-getRows
// Gets rows from a table in the 'temporary' schema.
// GET ?table_name=my_scratchpad&limit=100&order=created_at.desc&where_col=status&where_val=pending
// Response: {"rows": [...], "count": N}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const url = new URL(req.url);
    const tableName = (url.searchParams.get("table_name") || "").replace(/[^a-zA-Z0-9_]/g, "_");
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "100")));
    const orderCol = url.searchParams.get("order_col") || "created_at";
    const orderAsc = (url.searchParams.get("order") || "desc").toLowerCase() === "asc";
    const whereCol = url.searchParams.get("where_col");
    const whereVal = url.searchParams.get("where_val");
    if (!tableName) {
      return new Response(JSON.stringify({ error: "table_name required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    let q = supabase.schema("temporary").from(tableName)
      .select("*")
      .order(orderCol, { ascending: orderAsc })
      .limit(limit);
    if (whereCol && whereVal !== null) {
      q = q.eq(whereCol, whereVal);
    }
    const { data, error } = await q;
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ rows: data || [], count: data?.length || 0 }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
