/**
 * Test Companies Configuration
 *
 * This file contains the list of companies to test for news/PR page discovery.
 * Edit this file to add, remove, or modify companies.
 */

import { CompanyInput } from './src/types';

/**
 * Companies to test for news/PR page discovery
 *
 * Each company needs:
 * - name: Display name for logging
 * - website: Domain (with or without protocol)
 * - ticker: Optional stock ticker symbol
 */
export const TEST_COMPANIES: CompanyInput[] = [
  { name: 'Apple', website: 'apple.com' },



];

/**
 * Get a subset of companies for quick testing
 */
export function getQuickTestCompanies(count: number = 1): CompanyInput[] {
  return TEST_COMPANIES.slice(0, count);
}

/**
 * Get companies by ticker symbols
 */
export function getCompaniesByTicker(tickers: string[]): CompanyInput[] {
  const tickerSet = new Set(tickers.map((t) => t.toUpperCase()));
  return TEST_COMPANIES.filter((c) => c.ticker && tickerSet.has(c.ticker.toUpperCase()));
}
