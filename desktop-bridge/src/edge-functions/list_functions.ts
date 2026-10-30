// Edge function: list-functions
// AI agent calls this on first connect to discover the available commands on the phone.
//
// The catalog is split into two parts:
//   1. BUILT-IN commands — hardcoded here, matches CommandExecutor.java switch.
//   2. DYNAMIC module commands — read from the phone_capabilities table (populated
//      by upload-module + the phone's ModuleSynchronizer).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

// Static catalog of built-in commands. Matches CommandExecutor.java.
const BUILTIN_FUNCTIONS = [
  // ---- Core phone commands ----
  { name: "ping",         description: "Liveness probe — returns 'pong'.",                                                  args_schema: {},                                                                                                                default_permission: "ALLOWED" },
  { name: "flash_on",     description: "Turn on the rear camera flashlight.",                                                args_schema: {},                                                                                                                default_permission: "ALLOWED" },
  { name: "flash_off",    description: "Turn off the rear camera flashlight.",                                               args_schema: {},                                                                                                                default_permission: "ALLOWED" },
  { name: "vibrate",      description: "Vibrate the phone for the given duration.",                                          args_schema: { duration_ms: "number (default 500)" },                                                                          default_permission: "ASK" },
  { name: "open_app",     description: "Launch an installed app via getLaunchIntentForPackage.",                              args_schema: { package: "string (required)" },                                                                                default_permission: "DENIED" },
  { name: "open_url",     description: "Open a URL in the default browser.",                                                  args_schema: { url: "string (required)" },                                                                                      default_permission: "ASK" },
  { name: "notify",       description: "Post a system notification.",                                                       args_schema: { title: "string", text: "string" },                                                                              default_permission: "ASK" },
  { name: "shell",        description: "Run a shell command via Runtime.exec (app UID, no root).",                            args_schema: { cmd: "string (required)", timeout_ms: "number (default 5000)" },                                                default_permission: "DENIED" },
  { name: "shell_root",   description: "Run a shell command with elevated privileges via Shizuku (requires Shizuku).",       args_schema: { cmd: "string (required)", timeout_ms: "number (default 5000)" },                                                default_permission: "DENIED" },
  { name: "broadcast",   description: "Send a system broadcast Intent.",                                                    args_schema: { action: "string (required)", extras: "object (string values)" },                                                default_permission: "DENIED" },
  { name: "download_file", description: "Download a file from a URL to a local path on the phone.",                          args_schema: { url: "string (required)", path: "string (required)", timeout_ms: "number (default 60000)" },                     default_permission: "ASK" },
  { name: "upload_file",   description: "Upload a local file from the phone to Supabase Storage (returns a public URL).",     args_schema: { path: "string (required)", name: "string (optional)" },                                                         default_permission: "ASK" },
  { name: "execute_script", description: "Run a sequence of sub-commands locally and return per-command results.",          args_schema: { commands: "array of {command, args} (max 50)" },                                                                 default_permission: "DENIED" },

  // ---- Knowledge management ----
  // The AI agent should call these whenever it discovers a non-obvious method,
  // workaround, gotcha, or pattern while solving a task. The knowledge is stored
  // PERSISTENTLY ON THE PHONE (in files/knowledge/) so future sessions can recall
  // it without rediscovering.
  { name: "knowledge_add",    description: "Persist a knowledge entry (method/pattern/gotcha) to the phone. Call this whenever you discover something non-obvious you'd want to know next time.",  args_schema: { title: "string (required, search-friendly)", content: "string (required, markdown — be detailed: include exact steps, commands, edge cases)", summary: "string (optional, one-line)", tags: "string[] (optional, e.g. ['camera','flashlight'])" }, default_permission: "ALLOWED" },
  { name: "knowledge_get",    description: "Read a knowledge entry's full content by id (returned by knowledge_add or knowledge_list).",                                                                args_schema: { id: "string (required)" },                                                                                          default_permission: "ALLOWED" },
  { name: "knowledge_list",   description: "List knowledge HEADERS ONLY (id, title, summary, tags, created_at) — newest first. Use knowledge_get to read full content for any specific entry.",         args_schema: { tag: "string (optional filter)", limit: "number (default 100, max 1000)" },                                          default_permission: "ALLOWED" },
  { name: "knowledge_search", description: "Search knowledge entries whose title, summary, tags, or content match the query (case-insensitive substring). Returns headers only.",                          args_schema: { query: "string (required)", limit: "number (default 50)" },                                                          default_permission: "ALLOWED" },
  { name: "knowledge_update", description: "Patch title/content/summary/tags on an existing knowledge entry. Pass only the fields you want to change; null/missing fields are left unchanged.",          args_schema: { id: "string (required)", title: "string", content: "string", summary: "string", tags: "string[]" },                default_permission: "ALLOWED" },
  { name: "knowledge_delete", description: "Delete a knowledge entry by id.",                                                                                                                                args_schema: { id: "string (required)" },                                                                                          default_permission: "ALLOWED" },

  // ---- Skills management ----
  // A "skill" is a procedural instruction (a numbered list of steps) the AI
  // stores so it can re-follow the same procedure next time a similar task
  // comes up. Stored in files/skills/ on the phone.
  { name: "skills_add",    description: "Persist a procedural skill (a reusable sequence of steps) to the phone. Write the steps as numbered items in the content field — the AI will re-follow them verbatim next time.",  args_schema: { title: "string (required)", content: "string (required, markdown — numbered steps, include placeholders like {{package_name}})", summary: "string (optional)", tags: "string[] (optional)" }, default_permission: "ALLOWED" },
  { name: "skills_get",    description: "Read the full skill body by id.",                                                                                                                                                                args_schema: { id: "string (required)" },                                                                                          default_permission: "ALLOWED" },
  { name: "skills_list",   description: "List skill HEADERS ONLY — newest first. Use skills_get or skills_call to read full content.",                                                                                                    args_schema: { tag: "string (optional filter)", limit: "number (default 100)" },                                                   default_permission: "ALLOWED" },
  { name: "skills_search", description: "Search skills by title/summary/tags/content. Returns headers only.",                                                                                                                            args_schema: { query: "string (required)", limit: "number (default 50)" },                                                          default_permission: "ALLOWED" },
  { name: "skills_update", description: "Patch title/content/summary/tags on an existing skill.",                                                                                                                                          args_schema: { id: "string (required)", title: "string", content: "string", summary: "string", tags: "string[]" },                default_permission: "ALLOWED" },
  { name: "skills_delete", description: "Delete a skill by id.",                                                                                                                                                                          args_schema: { id: "string (required)" },                                                                                          default_permission: "ALLOWED" },
  { name: "skills_call",   description: "Retrieve a skill and follow its steps for the current task. Passes through call_args so the AI can substitute per-call variables. The response includes the full skill body and the caller's args.",  args_schema: { id: "string (required)", args: "object (optional, per-call variables for {{placeholders}} in the skill)" },       default_permission: "ALLOWED" },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Try to read dynamic capabilities the phone has registered (modules).
    let moduleCommands: Array<{ name: string; description?: string; args_schema?: object; default_permission?: string; module?: string }> = [];
    const { data: capabilities, error } = await supabase
      .from("phone_capabilities")
      .select("module_name, commands")
      .eq("status", "active");
    if (!error && capabilities) {
      for (const row of capabilities) {
        const cmds = Array.isArray(row.commands) ? row.commands : [];
        for (const c of cmds) {
          moduleCommands.push({ ...c, module: row.module_name });
        }
      }
    }

    return new Response(JSON.stringify({
      functions: [...BUILTIN_FUNCTIONS, ...moduleCommands],
      builtin_count: BUILTIN_FUNCTIONS.length,
      module_count: moduleCommands.length,
      permission_states: ["ALLOWED", "DENIED", "ASK"],
      notes: {
        knowledge_dir: "files/knowledge/",
        skills_dir: "files/skills/",
        knowledge_persistence: "Knowledge and skills are stored ON THE PHONE (not in Supabase). They persist across reboots and bridge disconnects.",
        ai_directive: "BE PROACTIVE: Whenever you discover a non-obvious method, workaround, or reliable procedure while solving a task, call knowledge_add or skills_add so future sessions can recall it. Before attempting a complex task, call knowledge_search and skills_search with relevant keywords to see if you've already solved something similar."
      }
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
