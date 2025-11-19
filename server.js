// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { loadDb, saveDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 4000;

// -------------------------
// CORS CONFIGURATION
// -------------------------

// Hard-coded allowed origins + optional extra from env
const defaultAllowedOrigins = [
  "https://zkarchive.us",
  "https://app.zkarchive.us",
  "https://useodds.fun",
  "http://localhost:3000",
  "http://localhost:5173"
];

// You can override or extend via env: CORS_ORIGINS="https://a.com,https://b.com"
let allowedOrigins = [...defaultAllowedOrigins];
if (process.env.CORS_ORIGINS) {
  const extra = process.env.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  allowedOrigins = [...new Set([...allowedOrigins, ...extra])];
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (e.g., curl, Postman) with no origin
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: false
  })
);

app.use(express.json());

// -------------------------
// UPLOAD STORAGE
// -------------------------

const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const id = uuidv4();
    const ext = path.extname(file.originalname || "");
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 100) * 1024 * 1024
  }
});

// -------------------------
// IN-MEMORY CACHE
// -------------------------

let archives = loadDb();

// -------------------------
// ROUTES
// -------------------------

// Healthcheck for Render
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/upload
 *
 * multipart/form-data:
 *  - file: binary file (already encrypted on the client)
 *  - hash: string (any identifier, e.g. content hash / note id)
 *  - walletAddress: string (user wallet address, optional)
 */
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    const { hash, walletAddress } = req.body;

    if (!hash || typeof hash !== "string") {
      return res.status(400).json({ error: "Field 'hash' is required" });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    const archive = {
      id,
      name: req.file.originalname || "encrypted-file",
      size: req.file.size,
      mimeType: req.file.mimetype || "application/octet-stream",
      hash,
      walletAddress: walletAddress || null,
      storagePath: req.file.filename,
      createdAt: now
    };

    // Put newest at the top
    archives.unshift(archive);
    saveDb(archives);

    return res.status(201).json({
      success: true,
      archive
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/files
 * Optional query:
 *  - wallet: filter by wallet address
 */
app.get("/api/files", (req, res) => {
  try {
    const { wallet } = req.query;

    if (wallet) {
      const items = archives.filter(
        (a) =>
          (a.walletAddress || "").toLowerCase() === wallet.toLowerCase()
      );
      return res.json({ items });
    }

    return res.json({ items: archives });
  } catch (err) {
    console.error("List files error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/files/:id
 * Returns metadata only (not the raw file).
 */
app.get("/api/files/:id", (req, res) => {
  try {
    const { id } = req.params;
    const archive = archives.find((a) => a.id === id);

    if (!archive) {
      return res.status(404).json({ error: "Archive not found" });
    }

    return res.json({ archive });
  } catch (err) {
    console.error("Get file metadata error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Optional: serve uploaded blobs (for debugging only)
app.use("/uploads", express.static(UPLOAD_DIR));

// Fallback 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler (including CORS errors)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS blocked" });
  }
  return res.status(500).json({ error: "Internal server error" });
});

// -------------------------
// START SERVER
// -------------------------

app.listen(PORT, () => {
  console.log(`zkArchive backend running on port ${PORT}`);
  console.log("Allowed CORS origins:", allowedOrigins);
});
