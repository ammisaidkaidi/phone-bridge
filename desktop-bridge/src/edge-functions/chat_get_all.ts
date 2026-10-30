// Edge function: chat-get-all
// Return ALL messages in a chat — getAllChatContent. Optionally filter
// by kind or since a message id.
//
// GET ?chat_id=<uuid>&kind=ask&since_id=<bigint>&limit=<int>
// Response: {"messages":[...],"count":N,"chat_id":"..."}

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
    const chatId  = url.searchParams.get("chat_id");
    const kind    = url.searchParams.get("kind");
    const sinceId = url.searchParams.get("since_id");
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "200", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, limitRaw)) : 200;
    if (!chatId) {
      return new Response(JSON.stringify({ error: "missing ?chat_id=" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    let q = supabase
      .from("chat_messages")
      .select("id, chat_id, from_agent, to_agent, kind, content, metadata, in_reply_to, created_at, consumed_at, status")
      .eq("chat_id", chatId)
      .order("id", { ascending: true })
      .limit(limit);
    if (kind)    q = q.eq("kind", kind);
    if (sinceId) q = q.gt("id", Number(sinceId));
    const { data, error } = await q;
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      messages: data ?? [], count: data?.length ?? 0, chat_id: chatId,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
