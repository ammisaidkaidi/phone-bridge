// Edge function: upload-module (v2)
// Receives a multipart upload with a single field:
//   file = the .mdl ZIP file (which contains manifest.json + classes.dex/*.so payload)
//
// The function:
//   1. Verifies the file is a valid ZIP
//   2. Extracts manifest.json from the ZIP and parses it
//   3. Computes SHA256 of the .mdl file
//   4. Stores the .mdl file in Supabase Storage (bucket "phone-modules") under
//      "<name>/<version>/<name>.mdl"
//   5. Upserts into phone_capabilities so list-modules can discover it and the
//      phone can download the .mdl on its next poll
//
// Backward compatibility: the old format (manifest=JSON string + file=binary) is
// still accepted — if no "file" field is present but a "manifest" field is, the
// legacy path is taken.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const BUCKET = "phone-modules";

// Minimal ZIP "End of Central Directory" record finder — used to sanity-check
// that the uploaded file is actually a ZIP archive before we hand it to the
// browser's DecompressionStream / the phone's ZipFile.
function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // ZIP local file header magic: 0x50 0x4B 0x03 0x04
  return bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

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

    // ===== v2 path: .mdl zip upload =====
    if (file && file instanceof File) {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (!looksLikeZip(buf)) {
        return new Response(JSON.stringify({
          error: "file must be a valid .mdl ZIP archive (got non-ZIP magic bytes)",
        }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // Extract manifest.json from the ZIP using a pure-JS unzip library.
      // We use jszip from esm.sh to keep the runtime dependency lightweight.
      // (Deno can resolve NPM-style imports natively.)
      const JSZip = (await import("https://esm.sh/jszip@3.10.1")).default;
      const zip = await JSZip.loadAsync(buf);
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) {
        return new Response(JSON.stringify({
          error: ".mdl archive missing manifest.json entry",
        }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const manifestJson = await manifestFile.async("string");
      const manifest = JSON.parse(manifestJson);
      const name = manifest.name;
      const version = manifest.version || "0.0.0";
      const type = manifest.type || "dex";
      if (!name) {
        return new Response(JSON.stringify({ error: "manifest.name required" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Compute SHA256 of the .mdl file for integrity verification on the phone
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const sha256 = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, "0")).join("");

      // If manifest declares a sha256, it should match the .mdl file's sha256
      if (manifest.sha256 && manifest.sha256.toLowerCase() !== sha256.toLowerCase()) {
        return new Response(JSON.stringify({
          error: "sha256 mismatch",
          expected: manifest.sha256,
          actual: sha256,
          note: "When uploading a .mdl, manifest.sha256 (if set) must match the .mdl file's sha256.",
        }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      // Ensure bucket exists (idempotent)
      try { await supabase.storage.createBucket(BUCKET, { public: true }); } catch (_e) {}

      // Upload the .mdl file to Storage
      const storagePath = `${name}/${version}/${name}.mdl`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buf, {
          contentType: "application/zip",
          upsert: true,
        });
      if (uploadError) {
        return new Response(JSON.stringify({
          error: "upload to storage failed: " + uploadError.message,
        }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      // getPublicUrl just builds the URL string; doesn't verify existence.
      const pub = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
      // pub may be { data: { publicURL: "..." } } or just { publicURL: "..." }
      const pubUrl = (pub && (pub.data?.publicURL || pub.publicURL)) || null;
      // Fall back to constructing the URL directly if getPublicUrl returned null/empty
      const downloadUrl = pubUrl || `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${storagePath}`;

      // Upsert into phone_capabilities so list-modules finds it
      const { error: upsertError } = await supabase
        .from("phone_capabilities")
        .upsert({
          module_name: name,
          version: version,
          type: type,
          status: "uploaded",
          commands: manifest.commands ?? [],
          sha256: sha256,
          storage_path: storagePath,
          download_url: downloadUrl,
          manifest: manifest,
          last_seen_at: new Date().toISOString(),
        }, { onConflict: "module_name,version" });
      if (upsertError) {
        return new Response(JSON.stringify({
          error: "upsert phone_capabilities failed: " + upsertError.message,
        }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        ok: true,
        module: name,
        version: version,
        type: type,
        sha256: sha256,
        storage_path: storagePath,
        download_url: downloadUrl,
        format: "mdl",
      }), { status: 201, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ===== Legacy path: manifest=JSON string + file=binary (.dex/.apk/.so) =====
    const manifestJson = form.get("manifest");
    const legacyFile = form.get("file");
    if (!manifestJson || typeof manifestJson !== "string") {
      return new Response(JSON.stringify({
        error: "Provide 'file' as a .mdl ZIP, or 'manifest' (JSON string) + 'file' (binary) for legacy formats",
      }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (!legacyFile || !(legacyFile instanceof File)) {
      return new Response(JSON.stringify({ error: "file (binary) required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const manifest = JSON.parse(manifestJson);
    const name = manifest.name;
    const version = manifest.version || "0.0.0";
    const type = manifest.type || "dex";
    if (!name) {
      return new Response(JSON.stringify({ error: "manifest.name required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const buf = await legacyFile.arrayBuffer();
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, "0")).join("");
    if (manifest.sha256 && manifest.sha256.toLowerCase() !== sha256.toLowerCase()) {
      return new Response(JSON.stringify({
        error: "sha256 mismatch",
        expected: manifest.sha256,
        actual: sha256,
      }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    try { await supabase.storage.createBucket(BUCKET, { public: true }); } catch (_e) {}
    const ext = type === "so" ? "so" : type;
    const storagePath = `${name}/${version}/${name}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buf, {
        contentType: type === "so" ? "application/octet-stream" : "application/zip",
        upsert: true,
      });
    if (uploadError) {
      return new Response(JSON.stringify({
        error: "upload to storage failed: " + uploadError.message,
      }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const pubLegacy = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const legacyPubUrl = (pubLegacy && (pubLegacy.data?.publicURL || pubLegacy.publicURL)) || null;
    const legacyDownloadUrl = legacyPubUrl || `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${storagePath}`;
    const { error: upsertError } = await supabase
      .from("phone_capabilities")
      .upsert({
        module_name: name,
        version: version,
        type: type,
        status: "uploaded",
        commands: manifest.commands ?? [],
        sha256: sha256,
        storage_path: storagePath,
        download_url: legacyDownloadUrl,
        manifest: manifest,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: "module_name,version" });
    if (upsertError) {
      return new Response(JSON.stringify({
        error: "upsert phone_capabilities failed: " + upsertError.message,
      }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true,
      module: name,
      version: version,
      sha256: sha256,
      storage_path: storagePath,
      download_url: legacyDownloadUrl,
      format: "legacy",
    }), { status: 201, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
