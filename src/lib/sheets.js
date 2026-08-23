// Google Sheets persistence.
//
// What changed from v1 and why:
//   * reads use valueRenderOption=UNFORMATTED_VALUE. The default is
//     FORMATTED_VALUE, which in a ru_RU spreadsheet renders 0.0125 as
//     "0,0125" and 250000 as "250 000"; parseFloat then yields 0 and 102.
//   * writes are ONE values:batchUpdate request. v1 issued four requests —
//     clear Accounts, clear Snapshots, write Accounts, write Snapshots — and
//     ignored the clear responses, so a failure after the clears left an empty
//     spreadsheet that the next sign-in then treated as the truth.
//   * stale rows are blanked by padding the written range to the extent
//     recorded in Meta, so nothing has to be cleared first.
//   * the grid is grown before writing. v1 would start failing permanently
//     once Snapshots passed the sheet's 1000 allocated rows — after the clears.
//   * Meta carries a schema version and a revision counter, so a second device
//     (or a stale tab) cannot blindly overwrite newer data.

import { SCHEMA_VERSION } from "./model.js";

export const ACCOUNT_HEADER = ["id", "name", "type", "currency", "openedMonth", "closedMonth", "updatedAt", "deletedAt"];
export const SNAPSHOT_HEADER = ["id", "accountId", "month", "balance", "currency", "contributed", "contribCurrency", "contribEstimated", "updatedAt", "deletedAt"];
export const RATE_HEADER = ["month", "currency", "perUSD", "fetchedAt"];
export const META_HEADER = ["key", "value"];
// The pre-migration data is copied here once, so the only copy of the v1
// spreadsheet is not the one the migration is about to overwrite.
export const BACKUP_TABS = { accounts: "Backup_Accounts_v1", snapshots: "Backup_Snapshots_v1" };

const API = "https://sheets.googleapis.com/v4/spreadsheets";

export class SheetsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    // A 403 is returned both for "you may not touch this sheet" and for "you
    // are over quota". Only the former means the user has to sign in again;
    // signing them out over a rate limit loses the session for no reason.
    const quotaish = /quota|rate limit|rateLimit|too many/i.test(message || "");
    this.needsAuth = status === 401 || (status === 403 && !quotaish);
    this.retryable = status === 429 || (status >= 500 && status < 600) || (status === 403 && quotaish);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries a throttled or transient failure instead of surfacing it as a sync
// error. Nothing here is retried after a successful response, so a write is
// never applied twice by this path.
const req = async (token, url, init, attempt = 0) => {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json())?.error?.message || ""; } catch {}
    const err = new SheetsError(detail || `HTTP ${r.status}`, r.status);
    if (err.retryable && attempt < 3) {
      await sleep(400 * 2 ** attempt);
      return req(token, url, init, attempt + 1);
    }
    throw err;
  }
  return r.status === 204 ? null : r.json();
};

// ── spreadsheet shape ────────────────────────────────────────────────────────

export const getMeta = async (token, sid) => {
  const j = await req(
    token,
    `${API}/${sid}?fields=properties(title,locale),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`
  );
  const tabs = {};
  for (const s of j.sheets || []) {
    tabs[s.properties.title] = {
      sheetId: s.properties.sheetId,
      rows: s.properties.gridProperties?.rowCount ?? 0,
      cols: s.properties.gridProperties?.columnCount ?? 0,
    };
  }
  return { title: j.properties?.title, locale: j.properties?.locale, tabs };
};

