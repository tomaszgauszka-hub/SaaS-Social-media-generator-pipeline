import { describe, expect, it } from "vitest";
import {
  mapStatus,
  mapType,
  mapWebhookPayload,
  parseCsv,
  parseMoney,
  redactPersonalData,
} from "./conversions.ts";

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

describe("personal data minimisation", () => {
  it("redacts buyer data from stored postback / CSV payloads but keeps attribution fields", () => {
    expect(
      redactPersonalData({
        transaction_id: "T-1",
        sub_id: "abc123",
        commission: "4.20",
        product_name: "Cordless drill",
        email: "jane@example.com",
        customer_id: "C-998",
        first_name: "Jane",
        username: "jane99",
        note: "contact jane@example.com",
        ip: "203.0.113.7",
        client: { ip_address: "203.0.113.7", device: "mobile" },
        items: [{ sku: "X" }],
        hotel: "not personal",
      }),
    ).toEqual({
      transaction_id: "T-1",
      sub_id: "abc123",
      commission: "4.20",
      product_name: "Cordless drill",
      email: "[redacted]",
      customer_id: "[redacted]",
      first_name: "[redacted]",
      username: "[redacted]",
      note: "[redacted]",
      ip: "[redacted]",
      client: { ip_address: "[redacted]", device: "mobile" },
      items: "[list omitted]",
      hotel: "not personal",
    });
  });
});
