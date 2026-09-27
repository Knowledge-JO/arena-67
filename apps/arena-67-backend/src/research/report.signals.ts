import type { TokenLink, TokenOverview, TokenPool } from '../market/market.types';
import type { HoldersBlock } from '../holders/holders.service';
import { ZERO_ADDRESS } from '../holders/transfer-fold';

export type SignalTone = 'good' | 'caution' | 'info';

export interface Signal {
  tone: SignalTone;
  text: string;
}

export interface TokenReport {
  kind: 'token_report';
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    totalSupply: string;
    imageUrl: string | null;
    websites: TokenLink[];
    socials: TokenLink[];
    /** null: no owner() function. Zero address: renounced. */
    owner: string | null;
  };
  market: TokenOverview | null;
  /** Where it can be traded here: deepest v4 pool per quote asset. */
  pools: TokenPool[];
  holders: HoldersBlock;
  /** Measured on-chain; null when it could not be measured. */
  transferTax?: { buyPct: number; sellPct: number } | null;
  signals: Signal[];
  explorer: string;
  asOf: string;
}

const HOUR = 3_600_000;

/**
 * Plain-language facts worth knowing before buying. Each one is computed
 * from a number in the report, so it can be checked against the card; none is
 * a prediction or advice.
 */
export function signalsFor(r: TokenReport, now = Date.now()): Signal[] {
  const out: Signal[] = [];
  const m = r.market;
  const h = r.holders;

  if (!m) {
    out.push({ tone: 'caution', text: 'No exchange lists this token yet, so there is no price or volume.' });
  } else {
    if (m.firstPoolAt != null && now - m.firstPoolAt < 24 * HOUR) {
      const hours = Math.max(1, Math.round((now - m.firstPoolAt) / HOUR));
      out.push({ tone: 'caution', text: `Very new: trading started about ${hours} hour${hours === 1 ? '' : 's'} ago.` });
    }
    if (m.liquidityUsd != null && m.liquidityUsd < 10_000) {
      out.push({
        tone: 'caution',
        text: `Thin liquidity (${money(m.liquidityUsd)}). Even a small trade can move the price a lot.`,
      });
    } else if (m.liquidityUsd != null && m.marketCap && m.liquidityUsd / m.marketCap < 0.02) {
      out.push({
        tone: 'caution',
        text: `Liquidity is small next to the market cap (${pct(m.liquidityUsd / m.marketCap * 100)}), so selling a large amount would be hard.`,
      });
    }
    const buys = m.buys.h24 ?? 0;
    const sells = m.sells.h24 ?? 0;
    if (sells >= 20 && sells >= 2 * buys) {
      out.push({ tone: 'caution', text: `More selling than buying today: ${ratio(sells, buys, 'sells', 'buy')}.` });
    } else if (buys >= 20 && buys >= 2 * sells) {
      out.push({ tone: 'info', text: `More buying than selling today: ${ratio(buys, sells, 'buys', 'sell')}.` });
    }
    const ch = m.priceChange.h24;
    if (ch != null && ch <= -50) out.push({ tone: 'caution', text: `Price is down ${Math.abs(ch).toFixed(0)}% in 24 hours.` });
    else if (ch != null && ch >= 100) out.push({ tone: 'info', text: `Price is up ${ch.toFixed(0)}% in 24 hours.` });
  }

  if (h.status === 'ready' && h.breakdown) {
    const top = h.breakdown.top10WalletsPercent;
    if (top != null) {
      if (top >= 50) out.push({ tone: 'caution', text: `Concentrated: the 10 largest wallets hold ${pct(top)} of the supply.` });
      else if (top >= 25) out.push({ tone: 'info', text: `The 10 largest wallets hold ${pct(top)} of the supply.` });
      else if ((h.breakdown.poolsPercent ?? 0) >= 80)
        // Few wallets holding much is not "spread out" when almost all of it
        // has simply never left the pool.
        out.push({
          tone: 'info',
          text: `Almost all of the supply (${pct(h.breakdown.poolsPercent!)}) is still in the liquidity pool — few people hold it yet.`,
        });
      else out.push({ tone: 'good', text: `Spread out: the 10 largest wallets hold ${pct(top)} of the supply.` });
    }
    if ((h.breakdown.contractsPercent ?? 0) >= 10) {
      out.push({
        tone: 'caution',
        text: `${pct(h.breakdown.contractsPercent!)} sits in contracts that are not pools — often a locker, vesting or launchpad. Worth checking what they are.`,
      });
    }
    if ((h.breakdown.burnedPercent ?? 0) >= 1) {
      out.push({ tone: 'info', text: `${pct(h.breakdown.burnedPercent!)} of the supply has been burned.` });
    }
  } else if (h.status === 'indexing' || h.status === 'queued') {
    out.push({ tone: 'info', text: 'Still counting holders — holder figures will appear when that finishes.' });
  }
  if (h.drift) {
    out.push({
      tone: 'caution',
      text: 'Holder counts are approximate: this token’s balances do not add up from its transfers (it may charge a fee on transfer or rebase). Top holders are still exact.',
    });
  }

  const tax = r.transferTax;
  if (tax && (tax.buyPct > 0 || tax.sellPct > 0)) {
    out.push({
      tone: 'caution',
      text: `Transfer tax: the token itself takes ${tax.buyPct}% of every buy and ${tax.sellPct}% of every sell, on top of pool fees.`,
    });
  } else if (tax) {
    out.push({ tone: 'good', text: 'No transfer tax — the token does not take a cut when you buy or sell.' });
  }

  const owner = r.token.owner;
  if (owner && owner !== ZERO_ADDRESS) {
    out.push({ tone: 'caution', text: 'The contract has an owner, who may be able to change how it works.' });
  } else if (owner === ZERO_ADDRESS) {
    out.push({ tone: 'good', text: 'Ownership has been given up, so no one can change the contract through an owner.' });
  }

  if (r.token.websites.length === 0 && r.token.socials.length === 0 && m) {
    out.push({ tone: 'info', text: 'No website or social links are listed.' });
  }
  return out;
}

function money(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${n < 10 ? n.toFixed(1) : n.toFixed(0)}%`;
}

function ratio(a: number, b: number, many: string, one: string): string {
  return b === 0 ? `${a} ${many} and no ${one}s` : `${(a / b).toFixed(1)} ${many} for every ${one}`;
}
