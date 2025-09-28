// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import https from "https";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import { ORG_ALIASES, KEYWORDS } from "./keywords.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===================== CONFIG =====================
const FEED_URL =
  process.env.PLACSP_FEED_URL ||
  "https://contrataciondelestado.es/sindicacion/sindicacion.atom"; // índice ATOM
const USE_MOCK = process.env.USE_MOCK === "1";
const USE_HTML = process.env.USE_HTML === "1";
const ALLOW_INSECURE = process.env.ALLOW_INSECURE === "1";

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const SEARCH_ENDPOINT = "https://duckduckgo.com/html/";

// ===================== UTILIDADES =====================
const norm = (s = "") =>
  s.toString().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const stripHtml = (s = "") => String(s).replace(/<[^>]+>/g, " ");

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

// ===================== MOCK =====================
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
      url: "https://contrataciondelestado.es/licitacion/ejemplo-inta-laser",
    },
    {
      titulo: "Sistema waterjet para mecanizado",
      organismo: "Navantia",
      procedimiento: "Abierto simplificado",
      estado: "Publicado",
      importe: "65000",
      fechaPublicacion: "2025-09-20",
      fechaLimite: "2025-10-05",
      url: "https://contrataciondelestado.es/licitacion/ejemplo-navantia-waterjet",
    },
    {
      titulo: "Plegadora CNC para taller naval",
      organismo: "Navantia",
      procedimiento: "SARA",
      estado: "Publicado",
      importe: "120000",
      fechaPublicacion: "2025-08-02",
      fechaLimite: "2025-09-01",
      url: "https://contrataciondelestado.es/licitacion/ejemplo-navantia-plegadora",
    },
  ];
}

// ===================== DRIVER HTML (DUCKDUCKGO) =====================
function buildQuery({ org, q }) {
  const alias = ORG_ALIASES[org] || [];
  const orgTerms =
    org === "todas"
      ? ""
      : alias.length
      ? `(${alias.join(" OR ")})`
      : `(${org})`;
  const base = `site:contrataciondelestado.es ${orgTerms} ${q || ""}`.trim();
  return base.replace(/\s+/g, " ");
}

