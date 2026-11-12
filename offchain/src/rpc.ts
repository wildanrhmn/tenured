// Read-only NEAR RPC client for view calls.
//
// Public endpoints rate-limit hard (fastnear answers 429 after a few dozen
// calls), so requests are spread round-robin over several endpoints, paced
// globally, and an endpoint that returns 429 is benched for a while.

export const MAINNET_RPCS = [
  "https://near.drpc.org",
  "https://rpc.mainnet.near.org",
  "https://free.rpc.fastnear.com",
];

export const TESTNET_RPCS = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
];

type Endpoint = { url: string; benchedUntil: number };

export class ViewError extends Error {
  constructor(
    message: string,
    readonly kind: "contract" | "transport",
  ) {
    super(message);
  }
}

export class RpcPool {
  private endpoints: Endpoint[];
  private next = 0;
  private lastSend = 0;

  constructor(
    urls: string[],
    private minIntervalMs = 250,
    private benchMs = 30_000,
  ) {
    this.endpoints = urls.map((url) => ({ url, benchedUntil: 0 }));
  }

  // Calls a view method and returns the decoded JSON result.
  // Throws ViewError("contract") when the contract itself panics or the
  // method doesn't exist: retrying won't help, so callers can skip it.
  async view<T = unknown>(accountId: string, method: string, args: object = {}): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "tr",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    });

    let lastErr = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const ep = await this.pick();
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        if (res.status === 429 || text.includes("-429") || text.includes("Rate limits exceeded")) {
          ep.benchedUntil = Date.now() + this.benchMs;
          lastErr = `429 from ${ep.url}`;
          continue;
        }
        const json = JSON.parse(text);
        const result = json?.result;
        if (result && Array.isArray(result.result)) {
          return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
        }
        // Contract-level failures come back either as result.error or as a
        // top-level error with a cause; neither is worth retrying.
        const msg: string = result?.error ?? json?.error?.data ?? json?.error?.message ?? text;
        if (/MethodNotFound|CodeDoesNotExist|wasm execution failed|panicked|AccountDoesNotExist/i.test(JSON.stringify(json))) {
          throw new ViewError(String(msg).slice(0, 300), "contract");
        }
        lastErr = String(msg).slice(0, 300);
      } catch (e) {
        if (e instanceof ViewError) throw e;
        lastErr = (e as Error).message;
        ep.benchedUntil = Date.now() + 5_000;
      }
      await sleep(500 * 2 ** Math.min(attempt, 5));
    }
    throw new ViewError(`gave up on ${accountId}.${method}: ${lastErr}`, "transport");
  }

  // Hash of the code an account runs. Accounts on a NEP-591 global contract
  // report an all-ones code_hash plus global_contract_hash (or the account
  // that publishes it), so that is what we return for them.
  // "11111111111111111111111111111111" means no contract at all.
  async codeHash(accountId: string): Promise<string> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "tr",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    });
    let lastErr = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const ep = await this.pick();
      try {
        const res = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        if (res.status === 429 || text.includes("-429") || text.includes("Rate limits exceeded")) {
          ep.benchedUntil = Date.now() + this.benchMs;
          lastErr = `429 from ${ep.url}`;
          continue;
        }
        const json = JSON.parse(text);
        const r = json?.result;
        if (r?.global_contract_hash) return r.global_contract_hash as string;
        if (r?.global_contract_account_id) return `global:${r.global_contract_account_id}`;
        if (r?.code_hash) return r.code_hash as string;
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(text)) throw new ViewError(`no account ${accountId}`, "contract");
        lastErr = text.slice(0, 300);
      } catch (e) {
        if (e instanceof ViewError) throw e;
        lastErr = (e as Error).message;
        ep.benchedUntil = Date.now() + 5_000;
      }
      await sleep(500 * 2 ** Math.min(attempt, 5));
    }
    throw new ViewError(`gave up on view_account ${accountId}: ${lastErr}`, "transport");
  }

  private async pick(): Promise<Endpoint> {
    for (;;) {
      const wait = this.lastSend + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      const now = Date.now();
      for (let i = 0; i < this.endpoints.length; i++) {
        const ep = this.endpoints[(this.next + i) % this.endpoints.length]!;
        if (ep.benchedUntil <= now) {
          this.next = (this.next + i + 1) % this.endpoints.length;
          this.lastSend = now;
          return ep;
        }
      }
      const soonest = Math.min(...this.endpoints.map((e) => e.benchedUntil));
      await sleep(Math.max(250, soonest - now));
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
