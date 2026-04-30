const express = require("express");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ──────────────────────────────────────────────────────────
const AUDIO_DIR = path.join(__dirname, "all-audios");

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".webm", ".opus",
]);

// ── Long-path helper ────────────────────────────────────────────────
// Windows has a 260-char path limit by default. Prefixing with \\?\
// tells the OS to bypass that limit. Works on NTFS with Node's fs.
function lp(p) {
  if (process.platform === "win32" && !p.startsWith("\\\\?\\")) {
    return "\\\\?\\" + path.resolve(p);
  }
  return p;
}

// ── Ensure audios folder exists ─────────────────────────────────────
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  console.log(`Created "${AUDIO_DIR}" — drop your zips / audio files there.`);
}

// ── Extract any .zip files found in AUDIO_DIR ───────────────────────
function extractZips() {
  const zips = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".zip"));
  for (const zipName of zips) {
    const zipPath = path.join(AUDIO_DIR, zipName);
    const destFolder = path.join(AUDIO_DIR, path.parse(zipName).name);
    if (fs.existsSync(destFolder)) {
      console.log(`  Skipping "${zipName}" (already extracted)`);
      // Delete the zip since extraction folder exists
      try {
        fs.unlinkSync(zipPath);
        console.log(`  🗑  Deleted zip: ${zipName}`);
      } catch (e) {
        console.error(`  Could not delete zip ${zipName}: ${e.message}`);
      }
      continue;
    }
    console.log(`  Extracting "${zipName}" (this may take a while for large files)...`);
    fs.mkdirSync(destFolder, { recursive: true });
    try {
      execSync(`tar -xf "${zipPath}" -C "${destFolder}"`, {
        stdio: "inherit",
        timeout: 600000,
      });
      console.log(`  ✓ Extracted to "${destFolder}"`);
      // Delete the zip after successful extraction
      try {
        fs.unlinkSync(zipPath);
        console.log(`  🗑  Deleted zip: ${zipName}`);
      } catch (e) {
        console.error(`  Could not delete zip ${zipName}: ${e.message}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to extract "${zipName}":`, err.message);
      console.error(`    Extract manually into audios/${path.parse(zipName).name}/`);
    }
  }
}

// ── Recursively collect audio files ─────────────────────────────────
function collectAudioFiles(dir, baseDir = dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(lp(dir), { withFileTypes: true });
  } catch (e) {
    console.error(`  [scan] Can't read dir: ${dir} — ${e.message}`);
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(collectAudioFiles(full, baseDir));
    } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      // Verify file is real and non-empty using long-path-safe stat
      try {
        const stat = fs.statSync(lp(full));
        if (stat.isFile() && stat.size > 0) {
          results.push(path.relative(baseDir, full).replace(/\\/g, "/"));
        }
      } catch {
        // truly broken file, skip silently
      }
    }
  }
  return results;
}

// ── Routes ──────────────────────────────────────────────────────────

// Serve the front-end
app.use(express.static(path.join(__dirname, "public")));

// Serve audio files — long-path safe, range-request safe
app.get("/audio/*", (req, res) => {
  try {
    const relative = decodeURIComponent(req.path.replace("/audio/", ""));
    const filePath = path.join(AUDIO_DIR, relative);

    // Safety: block path traversal
    if (!filePath.startsWith(AUDIO_DIR)) return res.status(403).end();

    const safePath = lp(filePath);

    let stat;
    try {
      stat = fs.statSync(safePath);
    } catch (e) {
      return res.status(404).json({ error: "File not found" });
    }

    if (!stat.isFile() || stat.size === 0) {
      return res.status(404).json({ error: "Not a file or empty" });
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
      ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4",
      ".wma": "audio/x-ms-wma", ".webm": "audio/webm", ".opus": "audio/opus",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";
    const fileSize = stat.size;

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      let start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= fileSize) end = fileSize - 1;
      if (start >= fileSize) start = 0;

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });
      const stream = fs.createReadStream(safePath, { start, end });
      stream.on("error", (e) => {
        console.error(`  [stream err] ${relative}: ${e.message}`);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      const stream = fs.createReadStream(safePath);
      stream.on("error", (e) => {
        console.error(`  [stream err] ${relative}: ${e.message}`);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      stream.pipe(res);
    }
  } catch (e) {
    console.error(`  [crash prevented] ${req.path}: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// API: list all audio files
app.get("/api/files", (_req, res) => {
  try {
    const files = collectAudioFiles(AUDIO_DIR);
    files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: re-extract zips (e.g. after dropping new ones in)
app.post("/api/extract", (_req, res) => {
  extractZips();
  res.json({ ok: true });
});

// ── File upload (audio files & zips via browser) ───────────────────
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ...AUDIO_EXTENSIONS,
  ".zip",
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._\-() ]/g, "_");
      const dest = path.join(AUDIO_DIR, safe);
      if (fs.existsSync(dest)) {
        cb(null, `${Date.now()}_${safe}`);
      } else {
        cb(null, safe);
      }
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} is not allowed`));
    }
  },
});

