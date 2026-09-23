/**
 * Kept as a re-export so existing imports keep working. The per-network values
 * now live in networks.ts — nothing chain-specific should be hardcoded here,
 * because there are two chains.
 */
export {
  NATIVE_TOKEN,
  NETWORKS,
  resolveNetwork,
  explorerTxUrl,
  type NetworkConfig,
  type NetworkName,
  type BaseToken,
} from './networks';
