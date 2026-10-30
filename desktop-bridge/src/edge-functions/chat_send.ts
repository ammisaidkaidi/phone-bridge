// Edge function: chat-send
// Send a message to a chat. kind is one of: ask | reply | result | system | note.
// to_agent can be null (broadcast to all participants) or a specific agent id.
// in_reply_to is the message id this reply/result is answering (set by chat-ask).
//
// POST body: {
//   chat_id: "uuid",
//   from_agent: "uuid",
//   to_agent: "uuid" | null,   // null = broadcast
//   kind: "ask" | "reply" | "result" | "system" | "note",
//   content: "...",
//   in_reply_to: <bigint>?,
//   metadata: {...}?
// }
// Response: {"message_id":42,"created_at":"..."}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const ALLOWED_KINDS = new Set(["ask", "reply", "result", "system", "note"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const chatId    = String(body?.chat_id ?? "");
    const fromAgent = String(body?.from_agent ?? "");
    const kind      = String(body?.kind ?? "");
    const content   = body?.content !== undefined ? String(body.content) : null;
    const metadata  = (body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata))
      ? body.metadata : {};
    const toAgentRaw = body?.to_agent;
    const toAgent = (toAgentRaw === null || toAgentRaw === undefined) ? null : String(toAgentRaw);
    const inReplyTo = body?.in_reply_to !== undefined && body.in_reply_to !== null
      ? Number(body.in_reply_to) : null;

    if (!chatId || !fromAgent || !kind) {
      return new Response(JSON.stringify({ error: "chat_id, from_agent, kind required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return new Response(JSON.stringify({ error: "kind must be one of: " + [...ALLOWED_KINDS].join(", ") }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase
      .from("chat_messages")
      .insert({
        chat_id: chatId,
        from_agent: fromAgent,
        to_agent: toAgent,
        kind,
        content,
        metadata,
        in_reply_to: inReplyTo,
        status: "pending",
      })
      .select("id, created_at")
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      message_id: data.id,
      created_at: data.created_at,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
