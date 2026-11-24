// Operations → what was spent, on what, and what merely moved between own accounts.
//
// Banks name categories differently (Газпромбанк says «Супермаркеты», Т-Банк
// «Супермаркеты» too but «Связь» where Газпромбанк says «Связь и интернет»,
// Капиталбанк's statement has none at all), so every bank category is folded
// into one short list of groups here. An operation's flow decides whether it
// counts at all:
//   spend  — purchases, payments, fees, cash taken out and not marked, transfers
//            to other people; a refund or reversal counts as negative spending
//   income — salary, interest, money from other people
//   own    — a transfer between own accounts: never spending; the difference
//            between what left and what arrived is the cost of the move
//            (exchange rate and fees), shown separately.

import { convert } from "./calc.js";

export const SPEND_GROUPS = [
  { id: "food", label: "Продукты", icon: "🛒", categories: ["Супермаркеты", "Продукты", "Продуктовые магазины"] },
  { id: "cafe", label: "Кафе и рестораны", icon: "🍽️", categories: ["Кафе и рестораны", "Фастфуд", "Рестораны", "Кафе"] },
  { id: "housing", label: "Жильё", icon: "🏠", categories: ["Аренда", "ЖКХ", "Коммунальные платежи", "Риелтор", "Дом и ремонт"] },
  { id: "transport", label: "Транспорт и такси", icon: "🚕", categories: ["Транспорт и такси", "Транспорт", "Такси", "Местный транспорт", "Каршеринг"] },
  { id: "car", label: "Автомобиль", icon: "🚗", categories: ["АЗС", "Автоуслуги", "Автомобиль", "Автозапчасти", "Топливо", "Парковки", "Штрафы", "Мойка авто", "Продажа транспортных средств"] },
  { id: "telecom", label: "Связь и интернет", icon: "📶", categories: ["Связь и интернет", "Мобильная связь", "Связь", "Интернет"] },
  { id: "travel", label: "Путешествия", icon: "✈️", categories: ["Путешествия", "Наличные в поездке", "Отели", "Авиабилеты", "Ж/д билеты", "Турагентства"] },
  { id: "health", label: "Здоровье и красота", icon: "💊", categories: ["Медицинские услуги", "Аптеки", "Салоны красоты", "Медицина", "Красота", "Здоровье"] },
  { id: "shopping", label: "Покупки", icon: "🛍️", categories: ["Маркетплейсы", "Разные товары", "Спортивные товары", "Одежда и обувь", "Электроника и техника", "Техника и электроника", "Различные товары", "Фото", "Цветы", "Книги"] },
  { id: "fun", label: "Развлечения", icon: "🎟️", categories: ["Развлечения", "Кино", "Спорт", "Хобби"] },
  { id: "software", label: "ИИ и софт", icon: "🤖", categories: ["Софт"] },
  { id: "services", label: "Сервисы и подписки", icon: "🧩", categories: ["Яндекс", "Экосистема Яндекс", "Экосистема Сбера", "Сервис", "Частные услуги", "Подписка Газпром Бонус Премиум", "Цифровые товары"] },
  { id: "education", label: "Учёба и экзамены", icon: "🎓", categories: ["Образование"] },
  { id: "docs", label: "Документы и госуслуги", icon: "📄", categories: ["Документы", "Госуслуги"] },
  { id: "fees", label: "Комиссии банков", icon: "🏦", categories: ["Услуги банка"] },
  { id: "cashSpent", label: "Наличными, без подробностей", icon: "💵", categories: ["Наличные без подробностей"] },
  { id: "cash", label: "Снято наличными, не размечено", icon: "🏧", categories: [] },
  { id: "people", label: "Переводы людям", icon: "👤", categories: ["Переводы", "Финансовые операции"] },
  // Покупка по просьбе других и их возмещение (возврат с той же категорией) гасят друг друга; остаток —
  // разница курсов, если платил в одной валюте, а вернули в другой.
  { id: "forOthers", label: "За других (с возмещением)", icon: "🤝", categories: ["За других"] },
  { id: "other", label: "Без категории", icon: "•", categories: ["Прочие расходы"] },
];

