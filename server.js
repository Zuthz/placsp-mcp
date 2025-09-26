import express from "express";
import fetch from "node-fetch";
import { ORG_ALIASES, KEYWORDS } from "./keywords.js";

const app = express();
const PORT = process.env.PORT || 3000;

// === Config ===
// Feed público muy amplio (suele existir en la Plataforma).
// Si este endpoint cambiara, te digo cómo ajustarlo rápidamente.
const FEED_URL = process.env.PLACSP_FEED_URL
  || "https://contrataciondelestado.es/sindicacion/sindicacion_1_2000.json";

/** Normaliza texto para comparar */
const norm = (s = "") =>
  s.toString().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Devuelve true si texto contiene alguna keyword */
const containsAny = (texto, arr) => {
  const t = norm(texto);
  return arr.some(k => t.includes(norm(k)));
};

/** Determina si el organismo coincide con el filtro org */
const orgMatch = (orgFilter, orgNombre) => {
  if (!orgFilter || orgFilter === "todas") return true;
  const aliases = ORG_ALIASES[orgFilter] || [];
  return containsAny(orgNombre, aliases);
};

/** Filtra por días (desde hoy) */
const inLastDays = (isoDate, days) => {
  if (!days) return true;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return true;
  const limit = new Date();
  limit.setDate(limit.getDate() - Number(days));
  return d >= limit;
};

/** Mapea un item del feed a nuestro formato */
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

app.get("/health", (_, res) => res.send("ok"));

/**
 * /search?org=inta|ensa|navantia|fnmt|indra|todas
 *        &q=palabraExtra
 *        &days=90
 *        &limit=100
 */
app.get("/search", async (req, res) => {
  const org = (req.query.org || "todas").toString().toLowerCase();
  const extra = (req.query.q || "").toString();
  const days = Number(req.query.days || 120);
  const limit = Number(req.query.limit || 100);

  try {
    const r = await fetch(FEED_URL, { timeout: 15000 });
    if (!r.ok) throw new Error(`Feed HTTP ${r.status}`);
    const data = await r.json();

    // Algunos feeds devuelven items en data.items, otros en data
    const rawItems = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    const items = rawItems.map(mapItem).filter(it => {
      // 1) Filtrar por organismo si procede
      const okOrg = orgMatch(org, it.organismo);

      // 2) Filtrar por keywords (búsqueda OR entre tu lista y la palabra extra)
      const kw = extra ? [extra, ...KEYWORDS] : KEYWORDS;
      const hayKW = containsAny(
        `${it.titulo} ${it.organismo} ${it.procedimiento} ${it.estado}`,
        kw
      );

      // 3) Filtrar por fecha de los últimos X días (si hay fecha)
      const okFecha = inLastDays(it.fechaPublicacion, days);

      return okOrg && hayKW && okFecha;
    });

    // Ordenar por fecha (desc) si tenemos fecha
    items.sort((a, b) => new Date(b.fechaPublicacion) - new Date(a.fechaPublicacion));

    res.json(items.slice(0, limit));
  } catch (err) {
    res.status(500).json({ error: err.message, hint: "Si el feed público cambia de URL, ajusta FEED_URL." });
  }
});

app.listen(PORT, () => {
  console.log(`PLACSP connector listening on ${PORT}`);
});