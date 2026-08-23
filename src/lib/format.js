import { isCrypto } from "./model.js";

export const CURRENCY_SYMBOLS = {
  RUB: "₽", USD: "$", EUR: "€", GBP: "£", AED: "د.إ",
  BTC: "₿", ETH: "Ξ", USDT: "₮", SOL: "◎", TON: "💎",
};

// v1 rounded before comparing, so 999 500 rendered as "1000K" and 999 999 999
// as "1000.0M". The thresholds here are the values that round up to the next
// unit, so the unit and the digits always agree.
export const fmtShort = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 999_500_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (a >= 999_500) return (n / 1_000_000).toFixed(1) + "M";
  if (a >= 999.5) return (n / 1_000).toFixed(0) + "K";
  if (a === 0) return "0";
  if (a < 1) return String(Number(n.toPrecision(3)));
  return n.toFixed(0);
};

// Crypto amounts are never abbreviated: "0.0125 BTC" is the whole point.
export const fmtBalance = (n, currency) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (isCrypto(currency)) return String(Number(n.toPrecision(9)));
  return fmtShort(n);
};

// The amount an account actually holds, shown next to its rouble value. These
// are small numbers where the K-abbreviation loses what matters: "2K €" hides
// whether it is 2 000 or 2 400. Grouped digits instead, and full precision for
// crypto.
export const fmtAmount = (n, currency) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (isCrypto(currency)) return String(Number(n.toPrecision(9)));
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return fmtShort(n);
  const digits = abs > 0 && abs < 100 && !Number.isInteger(n) ? 2 : 0;
  return n.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export const fmtSigned = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + fmtShort(n);
};

const MONTHS = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

export const monthLabel = (ym) => {
  if (!ym || typeof ym !== "string") return "";
  const [y, m] = ym.split("-");
  const i = parseInt(m, 10) - 1;
  if (!(i >= 0 && i < 12)) return ym;
  return `${MONTHS[i]} ${y}`;
};
