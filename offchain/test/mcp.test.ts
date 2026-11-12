import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Talks to the real server over stdio, the way an agent would.
describe("MCP server", () => {
  const client = new Client({ name: "test", version: "0" });

  beforeAll(async () => {
    const pkg = path.resolve(import.meta.dirname, "..");
    const tsx = path.resolve(pkg, "../node_modules/.bin/tsx"); // hoisted by npm workspaces
    await client.connect(new StdioClientTransport({ command: tsx, args: [path.join(pkg, "src/mcp.ts")], cwd: pkg }));
  }, 30_000);
  afterAll(() => client.close());

  it("lists its tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["find_claims", "plan_lane_request", "simulate_dao", "verify_record"]);
  });

  it("simulates a mainnet DAO from the snapshot", async () => {
    const res = await client.callTool({
      name: "simulate_dao",
      arguments: { dao: "nearweek-news-contribution.sputnik-dao.near", token: "near" },
    });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.result.payouts_considered).toBeGreaterThan(1000);
    expect(body.result.fast_laned).toBeGreaterThan(0);
    // aggregates only: apart from the DAO itself, no account names in the result
    const { dao, ...rest } = body.result;
    expect(dao).toBe("nearweek-news-contribution.sputnik-dao.near");
    expect(JSON.stringify(rest)).not.toMatch(/\.near/);
  }, 60_000);
});
