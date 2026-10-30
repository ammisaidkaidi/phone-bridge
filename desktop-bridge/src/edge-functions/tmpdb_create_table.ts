// Edge function: TmpDB-createTable
// Creates a table in the 'temporary' schema for agent scratchpad use.
// Agents can store intermediate results, share state, organize work.
//
// POST body: {
//   table_name: "my_scratchpad",            // no schema prefix
//   columns: [                               // optional; defaults to just id+created_at
//     {"name": "task", "type": "text"},
//     {"name": "status", "type": "text"},
//     {"name": "data", "type": "jsonb"},
//     {"name": "count", "type": "int"}
//   ]
// }
// Supported types: text, int, bigint, bool, jsonb, timestamptz, uuid, float
// Response: {"ok": true, "table": "temporary.my_scratchpad"}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const ALLOWED_TYPES = new Set(["text","int","integer","bigint","bool","boolean","jsonb","json","timestamptz","uuid","float","float8","real"]);

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
    if (!tableName || tableName.length < 1) {
      return new Response(JSON.stringify({ error: "table_name required (alphanumeric + underscore)" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const columns: Array<{name: string, type: string}> = Array.isArray(body?.columns) ? body.columns : [];
    // Build the CREATE TABLE SQL.
    // Always include id + created_at; agent columns are appended.
    let sql = `CREATE TABLE IF NOT EXISTS temporary."${tableName}" (\n`;
    sql += `  id BIGSERIAL PRIMARY KEY,\n`;
    sql += `  created_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
    for (const col of columns) {
      const colName = String(col.name || "").replace(/[^a-zA-Z0-9_]/g, "_");
      const colType = String(col.type || "text").toLowerCase();
      if (!colName) continue;
      if (!ALLOWED_TYPES.has(colType)) {
        return new Response(JSON.stringify({ error: `unsupported column type: ${colType} (allowed: ${[...ALLOWED_TYPES].join(", ")})` }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      sql += `,\n  "${colName}" ${colType}`;
    }
    sql += `\n);`;
    // Enable RLS + allow anon all access (it's a scratchpad).
    sql += `\nALTER TABLE temporary."${tableName}" ENABLE ROW LEVEL SECURITY;`;
    sql += `\nDROP POLICY IF EXISTS "tmp_all" ON temporary."${tableName}";`;
    sql += `\nCREATE POLICY "tmp_all" ON temporary."${tableName}" FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);`;
    // Grant access.
    sql += `\nGRANT ALL ON temporary."${tableName}" TO anon, authenticated;`;
    sql += `\nGRANT USAGE, SELECT ON SEQUENCE temporary."${tableName}_id_seq" TO anon, authenticated;`;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Run the SQL via the rpc endpoint (supabase-js doesn't support DDL).
    const { error } = await supabase.rpc("exec_sql", { sql_text: sql }).maybeSingle();
    // If exec_sql doesn't exist, try the SQL directly via the REST API.
    if (error) {
      // Fallback: use the pg REST endpoint.
      const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/exec_sql`, {
        method: "POST",
        headers: {
          "apikey": Deno.env.get("SUPABASE_SECRET_KEY")!,
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SECRET_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql_text: sql }),
      });
      if (!resp.ok) {
        // Last resort: return the SQL so the user can run it manually.
        return new Response(JSON.stringify({
          ok: false,
          error: "Cannot execute DDL via edge function. Run this SQL manually in the SQL Editor:",
          sql,
        }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ ok: true, table: `temporary.${tableName}` }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

async function fetch(url: string, opts: any): Promise<Response> {
  return globalThis.fetch(url, opts);
}
