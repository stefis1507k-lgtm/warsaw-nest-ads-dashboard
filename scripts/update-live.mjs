// Щогодинне оновлення «Факту»: читає статистику Meta (лише читання), шифрує в live.enc ключем DASH_KEY.
// Токен і ключ беруться зі змінних середовища (GitHub Secrets) і ніколи не друкуються.
import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN = process.env.META_TOKEN || "";
const KEY = process.env.DASH_KEY || "";
const ACC = "1789094317922925"; // кабінет «Я і Каріша»
const CAMP = process.env.CAMPAIGN_FILTER || "Warsaw Nest — пошук квартири";
const SINCE = process.env.SINCE || "2026-10-28";
const DRY = process.env.DRY_RUN === "1";
const MOCK = process.env.MOCK_FILE || "";
const OUT = process.env.LIVE_OUT || "live.enc";
const base = "https://graph.facebook.com";
const today = new Date().toISOString().slice(0, 10);
const GROUPS = { "А": "Набір А: офер 1, статика", "Б": "Набір Б: офер 2, статика", "В": "Набір В: відео" };

async function api(url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Meta " + r.status + " " + (j.error ? j.error.type + " " + j.error.code : ""));
  return j;
}
async function all(params) {
  const u = new URL(`${base}/act_${ACC}/insights`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let j = await api(u), out = [...(j.data || [])];
  while (j.paging && j.paging.next) { j = await api(j.paging.next); out.push(...(j.data || [])); }
  return out;
}

const num = (v) => Number(v || 0);
const lpv = (r) => num(((r.actions || []).find((a) => a.action_type === "landing_page_view") || {}).value);
const clicksOf = (r) => num(r.inline_link_clicks);
const isNarrow = (pos) => /story|stories|reels/i.test(pos || "");

async function load() {
  if (MOCK) return JSON.parse(fs.readFileSync(MOCK, "utf8"));
  const common = {
    time_range: JSON.stringify({ since: SINCE, until: today }),
    filtering: JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: CAMP }]),
    limit: "500",
  };
  const daily = await all({ ...common, level: "ad", time_increment: "1", fields: "ad_name,adset_name,spend,impressions,inline_link_clicks,actions" });
  const place = await all({ ...common, level: "ad", breakdowns: "publisher_platform,platform_position", fields: "ad_name,adset_name,spend,impressions,inline_link_clicks,actions" });
  return { daily, place };
}

function build({ daily, place }) {
  const idOf = (n) => { const t = String(n || "").split(/\s+/)[0]; return /^(S\d+(?:_\d+)?|V\d+)$/.test(t) ? t : null; };
  const cre = {}, add = (id, r) => {
    const o = cre[id] || (cre[id] = { spend: 0, impressions: 0, clicks: 0 });
    o.spend += num(r.spend); o.impressions += num(r.impressions); o.clicks += clicksOf(r);
  };
  // відео: усі покази разом; статика 4:5 і 9:16 з розбивки за місцем показу
  for (const r of daily) { const id = idOf(r.ad_name); if (id && id[0] === "V") add(id, r); }
  for (const r of place) {
    const id = idOf(r.ad_name); if (!id || id[0] === "V") continue;
    add(isNarrow(r.platform_position) ? id + " · 9:16" : id, r);
  }
  for (const o of Object.values(cre)) {
    o.ctr = o.impressions > 0 ? o.clicks / o.impressions : null;
    o.cpc = o.clicks > 0 ? o.spend / o.clicks : null;
  }
  // набори
  const grp = {};
  for (const r of daily) { const m = /Набір\s+([АБВ])/.exec(r.adset_name || ""); if (m) { const g = GROUPS[m[1]]; (grp[g] || (grp[g] = { spend: 0 })).spend += num(r.spend); } }
  // місця показу
  const rows = {};
  for (const r of place) {
    const p = r.publisher_platform; if (p !== "instagram" && p !== "facebook") continue;
    const kind = /reels/i.test(r.platform_position || "") ? "Reels" : /stor/i.test(r.platform_position || "") ? "Stories" : "стрічка";
    const label = (p === "instagram" ? "Instagram" : "Facebook") + " · " + kind;
    const o = rows[label] || (rows[label] = { place: label, spend: 0, impressions: 0, clicks: 0, landing_views: 0 });
    o.spend += num(r.spend); o.impressions += num(r.impressions); o.clicks += clicksOf(r); o.landing_views += lpv(r);
  }
  const placements = Object.values(rows).map((o) => ({ ...o, cpc: o.clicks > 0 ? o.spend / o.clicks : null }));
  // дні тесту (з першого дня з витратами), до 7 днів
  const byDate = {};
  for (const r of daily) { const d = r.date_start; if (!d) continue; const o = byDate[d] || (byDate[d] = { spend: 0, clicks: 0 }); o.spend += num(r.spend); o.clicks += clicksOf(r); }
  const dates = Object.keys(byDate).sort().filter((d) => byDate[d].spend > 0);
  const dailyRows = [];
  if (dates.length) {
    const t0 = Date.parse(dates[0]);
    for (const d of Object.keys(byDate).sort()) {
      const day = Math.round((Date.parse(d) - t0) / 86400000) + 1;
      if (day >= 1 && day <= 7) dailyRows.push({ day, spend: byDate[d].spend, clicks: byDate[d].clicks, briefs: null, clients: null });
    }
  }
  return { v: 1, updated: new Date().toISOString(), creatives: cre, groups: grp, placements, daily: dailyRows };
}

function encrypt(obj) {
  const key = Buffer.from(KEY, "base64url");
  if (key.length !== 32) throw new Error("DASH_KEY має бути 32 байти (43 символи base64url)");
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64url"), ct: ct.toString("base64url") });
}

let raw;
try { raw = await load(); } catch (e) {
  // помилка Meta не валить запуск: лишаються попередні цифри, причина видна в журналі
  console.log("Не вдалося отримати дані з Meta:", e.message, "| попередній live.enc лишається без змін");
  process.exit(0);
}
const live = build(raw);
const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
console.log("Рядків від Meta (по днях/по місцях):", (raw.daily || []).length, "/", (raw.place || []).length);
console.log("Креативів з даними:", Object.keys(live.creatives).length, "| місць показу:", live.placements.length, "| днів:", live.daily.length);
console.log("Разом витрати:", sum(live.daily, "spend").toFixed(2), "| кліки:", sum(live.daily, "clicks"));
if (DRY) { console.log("DRY RUN: файл не записано"); process.exit(0); }
fs.writeFileSync(OUT, encrypt(live));
console.log("live.enc записано");
