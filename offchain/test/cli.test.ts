import { describe, expect, it } from "vitest";
import { human, units } from "../src/cli.js";

describe("token amounts", () => {
  it("converts human amounts to smallest units and back", () => {
    expect(units("1", 24)).toBe("1000000000000000000000000");
    expect(units("12.5", 6)).toBe("12500000");
    expect(units("0.000001", 6)).toBe("1");
    expect(human("12500000", 6)).toBe("12.5");
    expect(human("1000000000000000000000000", 24)).toBe("1");
  });

  it("rejects things that aren't amounts", () => {
    expect(() => units("1.0000001", 6)).toThrow();
    expect(() => units("-1", 6)).toThrow();
    expect(() => units("1e6", 6)).toThrow();
  });
});
