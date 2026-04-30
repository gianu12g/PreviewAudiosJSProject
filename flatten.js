const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "audios");
const DEST = path.join(__dirname, "all-audios");
const EXTS = new Set([".mp3",".wav",".ogg",".flac",".aac",".m4a",".wma",".webm",".opus"]);

if (!fs.existsSync(DEST)) fs.mkdirSync(DEST);

const used = new Set();

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!EXTS.has(path.extname(entry.name).toLowerCase())) continue;

    let base = entry.name;
    if (used.has(base.toLowerCase())) {
      const parent = path.basename(path.dirname(full));
      base = parent + " - " + base;
      let counter = 2;
      while (used.has(base.toLowerCase())) {
        const ext = path.extname(entry.name);
        const stem = parent + " - " + path.basename(entry.name, ext);
        base = stem + "_" + counter + ext;
        counter++;
      }
    }
    used.add(base.toLowerCase());
    fs.copyFileSync(full, path.join(DEST, base));
  }
}

walk(SRC);
console.log("Copied " + used.size + " files to all-audios/");
