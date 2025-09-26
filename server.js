import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { ORG_ALIASES, KEYWORDS } from "./keywords.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// === Config ===
const FEED_URL =
  process.env.PLACSP_FEED_URL ||
  "https://contrataciondelestado.es/sindicacion/sindicacion_1_2000.json";

// --- utilidades ---
const norm = (s = "") =>
  s.toString().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const containsAny = (texto, arr) => {
  const t = norm(texto);
  return arr.some((k) => t.includes(norm(k)));
};

const orgMatch = (orgFilter, orgNombre) => {
  if (!orgFilter || orgFilter === "todas") return true;
  const aliases = ORG_ALIASES[orgFilter] || [];
  return containsAny(orgNombre, aliases);
};

const inLastDays = (isoDate, days) => {
  if (!days) return true;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return true;
  const limit = new Date();
  limit.setDate(limit.getDate() - Number(days));
  return d >= limit;
};

const mapItem = (it = {}) => ({
  titulo: it.titulo || it.title || "",
  organismo: it.organo || it.organismo || "",
  procedimiento: it.procedimiento || it.tipo || "",
  estado: it.estado || it.state || "",
  importe: it.presupuesto || it.importe || it.precio || "",
  fechaPublicacion: it.fecha || it.publicacion || it.date || "",
  fechaLimite: it.fecha_limite || it.limitDate || "",
  url: it.enlace || it.link || it.url || "",
});

// --- lógica común de búsqueda (reutilizable por /search y /invoke) ---
async function runSearch({ org = "todas", q = "", days = 120, limit = 100 }) {
  const r = await fetch(FEED_URL, { timeout: 15000 });
  if (!r.ok) throw new Error(`Feed HTTP ${r.status}`);
  const data = await r.json();

  const rawItems = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data)
    ? data
    : [];

  const items = rawItems.map(mapItem).filter((it) => {
    const okOrg = orgMatch(String(org).toLowerCase(), it.organismo);
    const kw = q ? [q, ...KEYWORDS] : KEYWORDS;
    const hayKW = containsAny(
      `${it.titulo} ${it.organismo} ${it.procedimiento} ${it.estado}`,
      kw
    );
    const okFecha = inLastDays(it.fechaPublicacion, days);
    return okOrg && hayKW && okFecha;
  });

  items.sort(
    (a, b) => new Date(b.fechaPublicacion) - new Date(a.fechaPublicacion)
  );

  return items.slice(0, Number(limit || 100));
}

// --- endpoints existentes ---
app.get("/health", (_, res) => res.send("ok"));

app.get("/search", async (req, res) => {
  try {
    const items = await runSearch({
      org: req.query.org || "todas",
      q: req.query.q || "",
      days: Number(req.query.days || 120),
      limit: Number(req.query.limit || 100),
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message, hint: "Ajusta PLACSP_FEED_URL si cambia el feed." });
  }
});

// --- MCP: manifiesto SSE y ejecución de herramientas ---

// 2.1) /sse expone el manifiesto del conector (tools)
app.get("/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const manifest = {
    protocol: "mcp",
    version: "0.1",
    tools: [
      {
        name: "placsp.search",
        description:
          "Busca licitaciones públicas en la Plataforma de Contratación del Sector Público filtrando por organismo y palabras clave de maquinaria (láser, waterjet, mecanizado, plegado, soldadura, etc.).",
        input_schema: {
          type: "object",
          properties: {
            org: {
              type: "string",
              enum: ["inta", "ensa", "navantia", "fnmt", "indra", "todas"],
              description:
                "Organismo a filtrar. Usa 'todas' para no filtrar por organismo.",
            },
            q: {
              type: "string",
              description:
                "Palabra clave adicional. Por defecto ya se usan keywords de maquinaria.",
            },
            days: {
              type: "integer",
              minimum: 1,
              maximum: 3650,
              description: "Días hacia atrás a considerar (por defecto 120).",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              description: "Máximo de resultados (por defecto 100).",
            },
          },
          required: [],
        },
      },
    ],
  };

  // Enviamos el manifiesto como primer evento
  res.write(`data: ${JSON.stringify({ type: "manifest", manifest })}\n\n`);

  // mantenemos viva la conexión
  const keepAlive = setInterval(() => res.write(":\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    res.end();
  });
});

// 2.2) /invoke ejecuta una tool con argumentos
app.post("/invoke", async (req, res) => {
  try {
    const { tool, args } = req.body || {};
    if (tool !== "placsp.search") {
      return res.status(400).json({ error: "Unknown tool" });
    }

    const items = await runSearch({
      org: args?.org || "todas",
      q: args?.q || "",
      days: Number(args?.days || 120),
      limit: Number(args?.limit || 100),
    });

    return res.json({
      type: "tool_result",
      tool,
      content: items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "invoke error" });
  }
});

app.listen(PORT, () => {
  console.log(`PLACSP connector listening on ${PORT}`);
});
