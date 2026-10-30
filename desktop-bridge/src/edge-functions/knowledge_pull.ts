// Edge function: knowledge-pull
// AI agent OR phone GET -> returns all knowledge entries visible to a given
// device. Visibility = (device_id IS NULL OR device_id = ?device_id).
//
// Query params:
//   device_id=<uuid>   — required. Returns global entries + entries targeted
//                       at this device. Entries from OTHER devices are NOT
//                       returned (a phone shouldn't see another phone's
//                       device-specific notes).
//   scope=global|device|all  — optional. default=all.
//       global = only device_id IS NULL entries.
//       device = only entries with device_id = <device_id>.
//       all    = both.
//   tag=<tag>          — optional filter by tag.
//   limit=<int>        — optional, default 200, max 1000.
//
// Returns: {entries: [{id, device_id, title, summary, content, tags,
//                      created_at, updated_at, author_device_id}], count:N}

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
    const deviceId = url.searchParams.get("device_id");
    const scope = url.searchParams.get("scope") ?? "all";
    const tag = url.searchParams.get("tag");
    const limitParam = url.searchParams.get("limit");
    let limit = limitParam ? Number(limitParam) : 200;
    if (!Number.isFinite(limit) || limit < 1) limit = 200;
    if (limit > 1000) limit = 1000;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase.from("knowledge")
      .select("id, device_id, title, summary, content, tags, created_at, updated_at, author_device_id")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (scope === "global") {
      query = query.is("device_id", null);
    } else if (scope === "device") {
      if (!deviceId) {
        return new Response(JSON.stringify({ error: "device_id required for scope=device" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      query = query.eq("device_id", deviceId);
    } else {
      // scope=all (default): global + this device's entries. If no device_id,
      // returns only global entries.
      if (deviceId) {
        query = query.or(`device_id.is.null,device_id.eq.${deviceId}`);
      } else {
        query = query.is("device_id", null);
      }
    }

    // Tag filter: must contain the tag in the tags JSON array.
    if (tag) {
      // JSONB contains: tags @> '["tag"]'
      query = query.contains("tags", [tag]);
    }

    const { data, error } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      entries: data ?? [],
      count: data?.length ?? 0,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
