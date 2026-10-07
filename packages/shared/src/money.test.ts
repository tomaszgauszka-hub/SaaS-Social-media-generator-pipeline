import { describe, expect, it } from "vitest";
import {
  decimalToMicros,
  formatUsd,
  microsToDecimalString,
  microsToUsd,
  mulMicros,
  safeRatio,
  sumMicros,
  usdToMicros,
} from "./money.ts";

describe("money", () => {
  it("converts USD to micros without float drift", () => {
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000);
    expect(usdToMicros(0.000123)).toBe(123);
    expect(microsToUsd(1_500_000)).toBe(1.5);
  });

  it("parses decimal strings exactly", () => {
    expect(decimalToMicros("0.000123")).toBe(123);
    expect(decimalToMicros("12.5")).toBe(12_500_000);
    expect(decimalToMicros("-3.000001")).toBe(-3_000_001);
    expect(decimalToMicros(".5")).toBe(500_000);
    expect(decimalToMicros("7")).toBe(7_000_000);
    expect(decimalToMicros(null)).toBe(0);
    expect(decimalToMicros(undefined)).toBe(0);
    expect(decimalToMicros({ toString: () => "1.25" })).toBe(1_250_000);
  });

  it("rounds precision beyond 6 decimals half away from zero", () => {
    expect(decimalToMicros("0.0000005")).toBe(1);
    expect(decimalToMicros("0.0000004")).toBe(0);
    expect(decimalToMicros("1e-7")).toBe(0);
  });

  it("rejects garbage", () => {
    expect(() => decimalToMicros("abc")).toThrow(RangeError);
  });

  it("formats decimal strings for Prisma", () => {
    expect(microsToDecimalString(123)).toBe("0.000123");
    expect(microsToDecimalString(-2_500_000)).toBe("-2.500000");
    expect(microsToDecimalString(0)).toBe("0.000000");
  });

  it("round-trips", () => {
    for (const m of [0, 1, 999_999, 1_000_000, 123_456_789, -42]) {
      expect(decimalToMicros(microsToDecimalString(m))).toBe(m);
    }
  });

  it("sums and multiplies in micros", () => {
    expect(sumMicros([100, 200, 300])).toBe(600);
    expect(mulMicros(1_000_000, 0.035)).toBe(35_000);
  });

  it("formats with adaptive precision", () => {
    expect(formatUsd(300)).toBe("$0.0003");
    expect(formatUsd(1_234_560)).toBe("$1.23");
    expect(formatUsd(-500_000)).toBe("-$0.50");
    expect(formatUsd(500_000, { signed: true })).toBe("+$0.50");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("safeRatio avoids division by zero", () => {
    expect(safeRatio(1, 0)).toBeNull();
    expect(safeRatio(1, 4)).toBe(0.25);
  });
});
