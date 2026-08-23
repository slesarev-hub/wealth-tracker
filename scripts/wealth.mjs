#!/usr/bin/env node
// Wealth Tracker CLI — read-only access to the "Wealth Tracker" spreadsheet.
//
// Auth reuses the task-tracker-auth Cloudflare Worker session that already
// lives in ~/.config/task-tracker/config.json: the worker holds a Google
// refresh token in KV and hands out fresh access tokens, so this never needs
// an interactive login again. The worker's scopes are
//   https://www.googleapis.com/auth/spreadsheets  (read+write, all sheets)
//   https://www.googleapis.com/auth/drive.readonly (needed for discovery)
// which is enough to read this spreadsheet even though the web app created it
// under a different OAuth client.
//
// Commands:
//   wealth.mjs dump [--raw|--formatted|--both]   print Accounts + Snapshots
//   wealth.mjs json                              machine-readable dump
//   wealth.mjs check                             audit stored data for defects
//
// This script never writes. Backups: `wealth.mjs json > backup.json`.

import fs from "fs";
import os from "os";
import path from "path";

const AUTH_WORKER_URL =
  "https://task-tracker-auth.alexander-g-slesarev.workers.dev";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const CONFIG_PATH =
  process.env.TRACKER_CONFIG_DIR
    ? path.join(process.env.TRACKER_CONFIG_DIR, "config.json")
    : path.join(os.homedir(), ".config", "task-tracker", "config.json");
const CACHE_PATH = path.join(
  os.homedir(),
  ".config",
  "task-tracker",
  "wealth-spreadsheet-id"
);
const SHEET_NAME = process.env.WEALTH_SHEET_NAME || "Wealth Tracker";

const die = (msg) => {
  process.stderr.write(msg + "\n");
  process.exit(1);
};

const getAccessToken = async () => {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    die(`No tracker config at ${CONFIG_PATH}. Run: tracker login`);
  }
  if (!cfg.sessionId) die("No sessionId in tracker config. Run: tracker login");
  const r = await fetch(`${AUTH_WORKER_URL}/token`, {
    headers: { Authorization: `Bearer ${cfg.sessionId}` },
  });
  if (r.status === 401) die("Session expired or revoked. Run: tracker login");
  if (!r.ok) die(`Auth worker error: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
};

const getSpreadsheetId = async (token) => {
  if (process.env.WEALTH_SHEET_ID) return process.env.WEALTH_SHEET_ID;
  try {
    const cached = fs.readFileSync(CACHE_PATH, "utf8").trim();
    if (cached) return cached;
  } catch {}
  const q = encodeURIComponent(
    `name='${SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
  );
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) die(`Drive search failed: ${r.status} ${await r.text()}`);
  const files = (await r.json()).files || [];
  if (files.length === 0) {
    die(
      `No '${SHEET_NAME}' spreadsheet found in Drive.\n` +
        `Set WEALTH_SHEET_ID=<id> if it is named differently.`
    );
  }
  if (files.length > 1) {
    process.stderr.write(
      `warning: ${files.length} spreadsheets named '${SHEET_NAME}'; using the first\n` +
        files.map((f) => `  ${f.id}  ${f.modifiedTime}`).join("\n") +
        "\n"
    );
  }
  try {
    fs.writeFileSync(CACHE_PATH, files[0].id + "\n", { mode: 0o600 });
  } catch {}
  return files[0].id;
};

