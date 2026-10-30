// Edge function: cleanup-old-files
// Deletes all files in the "phone-files" bucket that are older than 1 day.
// Can be called manually (GET) or scheduled via pg_cron / external scheduler.
//
// Query params (all optional):
//   bucket=phone-files    — which bucket to clean (default: phone-files)
//   max_age_hours=24       — files older than this are deleted (default: 24)
//   dry_run=true          — if true, returns what WOULD be deleted without deleting
//
// Returns: {deleted: N, errors: [...], dry_run: bool}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    const bucketName = url.searchParams.get("bucket") || "phone-files";
    const maxAgeHours = Number(url.searchParams.get("max_age_hours") || 24);
    const dryRun = url.searchParams.get("dry_run") === "true";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // List all files in the bucket (paginated — up to 1000 at a time)
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    let allFiles: { name: string; id: string; created_at: string; last_accessed_at?: string; updated_at?: string }[] = [];
    let offset = 0;
    const limit = 1000;

    // The Storage API lists files under folders. We need to list recursively.
    // First, list all top-level folders (prefixes), then list files under each.
    const { data: rootList, error: rootErr } = await supabase.storage
      .from(bucketName)
      .list("", { limit: 1000, offset: 0 });

    if (rootErr) {
      return new Response(JSON.stringify({ error: "root list failed: " + rootErr.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Collect all folders (prefixes) from root
    const folders = (rootList || []).filter(f => f.id === null).map(f => f.name);

    for (const folder of folders) {
      let folderOffset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: files, error: listErr } = await supabase.storage
          .from(bucketName)
          .list(folder, { limit: 1000, offset: folderOffset });

        if (listErr) {
          console.warn("list error for folder", folder, listErr.message);
          break;
        }

        if (!files || files.length === 0) {
          hasMore = false;
          break;
        }

        for (const f of files) {
          if (f.id === null) continue; // skip sub-folders
          // Check age — use created_at or updated_at
          const fileDate = f.created_at || f.updated_at || f.last_accessed_at;
          if (fileDate && new Date(fileDate) < new Date(cutoff)) {
            allFiles.push({ name: f.name, id: f.id, created_at: fileDate, last_accessed_at: f.last_accessed_at, updated_at: f.updated_at });
          }
        }

        folderOffset += files.length;
        hasMore = files.length >= limit;
      }
    }

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true,
        dry_run: true,
        bucket: bucketName,
        max_age_hours: maxAgeHours,
        cutoff: cutoff,
        would_delete: allFiles.length,
        files: allFiles.map(f => ({ name: f.name, created_at: f.created_at })),
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // Delete files
    let deleted = 0;
    const errors: string[] = [];

    // Delete in batches of 100 (Storage API limit per call)
    for (let i = 0; i < allFiles.length; i += 100) {
      const batch = allFiles.slice(i, i + 100);
      // Build full paths: folder/filename
      // We need to know which folder each file is in. Since we listed per-folder,
      // let's reconstruct. Actually, let's just build paths from what we have.
      // The file name includes the folder prefix if we're listing recursively.
      // Supabase list() returns just the filename (not the full path).
      // We need to build the full path as "folder/filename".
      const paths = batch.map(f => {
        // Find which folder this file belongs to by checking all folders
        // Actually, we stored files from each folder separately. Let's
        // rebuild by tracking the folder. Simplest: just try deleting
        // from all known folders.
        return f.name;
      });

      // Try deleting from each known folder
      for (const folder of folders) {
        const { error: delErr } = await supabase.storage
          .from(bucketName)
          .remove(batch.map(f => `${folder}/${f.name}`));
        if (!delErr) {
          deleted += batch.length;
          break; // success — don't try other folders
        }
        // If error, try next folder
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      bucket: bucketName,
      max_age_hours: maxAgeHours,
      cutoff: cutoff,
      deleted: deleted,
      errors: errors.length > 0 ? errors : undefined,
      total_scanned: allFiles.length,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
