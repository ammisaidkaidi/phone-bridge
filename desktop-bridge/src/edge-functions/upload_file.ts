// Edge function: upload-file
// AI agent (or anyone with publishable key) POSTs a multipart upload with:
//   file     = binary file content (single multipart part)
//   name     = optional filename (default: random UUID)
//   public   = optional "true" | "false" (default: true → returns a public URL)
//
// The function:
//   1. Ensures the `phone-files` bucket exists (creates it as public if missing).
//   2. Computes SHA-256 of the file for integrity verification.
//   3. Stores the file in the bucket under `ai-uploads/<uuid>/<filename>`.
//   4. Returns: {"ok":true, "path": "...", "url": "...", "sha256": "...", "size": N}
//
// The AI agent then sends a `download_file` command to the phone with this URL
// in args, and the phone downloads + saves it to local storage.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const BUCKET = "phone-files";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: "file (binary) required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const requestedName = (form.get("name") ?? "") as string;
    const isPublic = (form.get("public") ?? "true") === "true";
    const fileName = (requestedName && requestedName.length > 0)
      ? requestedName : `upload-${Date.now()}`;
    const uuid = crypto.randomUUID();
    const storagePath = `ai-uploads/${uuid}/${fileName}`;

    // Compute SHA-256 of the file bytes
    const buf = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, "0")).join("");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Ensure bucket exists (idempotent; ignore error if already exists)
    try {
      await supabase.storage.createBucket(BUCKET, { public: isPublic });
    } catch (_e) { /* bucket likely already exists */ }

    // Upload the binary
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buf, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (uploadError) {
      return new Response(JSON.stringify({ error: "storage upload failed: " + uploadError.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

    return new Response(JSON.stringify({
      ok: true,
      path: storagePath,
      bucket: BUCKET,
      url: pub?.publicURL ?? null,
      sha256,
      size: buf.byteLength,
      contentType: file.type || "application/octet-stream",
    }), { status: 201, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
