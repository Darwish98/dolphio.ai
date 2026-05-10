import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(helmet());

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
  })
);

app.use(express.json({ limit: "2mb" }));

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  req.user = {
    id: token,
    plan: "pro",
  };

  next();
}

const FILE_RULES = {
  "frontend/src/App.jsx":
    "Main React application component",

  "frontend/src/main.jsx":
    "React entry point",

  "backend/server.js":
    "Express backend server",

  "frontend/vite.config.js":
    "Vite config",

  "docker-compose.yml":
    "Docker compose file",
};

function detectIncompleteCode(code) {
  if (!code) return true;

  const opens = (code.match(/{/g) || []).length;
  const closes = (code.match(/}/g) || []).length;

  return (
    code.includes("TODO") ||
    code.endsWith("{") ||
    code.endsWith("(") ||
    opens !== closes
  );
}

function validateJavaScript(code) {
  try {
    new Function(code);
    return {
      valid: true,
      errors: [],
    };
  } catch (err) {
    return {
      valid: false,
      errors: [err.message],
    };
  }
}

async function generateFile({
  filePath,
  spec,
  existingFiles,
}) {
  const relevantContext = Object.entries(existingFiles || {})
    .slice(-2)
    .map(([p, c]) => {
      return `FILE: ${p}

${String(c).slice(0, 1000)}
`;
    })
    .join("\n\n");

  const prompt = `
APP SPEC:
${JSON.stringify(spec, null, 2)}

TARGET FILE:
${filePath}

FILE PURPOSE:
${FILE_RULES[filePath] || "Application file"}

RELATED FILES:
${relevantContext}

RULES:
- JavaScript only
- JSX only
- Never use TypeScript
- Never use interfaces
- Never use type annotations
- Complete file only
- Must compile
- Use relative imports correctly
- No markdown
- No explanations

Generate ONLY the file.
`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2500,

    system: `
You generate ONE production-ready file.

CRITICAL RULES:
- Output ONLY raw code
- Never use markdown
- Never explain
- Never truncate code
- Complete all functions
- Never use TypeScript
- Never output partial code
- Never output placeholders
- Prefer small modular components
`,

    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text =
    response.content.find((x) => x.type === "text")?.text || "";

  return text.trim();
}

async function repairFile({
  filePath,
  code,
  errors,
}) {
  const prompt = `
FILE:
${filePath}

BROKEN CODE:
${code}

ERRORS:
${errors.join("\n")}

Fix the file.

Rules:
- Return FULL corrected file
- No markdown
- No explanations
- JavaScript only
`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2500,

    system: `
You repair broken code files.

Return ONLY corrected code.
`,

    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return (
    response.content.find((x) => x.type === "text")?.text || ""
  ).trim();
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    model: "claude-sonnet-4-6",
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/api/architect",
  requireAuth,
  aiLimiter,
  async (req, res) => {
    const { description } = req.body;

    if (!description?.trim()) {
      return res.status(400).json({
        error: "description required",
      });
    }

    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",

        max_tokens: 1200,

        system: `
You are an expert full-stack architect.

Return ONLY valid JSON.

Use:
- React
- Vite
- JavaScript
- JSX
- Express
- SQLite

Never use TypeScript.
`,

        messages: [
          {
            role: "user",
            content: description,
          },
        ],
      });

      const text =
        message.content.find((b) => b.type === "text")?.text || "";

      let spec;

      try {
        spec = JSON.parse(
          text.replace(/```json|```/g, "").trim()
        );
      } catch (err) {
        return res.status(500).json({
          error: "Failed to parse architecture JSON",
          raw: text,
        });
      }

      res.json({ spec });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: err.message,
      });
    }
  }
);

app.post(
  "/api/generate-file",
  requireAuth,
  aiLimiter,
  async (req, res) => {
    const {
      filePath,
      spec,
      existingFiles = {},
    } = req.body;

    if (!filePath || !spec) {
      return res.status(400).json({
        error: "filePath and spec required",
      });
    }

    try {
      let code = await generateFile({
        filePath,
        spec,
        existingFiles,
      });

      let validation = validateJavaScript(code);

      if (
        !validation.valid ||
        detectIncompleteCode(code)
      ) {
        code = await repairFile({
          filePath,
          code,
          errors: validation.errors,
        });

        validation = validateJavaScript(code);
      }

      res.json({
        success: validation.valid,
        code,
        errors: validation.errors,
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: err.message,
      });
    }
  }
);

app.post(
  "/api/repair-file",
  requireAuth,
  aiLimiter,
  async (req, res) => {
    const {
      filePath,
      code,
      errors,
    } = req.body;

    try {
      const fixed = await repairFile({
        filePath,
        code,
        errors,
      });

      const validation =
        validateJavaScript(fixed);

      res.json({
        success: validation.valid,
        code: fixed,
        errors: validation.errors,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  }
);

app.post(
  "/api/verify-file",
  requireAuth,
  aiLimiter,
  async (req, res) => {
    const { code } = req.body;

    const validation =
      validateJavaScript(code);

    res.json(validation);
  }
);

app.listen(PORT, () => {
  console.log(`
🚀 Dolphio API running
http://localhost:${PORT}
`);
});