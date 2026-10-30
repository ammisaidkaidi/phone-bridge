// Edge function: chat-ack
// Mark a message as consumed (status='consumed', consumed_at=now()).
// Called by an agent after it has processed a message returned by
// chat-wait-for-ask or chat-wait-for-result, so subsequent long-polls
// don't return the same message again.
//
// POST body: {"message_id":42}
// Response: {"ok":true,"consumed_at":"..."}

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
    const messageId = Number(body?.message_id);
    if (!Number.isFinite(messageId) || messageId < 1) {
      return new Response(JSON.stringify({ error: "message_id (number) required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("chat_messages")
      .update({ status: "consumed", consumed_at: now })
      .eq("id", messageId)
      .select("id, status, consumed_at")
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, ...data }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
