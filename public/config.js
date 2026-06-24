// Canonical, locked house game. Every visitor auto-connects to this contract on
// Sepolia, so there's no "deploy" screen for players — they land straight into
// betting against the house (treasury 0x2F4B…aB39). A share link's ?contract=
// still overrides this if present. To point the site at a new game later, just
// update `address` here and push.
window.COINFLIP_CONFIG = {
  address: "0x2e3e84a41d6a122233ebac7a2cf2d9b5cd032998",
  chainId: 11155111,
  network: "sepolia",
  treasury: "0x2F4BEF94550C29c497b999B86b758F9771F7aB39",
  vrfCoordinator: null,
  abi: [],
};
