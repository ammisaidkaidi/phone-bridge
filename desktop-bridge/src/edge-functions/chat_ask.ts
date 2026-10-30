// Edge function: chat-ask
// CONVENIENCE COMBINED OP: send an ask + long-poll for the reply in ONE call.
// This is the `ask(..., timeout)` primitive the user asked for.
//
// Flow:
//   1. Insert ask message (kind='ask', from=me, to=other, status='pending').
//   2. Long-poll chat-wait-for-result(in_reply_to = ask.id, to = me, timeout).
//   3. Return the reply message (and ack it on the way out) or `{timed_out: true}`.
//
// POST body: {
//   chat_id: "uuid",
//   from_agent: "uuid",
//   to_agent: "uuid",
//   content: "...",
//   timeout_ms: 120000?
// }
// Response: {"ask_id":42,"reply":{...},"timed_out":false} |
//           {"ask_id":42,"reply":null,"timed_out":true}

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
    const chatId    = String(body?.chat_id ?? "");
    const fromAgent = String(body?.from_agent ?? "");
    const toAgent   = String(body?.to_agent ?? "");
    const content   = body?.content !== undefined ? String(body.content) : null;
    const metadata  = (body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata))
      ? body.metadata : {};
    let timeoutMs = Number(body?.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
    timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

    if (!chatId || !fromAgent || !toAgent) {
      return new Response(JSON.stringify({ error: "chat_id, from_agent, to_agent required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Insert the ask.
    const { data: askRow, error: askErr } = await supabase
      .from("chat_messages")
      .insert({
        chat_id: chatId,
        from_agent: fromAgent,
        to_agent: toAgent,
        kind: "ask",
        content,
        metadata,
        status: "pending",
      })
      .select("id, created_at")
      .single();
    if (askErr) {
      return new Response(JSON.stringify({ error: askErr.message, code: askErr.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const askId = askRow.id;

    // 2. Long-poll for the reply/result with in_reply_to = askId.
    const deadline = Date.now() + timeoutMs;
    const agentFilter = `to_agent.eq.${fromAgent},to_agent.is.null`;
    while (Date.now() < deadline) {
      const { data: rep, error: repErr } = await supabase
        .from("chat_messages")
        .select("id, chat_id, from_agent, to_agent, kind, content, metadata, in_reply_to, created_at, status")
        .eq("chat_id", chatId)
        .eq("in_reply_to", askId)
        .in("kind", ["reply", "result"])
        .eq("status", "pending")
        .or(agentFilter)
        .order("id", { ascending: true })
        .limit(1);
      if (repErr) {
        return new Response(JSON.stringify({ error: repErr.message, code: repErr.code }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      if (rep && rep.length > 0) {
        // 3. Auto-ack the reply on the way out so it doesn't resurface.
        await supabase.from("chat_messages")
          .update({ status: "consumed", consumed_at: new Date().toISOString() })
          .eq("id", rep[0].id);
        return new Response(JSON.stringify({
          ask_id: askId,
          reply: rep[0],
          timed_out: false,
        }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return new Response(JSON.stringify({
      ask_id: askId,
      reply: null,
      timed_out: true,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
