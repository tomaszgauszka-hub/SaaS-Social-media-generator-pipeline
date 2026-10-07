import { decimalToMicros, microsToDecimalString, type Micros } from "@cre/shared";
import { Prisma } from "./generated/prisma/client.ts";

/** Prisma.Decimal from micro-USD. */
export function microsToDecimal(micros: Micros): Prisma.Decimal {
  return new Prisma.Decimal(microsToDecimalString(micros));
}

/** micro-USD from a Prisma Decimal (or null → 0). */
export function decimalFieldToMicros(value: Prisma.Decimal | null | undefined): Micros {
  return value === null || value === undefined ? 0 : decimalToMicros(value);
}

/** Number from a Prisma Decimal (non-money values such as commission rates). */
export function decimalToNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value.toString());
}
