import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

// ─── INIT ─────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // never leaves this server
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(helmet()); // security headers
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

// Rate limit: 20 AI requests per user per minute
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
// Replace this with your real auth (Clerk, Auth0, Supabase Auth, JWT, etc.)

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // TODO: verify JWT or session token here
  // e.g. const user = await verifyJWT(token);
  // For now, any token passes (replace before going live)
  req.user = { id: token, plan: "pro" };
  next();
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    model: "claude-sonnet-4-6",
    timestamp: new Date().toISOString(),
  });
});

// ─── ARCHITECT ENDPOINT ───────────────────────────────────────────────────────
// Takes a plain-English app description, returns structured JSON architecture

app.post("/api/architect", requireAuth, aiLimiter, async (req, res) => {
  const { description } = req.body;

  if (!description?.trim()) {
    return res.status(400).json({ error: "description is required" });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are an expert full-stack architect. Given an app description, output ONLY a JSON object (no markdown, no explanation) with this exact structure:

{
  "appName": "my-app",
  "description": "one line description",
  "services": {
    "frontend": { "tech": "React + Vite + TypeScript + Tailwind CSS", "port": 5173, "description": "what it does" },
    "backend": { "tech": "Node.js + Express + TypeScript", "port": 3001, "description": "REST API endpoints" },
    "database": { "tech": "PostgreSQL 16", "port": 5432, "description": "tables and schema overview" }
  },
  "features": ["feature1", "feature2"],
  "apiRoutes": [
    {"method": "GET", "path": "/api/items", "description": "list all items"},
    {"method": "POST", "path": "/api/items", "description": "create item"}
  ]
}`,
      messages: [{ role: "user", content: description }],
    });

    const text = message.content.find((b) => b.type === "text")?.text || "";

    let spec;
    try {
      spec = JSON.parse(text.replace(/```json\n?|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "Failed to parse architecture JSON", raw: text });
    }

    res.json({ spec });
  } catch (err) {
    console.error("Architect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GENERATE FILE ENDPOINT (STREAMING) ───────────────────────────────────────
// Streams file content back using SSE so the UI can show content as it arrives

app.post("/api/generate-file", requireAuth, aiLimiter, async (req, res) => {
  const { filePath, spec, existingFiles = {} } = req.body;

  if (!filePath || !spec) {
    return res.status(400).json({ error: "filePath and spec are required" });
  }

  // SSE headers — client receives chunks as they stream
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const existingContext = Object.entries(existingFiles)
      .slice(-3)
      .map(([p, c]) => `// ${p}\n${String(c).slice(0, 400)}...`)
      .join("\n\n");

    const prompt = `App spec:\n${JSON.stringify(spec, null, 2)}\n\nAlready generated files (for context):\n${existingContext}\n\nNow generate the complete contents of: ${filePath}\n\nReturn ONLY the file content, nothing else.`;

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: `You are an expert full-stack developer. Generate complete, production-ready file contents for a Docker-based full-stack app. Return ONLY raw file content — no markdown fences, no explanation.

Rules:
- frontend/src/App.tsx: Full React app with Tailwind CSS, beautiful UI, real API calls via fetch('/api/...')
- frontend/vite.config.ts: proxy /api to http://backend:3001
- frontend/Dockerfile: multi-stage build with nginx
- frontend/nginx.conf: serve built app, proxy /api to backend:3001
- backend/src/index.ts: Express app, all routes, CORS, PostgreSQL via pg library (host=db, port=5432, user=appuser, password=secret, database=appdb)
- backend/src/db.ts: pg Pool, CREATE TABLE IF NOT EXISTS, seed data
- backend/Dockerfile: node:20-alpine, ts-node
- docker-compose.yml: frontend + backend + postgres:16-alpine with healthcheck, volumes, depends_on
- All package.json files: correct deps, scripts
Make the UI genuinely beautiful with gradients, shadows, animations.`,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        send({ type: "chunk", text: chunk.delta.text });
      }
    }

    const final = await stream.finalMessage();
    send({ type: "done", usage: final.usage });
    res.end();
  } catch (err) {
    console.error("Generate file error:", err.message);
    send({ type: "error", error: err.message });
    res.end();
  }
});

// ─── UPDATE FILES ENDPOINT ────────────────────────────────────────────────────
// Given a change request, returns which files need updating

app.post("/api/plan-update", requireAuth, aiLimiter, async (req, res) => {
  const { userRequest, spec, filePaths, conversationHistory = [] } = req.body;

  if (!userRequest || !spec || !filePaths) {
    return res.status(400).json({ error: "userRequest, spec, and filePaths are required" });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system:
        "You are a code update planner. Given an app and a change request, list which files need updating. Return ONLY file paths, one per line, no explanation, no bullet points.",
      messages: [
        ...conversationHistory,
        {
          role: "user",
          content: `Current app spec:\n${JSON.stringify(spec, null, 2)}\n\nUser wants to: ${userRequest}\n\nWhich files need to be regenerated? Choose from:\n${filePaths.join("\n")}`,
        },
      ],
    });

    const text = message.content.find((b) => b.type === "text")?.text || "";
    const files = text
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^[-*•]\s*/, ""))
      .filter((l) => filePaths.includes(l));

    res.json({ filesToUpdate: files });
  } catch (err) {
    console.error("Plan update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 DockerForge API running on http://localhost:${PORT}`);
  console.log(`   Anthropic key set: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`   Frontend allowed:  ${process.env.FRONTEND_URL || "http://localhost:5173"}`);
  console.log(`   Health:            http://localhost:${PORT}/health\n`);
});