// For operations the bank gave no category (Капиталбанк's statement never
// does): a few merchant names that say plainly what they are.
const MERCHANT_RULES = [
  [/anthropic|claude\.ai|openai|chatgpt|perplexity|trinka|cursor\.|github|midjourney|jetbrains/i, "software"],
  [/sportmaster|decathlon|aliexpress|ozon|wildberries|uzum market|flowwow|dufry|beautymania|sinsay|\bshop\b/i, "shopping"],
  [/supermarket|galmart|korzinka|makro|havas|magnum|carrefour|migros|\bbim\b|\ba101\b|пят[её]рочка|перекр[её]сток|магнит|universam|ovoshhi|frukty/i, "food"],
  [/hookah|coffee|cafe|кафе|restaurant|kfc|burger|subway|вкусно|pitstsa|pizza|nalunch|mc ?donalds|\bpub\b|\bbar\b|beer|restoran|ресторан/i, "cafe"],
  [/wingie|aviasales|booking\.com|agoda|airbnb|hotel|airways|aeroflot|pobeda|localrent|\btutu\b/i, "travel"],
  [/toefl|\bets\b|flywire|edu action|duolingo|coursera|udemy|sobes\.tech/i, "education"],
  [/yandex.?go|scooters|whoosh|uber|\bbolt\b|taxi|indrive|mytaxi/i, "transport"],
  [/petrol|\bopet\b|lukoil|\bshell\b|азс/i, "car"],
  [/ucell|beeline|uzmobile|mobiuz|yesim|airalo/i, "telecom"],
  [/yandex.?plus|justanswer|advocall/i, "services"],
  [/orenyeri|muzesi|museum/i, "fun"],
  [/\bepgu\b|gosuslugi|госуслуг/i, "docs"],
  [/apteka|аптека|pharm|beauty/i, "health"],
];

const GROUP_BY_ID = new Map(SPEND_GROUPS.map((g) => [g.id, g]));
const GROUP_BY_CATEGORY = new Map();
for (const g of SPEND_GROUPS) for (const c of g.categories) GROUP_BY_CATEGORY.set(c.toLowerCase(), g.id);

export const groupInfo = (id) => GROUP_BY_ID.get(id) || GROUP_BY_ID.get("other");

export const flowOf = (op) => {
  if (op.kind === "own_transfer") return "own";
  if (op.kind === "income" || op.kind === "transfer_in") return "income";
  return "spend";
};

// The group a spending operation belongs to. The bank's category decides when
// it is a known one; otherwise the kind does (a fee is a fee whatever the bank
// calls it, cash taken out is cash until someone says what it paid for).
export const groupOf = (op) => {
  if (op.kind === "fee") return "fees";
  if (op.kind === "cash") return "cash";
  const byCategory = GROUP_BY_CATEGORY.get(String(op.category || "").toLowerCase());
  // «Прочие расходы» is the bank giving up; the merchant's name may still tell.
  if (byCategory && byCategory !== "other") return byCategory;
  if (op.kind === "transfer_out" && !byCategory) return "people";
  const text = `${op.merchant} ${op.description}`;
  for (const [re, id] of MERCHANT_RULES) if (re.test(text)) return id;
  return "other";
};

export const dayOf = (op) => {
  const text = String(op.date || "");
  // A timestamp in UTC is shown on the day it was where the user is now; a
  // bare date, or a time with the bank's own offset, is the bank's day as written.
  if (text.length > 10 && /Z$/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  }
  return text.slice(0, 10);
};

export const monthOfOp = (op) => dayOf(op).slice(0, 7);

const time = (op) => {
  const t = Date.parse(op.date);
  return Number.isFinite(t) ? t : Date.parse(dayOf(op));
};

