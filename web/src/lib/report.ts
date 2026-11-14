// Headline numbers from data/mainnet/report.json (npm run reproduce).

export type Report = {
  snapshot: { crawled_from: string; crawled_to: string; factory: string };
  daos: {
    total: number;
    with_any_proposal: number;
    with_any_payout: number;
    /** Factory DAOs that no longer answer get_proposal. */
    unreadable: number;
    /** Sputnik version, or "custom" for code the factory never published. */
    by_code_version: Record<string, number>;
  };
  payouts: {
    total: number;
    by_path: Record<"transfer" | "bounty" | "ft_transfer" | "intents" | "bulk", number>;
    missed_by_a_transfer_only_crawl_pct: number;
    opaque: { chain_signature: number; bulk_list_missing: number };
    in_the_last_year: number;
    to_members_of_the_paying_dao_pct: number;
    filed_by_the_receiver_pct: number;
  };
  receivers: {
    total: number;
    paid_by_2_or_more_daos: number;
    paid_by_3_or_more_daos: number;
    claimable_from_2_or_more_daos: number;
  };
};

let cached: Promise<Report> | null = null;

export function loadReport(): Promise<Report> {
  cached ??= fetch(`${import.meta.env.BASE_URL}data/report.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`Couldn't download the report (HTTP ${r.status}).`);
      return r.json() as Promise<Report>;
    })
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}
