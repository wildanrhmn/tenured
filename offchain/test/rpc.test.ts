import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/rpc.js";

describe("toBase64", () => {
  it("matches Buffer for view-call args", () => {
    for (const s of ['{"id":42}', "{}", '{"account_id":"émile.near","note":"✓"}']) {
      const bytes = new TextEncoder().encode(s);
      expect(toBase64(bytes)).toBe(Buffer.from(s).toString("base64"));
    }
  });
});