// Both sides of a transfer between own accounts: outgoing id → incoming
// operation. The incoming side must be on the account the outgoing one names,
// within three days; an exact amount match wins over a nearer date (a
// same-currency transfer arrives whole), otherwise the nearest in time.
// `valueOf(op)`, when given, prices an operation in one currency; a pair across
// currencies is then accepted only if what left and what arrived are within a
// quarter of each other, so a 30-dollar transfer never pairs with a 100-dollar one.
export const pairOwnTransfers = (ops, valueOf) => {
  const WINDOW = 3 * 86400000;
  const plausible = (out, inc) => {
    if (!valueOf || inc.currency === out.currency) return true;
    const ratio = -valueOf(out) / valueOf(inc);
    return !Number.isFinite(ratio) || (ratio >= 0.8 && ratio <= 1.25);
  };
  const incoming = ops.filter((op) => op.kind === "own_transfer" && op.amount > 0);
  const used = new Set();
  const pairs = new Map();
  const outgoing = ops.filter((op) => op.kind === "own_transfer" && op.amount < 0 && op.counterAccountId)
    .sort((a, b) => time(a) - time(b));
  for (const out of outgoing) {
    const candidates = incoming.filter((inc) => !used.has(inc.id) && inc.accountId === out.counterAccountId
      && (!inc.counterAccountId || inc.counterAccountId === out.accountId)
      && Math.abs(time(inc) - time(out)) <= WINDOW
      && plausible(out, inc));
    if (!candidates.length) continue;
    const exact = (inc) => (inc.currency === out.currency && Math.abs(inc.amount + out.amount) < 0.005 ? 0 : 1);
    candidates.sort((a, b) => exact(a) - exact(b) || Math.abs(time(a) - time(out)) - Math.abs(time(b) - time(out)));
    used.add(candidates[0].id);
    pairs.set(out.id, candidates[0]);
  }
  return pairs;
};

const blankMonth = (month) => ({
  month, spend: 0, income: 0, moved: 0, moveCost: 0, movesPaired: 0, movesUnpaired: 0,
  groups: new Map(), days: new Map(), accounts: new Set(), unconverted: 0, firstDay: "", lastDay: "",
});

const addToDay = (days, day, entry) => {
  if (!days.has(day)) days.set(day, { day, spend: 0, ops: [] });
  const d = days.get(day);
  d.spend += entry.value;
  d.ops.push(entry);
};

// Per month, in `toCurrency` at that month's rates: spending by group (with
// the operations behind each group), income, money moved between own accounts
// and what those moves cost. `ratesOf(month).table` is the rate table.
export const spendingByMonth = (ops, toCurrency, ratesOf) => {
  const months = new Map();
  const at = (m) => {
    if (!months.has(m)) months.set(m, blankMonth(m));
    return months.get(m);
  };
  const pairs = pairOwnTransfers(ops, (op) => convert(op.amount, op.currency, toCurrency, ratesOf(monthOfOp(op)).table));
  const pairedIn = new Set([...pairs.values()].map((op) => op.id));
  for (const op of ops) {
    const month = monthOfOp(op);
    if (!/^\d{4}-\d\d$/.test(month)) continue;
    const m = at(month);
    m.accounts.add(op.accountId);
    const day = dayOf(op);
    if (!m.firstDay || day < m.firstDay) m.firstDay = day;
    if (day > m.lastDay) m.lastDay = day;
    const table = ratesOf(month).table;
    const value = convert(op.amount, op.currency, toCurrency, table);
    if (!Number.isFinite(value)) { m.unconverted += 1; continue; }
    const flow = flowOf(op);
    if (flow === "income") { m.income += value; continue; }
    if (flow === "own") {
      if (op.amount < 0) {
        m.moved += -value;
        const inc = pairs.get(op.id);
        if (inc) {
          const arrived = convert(inc.amount, inc.currency, toCurrency, table);
          if (Number.isFinite(arrived)) m.moveCost += -value - arrived;
          m.movesPaired += 1;
        } else {
          m.movesUnpaired += 1;
        }
      } else if (!pairedIn.has(op.id) && !op.counterAccountId) {
        m.movesUnpaired += 1;
      }
      continue;
    }
    const id = groupOf(op);
    if (!m.groups.has(id)) m.groups.set(id, { id, total: 0, ops: [] });
    const g = m.groups.get(id);
    g.total += -value;
    g.ops.push({ op, value: -value });
    addToDay(m.days, day, { op, value: -value, group: id });
    m.spend += -value;
  }
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  for (const m of list) {
    m.groupList = [...m.groups.values()]
      .map((g) => ({ ...g, ...groupInfo(g.id), ops: g.ops.sort((a, b) => b.value - a.value) }))
      .sort((a, b) => b.total - a.total);
  }
  return list;
};

