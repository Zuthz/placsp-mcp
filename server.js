import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import { ORG_ALIASES, KEYWORDS } from "./keywords.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===== CONFIG FEED =====
const FEED_URL =
  process.env.PLACSP_FEED_URL ||
  "https://contrataciondelestado.es/sindicacion/sindicacion_1_2000"; // ATOM/XML genérico

// ===== UTILIDADES =====
const norm = (s = "") =>
  s.toString().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const containsAny = (texto, arr) => {
  const t = norm(texto);
  return arr.some(k => t.includes(norm(k)));
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
  url: it.enlace || it.link || it.url || ""
});

// ===== MOCK PARA PRUEBAS =====
function mockItems() {
  return [
    {
      titulo: "Suministro máquina de corte por láser",
      organismo: "INTA",
      procedimiento: "Abierto",
      estado: "Publicado",
      importe: "100000",
      fechaPublicacion: "2025-09-25",
      fechaLimite: "2025-10-10",
      url: "https://contrataciondelestado.es/licitacion/ejemplo-inta-laser"
    },
    {
      titulo: "Sistema waterjet para mecanizado",
      organismo: "Navantia",
      procedimiento: "Abierto simplificado",
      estado: "Publicado",
      importe: "65000",
      fechaPublicacion: "2025-09-20",
      fechaLimite: "2025-10-05",
      url: "https://contrataciondelestado.es/licitacion/ejemplo-navantia-waterjet"
    }
  ];
}

// ===== LECTURA FEED REAL =====
async function fetchFeed() {
  const r = await fetch(FEED_URL, {
    // algunos servidores no devuelven nada si no ven un User-Agent "normal"
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    },
    // Render + Cloudflare a veces necesitan más margen
    // (node-fetch soporta este timeout así)
    timeout: 20000
  });

  if (!r.ok) throw new Error(`Feed HTTP ${r.status}`);

  const text = await r.text();
  const t = text.trim();

  // ¿JSON?
  if (t.startsWith("{") || t.startsWith("[")) {
    return { type: "json", data: JSON.parse(t) };
  }

  // ATOM/XML
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const xml = parser.parse(t);
  return { type: "xml", data: xml };
}
function extractItems(feed) {
  if (feed.type === "json") {
    const d = feed.data;
    return Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
  }
  const entries = feed.data?.feed?.entry;
  if (!entries) return [];
  const arr = Array.isArray(entries) ? entries : [entries];
  return arr.map(e => {
    const title = e.title?.["#text"] || e.title || "";
    const link = Array.isArray(e.link) ? e.link[0]?.href : e.link?.href;
    const updated = e.updated || e.published || "";
    const summary = e.summary?.["#text"] || e.summary || e.content || "";
    const orgMatch = String(summary).match(/Órgano de Contratación:\s*([^<\n]+)/i);
    return {
      titulo: title,
      enlace: link,
      fecha: updated,
      organo: orgMatch ? orgMatch[1].trim() : "",
      title,
      link,
      date: updated,
      organismo: orgMatch ? orgMatch[1].trim() : ""
    };
  });
}

// ===== LÓGICA DE BÚSQUEDA =====
async function runSearch({ org = "todas", q = "", days = 120, limit = 100 }) {
  if (process.env.USE_MOCK === "1") {
    const base = mockItems();
    const byOrg = org === "todas"
      ? base
      : base.filter(it => it.organismo.toLowerCase().includes(org.toLowerCase()));
    const withKw = q ? byOrg.filter(it =>
      (it.titulo + " " + it.organismo + " " + it.procedimiento).toLowerCase().includes(q.toLowerCase())
    ) : byOrg;
    return withKw.slice(0, Number(limit || 100));
  }

  const feed = await fetchFeed();
  const rawItems = extractItems(feed);

  const items = rawItems.map(mapItem).filter(it => {
    const okOrg = orgMatch(String(org).toLowerCase(), it.organismo);
    const kw = q ? [q, ...KEYWORDS] : KEYWORDS;
    const hayKW = containsAny(
      `${it.titulo} ${it.organismo} ${it.procedimiento} ${it.estado}`,
      kw
    );
    const okFecha = inLastDays(it.fechaPublicacion || it.fecha || it.date, days);
    return okOrg && hayKW && okFecha;
  });

  items.sort(
    (a, b) =>
      new Date(b.fechaPublicacion || b.fecha || b.date) -
      new Date(a.fechaPublicacion || a.fecha || a.date)
  );
  return items.slice(0, Number(limit || 100));
}

// ===== ENDPOINTS =====
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

// ===== MCP: /sse (manifiesto) =====
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
          "Busca licitaciones en la Plataforma del Sector Público filtrando por organismo y palabras clave de maquinaria.",
        input_schema: {
          type: "object",
          properties: {
            org: { type: "string", enum: ["inta","ensa","navantia","fnmt","indra","todas"] },
            q: { type: "string" },
            days: { type: "integer", minimum: 1, maximum: 3650 },
            limit: { type: "integer", minimum: 1, maximum: 500 }
          },
          required: []
        }
      }
    ]
  };

  res.write(`data: ${JSON.stringify({ type: "manifest", manifest })}\n\n`);
  const keepAlive = setInterval(() => res.write(":\n\n"), 25000);
  req.on("close", () => { clearInterval(keepAlive); res.end(); });
});

// ===== MCP: /invoke =====
app.post("/invoke", async (req, res) => {
  try {
    const { tool, args } = req.body || {};
    if (tool !== "placsp.search") return res.status(400).json({ error: "Unknown tool" });

    const items = await runSearch({
      org: args?.org || "todas",
      q: args?.q || "",
      days: Number(args?.days || 120),
      limit: Number(args?.limit || 100)
    });

    res.json({ type: "tool_result", tool, content: items });
  } catch (err) {
    res.status(500).json({ error: err.message || "invoke error" });
  }
});

// ===== DEBUG: ver cuántos items trae el feed y 3 ejemplos =====
app.get("/debug", async (req, res) => {
  try {
    const feed = await fetchFeed();          // lee el ATOM/JSON real
    const rawItems = extractItems(feed);     // extrae las entradas
    const mapped = rawItems.map(mapItem);    // aplica tu normalización

    res.json({
      feedType: feed.type,
      rawCount: rawItems.length,
      mappedCount: mapped.length,
      samples: mapped.slice(0, 3)            // primeras 3 entradas
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`PLACSP connector listening on ${PORT}`);
});
