import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

// In production replace with your auth provider token (Clerk, Auth0, Supabase, etc.)
// e.g. const { getToken } = useAuth(); const token = await getToken();
const getAuthToken = () => localStorage.getItem("auth_token") || "dev-token";

async function apiFetch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Stream a generated file from the server using SSE
async function streamGenerateFile(filePath, spec, existingFiles, onChunk) {
  const res = await fetch(`${API_BASE}/api/generate-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ filePath, spec, existingFiles }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "chunk") {
          fullContent += data.text;
          onChunk(fullContent);
        }
        if (data.type === "error") throw new Error(data.error);
      } catch {
        // skip malformed lines
      }
    }
  }

  return fullContent;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const FILE_TREE_TEMPLATE = () => [
  { path: "docker-compose.yml", icon: "🐳", label: "docker-compose.yml", category: "root" },
  { path: ".env.example", icon: "🔐", label: ".env.example", category: "root" },
  { path: "frontend/Dockerfile", icon: "🐋", label: "Dockerfile", category: "frontend" },
  { path: "frontend/nginx.conf", icon: "⚙️", label: "nginx.conf", category: "frontend" },
  { path: "frontend/package.json", icon: "📦", label: "package.json", category: "frontend" },
  { path: "frontend/vite.config.ts", icon: "⚡", label: "vite.config.ts", category: "frontend" },
  { path: "frontend/tsconfig.json", icon: "📘", label: "tsconfig.json", category: "frontend" },
  { path: "frontend/tailwind.config.js", icon: "🎨", label: "tailwind.config.js", category: "frontend" },
  { path: "frontend/postcss.config.js", icon: "🔧", label: "postcss.config.js", category: "frontend" },
  { path: "frontend/index.html", icon: "🌐", label: "index.html", category: "frontend" },
  { path: "frontend/src/main.tsx", icon: "🚀", label: "main.tsx", category: "frontend" },
  { path: "frontend/src/App.tsx", icon: "⚛️", label: "App.tsx", category: "frontend" },
  { path: "backend/Dockerfile", icon: "🐋", label: "Dockerfile", category: "backend" },
  { path: "backend/package.json", icon: "📦", label: "package.json", category: "backend" },
  { path: "backend/tsconfig.json", icon: "📘", label: "tsconfig.json", category: "backend" },
  { path: "backend/src/index.ts", icon: "🖥️", label: "index.ts", category: "backend" },
  { path: "backend/src/db.ts", icon: "🗄️", label: "db.ts", category: "backend" },
];

const CATEGORY_COLORS = { root: "#f59e0b", frontend: "#38bdf8", backend: "#34d399" };
const INITIAL_MESSAGES = [{ role: "assistant", content: "welcome", type: "welcome" }];
const BUILD_STEPS = ["Analyzing...", "Designing architecture...", "Generating files...", "Writing Docker config...", "Finalizing..."];

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function Spinner({ size = 16, color = "#38bdf8" }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      border: `2px solid ${color}22`, borderTopColor: color,
      animation: "spin 0.7s linear infinite", display: "inline-block", flexShrink: 0,
    }} />
  );
}

function ProgressBar({ steps, current }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #1e2433" }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {steps.map((_, i) => (
          <div key={i} style={{ flex: 1, height: 3, borderRadius: 4, background: i < current ? "#38bdf8" : i === current ? "#38bdf844" : "#1e2433", transition: "background 0.4s", position: "relative", overflow: "hidden" }}>
            {i === current && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, transparent, #38bdf8, transparent)", animation: "shimmer 1.2s infinite" }} />}
          </div>
        ))}
      </div>
      <div style={{ fontSize: "0.7rem", color: "#64748b", display: "flex", justifyContent: "space-between" }}>
        <span>{steps[current] || "Complete"}</span>
        <span>{Math.min(current, steps.length)}/{steps.length}</span>
      </div>
    </div>
  );
}

function ArchitectureCard({ spec }) {
  if (!spec) return null;
  return (
    <div style={{ margin: "8px 0", background: "#0d1117", border: "1px solid #1e2433", borderRadius: 12, overflow: "hidden", fontSize: "0.78rem" }}>
      <div style={{ padding: "10px 14px", background: "linear-gradient(90deg, #0f2027, #1a2a3a)", borderBottom: "1px solid #1e2433", display: "flex", alignItems: "center", gap: 8 }}>
        <span>🏗️</span><span style={{ fontWeight: 600, color: "#e2e8f0" }}>{spec.appName}</span>
        <span style={{ color: "#64748b", marginLeft: "auto" }}>Architecture</span>
      </div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {Object.entries(spec.services || {}).map(([key, svc]) => (
          <div key={key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", borderRadius: 8, background: key === "frontend" ? "#38bdf808" : key === "backend" ? "#34d39908" : "#a78bfa08", border: `1px solid ${key === "frontend" ? "#38bdf822" : key === "backend" ? "#34d39922" : "#a78bfa22"}` }}>
            <span>{key === "frontend" ? "⚛️" : key === "backend" ? "🖥️" : "🗄️"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ color: key === "frontend" ? "#38bdf8" : key === "backend" ? "#34d399" : "#a78bfa", fontWeight: 600, marginBottom: 2, textTransform: "capitalize" }}>{key} <span style={{ fontSize: "0.65rem", opacity: 0.6 }}>:{svc.port}</span></div>
              <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>{svc.tech}</div>
              <div style={{ color: "#64748b", fontSize: "0.68rem", marginTop: 2 }}>{svc.description}</div>
            </div>
          </div>
        ))}
        {spec.apiRoutes?.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ color: "#64748b", fontSize: "0.68rem", marginBottom: 4 }}>API ROUTES</div>
            {spec.apiRoutes.slice(0, 5).map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontSize: "0.6rem", fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: r.method === "GET" ? "#34d39922" : r.method === "POST" ? "#38bdf822" : "#f59e0b22", color: r.method === "GET" ? "#34d399" : r.method === "POST" ? "#38bdf8" : "#f59e0b" }}>{r.method}</span>
                <code style={{ color: "#94a3b8", fontSize: "0.68rem" }}>{r.path}</code>
                <span style={{ color: "#475569", fontSize: "0.65rem" }}>{r.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileTree({ files, selectedFile, onSelect, generatedFiles, generatingFile }) {
  const categories = ["root", "frontend", "backend"];
  const byCategory = {};
  categories.forEach(c => byCategory[c] = files.filter(f => f.category === c));
  return (
    <div style={{ padding: "8px 0", fontSize: "0.75rem" }}>
      {categories.map(cat => (
        <div key={cat}>
          {cat !== "root" && <div style={{ padding: "6px 16px 2px", color: CATEGORY_COLORS[cat], fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.7 }}>📁 {cat}/</div>}
          {byCategory[cat].map(f => {
            const isGenerated = generatedFiles[f.path] !== undefined;
            const isGenerating = generatingFile === f.path;
            const isSelected = selectedFile === f.path;
            return (
              <div key={f.path} onClick={() => isGenerated && onSelect(f.path)} style={{ padding: "5px 16px 5px " + (cat === "root" ? "16px" : "24px"), display: "flex", alignItems: "center", gap: 6, cursor: isGenerated ? "pointer" : "default", background: isSelected ? "#38bdf811" : "transparent", borderLeft: isSelected ? "2px solid #38bdf8" : "2px solid transparent", transition: "all 0.15s", opacity: isGenerated || isGenerating ? 1 : 0.3 }}>
                <span style={{ fontSize: "0.75rem" }}>{f.icon}</span>
                <span style={{ color: isSelected ? "#e2e8f0" : isGenerated ? "#94a3b8" : "#475569", flex: 1 }}>{f.label}</span>
                {isGenerating && <Spinner size={10} color={CATEGORY_COLORS[cat] || "#38bdf8"} />}
                {isGenerated && !isGenerating && <span style={{ color: "#34d399", fontSize: "0.6rem" }}>✓</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CodeView({ content, path }) {
  const [copied, setCopied] = useState(false);
  if (!content) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#334155" }}>Select a file to view its contents</div>;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #1e2433", display: "flex", alignItems: "center", gap: 8, background: "#0a0e1a" }}>
        <span style={{ color: "#64748b", fontSize: "0.75rem", fontFamily: "monospace" }}>{path}</span>
        <button onClick={() => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: 6, border: "1px solid #1e2433", background: "transparent", color: copied ? "#34d399" : "#64748b", fontSize: "0.7rem", cursor: "pointer" }}>{copied ? "✓ Copied" : "Copy"}</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        <pre style={{ fontFamily: "'Fira Code', monospace", fontSize: "0.72rem", lineHeight: 1.7, color: "#94a3b8", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{content}</pre>
      </div>
    </div>
  );
}

function DockerInstructions({ appName, spec }) {
  const [copied, setCopied] = useState(null);
  const cmd = (s) => (
    <div style={{ background: "#0a0e1a", border: "1px solid #1e2433", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: "0.75rem", color: "#38bdf8", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
      <span>{s}</span>
      <button onClick={() => { navigator.clipboard.writeText(s); setCopied(s); setTimeout(() => setCopied(null), 2000); }} style={{ border: "none", background: "transparent", color: copied === s ? "#34d399" : "#475569", cursor: "pointer", fontSize: "0.7rem" }}>{copied === s ? "✓" : "copy"}</button>
    </div>
  );
  return (
    <div style={{ padding: "16px", fontSize: "0.78rem", color: "#94a3b8" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: "#e2e8f0", fontWeight: 600, marginBottom: 8 }}>🐳 Run your app locally</div>
        {cmd(`cd ${appName || "my-app"}`)}
        {cmd("cp .env.example .env")}
        {cmd("docker compose up --build")}
        <div style={{ color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
          Frontend → <span style={{ color: "#38bdf8" }}>http://localhost:{spec?.services?.frontend?.port || 80}</span><br />
          Backend → <span style={{ color: "#34d399" }}>http://localhost:{spec?.services?.backend?.port || 3001}</span><br />
          Database → <span style={{ color: "#a78bfa" }}>localhost:{spec?.services?.database?.port || 5432}</span>
        </div>
      </div>
      <div style={{ borderTop: "1px solid #1e2433", paddingTop: 14 }}>
        <div style={{ color: "#e2e8f0", fontWeight: 600, marginBottom: 8 }}>⚡ Hot reload</div>
        {cmd("docker compose watch")}
      </div>
      <div style={{ borderTop: "1px solid #1e2433", paddingTop: 14, marginTop: 4 }}>
        <div style={{ color: "#e2e8f0", fontWeight: 600, marginBottom: 8 }}>🔄 Rebuild</div>
        {cmd("docker compose up --build --force-recreate")}
      </div>
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [buildStep, setBuildStep] = useState(-1);
  const [spec, setSpec] = useState(null);
  const [files, setFiles] = useState([]);
  const [generatedFiles, setGeneratedFiles] = useState({});
  const [generatingFile, setGeneratingFile] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [rightPanel, setRightPanel] = useState("files");
  const [conversationHistory, setConversationHistory] = useState([]);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const addMessage = (msg) => setMessages(prev => [...prev, msg]);

  const buildApp = useCallback(async (description) => {
    setLoading(true); setBuildStep(0); setGeneratedFiles({}); setSelectedFile(null);
    try {
      addMessage({ role: "assistant", type: "status", content: "🏗️ Designing architecture..." });
      setBuildStep(1);

      const { spec: specObj } = await apiFetch("/api/architect", { description });

      setSpec(specObj);
      const fileList = FILE_TREE_TEMPLATE();
      setFiles(fileList);
      addMessage({ role: "assistant", type: "architecture", content: specObj });
      setBuildStep(2);

      const generated = {};
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        setBuildStep(Math.min(2 + Math.floor((i / fileList.length) * 2), 4));
        setGeneratingFile(f.path);

        const content = await streamGenerateFile(f.path, specObj, generated, (partial) => {
          setGeneratedFiles(prev => ({ ...prev, [f.path]: partial }));
        });

        generated[f.path] = content;
        setGeneratedFiles(prev => ({ ...prev, [f.path]: content }));
        setGeneratingFile(null);
        if (f.path === "frontend/src/App.tsx") setSelectedFile(f.path);
      }

      setBuildStep(BUILD_STEPS.length);
      addMessage({ role: "assistant", type: "complete", content: `✅ **${specObj.appName}** is ready!\n\n${fileList.length} files generated. Check the Run tab for Docker commands.\n\nWhat would you like to change or add?` });
      setConversationHistory(prev => [...prev, { role: "user", content: description }, { role: "assistant", content: `Generated: ${specObj.appName}` }]);
    } catch (err) {
      addMessage({ role: "assistant", type: "error", content: `Error: ${err.message}` });
    }
    setLoading(false); setBuildStep(-1); setGeneratingFile(null);
  }, []);

  const updateApp = useCallback(async (userRequest) => {
    if (!spec) return;
    setLoading(true);
    addMessage({ role: "assistant", type: "status", content: "🔄 Planning update..." });
    try {
      const { filesToUpdate } = await apiFetch("/api/plan-update", { userRequest, spec, filePaths: files.map(f => f.path), conversationHistory });
      if (!filesToUpdate.length) {
        addMessage({ role: "assistant", type: "text", content: "No file changes needed. Could you be more specific?" });
        setLoading(false); return;
      }
      addMessage({ role: "assistant", type: "status", content: `📝 Updating: ${filesToUpdate.map(f => f.split("/").pop()).join(", ")}` });
      for (const filePath of filesToUpdate) {
        setGeneratingFile(filePath);
        const content = await streamGenerateFile(filePath, spec, generatedFiles, (partial) => setGeneratedFiles(prev => ({ ...prev, [filePath]: partial })));
        setGeneratedFiles(prev => ({ ...prev, [filePath]: content }));
        setGeneratingFile(null);
        if (filePath === selectedFile || filePath === "frontend/src/App.tsx") setSelectedFile(filePath);
      }
      setConversationHistory(prev => [...prev, { role: "user", content: userRequest }, { role: "assistant", content: `Updated: ${filesToUpdate.join(", ")}` }]);
      addMessage({ role: "assistant", type: "complete", content: `✅ Updated ${filesToUpdate.map(f => f.split("/").pop()).join(", ")}.\n\nRun \`docker compose up --build\` to apply. What else?` });
    } catch (err) {
      addMessage({ role: "assistant", type: "error", content: `Update failed: ${err.message}` });
    }
    setLoading(false); setGeneratingFile(null);
  }, [spec, files, generatedFiles, selectedFile, conversationHistory]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    addMessage({ role: "user", content: trimmed });
    setInput("");
    if (!spec) await buildApp(trimmed); else await updateApp(trimmed);
  }, [input, loading, spec, buildApp, updateApp]);

  const handleKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } };

  const handleDownloadFile = (path, content) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = path.split("/").pop(); a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadZip = async () => {
    // Dynamically load JSZip from CDN
    if (!window.JSZip) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const zip = new window.JSZip();
    const appName = spec?.appName || "my-app";
    // Add every file at its full path inside a root folder
    Object.entries(generatedFiles).forEach(([filePath, content]) => {
      zip.file(`${appName}/${filePath}`, content);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${appName}.zip`; a.click();
    URL.revokeObjectURL(url);
  };

  const totalFiles = files.length;
  const doneFiles = Object.keys(generatedFiles).length;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#070b14", color: "#c9d1e0", fontFamily: "'DM Sans', system-ui, sans-serif", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Fira+Code:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e2433; border-radius: 4px; }
        textarea:focus { outline: none; } button:focus { outline: none; }
      `}</style>

      {/* CHAT PANEL */}
      <div style={{ width: 380, minWidth: 380, display: "flex", flexDirection: "column", background: "#070b14", borderRight: "1px solid #111827" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #111827", background: "linear-gradient(180deg, #0a0f1e 0%, #070b14 100%)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #0ea5e9, #38bdf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 24px #38bdf833" }}>🐳</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.9rem", letterSpacing: "-0.01em" }}>DockerForge</div>
            <div style={{ fontSize: "0.65rem", color: "#334155", marginTop: 1 }}>AI Full-Stack Builder</div>
          </div>
          {spec && <div style={{ marginLeft: "auto", fontSize: "0.65rem", fontWeight: 600, background: "#34d39911", border: "1px solid #34d39933", color: "#34d399", padding: "3px 8px", borderRadius: 20 }}>{spec.appName}</div>}
        </div>

        {loading && buildStep >= 0 && <ProgressBar steps={BUILD_STEPS} current={buildStep} />}

        <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((m, i) => {
            if (m.type === "welcome") return (
              <div key={i} style={{ animation: "fadeUp 0.4s ease" }}>
                <div style={{ background: "linear-gradient(135deg, #0f1629, #111827)", border: "1px solid #1e2433", borderRadius: 14, padding: "18px 16px" }}>
                  <div style={{ fontSize: "1.5rem", marginBottom: 10 }}>🐳</div>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#e2e8f0", marginBottom: 6 }}>Full-Stack Docker Builder</div>
                  <div style={{ color: "#64748b", fontSize: "0.78rem", lineHeight: 1.7, marginBottom: 12 }}>Describe any app and I'll generate a complete containerized full-stack project — React frontend, Express backend, PostgreSQL, all wired with Docker Compose.</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {["A project management tool with tasks and teams", "A SaaS dashboard with user auth and billing", "An e-commerce store with products and cart"].map((ex, j) => (
                      <button key={j} onClick={() => { setInput(ex); inputRef.current?.focus(); }} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #1e2433", background: "#0d1117", color: "#64748b", fontSize: "0.73rem", cursor: "pointer", textAlign: "left", transition: "all 0.15s" }}
                        onMouseOver={e => { e.target.style.borderColor = "#38bdf844"; e.target.style.color = "#94a3b8"; }}
                        onMouseOut={e => { e.target.style.borderColor = "#1e2433"; e.target.style.color = "#64748b"; }}>→ {ex}</button>
                    ))}
                  </div>
                </div>
              </div>
            );
            if (m.type === "architecture") return <div key={i} style={{ animation: "fadeUp 0.4s ease" }}><ArchitectureCard spec={m.content} /></div>;
            if (m.type === "status") return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, animation: "fadeUp 0.3s ease" }}>
                <Spinner size={12} color="#38bdf8" />
                <span style={{ fontSize: "0.75rem", color: "#475569" }}>{m.content}</span>
              </div>
            );
            const isUser = m.role === "user";
            return (
              <div key={i} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", animation: "fadeUp 0.3s ease" }}>
                {!isUser && <div style={{ width: 24, height: 24, borderRadius: 6, flexShrink: 0, marginRight: 8, marginTop: 2, background: "linear-gradient(135deg, #0ea5e9, #38bdf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>🐳</div>}
                <div style={{ maxWidth: "80%", padding: "9px 13px", fontSize: "0.8rem", lineHeight: 1.65, borderRadius: isUser ? "14px 14px 4px 14px" : "4px 14px 14px 14px", background: isUser ? "linear-gradient(135deg, #0369a1, #0ea5e9)" : m.type === "complete" ? "#0f2027" : m.type === "error" ? "#1a0a0a" : "#0d1117", border: isUser ? "none" : `1px solid ${m.type === "complete" ? "#164e63" : m.type === "error" ? "#7f1d1d" : "#1e2433"}`, color: isUser ? "#fff" : m.type === "error" ? "#fca5a5" : "#94a3b8", whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            );
          })}
          {loading && buildStep === -1 && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Spinner size={12} /><span style={{ fontSize: "0.75rem", color: "#334155" }}>Thinking...</span></div>}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: "12px 16px 16px", borderTop: "1px solid #111827" }}>
          {spec && (
            <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
              {["Add auth", "Add dark mode", "Add search", "More API routes"].map(s => (
                <button key={s} onClick={() => setInput(s)} style={{ padding: "3px 9px", fontSize: "0.65rem", border: "1px solid #1e2433", borderRadius: 20, background: "transparent", color: "#475569", cursor: "pointer" }}>{s}</button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", background: "#0d1117", border: "1px solid #1e2433", borderRadius: 12, padding: "10px 12px" }}>
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
              placeholder={spec ? "Request a change or feature..." : "Describe the app you want to build..."} rows={1}
              style={{ flex: 1, background: "transparent", border: "none", color: "#e2e8f0", fontSize: "0.82rem", resize: "none", lineHeight: 1.5, fontFamily: "inherit", maxHeight: 100, overflowY: "auto" }}
              onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 100) + "px"; }} />
            <button onClick={handleSend} disabled={loading || !input.trim()} style={{ width: 32, height: 32, borderRadius: 8, border: "none", flexShrink: 0, background: loading || !input.trim() ? "#111827" : "linear-gradient(135deg, #0369a1, #0ea5e9)", color: loading || !input.trim() ? "#1e2433" : "#fff", cursor: loading || !input.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s", boxShadow: loading || !input.trim() ? "none" : "0 4px 14px #0ea5e933" }}>
              {loading ? <Spinner size={14} color="#334155" /> : <span style={{ fontSize: 16 }}>↑</span>}
            </button>
          </div>
        </div>
      </div>

      {/* FILE TREE */}
      <div style={{ width: 220, minWidth: 220, borderRight: "1px solid #111827", background: "#070b14", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #111827", display: "flex", alignItems: "center", gap: 6, background: "#0a0f1e" }}>
          <span style={{ fontSize: "0.7rem", color: "#334155", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>Files</span>
          {totalFiles > 0 && <span style={{ marginLeft: "auto", fontSize: "0.62rem", color: doneFiles === totalFiles ? "#34d399" : "#38bdf8", fontWeight: 600 }}>{doneFiles}/{totalFiles}</span>}
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {files.length === 0 ? <div style={{ padding: "24px 16px", color: "#1e2433", fontSize: "0.72rem", lineHeight: 1.6 }}>Files appear here once generation starts.</div>
            : <FileTree files={files} selectedFile={selectedFile} onSelect={setSelectedFile} generatedFiles={generatedFiles} generatingFile={generatingFile} />}
        </div>
        {doneFiles > 0 && (
          <div style={{ padding: "10px 12px", borderTop: "1px solid #111827" }}>
            <button onClick={handleDownloadZip}
              style={{ width: "100%", padding: "8px", borderRadius: 8, border: "1px solid #164e63", background: "#0c1f2c", color: "#38bdf8", fontSize: "0.72rem", cursor: "pointer", fontWeight: 600 }}>
              ⬇ Download .zip
            </button>
          </div>
        )}
      </div>

      {/* CODE / RUN PANEL */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#070b14", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "0 16px", borderBottom: "1px solid #111827", background: "#0a0f1e", height: 46, gap: 4 }}>
          {[{ key: "files", label: "</> Code" }, { key: "instructions", label: "🐳 Run" }].map(t => (
            <button key={t.key} onClick={() => setRightPanel(t.key)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: rightPanel === t.key ? "#0ea5e911" : "transparent", color: rightPanel === t.key ? "#38bdf8" : "#334155", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer", borderBottom: rightPanel === t.key ? "2px solid #38bdf8" : "2px solid transparent", transition: "all 0.15s" }}>{t.label}</button>
          ))}
          {selectedFile && generatedFiles[selectedFile] && rightPanel === "files" && (
            <button onClick={() => handleDownloadFile(selectedFile, generatedFiles[selectedFile])} style={{ marginLeft: "auto", padding: "5px 12px", borderRadius: 8, border: "1px solid #1e2433", background: "transparent", color: "#475569", fontSize: "0.7rem", cursor: "pointer" }}>⬇ Download</button>
          )}
          {loading && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: "0.7rem", color: "#334155" }}>
              <Spinner size={10} color="#38bdf8" />
              <span style={{ animation: "pulse 1.5s infinite" }}>{generatingFile ? `Streaming ${generatingFile.split("/").pop()}...` : "Working..."}</span>
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          {rightPanel === "files" ? <CodeView content={selectedFile ? generatedFiles[selectedFile] : null} path={selectedFile} />
            : <div style={{ height: "100%", overflowY: "auto" }}><DockerInstructions appName={spec?.appName} spec={spec} /></div>}
        </div>
        <div style={{ height: 28, borderTop: "1px solid #111827", display: "flex", alignItems: "center", padding: "0 16px", background: "#0a0f1e", gap: 16 }}>
          {[{ tech: "React + Vite + TS + Tailwind", color: "#38bdf8" }, { tech: "Node.js + Express + TS", color: "#34d399" }, { tech: "PostgreSQL 16", color: "#a78bfa" }].map(s => (
            <div key={s.tech} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: s.color, opacity: spec ? 1 : 0.3 }} />
              <span style={{ fontSize: "0.62rem", color: spec ? s.color : "#1e2433", opacity: spec ? 0.8 : 1 }}>{s.tech}</span>
            </div>
          ))}
          <span style={{ marginLeft: "auto", fontSize: "0.62rem", color: "#1e2433" }}>DockerForge v2.0</span>
        </div>
      </div>
    </div>
  );
}