// Several months folded into one, for "all time in the record".
export const mergeMonths = (list) => {
  const out = blankMonth("all");
  for (const m of list) {
    out.spend += m.spend; out.income += m.income; out.moved += m.moved; out.moveCost += m.moveCost;
    out.movesPaired += m.movesPaired; out.movesUnpaired += m.movesUnpaired; out.unconverted += m.unconverted;
    if (!out.firstDay || m.firstDay < out.firstDay) out.firstDay = m.firstDay;
    if (m.lastDay > out.lastDay) out.lastDay = m.lastDay;
    for (const a of m.accounts) out.accounts.add(a);
    for (const d of m.days.values()) for (const entry of d.ops) addToDay(out.days, d.day, entry);
    for (const g of m.groupList) {
      if (!out.groups.has(g.id)) out.groups.set(g.id, { id: g.id, total: 0, ops: [] });
      const target = out.groups.get(g.id);
      target.total += g.total;
      target.ops.push(...g.ops);
    }
  }
  out.groupList = [...out.groups.values()]
    .map((g) => ({ ...g, ...groupInfo(g.id), ops: g.ops.sort((a, b) => b.value - a.value) }))
    .sort((a, b) => b.total - a.total);
  return out;
};

// Every calendar day from `from` to `to` (YYYY-MM-DD, both included), with
// what was spent on it; a day without spending is there with zero, so the
// chart shows the quiet days too.
export const dailySeries = (days, from, to) => {
  const out = [];
  const [y, m, d] = from.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  for (let guard = 0; guard < 1000; guard += 1) {
    const day = cursor.toISOString().slice(0, 10);
    if (day > to) break;
    const found = days.get(day);
    out.push({ day, spend: found ? found.spend : 0, ops: found ? [...found.ops].sort((a, b) => b.value - a.value) : [] });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
};

// One purchase of a car on a single day would flatten every other bar into
// the axis. The axis is cut at 2.5 times the 90th percentile of the spending
// days instead, and the days above it are drawn to the cut with their sum
// written on top. Null when no day is that far above the rest.
export const dailyCap = (values) => {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length < 5) return null;
  const p90 = positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.9))];
  const cap = p90 * 2.5;
  return positive[positive.length - 1] > cap ? cap : null;
};

// Who got the money inside a group: merchant (or description) totals.
export const topPayees = (groupOps, limit = 8) => {
  const by = new Map();
  for (const { op, value } of groupOps) {
    const key = op.merchant || op.description || op.category || "—";
    const row = by.get(key) || { key, total: 0, count: 0 };
    row.total += value;
    row.count += 1;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.total - a.total).slice(0, limit);
};

// A readable line for an operation. Капиталбанк's statement has no merchant
// names, only the processing record ("IPS: 92300383 Эмитент взаиморасчёты по
// безналичным операциям … 8200.1.spisanie"); the terminal number is the only
// thing in it that tells two shops apart.
export const opTitle = (op) => {
  if (op.merchant) return op.merchant;
  const text = String(op.description || "").trim();
  const ips = text.match(/^IPS:\s*(\S+)\s+(Эмитент|Эквайер)[^,]*?по (наличным|безналичным)/);
  if (ips) {
    const what = /popolnenie/.test(text) ? "Пополнение" : ips[3] === "наличным" ? "Наличные" : "Оплата картой";
    return what === "Оплата картой" ? `Терминал ${ips[1]}` : `${what} · терминал ${ips[1]}`;
  }
  if (/^IPS: QR/.test(text)) return "Оплата по QR";
  const cut = text.replace(/^UzCard:\s*/, "").split(/ через |; |, Номер карты| Номер карты| RRN/)[0].trim();
  return (cut || op.category || "—").slice(0, 90);
};
