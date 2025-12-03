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
  {
    'name': 'Apple Inc',
    'website': 'https://www.apple.com',
  },
  {
    'name': 'Amgen Inc',
    'website': 'https://www.amgen.com',
  },
  {
    'name': 'Amazon.com Inc',
    'website': 'https://www.amazon.com',
  },
  {
    'name': 'Walt Disney Co',
    'website': 'https://www.thewaltdisneycompany.com',
  },
  {
    'name': 'Honeywell International Inc',
    'website': 'https://www.honeywell.com',
  },
  {
    'name': 'Cisco Systems Inc',
    'website': 'https://www.cisco.com',
  },
  {
    'name': 'Salesforce.Com Inc',
    'website': 'https://www.salesforce.com',
  },
  {
    'name': '3M',
    'website': 'https://www.3m.com',
  },
  {
    'name': 'American Express',
    'website': 'https://www.americanexpress.com',
  },
  {
    'name': 'Chevron Corp',
    'website': 'https://www.chevron.com',
  },
  {
    'name': 'Caterpillar',
    'website': 'https://www.caterpillar.com',
  },
  {
    'name': 'The Coca-Cola Company',
    'website': 'https://www.coca-colacompany.com',
  },
  {
    'name': 'NIKE, Inc.',
    'website': 'https://investors.nike.com',
  },
  {
    'name': 'The Home Depot, Inc.',
    'website': 'https://www.homedepot.com',
  },
  {
    'name': 'JPMorgan Chase & Co',
    'website': 'https://www.jpmorganchase.com',
  },
  {
    'name': 'The Boeing Company',
    'website': 'https://www.boeing.com',
  },
  {
    'name': 'Goldman Sachs Group Inc',
    'website': 'https://www.goldmansachs.com',
  },
  {
    'name': 'International Business Machines Corporation',
    'website': 'https://www.ibm.com',
  },
  {
    'name': 'Johnson & Johnson',
    'website': 'https://www.jnj.com',
  },
  {
    'name': 'Microsoft Corporation',
    'website': 'https://www.microsoft.com',
  },
  {
    'name': 'Walmart',
    'website': 'https://corporate.walmart.com',
  },
  {
    'name': 'Merck & Co Inc',
    'website': 'https://www.merck.com',
  },
  {
    'name': 'McDonald\'s',
    'website': 'https://corporate.mcdonalds.com',
  },
  {
    'name': 'NVIDIA Corp',
    'website': 'https://www.nvidia.com',
  },
  {
    'name': 'Travelers Companies Inc',
    'website': 'https://www.travelers.com',
  },
  {
    'name': 'Procter & Gamble Co',
    'website': 'https://www.pginvestor.com',
  },
  {
    'name': 'Sherwin-Williams',
    'website': 'https://www.sherwin-williams.com',
  },
  {
    'name': 'Verizon Communications',
    'website': 'https://www.verizon.com',
  },
  {
    'name': 'UnitedHealth Group Incorporated',
    'website': 'https://www.unitedhealthgroup.com',
  },
  {
    'name': 'Visa',
    'website': 'https://usa.visa.com',
  },
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