const values = async (token, sid, range, render) => {
  const r = await fetch(
    `${SHEETS}/${sid}/values/${encodeURIComponent(range)}?valueRenderOption=${render}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) die(`Sheets GET ${range} (${render}): ${r.status} ${await r.text()}`);
  return (await r.json()).values || [];
};

const meta = async (token, sid) => {
  const r = await fetch(
    `${SHEETS}/${sid}?fields=properties(title,locale,timeZone),sheets(properties(title,gridProperties))`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) die(`Sheets meta: ${r.status} ${await r.text()}`);
  return r.json();
};

const load = async () => {
  const token = await getAccessToken();
  const sid = await getSpreadsheetId(token);
  const m = await meta(token, sid);
  const [accF, accU, snapF, snapU] = await Promise.all([
    values(token, sid, "Accounts!A1:Z", "FORMATTED_VALUE"),
    values(token, sid, "Accounts!A1:Z", "UNFORMATTED_VALUE"),
    values(token, sid, "Snapshots!A1:Z", "FORMATTED_VALUE"),
    values(token, sid, "Snapshots!A1:Z", "UNFORMATTED_VALUE"),
  ]);
  const has = (t) => m.sheets.some((s) => s.properties.title === t);
  const rateU = has("Rates") ? await values(token, sid, "Rates!A1:Z", "UNFORMATTED_VALUE") : [];
  const metaU = has("Meta") ? await values(token, sid, "Meta!A1:Z", "UNFORMATTED_VALUE") : [];
  return { sid, meta: m, accF, accU, snapF, snapU, rateU, metaU };
};

// ── commands ────────────────────────────────────────────────────────────────

const cmdDump = async (mode) => {
  const { sid, meta: m, accF, accU, snapF, snapU } = await load();
  console.log(`spreadsheet: ${sid}`);
  console.log(
    `title: ${m.properties.title} · locale: ${m.properties.locale} · tz: ${m.properties.timeZone}`
  );
  for (const s of m.sheets) {
    const g = s.properties.gridProperties;
    console.log(`  tab "${s.properties.title}": ${g.rowCount}x${g.columnCount}`);
  }
  const show = (name, f, u) => {
    console.log(`\n── ${name} (${Math.max(f.length, u.length) - 1} data rows) ──`);
    const n = Math.max(f.length, u.length);
    for (let i = 0; i < n; i++) {
      const fr = f[i] || [];
      const ur = u[i] || [];
      if (mode === "formatted") console.log(`${String(i + 1).padStart(3)}| ${JSON.stringify(fr)}`);
      else if (mode === "raw") console.log(`${String(i + 1).padStart(3)}| ${JSON.stringify(ur)}`);
      else {
        console.log(`${String(i + 1).padStart(3)}| F ${JSON.stringify(fr)}`);
        if (JSON.stringify(fr) !== JSON.stringify(ur))
          console.log(`   | U ${JSON.stringify(ur)}   <-- differs`);
      }
    }
  };
  show("Accounts", accF, accU);
  show("Snapshots", snapF, snapU);
};

const cmdJson = async () => {
  const { sid, meta: m, accF, accU, snapF, snapU, rateU, metaU } = await load();
  console.log(
    JSON.stringify(
      { spreadsheetId: sid, properties: m.properties, accF, accU, snapF, snapU, rateU, metaU },
      null,
      2
    )
  );
};

// Mirrors src/App.jsx: prevMonth(), HAS_PNL, readFromSheets() parsing.
const prevMonth = (mo) => {
  const d = new Date(mo + "-15");
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const HAS_PNL = new Set(["investment", "crypto"]);

const cmdCheck = async () => {
  const { accF, accU, snapF, snapU, rateU, metaU } = await load();
  const hdr = (snapF[0] || []).map((c) => String(c ?? "").trim());
  const v2 = hdr.includes("contributed");
  const metaMap = Object.fromEntries((metaU || []).slice(1).map((r) => [String(r[0] ?? ""), r[1]]));
  console.log(`schema: ${v2 ? "v2" : "v1"}${metaMap.schemaVersion ? ` (Meta says v${metaMap.schemaVersion}, revision ${metaMap.revision})` : " (no Meta tab)"}`);
  if (v2) return cmdCheckV2({ accU, snapF, snapU, rateU, metaMap });
  const problems = [];
  const note = (sev, msg) => problems.push(`[${sev}] ${msg}`);

  // Header sanity
  const accHdr = (accF[0] || []).join(",");
  const snapHdr = (snapF[0] || []).join(",");
  if (accHdr !== "id,name,type,currency,closed,closedMonth")
    note("HIGH", `Accounts header unexpected: "${accHdr}"`);
  if (snapHdr !== "id,accountId,month,balance,invested")
    note("HIGH", `Snapshots header unexpected: "${snapHdr}"`);

  // Cell types: the app writes numbers as RAW strings; check what came back.
  const numericAsText = [];
  for (let i = 1; i < snapU.length; i++) {
    const row = snapU[i] || [];
    for (const col of [3, 4]) {
      const v = row[col];
      if (v === undefined || v === "") continue;
      if (typeof v === "string") numericAsText.push(`row ${i + 1} col ${"ABCDE"[col]}: ${JSON.stringify(v)}`);
    }
  }
  if (numericAsText.length)
    note(
      "INFO",
      `${numericAsText.length} numeric cells stored as text (expected: the app writes RAW strings):\n      ` +
        numericAsText.slice(0, 5).join("\n      ")
    );

  // Formatted vs unformatted divergence => parseFloat on read may misparse.
  for (let i = 1; i < Math.max(snapF.length, snapU.length); i++) {
    const f = snapF[i] || [], u = snapU[i] || [];
    for (const col of [3, 4]) {
      if (f[col] === undefined || f[col] === "") continue;
      const parsed = parseFloat(String(f[col]).replace(/ |\s/g, ""));
      const raw = typeof u[col] === "number" ? u[col] : parseFloat(u[col]);
      if (!isNaN(raw) && (isNaN(parsed) || Math.abs(parsed - raw) > 1e-9))
        note(
          "HIGH",
          `row ${i + 1} col ${"ABCDE"[col]}: app reads FORMATTED "${f[col]}" -> parseFloat ${parsed}, real value ${raw}`
        );
    }
  }

  const accounts = (accU.slice(1) || []).map(([id, name, type, currency, closed, closedMonth]) => ({
    id: String(id ?? ""), name, type, currency,
    closed: String(closed) === "true" || closed === true,
    closedMonth: closedMonth || undefined,
  }));
  const snapshots = (snapU.slice(1) || []).map(([id, accountId, month, balance, invested]) => ({
    id: String(id ?? ""), accountId: String(accountId ?? ""), month: String(month ?? ""),
    balance: typeof balance === "number" ? balance : parseFloat(balance),
    invested: invested === "" || invested === undefined ? undefined
      : typeof invested === "number" ? invested : parseFloat(invested),
  }));

  const accById = new Map(accounts.map((a) => [a.id, a]));

  // Orphans / duplicates / bad values
  for (const s of snapshots) {
    if (!accById.has(s.accountId))
      note("HIGH", `snapshot ${s.id} references unknown accountId ${s.accountId} (month ${s.month})`);
    if (isNaN(s.balance)) note("HIGH", `snapshot ${s.id} (${s.month}) has non-numeric balance`);
    if (!/^\d{4}-\d{2}$/.test(s.month)) note("HIGH", `snapshot ${s.id} has malformed month "${s.month}"`);
  }
  const seen = new Map();
  for (const s of snapshots) {
    const k = `${s.accountId}|${s.month}`;
    if (seen.has(k)) note("HIGH", `duplicate snapshot for account ${accById.get(s.accountId)?.name || s.accountId} month ${s.month} — month totals double-count it`);
    seen.set(k, s);
  }
  const ids = new Set();
  for (const s of snapshots) {
    if (ids.has(s.id)) note("MED", `duplicate snapshot id ${s.id}`);
    ids.add(s.id);
  }

  // Float artifacts
  for (const s of snapshots) {
    for (const [field, v] of [["balance", s.balance], ["invested", s.invested]]) {
      if (v === undefined || isNaN(v)) continue;
      const str = String(v);
      if (/\.\d{9,}/.test(str))
        note("MED", `snapshot ${s.id} (${s.month}) ${field} has float artifact: ${str}`);
    }
  }

  // The cumulative-invested chain: the real reason we are here.
  const months = [...new Set(snapshots.map((s) => s.month))].sort();
  for (const acc of accounts) {
    if (!HAS_PNL.has(acc.type)) {
      const withInv = snapshots.filter((s) => s.accountId === acc.id && s.invested !== undefined);
      if (withInv.length)
        note("MED", `account "${acc.name}" is type ${acc.type} but ${withInv.length} snapshots carry 'invested' (P&L is not displayed for this type)`);
      continue;
    }
    const own = snapshots
      .filter((s) => s.accountId === acc.id)
      .sort((a, b) => a.month.localeCompare(b.month));
    let prevInv = null, prevMo = null;
    for (const s of own) {
      if (s.invested === undefined) {
        note("MED", `"${acc.name}" ${s.month}: no 'invested' — P&L not shown for this month`);
        prevInv = null; prevMo = s.month; continue;
      }
      if (prevInv !== null && s.invested < prevInv) {
        const gap = prevMo && prevMonth(s.month) !== prevMo;
        note(
          "HIGH",
          `"${acc.name}" ${s.month}: cumulative invested DROPPED ${prevInv} -> ${s.invested}` +
            (gap ? ` (gap: previous record is ${prevMo}, not ${prevMonth(s.month)} — matches the skipped-month reset bug)` : ` (no gap; either a withdrawal or a corrupted base)`) +
            `; P&L for this month = ${s.balance - s.invested}`
        );
      }
      if (prevMo && prevMonth(s.month) !== prevMo)
        note(
          "HIGH",
          `"${acc.name}": gap between ${prevMo} and ${s.month} — saveRecord uses prevMonth(${s.month})=${prevMonth(s.month)} as the cumulative base, which does not exist`
        );
      prevInv = s.invested; prevMo = s.month;
    }
    if (own.length) {
      const last = own[own.length - 1];
      if (last.invested !== undefined)
        console.log(`  "${acc.name}": last ${last.month} balance ${last.balance} invested ${last.invested} P&L ${(last.balance - last.invested).toFixed(2)}`);
    }
  }

  // Months where an account has no snapshot but had one before and after:
  // monthTotal() treats the missing month as 0, denting the chart.
  for (const acc of accounts) {
    const own = snapshots.filter((s) => s.accountId === acc.id).map((s) => s.month).sort();
    if (own.length < 2) continue;
    const first = own[0], last = own[own.length - 1];
    for (const m of months) {
      if (m <= first || m >= last) continue;
      if (own.includes(m)) continue;
      if (acc.closed && acc.closedMonth && m > acc.closedMonth) continue;
      note("MED", `"${acc.name}" has no snapshot for ${m} (recorded ${first}..${last}) — counted as 0 in that month's total`);
    }
  }

  console.log(`\naccounts: ${accounts.length}, snapshots: ${snapshots.length}, months: ${months.length ? months[0] + ".." + months[months.length - 1] : "—"}`);
  console.log(`\n── findings (${problems.length}) ──`);
  if (!problems.length) console.log("no defects detected in the stored data");
  for (const p of problems) console.log(p);
};

