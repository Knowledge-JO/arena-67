/**
 * Rough reads of what a message asks for, used only as a safety net: the
 * model decides which tool to call, and these catch the case where it
 * answered from earlier messages instead of calling one at all.
 */

const PORTFOLIO =
  /\b(portfolio|my (holdings?|balances?|bags?|positions?|p&l|pnl|profits?|wallet|tokens)|what do i (hold|own|have)|how am i doing|how much (do i have|am i (up|down)))\b/i;

const LIVE_DATA =
  /\b(buy|sell|swap|trade|ape|dump|price|chart|report|research|holders?|holding|trending|top|volume|launch(ed|es)?|new tokens?|quote|worth|market ?cap|liquidity|balance)\b|0x[a-fA-F0-9]{40}|\d+\s*%/i;

/** "Show my portfolio", "what do I hold", "my balance". */
export function asksForPortfolio(message: string): boolean {
  return PORTFOLIO.test(message);
}

/** Live figures or a trade: a reply without a tool call cannot be right. */
export function needsTool(message: string): boolean {
  return asksForPortfolio(message) || LIVE_DATA.test(message);
}