app.post("/api/upload", upload.array("files", 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }
  const zips = req.files.filter((f) => f.originalname.toLowerCase().endsWith(".zip"));
  if (zips.length > 0) {
    extractZips();
  }
  const saved = req.files.map((f) => f.filename);
  res.json({ ok: true, files: saved, count: saved.length });
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ── Roblox Open Cloud — Upload Audio ────────────────────────────────
// Roblox only accepts: .mp3, .ogg, .wav, .flac (max 20MB, 7min)
const ROBLOX_MIME = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

app.use(express.json());

// Upload a single audio file to Roblox
app.post("/api/roblox/upload", async (req, res) => {
  const { apiKey, userId, groupId, filePath: relPath, displayName, description } = req.body;

  if (!apiKey || (!userId && !groupId) || !relPath) {
    return res.status(400).json({ error: "Missing apiKey, userId/groupId, or filePath" });
  }

  const absPath = path.join(AUDIO_DIR, relPath);
  if (!absPath.startsWith(AUDIO_DIR)) return res.status(403).json({ error: "Invalid path" });

  const ext = path.extname(absPath).toLowerCase();
  const contentType = ROBLOX_MIME[ext];
  if (!contentType) {
    return res.status(400).json({
      error: `Roblox doesn't accept ${ext} files. Convert to .mp3, .ogg, .wav, or .flac first.`,
    });
  }

  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(lp(absPath));
  } catch (e) {
    return res.status(404).json({ error: `Can't read file: ${e.message}` });
  }

  if (fileBuffer.length > 20 * 1024 * 1024) {
    return res.status(400).json({ error: "File exceeds Roblox's 20MB limit" });
  }

  const name = displayName || path.parse(relPath).name.substring(0, 50);
  const desc = description || "";

  // Build multipart form manually
  const boundary = "----RobloxUpload" + Date.now();
  // Use groupId if provided, otherwise userId
  const creator = groupId
    ? { groupId: String(groupId) }
    : { userId: String(userId) };

  const requestJson = JSON.stringify({
    assetType: "Audio",
    displayName: name,
    description: desc,
    creationContext: { creator },
  });

  const preamble = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="request"`,
    `Content-Type: application/json`,
    ``,
    requestJson,
    `--${boundary}`,
    `Content-Disposition: form-data; name="fileContent"; filename="${path.basename(relPath)}"`,
    `Content-Type: ${contentType}`,
    ``,
    ``,
  ].join("\r\n");

  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([Buffer.from(preamble), fileBuffer, epilogue]);

  try {
    const response = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || data.error || JSON.stringify(data),
      });
    }

    // Response contains { path: "operations/{operationId}" }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Upload failed: ${e.message}` });
  }
});

// Poll operation status to get the asset ID
app.post("/api/roblox/poll", async (req, res) => {
  const { apiKey, operationId } = req.body;

  if (!apiKey || !operationId) {
    return res.status(400).json({ error: "Missing apiKey or operationId" });
  }

  try {
    const response = await fetch(
      `https://apis.roblox.com/assets/v1/operations/${operationId}`,
      { headers: { "x-api-key": apiKey } }
    );
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Poll failed: ${e.message}` });
  }
});

// ── Crash guards — keep the server alive no matter what ─────────────
process.on("uncaughtException", (err) => {
  console.error("  [uncaught]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("  [unhandled rejection]", err);
});

// ── Start ───────────────────────────────────────────────────────────
extractZips();

console.log("\n  Scanning audio files...");
const fileCount = collectAudioFiles(AUDIO_DIR).length;
app.listen(PORT, () => {
  console.log(`\n🎧  Audio Preview running at  http://localhost:${PORT}`);
  console.log(`   Found ${fileCount} audio file(s) in "${AUDIO_DIR}"\n`);
});
