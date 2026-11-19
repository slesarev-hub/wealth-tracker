// Operations: the history of money movements per account, stored in its own
// tab next to the balance snapshots.
//
// The tab lives outside the main dataset on purpose. writeToSheets rewrites
// Accounts/Snapshots/Rates wholesale on every save and the app mirrors that
// dataset into localStorage; thousands of operations would bloat both. Here
// rows are only appended (an import) or updated in place by id (an edit), and
// the app reads them when it needs them.
//
// Statements arrive for arbitrary, overlapping periods, so every row carries a
// deterministic id derived from what the bank says about the operation:
//   * a bank reference (RRN, slip number, operation id) when there is one —
//     the same operation in two statements then gets the same id;
//   * otherwise a fingerprint of account, day, amount and description plus an
//     occurrence number, so two identical coffees on one day stay two rows and
//     a second statement covering the same day adds nothing.
import { req, batchGet, getMeta, SheetsError } from "./sheets.js";
import { parseNum, roundAmount } from "./model.js";

export const OPERATIONS_TAB = "Operations";
export const OPERATION_HEADER = [
  "id", "accountId", "date", "postedDate", "amount", "currency", "origAmount", "origCurrency",
  "kind", "category", "merchant", "description", "note", "counterAccountId",
  "source", "ref", "importedAt", "updatedAt", "deletedAt",
];

// What an operation means for spending statistics. `own_transfer` moves money
// between the user's own accounts (a card top-up, a conversion, cash taken out
// into a stash) and is never counted as spending or income; `counterAccountId`
// names the other side when it is a tracked account.
export const OPERATION_KINDS = [
  { id: "purchase", label: "Покупка" },
  { id: "payment", label: "Платёж" },
  { id: "cash", label: "Снятие наличных" },
  { id: "fee", label: "Комиссия" },
  { id: "transfer_out", label: "Перевод людям" },
  { id: "transfer_in", label: "Поступление" },
  { id: "income", label: "Доход" },
  { id: "refund", label: "Возврат" },
  { id: "own_transfer", label: "Между своими счетами" },
  { id: "other", label: "Прочее" },
];
const KIND_IDS = new Set(OPERATION_KINDS.map((k) => k.id));

