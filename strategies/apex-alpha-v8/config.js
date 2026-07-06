/** Default parameters matching ETH_4H_Apex_Alpha_v8.pine */

export const DEFAULT_CONFIG = {
  // Macro trend filter
  useMacroFilter: false,
  macroEmaLen: 200,

  // Filters
  useEmaFilter: true,
  emaLen: 150,
  useRsiFilter: true,
  rsiOkLevel: 78,
  rsiOkShortLevel: 22,

  // Strategy core
  atrLen: 10,
  factor: 2.4,
  kLen: 3,
  dLen: 3,
  rsiLen: 14,
  stochLen: 14,
  overSold: 38,
  overBought: 62,

  // God mode
  useMfiGod: true,
  mfiLen: 14,
  mfiStrong: 42,

  // Risk & sizing
  basePct: 25.0,
  godPct: 80.0,
  capGodPct: 50.0,
  cooldownBars: 0,
  allowReverse: true,

  // Exits
  slPct: 5.5,
  trailPct: 2.2,
  trailOffsetPct: 0.9,

  // Backtest
  initialCapital: 1_000_000,
  commissionPct: 0.1,
  slippagePct: 0.05,
  tickSize: 0.01,
};

/** @param {Partial<typeof DEFAULT_CONFIG>} overrides */
export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  cfg.effectiveGodPct =
    cfg.capGodPct > 0 ? Math.min(cfg.godPct, cfg.capGodPct) : cfg.godPct;
  return cfg;
}