// v2: the invariants that matter once contributions are per-month deltas.
const cmdCheckV2 = async ({ accU, snapF, snapU, rateU, metaMap }) => {
  const problems = [];
  const note = (sev, msg) => problems.push(`[${sev}] ${msg}`);
  const obj = (rows) => {
    const h = (rows[0] || []).map((c) => String(c ?? "").trim());
    return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  };
  const accounts = obj(accU).filter((a) => String(a.id ?? "").trim());
  const snaps = obj(snapU).filter((s) => String(s.id ?? "").trim());
  const rates = obj(rateU).filter((r) => String(r.month ?? "").trim());
  const alive = (r) => !String(r.deletedAt ?? "").trim();
  const accById = new Map(accounts.map((a) => [String(a.id), a]));

  for (const s of snaps.filter(alive)) {
    if (!accById.has(String(s.accountId))) note("HIGH", `snapshot ${s.id} -> unknown account ${s.accountId}`);
    if (!/^\d{4}-\d{2}$/.test(String(s.month))) note("HIGH", `snapshot ${s.id} bad month "${s.month}"`);
    if (!Number.isFinite(Number(s.balance))) note("HIGH", `snapshot ${s.id} bad balance "${s.balance}"`);
    if (!String(s.currency ?? "").trim()) note("HIGH", `snapshot ${s.id} has no currency`);
    if (!String(s.updatedAt ?? "").trim()) note("MED", `snapshot ${s.id} has no updatedAt (merge cannot order it)`);
  }
  const keys = new Set();
  for (const s of snaps.filter(alive)) {
    const k = `${s.accountId}|${s.month}`;
    if (keys.has(k)) note("HIGH", `duplicate live snapshot ${k} — month totals double-count`);
    keys.add(k);
  }
  // Cost basis must never go negative: that means more was withdrawn than put in.
  for (const acc of accounts) {
    const own = snaps.filter((s) => alive(s) && String(s.accountId) === String(acc.id))
      .sort((a, b) => String(a.month).localeCompare(String(b.month)));
    let cum = 0, any = false;
    for (const s of own) {
      if (s.contributed === "" || s.contributed === undefined) continue;
      any = true;
      cum += Number(s.contributed) || 0;
      if (cum < 0) note("MED", `"${acc.name}" ${s.month}: cumulative cost basis went negative (${cum})`);
      const cc = String(s.contribCurrency ?? "");
      if (!cc) note("MED", `"${acc.name}" ${s.month}: contribution has no currency`);
      else if (cc === acc.currency && ["BTC","ETH","USDT","SOL","TON"].includes(cc))
        note("MED", `"${acc.name}" ${s.month}: contribution recorded in ${cc} (coins) — P&L cannot be computed`);
    }
    if (any) {
      const last = own[own.length - 1];
      console.log(`  "${acc.name}": ${last.month} balance ${last.balance} ${last.currency}, вложено ${cum}`);
    }
  }
  // Months valued with today's rate rather than their own.
  const months = [...new Set(snaps.filter(alive).map((s) => String(s.month)))].sort();
  const stamped = new Set(rates.map((r) => String(r.month)));
  const unstamped = months.filter((m) => !stamped.has(m));
  if (unstamped.length) note("INFO", `${unstamped.length} month(s) have no stored FX rate and float with today's rate: ${unstamped.join(", ")}`);

  console.log(`\naccounts: ${accounts.filter(alive).length} live / ${accounts.length} rows, snapshots: ${snaps.filter(alive).length} live / ${snaps.length} rows, rates: ${rates.length}`);
  console.log(`\n── findings (${problems.length}) ──`);
  if (!problems.length) console.log("no defects detected in the stored data");
  for (const p of problems) console.log(p);
};

const cmd = process.argv[2] || "dump";
const flag = (process.argv[3] || "--both").replace(/^--/, "");
if (cmd === "dump") await cmdDump(flag);
else if (cmd === "json") await cmdJson();
else if (cmd === "check") await cmdCheck();
else die(`Unknown command "${cmd}". Use: dump [--raw|--formatted|--both] | json | check`);
