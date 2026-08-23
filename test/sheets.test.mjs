// Exercises the Google Sheets layer against an in-memory fake of the v4 API.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFromSheets, writeToSheets, buildValues, BACKUP_TABS, SheetsError } from "../src/lib/sheets.js";
import { ensureV2, normalize, SCHEMA_VERSION } from "../src/lib/model.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

// A minimal spreadsheet: tabs of row arrays, plus the calls made against it.
const makeSheet = (tabs) => {
  const state = {
    tabs: Object.fromEntries(Object.entries(tabs).map(([t, rows], i) => [t, { id: i, rows: rows.map((r) => [...r]) }])),
    grid: Object.fromEntries(Object.keys(tabs).map((t, i) => [t, { rows: 1000, cols: 26 }])),
    calls: [],
  };
  const install = () => {
    globalThis.fetch = async (url, init = {}) => {
      state.calls.push(`${init.method || "GET"} ${String(url).split("?")[0].replace(API + "/", "")}`);
      const u = new URL(url);
      const body = init.body ? JSON.parse(init.body) : null;
      const ok = (j) => ({ ok: true, status: 200, json: async () => j });

      if (init.method === "POST" && u.pathname.endsWith(":batchUpdate") && !u.pathname.includes("/values")) {
        for (const r of body.requests) {
          if (r.addSheet) {
            const t = r.addSheet.properties.title;
            state.tabs[t] = { id: Object.keys(state.tabs).length, rows: [] };
            state.grid[t] = { rows: r.addSheet.properties.gridProperties.rowCount, cols: r.addSheet.properties.gridProperties.columnCount };
          }
          if (r.appendDimension) {
            const t = Object.keys(state.tabs).find((k) => state.tabs[k].id === r.appendDimension.sheetId);
            state.grid[t][r.appendDimension.dimension === "ROWS" ? "rows" : "cols"] += r.appendDimension.length;
          }
        }
        return ok({});
      }
      if (init.method === "POST" && u.pathname.endsWith("/values:batchUpdate")) {
        for (const d of body.data) {
          const tab = d.range.split("!")[0];
          if (!state.tabs[tab]) throw new Error("write to missing tab " + tab);
          d.values.forEach((row, i) => { state.tabs[tab].rows[i] = [...row]; });
        }
        return ok({});
      }
      if (u.pathname.endsWith("/values:batchGet")) {
        const ranges = u.searchParams.getAll("ranges");
        assert.equal(u.searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE",
          "reading with FORMATTED_VALUE is what corrupted ru_RU decimals");
        return ok({ valueRanges: ranges.map((r) => ({ values: state.tabs[r.split("!")[0]]?.rows || [] })) });
      }
      // metadata
      return ok({
        properties: { title: "Wealth Tracker", locale: "ru_RU" },
        sheets: Object.entries(state.tabs).map(([title, t]) => ({
          properties: { sheetId: t.id, title, gridProperties: state.grid[title] },
        })),
      });
    };
  };
  return { state, install };
};

const V1 = {
  Accounts: [
    ["id", "name", "type", "currency", "closed", "closedMonth"],
    ["a1", "Банк", "investment", "RUB", "", ""],
    ["a2", "Криптобиржа", "crypto", "BTC", "", ""],
  ],
  Snapshots: [
    ["id", "accountId", "month", "balance", "invested"],
    ["s1", "a1", "2026-03", "50000", "50000"],
    ["s2", "a1", "2026-04", "48000", "50000"],
    ["s3", "a2", "2026-03", "0.0125", "0.0125"],
  ],
};

test("a v1 sheet is read with its own header and reported as v1", async () => {
  const { install } = makeSheet(structuredClone(V1));
  install();
  const res = await readFromSheets("tok", "sid");
  assert.equal(res.version, 1);
  assert.equal(res.payload.snapshots.length, 3);
  assert.equal(res.payload.snapshots[0].invested, "50000");
  assert.equal(res.payload.accounts[1].currency, "BTC");
  assert.equal(res.rawRows.snapshots.length, 4);
});

test("a v2 sheet whose Meta tab was deleted is NOT re-read as v1", async () => {
  const data = ensureV2({
    accounts: [{ id: "a1", name: "I", type: "investment", currency: "RUB" }],
    snapshots: [{ id: "s1", accountId: "a1", month: "2026-03", balance: "100", invested: "90" }],
  }, "2026-01-01T00:00:00.000Z").data;
  const v = buildValues(data);
  const { install } = makeSheet({ Accounts: v.accounts, Snapshots: v.snapshots, Rates: v.rates });
  install();
  const res = await readFromSheets("tok", "sid");
  assert.equal(res.version, 2, "re-migrating a v2 sheet nulls every contribution");
  assert.equal(ensureV2(res.payload).migrated, false);
  assert.equal(ensureV2(res.payload).data.snapshots[0].contributed, 90);
});

test("a tab that was renamed or deleted is refused, not treated as empty", async () => {
  const { install } = makeSheet({
    Accounts: V1.Accounts, Meta: [["key", "value"], ["schemaVersion", 2], ["revision", 3]],
  });
  install();
  await assert.rejects(() => readFromSheets("tok", "sid"), /Snapshots/);
});

test("a tab with data but no header row is refused instead of mis-mapped", async () => {
  const { install } = makeSheet({
    Accounts: V1.Accounts,
    Snapshots: [["s1", "a1", "2026-03", "100"]],          // header row deleted
  });
  install();
  await assert.rejects(() => readFromSheets("tok", "sid"), /заголовк/);
});

