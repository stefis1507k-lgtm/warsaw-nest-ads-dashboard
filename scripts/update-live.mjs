// Щогодинне оновлення «Факту»: читає статистику Meta (лише читання), шифрує в live.enc ключем DASH_KEY.
// Токен і ключ беруться зі змінних середовища (GitHub Secrets) і ніколи не друкуються.
import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN = process.env.META_TOKEN || "";
const KEY = process.env.DASH_KEY || "";
const ACC = "1789094317922925"; // кабінет «Я і Каріша»
const CAMP = process.env.CAMPAIGN_FILTER || "Warsaw Nest — ліди, Варшава +45 км";
const SINCE = process.env.SINCE || "2026-11-02";
const DRY = process.env.DRY_RUN === "1";
const MOCK = process.env.MOCK_FILE || "";
const OUT = process.env.LIVE_OUT || "live.enc";
const SB = process.env.SUPABASE_URL || "https://yfezeouwonqqtmsrsten.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SS_KEY = process.env.SMARTSENDER_API_TOKEN || "";
const SS = "https://api.smartsender.com/v1";
const TEST_CONTACTS = ["243152878", "243256273"]; // тестові акаунти Світлани і Каріни, не клієнти
const base = "https://graph.facebook.com";
const today = new Date().toISOString().slice(0, 10);
const GROUPS = { "А": "Набір А: офер 1, статика", "Б": "Набір Б: офер 2, статика", "В": "Набір В: відео" };

async function api(url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Meta " + r.status + " " + (j.error ? j.error.type + " " + j.error.code + " " + String(j.error.message || "").slice(0, 160) : ""));
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
  if (SINCE > today) return { daily: [], place: [] }; // реклама ще не стартувала: нічого не питаємо в Meta
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

// Вхід у бот = перше повідомлення контакту в SmartSender (читання). Сторінки повідомлень йдуть від нових до старих.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ss(path) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(SS + path, { headers: { Authorization: "Bearer " + SS_KEY, Accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status !== 423) throw new Error("SmartSender " + r.status);
    await sleep(2000 * (i + 1)); // ліміт запитів SmartSender: чекаємо й повторюємо
  }
  throw new Error("SmartSender: ліміт не минув після повторів");
}
const msgPage = async (id, p) => (await ss(`/contacts/${id}/messages?page=${p}&limitation=20`)).collection || [];
const warsawDay = (ts) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }); // YYYY-MM-DD за Варшавою
// true, якщо перше повідомлення контакту припадає на SINCE або пізніше (за Варшавою)
async function startedSince(id) {
  const p1 = await msgPage(id, 1);
  if (!p1.length) return false;
  if (p1.length < 20) return warsawDay(p1[p1.length - 1].createdAt) >= SINCE;
  if (warsawDay(p1[p1.length - 1].createdAt) < SINCE) return false; // на 1-й сторінці вже старіші за SINCE
  let lo = 1, hi = 2; // знаходимо останню непорожню сторінку
  while ((await msgPage(id, hi)).length > 0) { lo = hi; hi *= 2; await sleep(200); }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await msgPage(id, mid)).length > 0) lo = mid; else hi = mid; await sleep(200); }
  const last = await msgPage(id, lo);
  return warsawDay(last[last.length - 1].createdAt) >= SINCE;
}
async function smartsenderEntries() {
  if (!SS_KEY) throw new Error("немає SMARTSENDER_API_TOKEN");
  let entries = 0;
  for (let p = 1; ; p++) {
    const j = await ss(`/contacts?page=${p}&limitation=20`);
    for (const c of j.collection || []) {
      if (TEST_CONTACTS.includes(String(c.id))) continue;
      if (await startedSince(c.id)) entries++;
      await sleep(150);
    }
    if (p >= Number((j.cursor || {}).pages || 1)) break;
  }
  return entries;
}

// Воронка з Supabase: функція funnel_counts лише читає дані, тестові контакти виключає сама
async function funnel() {
  const r = await fetch(`${SB}/rest/v1/rpc/funnel_counts`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_since: SINCE, p_test_contacts: TEST_CONTACTS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Supabase " + r.status + " " + String(j.message || "").slice(0, 160));
  return j;
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
// Вартість кроку = витрати Meta за весь період ÷ кількість людей на кроці (повні витрати, не лише 7 днів)
let fun = null;
try { fun = await funnel(); } catch (e) { console.log("Не вдалося отримати воронку з Supabase:", e.message, "| брифи і перегляди буде порожньо"); }
let entries = null;
try { entries = await smartsenderEntries(); } catch (e) { console.log("Не вдалося порахувати входи в SmartSender:", e.message, "| входи буде порожньо"); }
const spendAll = (raw.daily || []).reduce((s, x) => s + num(x.spend), 0); // Meta віддає spend рядком
const clicksAll = (raw.daily || []).reduce((s, x) => s + clicksOf(x), 0); // посилання (inline_link_clicks)
const imprAll = (raw.daily || []).reduce((s, x) => s + num(x.impressions), 0);
const landingAll = (raw.daily || []).reduce((s, x) => s + lpv(x), 0); // Meta: перехід на сайт (landing_page_view), для порівняння з входами в бот
// Meta: натискання кнопки Start на лендингу (подія пікселя StartSearch; у даних Meta це тип offsite_conversion.fb_pixel_custom)
const startAll = (raw.daily || []).reduce((s, x) => s + num(((x.actions || []).find((a) => a.action_type === "offsite_conversion.fb_pixel_custom") || {}).value), 0);
const perStep = (n) => (n > 0 && spendAll > 0 ? spendAll / n : null);
live.funnel = {
  since: SINCE,
  spend: spendAll,
  clicks: clicksAll,
  impressions: imprAll,
  landing_views: landingAll,
  start_search: startAll,
  entries,
  briefs: fun ? fun.briefs_confirmed : null,
  viewings: fun ? fun.viewing_requests : null,
  cost_click: perStep(clicksAll),
  cost_landing: perStep(landingAll),
  cost_start: perStep(startAll),
  cost_entry: perStep(entries),
  cost_brief: fun ? perStep(fun.briefs_confirmed) : null,
  cost_viewing: fun ? perStep(fun.viewing_requests) : null,
};
console.log("Воронка:", JSON.stringify({ clicks: live.funnel.clicks, impressions: live.funnel.impressions, entries: live.funnel.entries, briefs: live.funnel.briefs, viewings: live.funnel.viewings }));
if (DRY) { console.log("DRY RUN: файл не записано"); process.exit(0); }
fs.writeFileSync(OUT, encrypt(live));
console.log("live.enc записано");
