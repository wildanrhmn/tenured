import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generate, RANDOM_FIXTURES } from "../src/fuzz.js";

// The Rust rules crate checks the same file (agrees_with_typescript_on_random_inputs).
// Regenerating it here means a change to the TypeScript rules that isn't
// mirrored in Rust, or vice versa, fails one side or the other.
describe("random rule fixtures", () => {
  it("are exactly what the current TypeScript rules produce", () => {
    const committed = readFileSync(RANDOM_FIXTURES, "utf8");
    expect(JSON.stringify(generate()) + "\n").toBe(committed);
  });
});
