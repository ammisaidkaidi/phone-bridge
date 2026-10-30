// Edge function: chat-unreaded
// Get unread messages (status='pending') addressed to a specific agent.
// GET ?chat_id=<uuid>&agent_id=<uuid>&limit=<int>
// Response: {messages: [...], count: N}

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
    const agentId = url.searchParams.get("agent_id");
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;
    if (!chatId || !agentId) {
      return new Response(JSON.stringify({ error: "chat_id and agent_id required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Unread = status='pending' AND (to_agent = me OR to_agent IS NULL)
    const agentFilter = `to_agent.eq.${agentId},to_agent.is.null`;
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, chat_id, from_agent, to_agent, kind, content, metadata, in_reply_to, created_at, status")
      .eq("chat_id", chatId)
      .eq("status", "pending")
      .or(agentFilter)
      .order("id", { ascending: true })
      .limit(limit);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ messages: data ?? [], count: data?.length ?? 0 }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