// Creates whatever tabs are missing and grows any that are too small, in one
// structural batchUpdate. Returns the refreshed tab map.
const ensureShape = async (token, sid, tabs, need) => {
  const requests = [];
  for (const [title, { rows, cols }] of Object.entries(need)) {
    const t = tabs[title];
    if (!t) {
      requests.push({
        addSheet: { properties: { title, gridProperties: { rowCount: Math.max(rows, 1000), columnCount: Math.max(cols, 8) } } },
      });
    } else {
      if (t.rows < rows) requests.push({ appendDimension: { sheetId: t.sheetId, dimension: "ROWS", length: rows - t.rows + 200 } });
      if (t.cols < cols) requests.push({ appendDimension: { sheetId: t.sheetId, dimension: "COLUMNS", length: cols - t.cols } });
    }
  }
  if (!requests.length) return tabs;
  await req(token, `${API}/${sid}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  return (await getMeta(token, sid)).tabs;
};

export const createSpreadsheet = async (token) => {
  const j = await req(token, API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "Wealth Tracker" },
      sheets: [
        { properties: { title: "Accounts" } },
        { properties: { title: "Snapshots" } },
        { properties: { title: "Rates" } },
        { properties: { title: "Meta" } },
      ],
    }),
  });
  return j.spreadsheetId;
};

// ── reading ──────────────────────────────────────────────────────────────────

const batchGet = async (token, sid, ranges) => {
  if (!ranges.length) return {};
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const j = await req(token, `${API}/${sid}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
  const out = {};
  (j.valueRanges || []).forEach((vr, i) => { out[ranges[i]] = vr.values || []; });
  return out;
};

// Google stores a cell it parsed as a date as a serial number counted from
// 1899-12-30. UNFORMATTED_VALUE hands that number back, so a month someone
// typed by hand arrives as e.g. 46266 instead of "2026-09".
const serialToMonth = (n) => {
  if (!Number.isFinite(n) || n < 1 || n > 100000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Mapping rows onto the wrong columns and then rewriting the sheet would
// destroy it, so a tab whose header cannot be recognised is refused outright
// rather than guessed at.
const rowsToObjects = (rows, header, tab, required) => {
  if (!rows || rows.length === 0) return [];
  const first = (rows[0] || []).map((c) => String(c ?? "").trim());
  const looksLikeHeader = required.every((k) => first.includes(k));
  if (!looksLikeHeader) {
    const hasData = rows.some((r) => (r || []).some((c) => String(c ?? "").trim()));
    if (!hasData) return [];
    throw new SheetsError(
      `Лист «${tab}»: не найдена строка заголовков (${required.join(", ")}). ` +
      `Восстановите её или переименуйте лист, иначе данные будут прочитаны неверно.`,
      0
    );
  }
  return rows.slice(1).map((row) => {
    const o = {};
    first.forEach((name, i) => { if (name) o[name] = row[i]; });
    if (typeof o.month === "number") o.month = serialToMonth(o.month) ?? o.month;
    return o;
  });
};

export const readFromSheets = async (token, sid) => {
  const meta = await getMeta(token, sid);
  // A tab that was renamed or deleted reads as "empty", which would look like a
  // fresh spreadsheet and fork the dataset on the next write.
  const known = meta.tabs.Meta || meta.tabs.Rates;
  for (const t of ["Accounts", "Snapshots"]) {
    if (!meta.tabs[t] && known) {
      throw new SheetsError(`В таблице нет листа «${t}» — он переименован или удалён. Восстановите название.`, 0);
    }
  }
  const wanted = [
    ["Accounts", "Accounts!A1:Z"],
    ["Snapshots", "Snapshots!A1:Z"],
    ["Rates", "Rates!A1:Z"],
    ["Meta", "Meta!A1:Z"],
  ].filter(([tab]) => meta.tabs[tab]);
  const got = await batchGet(token, sid, wanted.map(([, r]) => r));

  const accRows = got["Accounts!A1:Z"] || [];
  const snapRows = got["Snapshots!A1:Z"] || [];
  const rateRows = got["Rates!A1:Z"] || [];
  const metaRows = got["Meta!A1:Z"] || [];

  const metaMap = {};
  for (const row of metaRows) {
    const k = String(row?.[0] ?? "").trim();
    if (k && k !== "key") metaMap[k] = row[1];
  }

  // The row SHAPE decides the version. Trusting Meta alone means a sheet whose
  // Meta tab was deleted is re-migrated as v1, which nulls every contribution.
  const snapHeader = (snapRows[0] || []).map((c) => String(c ?? "").trim());
  const accHeader = (accRows[0] || []).map((c) => String(c ?? "").trim());
  const looksV2 = snapHeader.includes("contributed") || accHeader.includes("deletedAt");
  const looksV1 = snapHeader.includes("invested") || accHeader.includes("closed");
  const version = looksV2 ? 2
    : looksV1 ? 1
    : Number(metaMap.schemaVersion) || (snapRows.length || accRows.length ? 1 : 0);

  const payload = {
    schemaVersion: version,
    revision: Number(metaMap.revision) || 0,
    accounts: rowsToObjects(accRows, ACCOUNT_HEADER, "Accounts", ["id", "name", "type", "currency"]),
    snapshots: rowsToObjects(snapRows, SNAPSHOT_HEADER, "Snapshots", ["id", "accountId", "month", "balance"]),
    rates: rowsToObjects(rateRows, RATE_HEADER, "Rates", ["month", "currency", "perUSD"]),
  };
  // v1 encoded "closed" as the string "true"; normalise it for the migrator.
  if (version < 2) {
    for (const a of payload.accounts) a.closed = String(a.closed ?? "").toLowerCase() === "true";
  }
  return {
    payload,
    version,
    meta,
    rawRows: { accounts: accRows, snapshots: snapRows },
    extent: {
      Accounts: Math.max(accRows.length, 1),
      Snapshots: Math.max(snapRows.length, 1),
      Rates: Math.max(rateRows.length, 1),
    },
    isEmpty: accRows.filter((r) => String(r?.[0] ?? "").trim() && String(r?.[0]).trim() !== "id").length === 0
      && snapRows.filter((r) => String(r?.[0] ?? "").trim() && String(r?.[0]).trim() !== "id").length === 0,
  };
};

// ── writing ──────────────────────────────────────────────────────────────────

const blank = (width) => Array.from({ length: width }, () => "");

const pad = (rows, width, upTo) => {
  const out = rows.slice();
  while (out.length < upTo) out.push(blank(width));
  return out;
};

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(v) ? "" : v);

// Rows normalize could not interpret are written back exactly as they were
// read. They take no part in any calculation, but the spreadsheet is rewritten
// wholesale on every save, so dropping them here would delete the user's data.
const quarantineRows = (data, kind, header) =>
  (data.quarantine || [])
    .filter((q) => q.kind === kind && q.row && typeof q.row === "object")
    .map((q) => header.map((k) => {
      const v = q.row[k];
      return v === undefined || v === null ? "" : v;
    }));

export const buildValues = (data) => {
  const accounts = [ACCOUNT_HEADER, ...data.accounts.map((a) => [
    a.id, a.name, a.type, a.currency, a.openedMonth || "", a.closedMonth || "", a.updatedAt || "", a.deletedAt || "",
  ]), ...quarantineRows(data, "account", ACCOUNT_HEADER)];
  const snapshots = [SNAPSHOT_HEADER, ...data.snapshots.map((s) => [
    s.id, s.accountId, s.month, num(s.balance), s.currency,
    num(s.contributed), s.contribCurrency || "", s.contribEstimated ? "true" : "", s.updatedAt || "", s.deletedAt || "",
  ]), ...quarantineRows(data, "snapshot", SNAPSHOT_HEADER)];
  const rates = [RATE_HEADER, ...data.rates.map((r) => [r.month, r.currency, num(r.perUSD), r.fetchedAt || ""])];
  return { accounts, snapshots, rates };
};

// `base` is the revision this client last saw. If the sheet has moved on, the
// write is refused instead of clobbering the other writer.
export const writeToSheets = async (token, sid, data, { base, extent, writer, backup } = {}) => {
  const meta = await getMeta(token, sid);
  const existing = meta.tabs.Meta
    ? await batchGet(token, sid, ["Meta!A1:Z"])
    : {};
  const metaMap = {};
  for (const row of existing["Meta!A1:Z"] || []) {
    const k = String(row?.[0] ?? "").trim();
    if (k && k !== "key") metaMap[k] = row[1];
  }
  const remoteRevision = Number(metaMap.revision) || 0;
  // Writing without a base means writing over a spreadsheet this client has
  // never read. Refuse: the caller must read and merge first.
  if (!Number.isFinite(base)) return { conflict: true, remoteRevision, reason: "no-base" };
  if (remoteRevision !== base) return { conflict: true, remoteRevision };

  const { accounts, snapshots, rates } = buildValues(data);
  const prev = {
    Accounts: Math.max(Number(metaMap.accountRows) || 0, extent?.Accounts || 0),
    Snapshots: Math.max(Number(metaMap.snapshotRows) || 0, extent?.Snapshots || 0),
    Rates: Math.max(Number(metaMap.rateRows) || 0, extent?.Rates || 0),
  };

  // Only ever written once: if the backup tabs already exist, the pre-migration
  // data is already safe and must not be replaced by post-migration rows.
  const doBackup = !!backup
    && ((backup.accounts?.length || 0) + (backup.snapshots?.length || 0) > 0)
    && !meta.tabs[BACKUP_TABS.accounts] && !meta.tabs[BACKUP_TABS.snapshots];

  const need = {
    Accounts: { rows: Math.max(accounts.length, prev.Accounts) + 1, cols: ACCOUNT_HEADER.length },
    Snapshots: { rows: Math.max(snapshots.length, prev.Snapshots) + 1, cols: SNAPSHOT_HEADER.length },
    Rates: { rows: Math.max(rates.length, prev.Rates) + 1, cols: RATE_HEADER.length },
    Meta: { rows: 20, cols: META_HEADER.length },
  };
  if (doBackup) {
    const w = (rows) => Math.max(1, ...rows.map((r) => (r || []).length));
    need[BACKUP_TABS.accounts] = { rows: backup.accounts.length + 1, cols: w(backup.accounts) };
    need[BACKUP_TABS.snapshots] = { rows: backup.snapshots.length + 1, cols: w(backup.snapshots) };
  }
  await ensureShape(token, sid, meta.tabs, need);

  const revision = remoteRevision + 1;
  const metaRows = [
    META_HEADER,
    ["schemaVersion", SCHEMA_VERSION],
    ["revision", revision],
    ["updatedAt", new Date().toISOString()],
    ["writer", writer || "wealth-tracker"],
    ["accountRows", accounts.length],
    ["snapshotRows", snapshots.length],
    ["rateRows", rates.length],
  ];

  // One request. Either the whole dataset lands or none of it does; there is
  // no window in which the spreadsheet is empty.
  await req(token, `${API}/${sid}/values:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        { range: "Accounts!A1", values: pad(accounts, ACCOUNT_HEADER.length, prev.Accounts) },
        { range: "Snapshots!A1", values: pad(snapshots, SNAPSHOT_HEADER.length, prev.Snapshots) },
        { range: "Rates!A1", values: pad(rates, RATE_HEADER.length, prev.Rates) },
        { range: "Meta!A1", values: pad(metaRows, META_HEADER.length, 12) },
        ...(doBackup ? [
          { range: `${BACKUP_TABS.accounts}!A1`, values: backup.accounts },
          { range: `${BACKUP_TABS.snapshots}!A1`, values: backup.snapshots },
        ] : []),
      ],
    }),
  });

  return {
    conflict: false,
    backedUp: doBackup,
    revision,
    extent: { Accounts: accounts.length, Snapshots: snapshots.length, Rates: rates.length },
  };
};
