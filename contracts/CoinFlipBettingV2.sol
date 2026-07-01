// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CoinFlipBettingV2
/// @notice ETH escrow + house-signed blackjack settlement for the Crypto TV app.
/// @dev    RETIREMENT (2026-07-01, F5): every on-chain-block-randomness game
///         (coin flip vs house, PvP rooms, host tables, dice, two-dice, crash,
///         slots) has been DELETED. Those games read `block.prevrandao` /
///         `blockhash` / `gasleft()` in-transaction and returned/emitted the
///         outcome, so an attacker could `eth_call`-simulate the settling call
///         and only submit the winning ones (the "staticCall cherry-pick"). The
///         on-chain PvP tables are retired outright; every vs-house game moves to
///         the off-chain server commit-reveal token bridge. What remains here is
///         ONLY the money path the bridge needs: pure-ETH deposit/withdraw escrow,
///         the owner-funded house bankroll, and the house-signed per-session
///         blackjack lock+settle (Critical-4 per-session isolation, EIP-2 low-s
///         guard, and the over-loss revert invariant, all unchanged).
contract CoinFlipBettingV2 {
    // --------------------------------------------------------------------- //
    //  Ownership (minimal, no external deps)
    // --------------------------------------------------------------------- //
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────── //
    //  Circuit-breaker + EOA guard. `paused` lets the owner halt all settling
    //  instantly without a redeploy; _betGuard() forbids contract callers (EOA
    //  only) on any settling entrypoint. Kept for the remaining money path.
    // ─────────────────────────────────────────────────────────────────────── //
    error ContractCaller();
    error Paused();
    bool public paused;
    event PausedSet(bool paused);

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function _betGuard() internal view {
        if (msg.sender != tx.origin) revert ContractCaller();
        if (paused) revert Paused();
    }

    // --------------------------------------------------------------------- //
    //  Constants / config
    // --------------------------------------------------------------------- //

    /// @notice Minimum bet per player, in wei (0.0001 ETH).
    uint256 public constant MIN_BET = 0.0001 ether;

    /// @notice Maximum bet per player, in wei. Pure ETH. Owner-adjustable.
    ///         Default 1 ETH so the UI's up-to-$500 slider always fits.
    uint256 public maxBet = 1 ether;

    /// @notice House fee in basis points (300 = 3%). Kept for the UI/stats.
    uint256 public constant HOUSE_FEE_BPS = 300;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Wallet that receives fees (the host). Set at deploy.
    address public immutable treasury;

    // --------------------------------------------------------------------- //
    //  Bankroll / stats
    // --------------------------------------------------------------------- //

    /// @notice Withdrawable balance per address (deposits + winnings).
    mapping(address => uint256) public balances;

    /// @notice ETH pool that funds the house's side of games (blackjack).
    uint256 public houseBankroll;

    // --------------------------------------------------------------------- //
    //  Blackjack: server-authoritative multiplayer, house-signed settlement.
    //  V2 — PER-SESSION LOCKS (audit Critical-4).
    //  Players LOCK a buy-in from their balance into a NEW, independent session
    //  (keyed by an opaque `sessionId`) to sit at a real-money table — so they
    //  can't withdraw mid-hand AND one table's settle can never touch another
    //  table's principal. The trusted house signer (the game server) signs each
    //  session's NET result OVER THE sessionId; settleSession verifies the
    //  signature and reconciles only THAT session's locked funds against the
    //  house bankroll. A player can never lose more than they locked in that
    //  session.
    // --------------------------------------------------------------------- //
    /// @notice Address whose signature authorizes blackjack settlements (the server).
    address public blackjackSigner;

    /// @notice One real-money blackjack table session. `locked` is the escrowed
    ///         buy-in for THIS session only; `settled` flips true once paid out.
    struct Session {
        address player;
        uint256 locked;
        bool settled;
    }
    /// @notice Per-session escrow, keyed by an opaque off-chain session id.
    mapping(bytes32 => Session) public sessions;
    /// @notice Sum of all of an address's currently-locked sessions (UI/safety view).
    mapping(address => uint256) public totalLocked;
    /// @notice Spent settlement nonces (replay protection).
    mapping(uint256 => bool) public bjNonceUsed;

    // --------------------------------------------------------------------- //
    //  Events
    // --------------------------------------------------------------------- //

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount, uint256 newBalance);
    event MaxBetUpdated(uint256 newMaxBet);
    event HouseFunded(uint256 amount, uint256 bankroll);
    event HouseWithdrawn(uint256 amount, uint256 bankroll);
    event BlackjackSignerUpdated(address indexed signer);
    /// @notice A new per-session blackjack buy-in was locked.
    event BlackjackSessionStarted(bytes32 indexed sessionId, address indexed player, uint256 amount);
    /// @notice A per-session blackjack result settled (net P&L applied to that session).
    event BlackjackSessionSettled(bytes32 indexed sessionId, address indexed player, int256 net, uint256 returned, uint256 nonce);

    // --------------------------------------------------------------------- //
    //  Errors
    // --------------------------------------------------------------------- //

    error NotOwner();
    error BetTooSmall();
    error BetIsZero();
    error InsufficientBalance();
    error NothingToWithdraw();
    error TransferFailed();
    error HouseBankrollLow();
    // V2 per-session blackjack
    error SessionExists();
    error UnknownSession();
    error SessionSettled();
    error BadSignature();
    error NonceUsed();

    // --------------------------------------------------------------------- //
    //  Constructor
    // --------------------------------------------------------------------- //

    constructor(address _treasury) {
        owner = msg.sender;
        treasury = _treasury == address(0) ? msg.sender : _treasury;
    }

    // --------------------------------------------------------------------- //
    //  Bankroll: deposit / withdraw
    // --------------------------------------------------------------------- //

    function deposit() external payable {
        if (msg.value == 0) revert BetIsZero();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        uint256 bal = balances[msg.sender];
        if (amount == 0 || amount > bal) revert InsufficientBalance();
        balances[msg.sender] = bal - amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    function withdrawAll() external {
        uint256 bal = balances[msg.sender];
        if (bal == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, bal, 0);
    }

    // --------------------------------------------------------------------- //
    //  House bankroll: fund / withdraw (owner)
    // --------------------------------------------------------------------- //

    function fundHouse() external payable onlyOwner {
        if (msg.value == 0) revert BetIsZero();
        houseBankroll += msg.value;
        emit HouseFunded(msg.value, houseBankroll);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (amount == 0 || amount > houseBankroll) revert HouseBankrollLow();
        houseBankroll -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawn(amount, houseBankroll);
    }

    // --------------------------------------------------------------------- //
    //  Blackjack: house-signed settlement — V2 PER-SESSION LOCKS
    // --------------------------------------------------------------------- //

    /// @notice Set the trusted signer (the game server) that authorizes blackjack
    ///         settlements. The server holds the matching private key.
    function setBlackjackSigner(address signer) external onlyOwner {
        blackjackSigner = signer;
        emit BlackjackSignerUpdated(signer);
    }

    /// @notice Lock a buy-in from your withdrawable balance into a NEW, isolated
    ///         table session keyed by `sessionId`. Locked funds can't be withdrawn
    ///         until that session is settled — this is what makes server-
    ///         authoritative play safe. Each session is independent: one session's
    ///         signed settle can only ever release that session's principal, so two
    ///         concurrent tables can never be made to drain each other's buy-in.
    ///         Reverts if `sessionId` is already in use.
    function startSession(bytes32 sessionId, uint256 amount) external {
        if (sessions[sessionId].player != address(0)) revert SessionExists();
        uint256 bal = balances[msg.sender];
        if (amount == 0 || amount > bal) revert InsufficientBalance();

        balances[msg.sender] = bal - amount;
        sessions[sessionId] = Session({player: msg.sender, locked: amount, settled: false});
        totalLocked[msg.sender] += amount;

        emit BlackjackSessionStarted(sessionId, msg.sender, amount);
    }

    /// @notice Settle one blackjack session. `net` is the signed net P&L for THIS
    ///         session (positive = the player won, negative = they lost). Pays out
    ///         `locked + net` for this session only against the house bankroll,
    ///         marks it settled, and returns the remainder to the player's
    ///         withdrawable balance. Requires a signature from `blackjackSigner`
    ///         over (sessionId, player, net, nonce, chainId, contract) — binding
    ///         the sessionId is what prevents one session's signature from being
    ///         replayed to drain another's principal. A player can never lose more
    ///         than they locked in this session: a signed net below -locked is
    ///         REJECTED (revert InsufficientBalance). The house signer is
    ///         responsible for flooring net at -locked before signing; the contract
    ///         enforces it as a hard invariant (reject a malformed authorization
    ///         outright rather than silently clamp-and-pay).
    function settleSession(bytes32 sessionId, int256 net, uint256 nonce, bytes calldata signature) external {
        if (blackjackSigner == address(0)) revert NotOwner();
        if (bjNonceUsed[nonce]) revert NonceUsed();

        Session storage s = sessions[sessionId];
        address player = s.player;
        if (player == address(0)) revert UnknownSession();
        if (s.settled) revert SessionSettled();

        // The digest BINDS the sessionId (plus player, net, nonce, chainid,
        // contract). A settle authorized for one session can therefore never be
        // accepted against another session — that is the Critical-4 fix.
        bytes32 h = keccak256(abi.encodePacked(sessionId, player, net, nonce, block.chainid, address(this)));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        if (_recover(ethHash, signature) != blackjackSigner) revert BadSignature();

        bjNonceUsed[nonce] = true;
        uint256 locked = s.locked;
        s.locked = 0;
        s.settled = true;
        totalLocked[player] -= locked;

        uint256 returned;
        if (net >= 0) {
            uint256 win = uint256(net);
            if (win > houseBankroll) revert HouseBankrollLow();
            houseBankroll -= win;
            returned = locked + win;
        } else {
            uint256 loss = uint256(-net);
            if (loss > locked) revert InsufficientBalance(); // never lose more than this session's lock
            houseBankroll += loss;
            returned = locked - loss;
        }
        balances[player] += returned;
        emit BlackjackSessionSettled(sessionId, player, net, returned, nonce);
    }

    /// @notice View: ETH locked in a given session (0 if absent or settled).
    function lockedOf(bytes32 sessionId) external view returns (uint256) {
        return sessions[sessionId].locked;
    }

    /// @notice View: total ETH a player currently has locked across all open
    ///         (unsettled) sessions.
    function totalLockedOf(address player) external view returns (uint256) {
        return totalLocked[player];
    }

    /// @dev Minimal ECDSA recover (no external deps).
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // EIP-2: reject the upper-half (malleable) `s`. Without this, a captured signature can be re-mangled into
        // a SECOND valid (r, s', v') for the same digest (s' = n - s, v' = v^1). The honest house signer (ethers)
        // always emits canonical low-s sigs, so this only rejects adversarial twins and never a legitimate settle.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }

    // --------------------------------------------------------------------- //
    //  Owner config
    // --------------------------------------------------------------------- //

    function setMaxBet(uint256 newMaxBet) external onlyOwner {
        if (newMaxBet < MIN_BET) revert BetTooSmall();
        maxBet = newMaxBet;
        emit MaxBetUpdated(newMaxBet);
    }
}
