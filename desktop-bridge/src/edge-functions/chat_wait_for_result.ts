// Edge function: chat-wait-for-result
// LONG-POLL: blocks until a 'reply' or 'result' message arrives in this
// chat that is addressed to me (to_agent = agent_id OR broadcast).
// If in_reply_to is provided, only matches messages that reply to that
// specific ask — used by chat-ask to correlate an ask with its reply.
//
// POST body: {
//   chat_id: "uuid",
//   agent_id: "uuid",
//   in_reply_to: <bigint>?,
//   timeout_ms: 120000?
// }
// Response: {"message":{...}} | {"timeout":true}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const POLL_INTERVAL_MS = 1000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 120_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const chatId   = String(body?.chat_id ?? "");
    const agentId  = String(body?.agent_id ?? "");
    const inReplyTo = body?.in_reply_to !== undefined && body.in_reply_to !== null
      ? Number(body.in_reply_to) : null;
    let timeoutMs  = Number(body?.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
    timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

    if (!chatId || !agentId) {
      return new Response(JSON.stringify({ error: "chat_id and agent_id required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const agentFilter = `to_agent.eq.${agentId},to_agent.is.null`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // We want kind IN ('reply','result'). supabase-js v2 supports .in("kind", [...])
      let q = supabase
        .from("chat_messages")
        .select("id, chat_id, from_agent, to_agent, kind, content, metadata, in_reply_to, created_at, status")
        .eq("chat_id", chatId)
        .in("kind", ["reply", "result"])
        .eq("status", "pending")
        .or(agentFilter)
        .order("id", { ascending: true })
        .limit(1);
      if (inReplyTo !== null) q = q.eq("in_reply_to", inReplyTo);
      const { data, error } = await q;
      if (error) {
        return new Response(JSON.stringify({ error: error.message, code: error.code }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      if (data && data.length > 0) {
        return new Response(JSON.stringify({ message: data[0] }), {
          status: 200, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return new Response(JSON.stringify({ timeout: true }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
