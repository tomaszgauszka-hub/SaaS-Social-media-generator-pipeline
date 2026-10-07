/**
 * Money helpers.
 *
 * Storage:  PostgreSQL `Decimal(18,6)` in USD (exact).
 * Math:     integer micro-dollars (1 USD = 1_000_000 micros) as JS numbers.
 *           Safe up to Number.MAX_SAFE_INTEGER micros ≈ $9 billion — far beyond any single workspace.
 *
 * Never do arithmetic on floating point dollars.
 */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;

/** Anything Prisma may hand us for a Decimal column (Prisma.Decimal, string, number). */
export type DecimalLike = { toString(): string } | string | number;

export function usdToMicros(usd: number): Micros {
  if (!Number.isFinite(usd)) throw new RangeError(`usdToMicros: non-finite value ${usd}`);
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: Micros): number {
  return micros / MICROS_PER_USD;
}

/**
 * Exact conversion from a decimal representation to micros (string parsing, no float multiplication).
 * Extra precision beyond 6 decimals is rounded half away from zero.
 */
export function decimalToMicros(value: DecimalLike | null | undefined): Micros {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return usdToMicros(value);
  const raw = value.toString().trim();
  if (raw === "") return 0;
  // Handle exponent notation (e.g. "1e-7") via number path; Decimal.toString() may emit it for tiny values.
  if (/e/i.test(raw)) return usdToMicros(Number(raw));
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) throw new RangeError(`decimalToMicros: cannot parse "${raw}"`);
  const sign = match[1] === "-" ? -1 : 1;
  const intPart = match[2] === undefined || match[2] === "" ? "0" : match[2];
  const fracRaw = match[3] ?? "";
  const frac6 = (fracRaw + "000000").slice(0, 6);
  let micros = Number(intPart) * MICROS_PER_USD + Number(frac6);
  const nextDigit = fracRaw.length > 6 ? Number(fracRaw[6]) : 0;
  if (nextDigit >= 5) micros += 1;
  return sign * micros;
}

/** Decimal string with 6 fractional digits — suitable for Prisma Decimal inputs. */
export function microsToDecimalString(micros: Micros): string {
  if (!Number.isInteger(micros)) micros = Math.round(micros);
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const intPart = Math.floor(abs / MICROS_PER_USD);
  const frac = String(abs % MICROS_PER_USD).padStart(6, "0");
  return `${sign}${intPart}.${frac}`;
}

export function sumMicros(values: Iterable<Micros>): Micros {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Multiply an amount by a (non-money) factor, rounding to whole micros. */
export function mulMicros(micros: Micros, factor: number): Micros {
  return Math.round(micros * factor);
}

/**
 * Human formatting with adaptive precision: sub-cent amounts keep 4 decimals so a $0.0003 LLM call is
 * not displayed as $0.00.
 */
export function formatUsd(micros: Micros, opts: { precision?: number; signed?: boolean } = {}): string {
  const usd = microsToUsd(micros);
  const abs = Math.abs(usd);
  const precision = opts.precision ?? (abs !== 0 && abs < 0.01 ? 4 : 2);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  const sign = usd < 0 ? "-" : opts.signed && usd > 0 ? "+" : "";
  return `${sign}$${formatted}`;
}

/** Ratio helper that returns null instead of Infinity/NaN when the denominator is zero. */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}
