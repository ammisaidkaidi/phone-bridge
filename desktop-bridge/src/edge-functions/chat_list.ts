// Edge function: chat-list
// List chats an agent is a participant of.
//
// GET ?agent_id=<uuid>             — chats this agent is in
// Response: {"chats":[...],"count":N}

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
    const agentId = url.searchParams.get("agent_id");
    if (!agentId) {
      return new Response(JSON.stringify({ error: "missing ?agent_id=" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase
      .from("chat_participants")
      .select("chat_id, joined_at, chats(id, name, status, created_at, closed_at)")
      .eq("agent_id", agentId)
      .order("joined_at", { ascending: false });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const chats = (data ?? []).map((r: any) => ({
      chat_id: r.chat_id,
      joined_at: r.joined_at,
      ...r.chats,
    }));
    return new Response(JSON.stringify({ chats, count: chats.length }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