test("a month Google parsed as a date comes back as a month, not a serial", async () => {
  const rows = structuredClone(V1);
  rows.Snapshots[1][2] = 46082;                            // 2026-03-01 as a Sheets serial
  const { install } = makeSheet(rows);
  install();
  const res = await readFromSheets("tok", "sid");
  assert.equal(res.payload.snapshots[0].month, "2026-03");
});

test("the whole dataset is written in ONE values request, with the v1 rows backed up", async () => {
  const { state, install } = makeSheet(structuredClone(V1));
  install();
  const res = await readFromSheets("tok", "sid");
  const { data } = ensureV2(res.payload, "2026-01-01T00:00:00.000Z");
  state.calls.length = 0;
  const out = await writeToSheets("tok", "sid", data, { base: 0, extent: res.extent, backup: res.rawRows });
  assert.equal(out.conflict, false);
  assert.equal(out.backedUp, true);
  assert.equal(state.calls.filter((c) => c === "POST sid/values:batchUpdate").length, 1,
    "v1 issued four requests and could leave the sheet empty between them");
  assert.equal(state.calls.filter((c) => c.startsWith("POST") && c.includes(":clear")).length, 0);
  // the untouched v1 rows are preserved inside the same spreadsheet
  assert.deepEqual(state.tabs[BACKUP_TABS.snapshots].rows, V1.Snapshots);
  assert.deepEqual(state.tabs[BACKUP_TABS.accounts].rows, V1.Accounts);
  // and numbers land as numbers, not as locale-formatted text
  const bal = state.tabs.Snapshots.rows[1][3];
  assert.equal(typeof bal, "number");
});

test("a second migration does not overwrite the backup that already exists", async () => {
  const { state, install } = makeSheet(structuredClone(V1));
  install();
  const res = await readFromSheets("tok", "sid");
  const { data } = ensureV2(res.payload, "2026-01-01T00:00:00.000Z");
  await writeToSheets("tok", "sid", data, { base: 0, extent: res.extent, backup: res.rawRows });
  const again = await writeToSheets("tok", "sid", data, { base: 1, extent: res.extent, backup: { accounts: [["x"]], snapshots: [["y"]] } });
  assert.equal(again.backedUp, false);
  assert.deepEqual(state.tabs[BACKUP_TABS.snapshots].rows, V1.Snapshots);
});

test("a write is refused when this client never read the sheet", async () => {
  const { install } = makeSheet(structuredClone(V1));
  install();
  const out = await writeToSheets("tok", "sid", normalize({ accounts: [], snapshots: [] }), {});
  assert.equal(out.conflict, true);
  assert.equal(out.reason, "no-base");
});

test("a write against a stale revision is refused instead of clobbering", async () => {
  const { install } = makeSheet({
    ...structuredClone(V1),
    Meta: [["key", "value"], ["schemaVersion", SCHEMA_VERSION], ["revision", 7], ["snapshotRows", 4]],
  });
  install();
  const out = await writeToSheets("tok", "sid", normalize({ accounts: [], snapshots: [] }), { base: 5 });
  assert.equal(out.conflict, true);
  assert.equal(out.remoteRevision, 7);
});

test("shrinking the dataset blanks the rows that are no longer used", async () => {
  const { state, install } = makeSheet(structuredClone(V1));
  install();
  const res = await readFromSheets("tok", "sid");
  const { data } = ensureV2(res.payload, "2026-01-01T00:00:00.000Z");
  await writeToSheets("tok", "sid", data, { base: 0, extent: res.extent });
  const fewer = normalize({ accounts: data.accounts, snapshots: data.snapshots.slice(0, 1) });
  await writeToSheets("tok", "sid", fewer, { base: 1, extent: { Snapshots: 4 } });
  const rows = state.tabs.Snapshots.rows;
  assert.equal(rows[1][0], data.snapshots[0].id);
  for (const r of rows.slice(2, 4)) assert.ok(r.every((c) => c === ""), "stale rows must be blanked, not left behind");
});

test("a throttled request is retried rather than surfaced as a sync failure", async () => {
  const { install } = makeSheet(structuredClone(V1));
  install();
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (u, i) => {
    if (n++ === 0) return { ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded" } }) };
    return real(u, i);
  };
  const res = await readFromSheets("tok", "sid");
  assert.equal(res.version, 1);
  assert.ok(n > 1);
});

test("a quota 403 does not sign the user out, a permission 403 does", () => {
  assert.equal(new SheetsError("Quota exceeded for quota metric", 403).needsAuth, false);
  assert.equal(new SheetsError("The caller does not have permission", 403).needsAuth, true);
  assert.equal(new SheetsError("Invalid Credentials", 401).needsAuth, true);
});

test("quarantined rows survive a full read-write-read cycle without multiplying", async () => {
  const rows = structuredClone(V1);
  rows.Snapshots.push(["s9", "a1", "2026-05", "около ста тысяч", ""]);
  const { state, install } = makeSheet(rows);
  install();
  let res = await readFromSheets("tok", "sid");
  let { data } = ensureV2(res.payload, "2026-01-01T00:00:00.000Z");
  assert.equal(data.quarantine.length, 1);
  for (let i = 0; i < 3; i++) {
    await writeToSheets("tok", "sid", data, { base: i, extent: res.extent });
    res = await readFromSheets("tok", "sid");
    data = ensureV2(res.payload).data;
    assert.equal(data.quarantine.length, 1, "the unreadable row must neither vanish nor be duplicated");
  }
  assert.ok(state.tabs.Snapshots.rows.some((r) => r[3] === "около ста тысяч"));
});