async function searchHtml({ org = "todas", q = "", limit = 20 }) {
  const query = buildQuery({ org, q });
  const params = new URLSearchParams({ q: query });
  const url = `${SEARCH_ENDPOINT}?${params.toString()}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    },
    timeout: 20000,
    agent: ALLOW_INSECURE ? insecureAgent : undefined,
  });
  if (!r.ok) throw new Error(`Search HTTP ${r.status}`);
  const html = await r.text();

  const $ = cheerio.load(html);
  const results = [];
  $(".result__a").each((_, el) => {
    const a = $(el);
    const href = a.attr("href");
    const title = a.text().trim();
    if (!href || !/^https?:\/\//.test(href)) return;
    if (!/contrataciondelestado\.es/i.test(href)) return;

    results.push({
      titulo: title,
      organismo: org === "todas" ? "" : org.toUpperCase(),
      procedimiento: "",
      estado: "",
      importe: "",
      fechaPublicacion: "",
      fechaLimite: "",
      url: href,
    });
  });

  return results.slice(0, Number(limit || 20));
}

// ===================== DRIVER FEED (ATOM/XML) =====================
async function fetchXml(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "application/atom+xml, application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    },
    timeout: 20000,
    agent: ALLOW_INSECURE ? insecureAgent : undefined,
  });
  const text = await r.text();
  // Logs opcionales de diagnóstico:
  // console.log("[FEED]", "status:", r.status, "url:", url, "len:", text.length);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const xml = parser.parse(text);
  return xml;
}

async function fetchFeed() {
  // Índice de sindicación; intentamos seguir rel="first"
  const indexXml = await fetchXml(FEED_URL);
  const links = indexXml?.feed?.link;
  const arr = Array.isArray(links) ? links : links ? [links] : [];
  const firstUrl = arr.find((l) => (l?.rel || "").toLowerCase() === "first")?.href || FEED_URL;
  const firstXml = await fetchXml(firstUrl);
  return { type: "xml", data: firstXml, firstUrl };
}

function extractItems(feed) {
  const entries = feed.data?.feed?.entry;
  if (!entries) return [];
  const arr = Array.isArray(entries) ? entries : [entries];

  return arr.map((e) => {
    const title = e.title?.["#text"] || e.title || "";
    const link = Array.isArray(e.link) ? e.link[0]?.href : e.link?.href;
    const updated = e.updated || e.published || "";
    const summaryRaw = e.summary?.["#text"] || e.summary || e.content || "";
    const summaryText = stripHtml(summaryRaw);

    const orgRegexes = [
      /Órgano de Contratación:\s*([^<\n]+)/i,
      /Órgano de Contratación\s*-\s*([^<\n]+)/i,
      /Organismo:\s*([^<\n]+)/i,
      /Entidad adjudicadora:\s*([^<\n]+)/i,
    ];
    let organo = "";
    for (const rx of orgRegexes) {
      const m = String(summaryRaw).match(rx);
      if (m) {
        organo = m[1].trim();
        break;
      }
    }

    return {
      titulo: title,
      enlace: link,
      fecha: updated,
      organo,
      summaryText,
      title,
      link,
      date: updated,
      organismo: organo,
    };
  });
}

// ===================== BÚSQUEDA (selector de driver) =====================
async function runSearch({ org = "todas", q = "", days = 120, limit = 100 }) {
  // 1) MOCK
  if (USE_MOCK) {
    const base = mockItems();
    const byOrg =
      org === "todas"
        ? base
        : base.filter((it) => it.organismo.toLowerCase().includes(org.toLowerCase()));
    const withKw = q
      ? byOrg.filter((it) =>
          (it.titulo + " " + it.organismo + " " + it.procedimiento)
            .toLowerCase()
            .includes(q.toLowerCase())
        )
      : byOrg;
    return withKw.slice(0, Number(limit || 100));
  }

  // 2) HTML (barrido web)
  if (USE_HTML) {
    return await searchHtml({ org, q, limit });
  }

  // 3) FEED ATOM/XML (si algún día está accesible)
  const feed = await fetchFeed();
  let rawItems = extractItems(feed);

  // Fallback: si no hay entradas en el "first", podríamos seguir pagesBack aquí (omitido por brevedad)

  // Map + filtro
  const items = rawItems.map(mapItem).filter((it, idx) => {
    const raw = rawItems[idx];
    const textoBuscado = `${it.titulo} ${it.organismo} ${it.procedimiento} ${it.estado} ${raw?.summaryText || ""}`;
    const okOrg =
      it.organismo
        ? orgMatch(String(org).toLowerCase(), it.organismo)
        : org === "todas" ? true : true; // relaja org cuando no viene parseado
    const kw = q ? [q, ...KEYWORDS] : KEYWORDS;
    const hayKW = containsAny(textoBuscado, kw);
    const fechaRef = it.fechaPublicacion || it.fecha || it.date;
    const okFecha = inLastDays(fechaRef, days);
    return okOrg && hayKW && okFecha;
  });

  items.sort(
    (a, b) =>
      new Date(b.fechaPublicacion || b.fecha || b.date) -
      new Date(a.fechaPublicacion || a.fecha || a.date)
  );

  return items.slice(0, Number(limit || 100));
}

// ===================== ENDPOINTS =====================
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
    res.status(500).json({ error: err.message, hint: "Activa USE_HTML=1 o USE_MOCK=1 si no hay feed accesible." });
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
          "Busca licitaciones en la web pública (o feed si disponible) filtrando por organismo (INTA, ENSA, NAVANTIA, FNMT, INDRA) y palabras clave (láser, waterjet, mecanizado, plegado, soldadura...).",
        input_schema: {
          type: "object",
          properties: {
            org: { type: "string", enum: ["inta", "ensa", "navantia", "fnmt", "indra", "todas"] },
            q: { type: "string" },
            days: { type: "integer", minimum: 1, maximum: 3650 },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          required: [],
        },
      },
    ],
  };

  res.write(`data: ${JSON.stringify({ type: "manifest", manifest })}\n\n`);
  const keepAlive = setInterval(() => res.write(":\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    res.end();
  });
});

// ===== MCP: /invoke =====
app.post("/invoke", async (req, res) => {
  try {
    const { tool, args } = req.body || {};
    if (tool !== "placsp.search")
      return res.status(400).json({ error: "Unknown tool" });

    const items = await runSearch({
      org: args?.org || "todas",
      q: args?.q || "",
      days: Number(args?.days || 120),
      limit: Number(args?.limit || 100),
    });

    res.json({ type: "tool_result", tool, content: items });
  } catch (err) {
    res.status(500).json({ error: err.message || "invoke error" });
  }
});

// ===== DEBUG: ver el “pulso” del origen (solo para feed) =====
app.get("/debug", async (req, res) => {
  try {
    // si estás en USE_HTML, este debug no aplica al buscador; muestra estado
    if (USE_HTML) {
      return res.json({ mode: "HTML", note: "USE_HTML=1 activo; /debug feed no aplica" });
    }
    const feed = await fetchFeed();
    const raw = extractItems(feed);
    const mapped = raw.map(mapItem);
    res.json({
      mode: USE_MOCK ? "MOCK" : "FEED",
      feedType: "xml",
      rawCount: raw.length,
      mappedCount: mapped.length,
      samples: mapped.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`PLACSP connector listening on ${PORT}`);
});
