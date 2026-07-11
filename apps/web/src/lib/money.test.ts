import { describe, expect, it } from "vitest";

import { formatCents, parseDollarCents } from "@/lib/money";

describe("integer-cent money handling", () => {
  it("parses dollar strings without floating-point arithmetic", () => {
    expect(parseDollarCents("10")).toBe(1000);
    expect(parseDollarCents("10.5")).toBe(1050);
    expect(parseDollarCents("10.05")).toBe(1005);
  });

  it("rejects malformed, negative, over-precision, and unsafe amounts", () => {
    for (const value of ["", "-1", "1.001", "1.", ".5", "abc", "90071992547410.00"]) {
      expect(parseDollarCents(value)).toBeNull();
    }
  });

  it("formats positive, negative, and zero integer cents", () => {
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(-501)).toBe("-$5.01");
    expect(formatCents(0)).toBe("$0.00");
  });
});
