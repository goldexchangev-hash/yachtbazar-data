// Canonical, locked house game. Every visitor auto-connects to this contract on
// Sepolia. A share link's ?contract= still overrides this if present.
//
// `registry` (optional): a one-time, immutable GameRegistry address. When set,
// the site resolves the live game from registry.activeGame() on load, so the
// owner can switch the whole site to a new contract with a single on-chain tx
// (no code push). `address` below is the fallback if the registry is unset or
// unreachable.
window.COINFLIP_CONFIG = {
  address: "0x2BE6D59A6DfD8CE91D08c87D5110962Fa7648A30",
  registry: null,
  chainId: 11155111,
  network: "sepolia",
  treasury: "0x2F4BEF94550C29c497b999B86b758F9771F7aB39",
  vrfCoordinator: null,
  abi: [],
};
