import { describe, expect, it } from "vitest";
import { mapStatus, mapType, mapWebhookPayload, parseCsv, parseMoney } from "./conversions.ts";

describe("CSV parsing", () => {
  it("handles quotes, escaped quotes, commas and newlines in fields", () => {
    const rows = parseCsv(
      'date,product,commission\r\n2026-10-01,"Drill, 20V ""Pro""","3,56"\n2026-10-02,"multi\nline",1.2\n\n',
    );
    expect(rows).toEqual([
      ["date", "product", "commission"],
      ["2026-10-01", 'Drill, 20V "Pro"', "3,56"],
      ["2026-10-02", "multi\nline", "1.2"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseCsv("\uFEFFa,b\n1,2")[0]).toEqual(["a", "b"]);
  });
});

describe("value mapping", () => {
  it("parses money in US and EU formats", () => {
    expect(parseMoney("$1,234.50")).toBe(1_234_500_000);
    expect(parseMoney("1.234,50")).toBe(1_234_500_000);
    expect(parseMoney("3,56")).toBe(3_560_000);
    expect(parseMoney("12")).toBe(12_000_000);
    expect(parseMoney("")).toBeNull();
  });

  it("normalises network statuses and types", () => {
    expect(mapStatus("Approved")).toBe("APPROVED");
    expect(mapStatus("declined")).toBe("REVERSED");
    expect(mapStatus("open")).toBe("PENDING");
    expect(mapType("Lead")).toBe("LEAD");
    expect(mapType("purchase")).toBe("SALE");
    expect(mapType("free trial")).toBe("SIGNUP");
  });

  it("maps webhook payloads with a custom field map", () => {
    const m = mapWebhookPayload(
      { data: { txn: "T-1", sub1: "CLICK123", payout: "4.20", state: "paid" }, ts: "2026-10-05T10:00:00Z" },
      {
        externalId: "data.txn",
        clickId: "data.sub1",
        commission: "data.payout",
        status: "data.state",
        occurredAt: "ts",
      },
    );
    expect(m).toMatchObject({
      externalId: "T-1",
      clickId: "CLICK123",
      commission: 4_200_000,
      status: "APPROVED",
      currency: "USD",
    });
    expect(m.occurredAt.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });
});
