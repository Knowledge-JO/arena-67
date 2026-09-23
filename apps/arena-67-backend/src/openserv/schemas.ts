import { z } from 'zod';

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Deliberately permissive. The original plan made `amount` and `currency`
 * required, which breaks the product's own flow: the user is meant to pick a
 * token first and only then be asked "how much?". A required `amount` forces
 * the model to either fail extraction or invent a number on "buy Trump".
 *
 * So every trade parameter is optional here and the *orchestrator* decides
 * which slot is still missing. The model's only job is to report what the user
 * actually said.
 */
export const TradeIntentSchema = z.object({
  action: z
    .enum(['buy', 'sell'])
    .describe('Whether the user wants to buy or sell. Required.'),
  ticker: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'The token name or symbol as the user said it, e.g. "Trump", "Doge". ' +
        'Omit if the user gave only a contract address.',
    ),
  contractAddress: z
    .string()
    .regex(EVM_ADDRESS, 'Must be a valid EVM address')
    .optional()
    .describe(
      'The exact 0x token contract address. Omit unless the user literally ' +
        'typed an address — never guess or infer one from a ticker.',
    ),
  amount: z
    .number()
    .positive()
    .optional()
    .describe(
      'The numeric amount to spend (when buying) or sell. Omit if the user ' +
        'has not named an amount yet.',
    ),
  currency: z
    .string()
    .trim()
    .optional()
    .describe(
      'The funding asset the amount is denominated in, e.g. "USDG" or "ETH". ' +
        'Omit if the user did not say.',
    ),
});

export type TradeIntent = z.infer<typeof TradeIntentSchema>;

/** Which piece of the trade we still need before anything can be signed. */
export type MissingSlot = 'token' | 'amount' | 'confirmation' | null;

export const TRADE_SLOTS = ['token', 'amount', 'confirmation'] as const;
