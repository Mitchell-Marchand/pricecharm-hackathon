export interface Trade {
  id: string;
  name: string;
  services: string[];
  /** How many of the services start selected. */
  preselect: number;
  /** Placeholder for describing a past job in this trade. */
  jobHint: string;
  /** Placeholder for how big a past job was, in the way this trade usually sizes one. */
  sizeHint: string;
}

export declare const TRADES: Trade[];
export declare const TRADES_BY_ID: Record<string, Trade>;
export declare function tradeName(tradeId: string | null | undefined, customTrade: string | null | undefined): string;
