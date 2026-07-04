// Canonical, locked house game. Every visitor auto-connects to this contract on
// Sepolia. A share link's ?contract= still overrides this if present.
//
// `registry` (optional): a one-time, immutable GameRegistry address. When set,
// the site resolves the live game from registry.activeGame() on load, so the
// owner can switch the whole site to a new contract with a single on-chain tx
// (no code push). `address` below is the fallback if the registry is unset or
// unreachable.
window.COINFLIP_CONFIG = {
  // THE live game (== registry.activeGame() as of 2026-07-02). The fallback MUST equal the registry-active
  // contract: a stale fallback here + a slow/lost registry read used to bind sessions to the OLD dead contract
  // (deposits landed there, blackjackBuyIn reverted "transaction execution reverted", and the in-game balance
  // flapped between the two contracts' balances on refresh).
  address: "0x8d7fFC40AcF64793FA5175808Ee33FF242E59955",
  // Our OWN previous contracts (trusted list — ours, not user-supplied). An explicit ?contract= matching one
  // of these binds it in RECOVERY MODE so stranded deposits can still be withdrawn.
  legacy: ["0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc"],
  registry: "0x21Fc88619753254D2Cd5D74A2102D4A876fc1Fa1",
  chainId: 11155111,
  network: "sepolia",
  treasury: "0x2F4BEF94550C29c497b999B86b758F9771F7aB39",
  vrfCoordinator: null,
  abi: [],
};
// Fish Shooter loads the .webp sprite pack (10.2MB) instead of the PNGs (16.8MB) — siblings generated
// at q90 (sharp), PNGs kept as the automatic per-file fallback (fishshooter.js tryLoad). Regenerate the
// .webp pack whenever the sprite pipeline adds/changes PNGs, or new art silently loads the PNG path.
window.FS_WEBP_PACK = true;
window.FS2_ENABLED = true; // Fish Shooter V2 (CH 20) kill switch — set false to hide the whole channel (v1 untouched)
window.BACCARAT_ENABLED = true; // Baccarat (CH 21) kill switch — set false to hide the whole channel (tile + rotation + felt)
window.POKER_ENABLED = true; // Poker (CH 22) LIVE — P6 money+security audit passed (2 CRITICALs found, fixed, regression-tested; re-audit CLEAR), P7 flip 2026-07-04. Kill switch: set false to instantly hide the tile + rotation + felt.
