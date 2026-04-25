/**
 * cleanup.js — Scan all audio files, validate them, delete broken ones.
 *
 * Usage:  node cleanup.js           (dry run — shows what would be deleted)
 *         node cleanup.js --delete  (actually deletes bad files)
 */

const fs = require("fs");
const path = require("path");

const AUDIO_DIR = path.join(__dirname, "audios");
const DELETE_MODE = process.argv.includes("--delete");

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".webm", ".opus",
]);

// Long-path helper for Windows
function lp(p) {
  if (process.platform === "win32" && !p.startsWith("\\\\?\\")) {
    return "\\\\?\\" + path.resolve(p);
  }
  return p;
}

// Recursively find all audio files
function findAllAudio(dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(lp(dir), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findAllAudio(full));
    } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

// Remove empty directories recursively (bottom-up)
function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(lp(dir), { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name));
    }
  }

  // Re-read after cleaning children
  try {
    const remaining = fs.readdirSync(lp(dir));
    if (remaining.length === 0 && dir !== AUDIO_DIR) {
      fs.rmdirSync(lp(dir));
    }
  } catch { /* ignore */ }
}

async function main() {
  const mm = await import("music-metadata");

  console.log(DELETE_MODE
    ? "\n🗑  DELETE MODE — broken files will be removed\n"
    : "\n🔍  DRY RUN — showing what would be deleted (run with --delete to actually remove)\n"
  );

  console.log("  Scanning for audio files...");
  const allFiles = findAllAudio(AUDIO_DIR);
  console.log(`  Found ${allFiles.length} audio files to check\n`);

  if (allFiles.length === 0) {
    console.log("  Nothing to do.");
    return;
  }

  const bad = [];
  const good = [];
  let checked = 0;

  for (const filePath of allFiles) {
    checked++;
    const rel = path.relative(AUDIO_DIR, filePath);

    // Progress every 100 files
    if (checked % 100 === 0 || checked === allFiles.length) {
      process.stdout.write(`\r  Checked ${checked} / ${allFiles.length} ...`);
    }

    // 1) Check file is stat-able and non-empty
    let stat;
    try {
      stat = fs.statSync(lp(filePath));
    } catch {
      bad.push({ path: filePath, rel, reason: "can't read file (path too long or missing)" });
      continue;
    }
    if (stat.size === 0) {
      bad.push({ path: filePath, rel, reason: "0 bytes" });
      continue;
    }

    // 2) Try to parse audio metadata
    try {
      const metadata = await mm.parseFile(lp(filePath), { duration: true, skipCovers: true });
      const duration = metadata.format.duration;

      if (duration === undefined || duration === null) {
        bad.push({ path: filePath, rel, reason: "no duration detected (unreadable audio)" });
        continue;
      }

      if (duration <= 0) {
        bad.push({ path: filePath, rel, reason: "0s duration" });
        continue;
      }

      good.push(rel);
    } catch (e) {
      const reason = e.message || "parse error";
      bad.push({ path: filePath, rel, reason: reason.substring(0, 80) });
    }
  }

  console.log("\n");

  // Report
  console.log(`  ✓ ${good.length} valid audio files`);
  console.log(`  ✗ ${bad.length} broken/unplayable files\n`);

  if (bad.length === 0) {
    console.log("  All files are good! Nothing to clean up.\n");
    return;
  }

  // Show bad files
  console.log("  Broken files:");
  for (const { rel, reason } of bad) {
    console.log(`    ✗ ${rel}`);
    console.log(`      → ${reason}`);
  }

  if (DELETE_MODE) {
    console.log(`\n  Deleting ${bad.length} files...`);
    let deleted = 0;
    for (const { path: fp, rel } of bad) {
      try {
        fs.unlinkSync(lp(fp));
        deleted++;
      } catch (e) {
        console.error(`    Could not delete ${rel}: ${e.message}`);
      }
    }
    console.log(`  🗑  Deleted ${deleted} files`);

    // Clean up empty folders
    console.log("  Cleaning up empty folders...");
    removeEmptyDirs(AUDIO_DIR);

    console.log(`\n  Done! ${good.length} playable files remain.\n`);
  } else {
    console.log(`\n  Run with --delete to remove these ${bad.length} files:`);
    console.log(`    node cleanup.js --delete\n`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
