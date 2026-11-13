// MCP server, so an AI agent that works for DAOs can use its own track
// record: find its claims, verify them, simulate a DAO and get the exact
// transactions for a fast-lane request. It never holds keys; the agent
// signs the returned steps with its own wallet (for example nearai/near-mcp).
//
//   npx tsx offchain/src/mcp.ts        (stdio)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findClaims, lanePlan, simulateDao, suggestTrust, verifyLive } from "./api.js";
import { defaultRules } from "./cli.js";

const claim = z.object({ dao_id: z.string(), proposal_id: z.number().int().nonnegative() });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "tenured", version: "0.1.0" });

server.registerTool(
  "find_claims",
  {
    title: "Find my claimable payouts",
    description:
      "Find the best past DAO payouts (up to 9) an account can present as its track record, from the mainnet snapshot. " +
      "Give trusted_daos explicitly, or trust_like to trust the DAOs that paid the same people as that DAO.",
    inputSchema: {
      account: z.string().describe("NEAR account, e.g. alice.near"),
      trusted_daos: z.array(z.string()).optional(),
      trust_like: z.string().optional().describe("a DAO, e.g. marketing.sputnik-dao.near"),
    },
  },
  async ({ account, trusted_daos, trust_like }) => {
    const trusted = trusted_daos?.length ? trusted_daos : trust_like ? await suggestTrust(trust_like) : [];
    if (!trusted.length) throw new Error("give trusted_daos or trust_like");
    return json({ trusted, ...(await findClaims(account, trusted, defaultRules(trusted))) });
  },
);

server.registerTool(
  "verify_record",
  {
    title: "Verify a track record live",
    description:
      "Read each claimed proposal from its DAO over RPC and apply the same rules as the on-chain verifier contract. " +
      "Also reports each paying DAO's Sputnik code version and warns about unpublished code.",
    inputSchema: {
      account: z.string(),
      claims: z.array(claim).min(1).max(9),
      trusted_daos: z.array(z.string()).min(1),
      network: z.enum(["mainnet", "testnet"]).default("mainnet"),
      min_near: z.string().default("1").describe("smallest NEAR payout that counts"),
      exclude_members: z.boolean().default(false).describe("don't count payouts to members of the paying DAO"),
    },
  },
  async ({ account, claims, trusted_daos, network, min_near, exclude_members }) =>
    json(
      await verifyLive(
        account,
        claims,
        defaultRules(trusted_daos, { "min-near": min_near, ...(exclude_members ? { "exclude-members": true as const } : {}) }),
        network,
      ),
    ),
);

server.registerTool(
  "simulate_dao",
  {
    title: "Simulate the fast lane on a DAO",
    description:
      "Replay a mainnet DAO's real payout history as if the fast lane had been installed. Returns aggregates only: " +
      "payouts that would have skipped a vote, council votes saved, payouts stopped by cap or budget, max moved per period.",
    inputSchema: {
      dao: z.string(),
      token: z.enum(["near", "usdc", "usdc.e", "usdt", "usdt.e", "dai"]).default("near"),
      cap: z.string().default("500"),
      budget: z.string().default("2000"),
      period_days: z.number().int().positive().default(30),
      trusted_daos: z.array(z.string()).optional(),
      exclude_members: z.boolean().default(false).describe("don't count payouts to members of the paying DAO"),
    },
  },
  async ({ dao, token, cap, budget, period_days, trusted_daos, exclude_members }) =>
    json(await simulateDao(dao, { token, cap, budget, period_days, trusted: trusted_daos, exclude_members })),
);

server.registerTool(
  "plan_lane_request",
  {
    title: "Plan a fast-lane payout request",
    description:
      "Build the two transactions an account signs to request a payout through a Tenured lane: " +
      "add_proposal on the lane's DAO (with the DAO's bond), then register on the lane with verified claims. " +
      "Nothing is signed; returns args, deposits, gas and near CLI commands.",
    inputSchema: {
      account: z.string(),
      lane: z.string().describe("lane contract, e.g. trackrecord-lane.testnet"),
      amount: z.string().describe("payout in the lane's pay token, smallest units"),
      network: z.enum(["mainnet", "testnet"]).default("testnet"),
      claims: z.array(claim).max(9).optional(),
    },
  },
  async ({ account, lane, amount, network, claims }) => json(await lanePlan(account, lane, amount, network, claims)),
);

await server.connect(new StdioServerTransport());
