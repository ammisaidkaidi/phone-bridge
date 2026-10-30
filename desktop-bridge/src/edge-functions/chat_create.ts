// Edge function: chat-create
// Create a chat session between 2+ agents.
//
// POST body: {"name":"...","participant_ids":["uuid","uuid"],"metadata":{}}
// Response: {"chat_id":"uuid","name":"...","participants":[{"agent_id":"...","name":"..."}]}

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
    const name = body?.name ? String(body.name) : null;
    const participantIds: string[] = Array.isArray(body?.participant_ids)
      ? body.participant_ids.map((x: unknown) => String(x))
      : [];
    const metadata = (body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata))
      ? body.metadata : {};

    if (participantIds.length < 2) {
      return new Response(JSON.stringify({ error: "at least 2 participant_ids required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: chat, error: chatErr } = await supabase
      .from("chats")
      .insert({ name, status: "active", metadata })
      .select("id, name, created_at")
      .single();
    if (chatErr) {
      return new Response(JSON.stringify({ error: chatErr.message, code: chatErr.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const rows = participantIds.map((agent_id) => ({ chat_id: chat.id, agent_id }));
    const { error: pErr } = await supabase.from("chat_participants").insert(rows);
    if (pErr) {
      // Best-effort cleanup of the chat row so we don't leave an orphan.
      await supabase.from("chats").delete().eq("id", chat.id);
      return new Response(JSON.stringify({ error: pErr.message, code: pErr.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { data: parts } = await supabase
      .from("chat_participants")
      .select("agent_id, agents(id, name)")
      .eq("chat_id", chat.id);

    const participants = (parts ?? []).map((r: any) => ({
      agent_id: r.agent_id,
      name: r.agents?.name ?? null,
    }));

    return new Response(JSON.stringify({
      chat_id: chat.id,
      name: chat.name,
      created_at: chat.created_at,
      participants,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
