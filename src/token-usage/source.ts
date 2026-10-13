import type { TokenUsageReport } from './schema.js';

export interface TokenUsageQueryOptions {
  days: number;
  timezone?: string;
}

export interface TokenUsageSource {
  getUsage(options: TokenUsageQueryOptions): Promise<TokenUsageReport>;
}