// 64-bit FNV-1a as two 32-bit halves with different offsets. Plain JS, so the
// browser and node compute the same id for the same operation.
const fnv32 = (text, seed) => {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
export const hashKey = (text) => fnv32(text, 0x811c9dc5) + fnv32(text, 0x050c5d1f);

const cents = (amount) => Math.round(amount * 100);
const day = (date) => String(date || "").slice(0, 10);
export const normalizeDescription = (text) =>
  String(text || "").toLowerCase().replace(/\d{6}\*+\d{4}/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const referenceKey = (op) => `ref|${op.accountId}|${op.ref}|${cents(op.amount)}`;
export const fingerprintKey = (op) =>
  `fp|${op.accountId}|${day(op.date)}|${cents(op.amount)}|${normalizeDescription(op.description)}`;

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());
const optionalNumber = (v) => {
  const n = parseNum(v);
  return Number.isFinite(n) ? roundAmount(n) : null;
};

// Brings a row read from the sheet (or built by an importer) to one shape.
// Returns null for a row that cannot be an operation at all.
export const normalizeOperation = (row) => {
  const amount = parseNum(row?.amount);
  const id = text(row?.id);
  const accountId = text(row?.accountId);
  if (!id || !accountId || !Number.isFinite(amount)) return null;
  const kind = text(row.kind);
  return {
    id,
    accountId,
    date: text(row.date),
    postedDate: text(row.postedDate),
    amount: roundAmount(amount),
    currency: text(row.currency).toUpperCase(),
    origAmount: optionalNumber(row.origAmount),
    origCurrency: text(row.origCurrency).toUpperCase(),
    kind: KIND_IDS.has(kind) ? kind : "other",
    category: text(row.category),
    merchant: text(row.merchant),
    description: text(row.description),
    note: text(row.note),
    counterAccountId: text(row.counterAccountId),
    source: text(row.source),
    ref: text(row.ref),
    importedAt: text(row.importedAt),
    updatedAt: text(row.updatedAt),
    deletedAt: text(row.deletedAt),
  };
};

// Decides which incoming operations are new. Existing ids include deleted
// rows: an operation the user removed must not come back with the next import.
// Incoming operations without an id get one here; the result keeps the
// incoming order.
export const planImport = (existing, incoming) => {
  const known = new Set(existing.map((op) => op.id));
  const occurrences = new Map();
  const added = [];
  let duplicates = 0;
  for (const op of incoming) {
    let key;
    if (op.ref) {
      key = referenceKey(op);
    } else {
      const base = fingerprintKey(op);
      const seen = occurrences.get(base) || 0;
      occurrences.set(base, seen + 1);
      key = `${base}|${seen}`;
    }
    const id = hashKey(key);
    if (known.has(id)) {
      duplicates += 1;
      continue;
    }
    known.add(id);
    added.push({ ...op, id });
  }
  return { added, duplicates };
};

export const operationToRow = (op) => OPERATION_HEADER.map((name) => {
  const value = op[name];
  return value === undefined || value === null ? "" : value;
});

// ── sheet access ────────────────────────────────────────────────────────────

const API = "https://sheets.googleapis.com/v4/spreadsheets";

// Returns the operations with the sheet row each one sits on (1-based, header
// is row 1), so an edit can be written back to exactly that row.
export const readOperations = async (token, sid) => {
  const meta = await getMeta(token, sid);
  if (!meta.tabs[OPERATIONS_TAB]) return { exists: false, operations: [], rejected: [] };
  const range = `${OPERATIONS_TAB}!A1:Z`;
  const rows = (await batchGet(token, sid, [range]))[range] || [];
  if (!rows.length) return { exists: true, operations: [], rejected: [] };
  const header = (rows[0] || []).map((c) => text(c));
  if (!["id", "accountId", "amount"].every((k) => header.includes(k))) {
    throw new SheetsError(`Лист «${OPERATIONS_TAB}»: не найдена строка заголовков (id, accountId, amount).`, 0);
  }
  const operations = [];
  const rejected = [];
  rows.slice(1).forEach((row, index) => {
    const raw = {};
    header.forEach((name, column) => { if (name) raw[name] = row[column]; });
    if (Object.values(raw).every((v) => text(v) === "")) return;
    const op = normalizeOperation(raw);
    if (op) operations.push({ ...op, sheetRow: index + 2 });
    else rejected.push({ sheetRow: index + 2, raw });
  });
  return { exists: true, header, operations, rejected };
};

// Rows are written by position, so a tab whose columns were rearranged by hand
// is refused instead of being filled column-shifted.
const checkHeader = (header) => {
  const same = OPERATION_HEADER.every((name, i) => header[i] === name);
  if (!same) throw new SheetsError(`Лист «${OPERATIONS_TAB}»: столбцы не совпадают с ожидаемыми (${OPERATION_HEADER.join(", ")}).`, 0);
};

const ensureTab = async (token, sid) => {
  const meta = await getMeta(token, sid);
  if (meta.tabs[OPERATIONS_TAB]) {
    const current = await readOperations(token, sid);
    if (current.header) checkHeader(current.header);
    return;
  }
  await req(token, `${API}/${sid}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: OPERATIONS_TAB, gridProperties: { rowCount: 1000, columnCount: OPERATION_HEADER.length } } } }],
    }),
  });
  await req(token, `${API}/${sid}/values/${encodeURIComponent(`${OPERATIONS_TAB}!A1`)}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: [OPERATION_HEADER] }),
  });
};

// Appends rows below the existing ones; nothing already in the tab is touched.
export const appendOperations = async (token, sid, operations) => {
  if (!operations.length) return { appended: 0 };
  await ensureTab(token, sid);
  const url = `${API}/${sid}/values/${encodeURIComponent(`${OPERATIONS_TAB}!A1`)}:append`
    + "?valueInputOption=RAW&insertDataOption=INSERT_ROWS";
  await req(token, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: operations.map(operationToRow) }),
  });
  return { appended: operations.length };
};

// Rewrites single rows in place. Each operation must carry the sheetRow it was
// read from; the id in that row is checked first so a sheet sorted by hand in
// the meantime cannot make an edit land on someone else's row.
export const updateOperations = async (token, sid, operations) => {
  if (!operations.length) return { updated: 0 };
  const current = await readOperations(token, sid);
  checkHeader(current.header || []);
  const byRow = new Map(current.operations.map((op) => [op.sheetRow, op.id]));
  for (const op of operations) {
    if (byRow.get(op.sheetRow) !== op.id) {
      throw new SheetsError(`Строка ${op.sheetRow} листа «${OPERATIONS_TAB}» изменилась — перечитайте операции.`, 0);
    }
  }
  const last = String.fromCharCode(64 + OPERATION_HEADER.length);
  await req(token, `${API}/${sid}/values:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: operations.map((op) => ({ range: `${OPERATIONS_TAB}!A${op.sheetRow}:${last}${op.sheetRow}`, values: [operationToRow(op)] })),
    }),
  });
  return { updated: operations.length };
};
