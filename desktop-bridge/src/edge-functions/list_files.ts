// Edge function: list-files
// Returns the list of files in the `phone-files` bucket.
//
// Query params (all optional):
//   prefix   = path prefix to list under (default: "")
//   limit    = page size (default: 100, max: 1000)
//   offset   = page offset (default: 0)
//   search   = substring filter on filename
//
// Response: {"files": [{name, id, created_at, updated_at, last_accessed_at, metadata}], "count": N}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const BUCKET = "phone-files";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const url = new URL(req.url);
    const prefix = url.searchParams.get("prefix") ?? "";
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, limitRaw)) : 100;
    const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const search = url.searchParams.get("search") ?? "";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix || undefined, { limit, offset, search: search || undefined, sortBy: { column: "created_at", order: "desc" } });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    // Augment each file with its public URL
    const files = (data ?? []).map((f) => ({
      name: f.name,
      id: f.id,
      created_at: f.created_at,
      updated_at: f.updated_at,
      last_accessed_at: f.last_accessed_at,
      metadata: f.metadata,
      url: supabase.storage.from(BUCKET).getPublicUrl(`${prefix ? prefix + "/" : ""}${f.name}`).publicURL,
    }));
    return new Response(JSON.stringify({ files, count: files.length, prefix, limit, offset }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
