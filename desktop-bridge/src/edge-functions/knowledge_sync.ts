// Edge function: knowledge-sync
// Phone POSTs one or more knowledge entries to upsert into the public.knowledge
// table. The phone keeps a local cache (files/knowledge/) for fast reads +
// offline access; this function syncs the local cache to the database so it
// can be shared across the user's other devices.
//
// Body shape:
//   {
//     "entries": [
//       {
//         "id": "abc123",         // phone-generated id (16 hex chars)
//         "device_id": "<uuid>" or null,   // null = global (visible to all devices),
//                                           // non-null = device-specific
//         "title": "...",
//         "summary": "...",
//         "content": "...",
//         "tags": ["a","b"],
//         "created_at": 1730000000000,  // epoch millis
//         "updated_at": 1730000005000,  // epoch millis
//         "author_device_id": "<uuid>"
//       },
//       ...
//     ]
//   }
//
// On conflict over (id), updates title/summary/content/tags/device_id/updated_at.
// Returns: {ok: true, upserted: N} or {ok: true, upserted: 0} if entries was empty.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-bridge-token",
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
    const entries = Array.isArray(body?.entries) ? body.entries : null;
    if (!entries) {
      return new Response(JSON.stringify({ error: "entries (array) required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    if (entries.length > 200) {
      return new Response(JSON.stringify({ error: "entries length must be <= 200 (got " + entries.length + ")" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Normalize entries — convert epoch millis to ISO timestamps, ensure
    // device_id is null when not provided.
    const rows = entries.map((e: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        id: String(e.id),
        title: String(e.title ?? ""),
        content: String(e.content ?? ""),
      };
      if (e.summary !== undefined && e.summary !== null) row.summary = String(e.summary);
      else row.summary = "";
      // tags: must be array
      if (Array.isArray(e.tags)) row.tags = e.tags;
      else row.tags = [];
      // device_id: null = global
      if (e.device_id !== undefined && e.device_id !== null && String(e.device_id).length > 0) {
        row.device_id = String(e.device_id);
      } else {
        row.device_id = null;
      }
      // author_device_id: optional
      if (e.author_device_id !== undefined && e.author_device_id !== null) {
        row.author_device_id = String(e.author_device_id);
      }
      // created_at / updated_at: accept epoch millis OR ISO string
      const createdAt = e.created_at;
      if (createdAt !== undefined && createdAt !== null) {
        row.created_at = typeof createdAt === "number"
          ? new Date(createdAt).toISOString()
          : String(createdAt);
      }
      const updatedAt = e.updated_at;
      if (updatedAt !== undefined && updatedAt !== null) {
        row.updated_at = typeof updatedAt === "number"
          ? new Date(updatedAt).toISOString()
          : String(updatedAt);
      } else {
        row.updated_at = new Date().toISOString();
      }
      return row;
    });

    if (rows.length === 0) {
      return new Response(JSON.stringify({ ok: true, upserted: 0 }), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { error: upsertErr } = await supabase
      .from("knowledge")
      .upsert(rows, { onConflict: "id" });
    if (upsertErr) {
      return new Response(JSON.stringify({ error: "upsert failed: " + upsertErr.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      upserted: rows.length,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
