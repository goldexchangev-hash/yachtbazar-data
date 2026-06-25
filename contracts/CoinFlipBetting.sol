// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CoinFlipBetting
/// @notice A two-player (and vs-house) ETH coin-flip betting game.
///         Randomness uses Ethereum's built-in `block.prevrandao` (the post-Merge
///         RANDAO beacon) mixed with block + game data — the most popular on-chain
///         randomness that needs NO oracle, NO subscription, and NO LINK. Flips
///         settle instantly in the same transaction.
/// @dev    Trade-off: `prevrandao` is not resistant to a determined validator the
///         way Chainlink VRF is, so this is intended for a fun game on a test
///         network, not a high-stakes real-money casino.
///         Everything is pure ETH — no tokens, swaps, or conversion fees. The
///         winner takes the pot minus a 10% house fee credited to the treasury.
contract CoinFlipBetting {
    // --------------------------------------------------------------------- //
    //  Ownership (minimal, no external deps)
    // --------------------------------------------------------------------- //
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // --------------------------------------------------------------------- //
    //  Constants / config
    // --------------------------------------------------------------------- //

    /// @notice Minimum bet per player, in wei (0.0001 ETH).
    uint256 public constant MIN_BET = 0.0001 ether;

    /// @notice Maximum bet per player, in wei. Pure ETH. Owner-adjustable.
    ///         Default 1 ETH so the UI's up-to-$500 slider always fits.
    uint256 public maxBet = 1 ether;

    /// @notice House fee in basis points (1000 = 10%).
    uint256 public constant HOUSE_FEE_BPS = 1000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ---- Dice game (CH 09): roll 0..9999 (shown 0.00–99.99), roll under/over ----
    uint256 public constant DICE_OUTCOMES = 10_000;       // roll space [0,9999]
    uint256 public constant MIN_WIN_OUTCOMES = 100;       // >=1.00% chance (<=98x)
    uint256 public constant MAX_WIN_OUTCOMES = 9_700;     // <=97.00% chance, keeps payout > stake at the default edge
    uint256 public constant MAX_DICE_EDGE_BPS = 1_000;    // owner can't set edge above 10%
    /// @notice Dice house edge in bps (200 = 2%). Owner-tunable via setDiceEdge.
    uint256 public diceEdgeBps = 200;
    uint256 public nextDiceGameId = 1;
    /// @notice Single bet's max payout-above-stake is capped to this share of the
    ///         bankroll. Owner-tunable via setMaxPayoutCap. Default 1000 bps = 10%,
    ///         so one lucky win can never drain more than a tenth of the house in a
    ///         single roll (protects liquidity / other players).
    uint256 public maxPayoutBpsOfBankroll = 1_000;

    struct DiceGame {
        uint256 id;
        address player;
        uint256 betAmount;
        uint16 target;
        bool rollOver;
        uint16 roll;
        bool won;
        uint256 payout;
        uint256 multiplierBps;
        uint256 settledAt;
    }
    mapping(uint256 => DiceGame) public diceGames;
    uint256[] private _diceIds;

    // ---- Dice #2 (CH 10): two d6 dice, sum 2..12, roll under/over a target total ----
    uint256 public constant TWO_DICE_COMBOS = 36; // 6 x 6 equally-likely faces
    /// @notice Dice #2 house edge in bps (200 = 2%). Owner-tunable via setTwoDiceEdge.
    uint256 public twoDiceEdgeBps = 200;
    uint256 public nextTwoDiceGameId = 1;

    struct TwoDiceGame {
        uint256 id;
        address player;
        uint256 betAmount;
        uint8 target;   // 2..12, the line
        bool rollOver;  // true: win if sum > target; false: win if sum < target
        uint8 d1;       // first die, 1..6
        uint8 d2;       // second die, 1..6
        bool won;
        uint256 payout;
        uint256 multiplierBps;
        uint256 settledAt;
    }
    mapping(uint256 => TwoDiceGame) public twoDiceGames;
    uint256[] private _twoDiceIds;

    /// @notice Wallet that receives the 10% fee (the host). Set at deploy.
    address public immutable treasury;

    // --------------------------------------------------------------------- //
    //  Game state
    // --------------------------------------------------------------------- //

    enum Status {
        Open, // 0 — waiting for a second player
        Flipping, // 1 — (unused; kept so Settled stays 2 for the frontend)
        Settled, // 2 — decided & paid (internally)
        Cancelled // 3 — creator cancelled before anyone joined
    }

    struct Room {
        uint256 id;
        string name;
        address creator;
        uint256 betAmount;
        address player1; // "heads"
        address player2; // "tails"
        Status status;
        address winner;
        bool headsWon; // true => the coin landed HEADS (used for the TV coin side)
        uint256 createdAt;
        uint256 settledAt;
        bool isHouseGame; // true => player2 is the house bankroll
        bool creatorHeads; // true => creator (player1) picked HEADS; player2 gets the other side
    }

    uint256 public nextRoomId = 1;
    mapping(uint256 => Room) public rooms;
    uint256[] private _roomIds;
    uint256 private _nonce;

    /// @notice Withdrawable balance per address (deposits + winnings + fees).
    mapping(address => uint256) public balances;

    /// @notice Lifetime stats for the UI.
    uint256 public totalFeesCollected;
    uint256 public totalGamesPlayed;
    uint256 public totalWagered;

    /// @notice ETH pool that funds the house's side of "play vs house" games.
    uint256 public houseBankroll;

    // --------------------------------------------------------------------- //
    //  Host tables (be-your-own-house links)
    // --------------------------------------------------------------------- //

    /// @notice A personal "house" table: the creator escrows a bank, and anyone
    ///         with the link flips against it for any amount up to the bank. The
    ///         creator is the house and collects the 10% rake. If a table sees no
    ///         play for HOST_TIMEOUT it can be closed by anyone and the remaining
    ///         bank is refunded to the creator.
    struct HostRoom {
        uint256 id;
        string name;
        address creator; // the personal house / bank owner
        uint256 bank; // remaining escrowed funds backing player bets
        uint256 lastActivity; // create-or-last-flip timestamp (idle-timeout anchor)
        uint256 gamesPlayed;
        bool open;
    }

    /// @notice Idle window before a host table can be closed + refunded by anyone.
    uint256 public constant HOST_TIMEOUT = 5 minutes;

    uint256 public nextHostRoomId = 1;
    mapping(uint256 => HostRoom) public hostRooms;
    uint256[] private _hostRoomIds;

    // Compact "currently open" sets so getOpenRooms / getOpenHostRooms stay
    // O(open) instead of O(all-time) — free testnet create+cancel spam can no
    // longer bloat those loops until they exceed the block gas limit. Swap-pop.
    uint256[] private _openRoomIds;
    mapping(uint256 => uint256) private _openRoomPos; // 1-based index; 0 = absent
    uint256[] private _openHostRoomIds;
    mapping(uint256 => uint256) private _openHostPos; // 1-based index; 0 = absent

    /// @notice Currently-open PvP rooms / host tables per address (anti-spam cap).
    mapping(address => uint256) public openRoomsOf;
    mapping(address => uint256) public openTablesOf;
    /// @notice Cap on simultaneously-open rooms / tables a single address may hold.
    uint256 public constant MAX_OPEN_PER_ADDRESS = 12;

    // --------------------------------------------------------------------- //
    //  Events
    // --------------------------------------------------------------------- //

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount, uint256 newBalance);
    event RoomCreated(uint256 indexed roomId, address indexed creator, uint256 betAmount, string name);
    event MaxBetUpdated(uint256 newMaxBet);
    event RoomCancelled(uint256 indexed roomId);
    event RoomBetUpdated(uint256 indexed roomId, uint256 newBet);
    event PlayerJoined(uint256 indexed roomId, address indexed player2);
    event HouseFunded(uint256 amount, uint256 bankroll);
    event HouseWithdrawn(uint256 amount, uint256 bankroll);
    event HouseGameStarted(uint256 indexed roomId, address indexed player, uint256 betAmount);
    event FlipSettled(uint256 indexed roomId, address indexed winner, bool headsWon, uint256 payout, uint256 fee);
    event HostRoomCreated(uint256 indexed roomId, address indexed creator, uint256 bank, string name);
    event HostFlip(uint256 indexed roomId, address indexed player, uint256 betAmount, bool playerWon, uint256 payout, uint256 fee);
    event HostRoomClosed(uint256 indexed roomId, uint256 refund);
    event DiceRolled(
        uint256 indexed gameId, address indexed player, uint256 betAmount,
        uint16 target, bool rollOver, uint16 roll, bool won, uint256 payout, uint256 multiplierBps
    );
    event DiceEdgeUpdated(uint256 newEdgeBps);
    event MaxPayoutCapUpdated(uint256 newBps);
    event TwoDiceRolled(
        uint256 indexed gameId, address indexed player, uint256 betAmount,
        uint8 target, bool rollOver, uint8 d1, uint8 d2, bool won, uint256 payout, uint256 multiplierBps
    );
    event TwoDiceEdgeUpdated(uint256 newEdgeBps);

    // --------------------------------------------------------------------- //
    //  Errors
    // --------------------------------------------------------------------- //

    error NotOwner();
    error BetTooHigh();
    error BetTooSmall();
    error BetIsZero();
    error InsufficientBalance();
    error RoomNotOpen();
    error CannotJoinOwnRoom();
    error NotRoomCreator();
    error NothingToWithdraw();
    error TransferFailed();
    error UnknownRoom();
    error HouseBankrollLow();
    error HostRoomNotOpen();
    error CannotPlayOwnTable();
    error BankTooLow();
    error HostRoomStillActive();
    error TooManyOpen();
    error DiceBadTarget();
    error DiceEdgeTooHigh();

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
    //  Rooms: create / cancel / update / join
    // --------------------------------------------------------------------- //

    function createRoom(uint256 betAmount, string calldata name, bool creatorHeads) external returns (uint256 roomId) {
        if (betAmount < MIN_BET) revert BetTooSmall();
        if (betAmount > maxBet) revert BetTooHigh();
        if (balances[msg.sender] < betAmount) revert InsufficientBalance();
        if (openRoomsOf[msg.sender] >= MAX_OPEN_PER_ADDRESS) revert TooManyOpen();

        balances[msg.sender] -= betAmount; // escrowed in the room

        roomId = nextRoomId++;
        rooms[roomId] = Room({
            id: roomId,
            name: bytes(name).length == 0 ? "Coin Flip" : name,
            creator: msg.sender,
            betAmount: betAmount,
            player1: msg.sender,
            player2: address(0),
            status: Status.Open,
            winner: address(0),
            headsWon: false,
            createdAt: block.timestamp,
            settledAt: 0,
            isHouseGame: false,
            creatorHeads: creatorHeads
        });
        _roomIds.push(roomId);
        _addOpenRoom(roomId);
        openRoomsOf[msg.sender]++;

        emit RoomCreated(roomId, msg.sender, betAmount, rooms[roomId].name);
    }

    /// @notice Creator adjusts the room's bet while it's still open (used by the
    ///         off-chain bet negotiation). Escrow tops up or refunds to match.
    function updateRoomBet(uint256 roomId, uint256 newBet) external {
        Room storage room = rooms[roomId];
        if (room.id == 0) revert UnknownRoom();
        if (room.creator != msg.sender) revert NotRoomCreator();
        if (room.status != Status.Open) revert RoomNotOpen();
        if (newBet < MIN_BET) revert BetTooSmall();
        if (newBet > maxBet) revert BetTooHigh();

        uint256 old = room.betAmount;
        if (newBet > old) {
            uint256 diff = newBet - old;
            if (balances[msg.sender] < diff) revert InsufficientBalance();
            balances[msg.sender] -= diff;
        } else if (newBet < old) {
            balances[msg.sender] += (old - newBet);
        }
        room.betAmount = newBet;
        emit RoomBetUpdated(roomId, newBet);
    }

    function cancelRoom(uint256 roomId) external {
        Room storage room = rooms[roomId];
        if (room.id == 0) revert UnknownRoom();
        if (room.creator != msg.sender) revert NotRoomCreator();
        if (room.status != Status.Open) revert RoomNotOpen();

        room.status = Status.Cancelled;
        _removeOpenRoom(roomId);
        openRoomsOf[room.creator]--;
        balances[room.player1] += room.betAmount; // refund
        emit RoomCancelled(roomId);
    }

    /// @notice Join an open room, escrow your matching bet, and flip immediately.
    function joinRoom(uint256 roomId) external {
        Room storage room = rooms[roomId];
        if (room.id == 0) revert UnknownRoom();
        if (room.status != Status.Open) revert RoomNotOpen();
        if (room.creator == msg.sender) revert CannotJoinOwnRoom();
        if (balances[msg.sender] < room.betAmount) revert InsufficientBalance();

        balances[msg.sender] -= room.betAmount; // escrowed in the room
        room.player2 = msg.sender;
        emit PlayerJoined(roomId, msg.sender);

        _settleFlip(roomId);
    }

    // --------------------------------------------------------------------- //
    //  Play vs House
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

    /// @notice One-tap coin flip against the house. Your bet is matched from the
    ///         house bankroll; winner takes the pot minus the 10% fee. You are
    ///         "heads" (player1). Settles instantly.
    function playHouse(uint256 betAmount, bool wantsHeads) external returns (uint256 roomId) {
        if (betAmount < MIN_BET) revert BetTooSmall();
        if (betAmount > maxBet) revert BetTooHigh();
        if (balances[msg.sender] < betAmount) revert InsufficientBalance();
        if (houseBankroll < betAmount) revert HouseBankrollLow();

        balances[msg.sender] -= betAmount; // your stake
        houseBankroll -= betAmount; // the house's matching stake

        roomId = nextRoomId++;
        rooms[roomId] = Room({
            id: roomId,
            name: "Vs House",
            creator: msg.sender,
            betAmount: betAmount,
            player1: msg.sender, // you
            player2: treasury, // the house takes the other side
            status: Status.Open,
            winner: address(0),
            headsWon: false,
            createdAt: block.timestamp,
            settledAt: 0,
            isHouseGame: true,
            creatorHeads: wantsHeads
        });
        _roomIds.push(roomId);

        emit HouseGameStarted(roomId, msg.sender, betAmount);
        _settleFlip(roomId);
    }

    // --------------------------------------------------------------------- //
    //  Settlement (synchronous, prevrandao-based)
    // --------------------------------------------------------------------- //

    function _random(uint256 roomId, address p1, address p2) internal returns (uint256) {
        unchecked {
            return
                uint256(
                    keccak256(
                        abi.encodePacked(
                            block.prevrandao,
                            block.timestamp,
                            blockhash(block.number - 1),
                            p1,
                            p2,
                            roomId,
                            _nonce++,
                            gasleft()
                        )
                    )
                );
        }
    }

    // ----- open-set maintenance (swap-pop, O(1)) -----
    function _addOpenRoom(uint256 id) private { _openRoomIds.push(id); _openRoomPos[id] = _openRoomIds.length; }
    function _removeOpenRoom(uint256 id) private {
        uint256 pos = _openRoomPos[id];
        if (pos == 0) return;
        uint256 lastIdx = _openRoomIds.length - 1;
        if (pos - 1 != lastIdx) {
            uint256 lastId = _openRoomIds[lastIdx];
            _openRoomIds[pos - 1] = lastId;
            _openRoomPos[lastId] = pos;
        }
        _openRoomIds.pop();
        _openRoomPos[id] = 0;
    }
    function _addOpenHost(uint256 id) private { _openHostRoomIds.push(id); _openHostPos[id] = _openHostRoomIds.length; }
    function _removeOpenHost(uint256 id) private {
        uint256 pos = _openHostPos[id];
        if (pos == 0) return;
        uint256 lastIdx = _openHostRoomIds.length - 1;
        if (pos - 1 != lastIdx) {
            uint256 lastId = _openHostRoomIds[lastIdx];
            _openHostRoomIds[pos - 1] = lastId;
            _openHostPos[lastId] = pos;
        }
        _openHostRoomIds.pop();
        _openHostPos[id] = 0;
    }

    function _settleFlip(uint256 roomId) internal {
        Room storage room = rooms[roomId];

        // Flip the coin, then decide by the side the creator (player1) chose: they
        // win when the coin lands on their side. Player2 always gets the other side.
        bool headsLanded = (_random(roomId, room.player1, room.player2) % 2 == 0);
        bool creatorWon = (headsLanded == room.creatorHeads);
        address winner = creatorWon ? room.player1 : room.player2;

        uint256 pot = room.betAmount * 2;
        uint256 fee = (pot * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        uint256 payout = pot - fee;

        // The 10% rake flows back into the house bankroll (the pool players
        // bet against), not the host's separate in-game balance.
        houseBankroll += fee;

        if (room.isHouseGame && !creatorWon) {
            houseBankroll += payout; // house won — refill bankroll
        } else {
            balances[winner] += payout; // a human winner
        }

        room.status = Status.Settled;
        room.winner = winner;
        room.headsWon = headsLanded; // the coin's actual side (for the TV)
        room.settledAt = block.timestamp;

        // Drop a PvP room out of the open set when it settles (vs-house rooms were
        // never added — settled atomically on creation — so this no-ops for them).
        if (_openRoomPos[roomId] != 0) {
            _removeOpenRoom(roomId);
            openRoomsOf[room.player1]--;
        }

        totalFeesCollected += fee;
        totalGamesPlayed += 1;
        totalWagered += pot;

        emit FlipSettled(roomId, winner, headsLanded, payout, fee);
    }

    // --------------------------------------------------------------------- //
    //  Owner config
    // --------------------------------------------------------------------- //

    function setMaxBet(uint256 newMaxBet) external onlyOwner {
        if (newMaxBet < MIN_BET) revert BetTooSmall();
        maxBet = newMaxBet;
        emit MaxBetUpdated(newMaxBet);
    }

    // --------------------------------------------------------------------- //
    //  Host tables: create / play / close
    // --------------------------------------------------------------------- //

    /// @notice Open a personal "house" table funded with `bank` from your balance.
    ///         Share the link; anyone can flip against your bank for any amount.
    function createHostRoom(uint256 bank, string calldata name) external returns (uint256 roomId) {
        if (bank < MIN_BET) revert BetTooSmall();
        if (balances[msg.sender] < bank) revert InsufficientBalance();
        if (openTablesOf[msg.sender] >= MAX_OPEN_PER_ADDRESS) revert TooManyOpen();

        balances[msg.sender] -= bank; // escrow the bank

        roomId = nextHostRoomId++;
        hostRooms[roomId] = HostRoom({
            id: roomId,
            name: bytes(name).length == 0 ? "Host Table" : name,
            creator: msg.sender,
            bank: bank,
            lastActivity: block.timestamp,
            gamesPlayed: 0,
            open: true
        });
        _hostRoomIds.push(roomId);
        _addOpenHost(roomId);
        openTablesOf[msg.sender]++;

        emit HostRoomCreated(roomId, msg.sender, bank, hostRooms[roomId].name);
    }

    /// @notice Flip against a host table for `betAmount`. You are "heads"; the table
    ///         creator (the house) is "tails" and matches your bet from their bank.
    ///         The creator always collects the 10% rake. Settles instantly.
    function playHostRoom(uint256 roomId, uint256 betAmount, bool wantsHeads) external returns (bool playerWon) {
        HostRoom storage hr = hostRooms[roomId];
        if (hr.id == 0 || !hr.open) revert HostRoomNotOpen();
        if (msg.sender == hr.creator) revert CannotPlayOwnTable();
        if (betAmount < MIN_BET) revert BetTooSmall();
        if (betAmount > maxBet) revert BetTooHigh();
        if (hr.bank < betAmount) revert BankTooLow(); // creator must be able to cover it
        if (balances[msg.sender] < betAmount) revert InsufficientBalance();

        balances[msg.sender] -= betAmount; // your stake
        hr.bank -= betAmount; // the creator's matching stake

        uint256 pot = betAmount * 2;
        uint256 fee = (pot * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        uint256 payout = pot - fee;

        // The 10% rake is split 50/50: half to the platform (treasury / the
        // original wallet), half to the table creator hosting this game — so the
        // platform always takes ~5% of the pot and the host keeps ~5%.
        uint256 platformCut = fee / 2;
        houseBankroll += platformCut; // the platform's 5% flows into the house pool
        balances[hr.creator] += fee - platformCut;
        totalFeesCollected += platformCut;

        // Flip the coin; you win if it lands on the side you picked.
        bool headsLanded = (_random(roomId, msg.sender, hr.creator) % 2 == 0);
        playerWon = (headsLanded == wantsHeads);
        if (playerWon) {
            balances[msg.sender] += payout; // you take the pot (minus rake)
        } else {
            hr.bank += payout; // the house keeps it in the bank
        }

        hr.lastActivity = block.timestamp;
        hr.gamesPlayed += 1;
        totalGamesPlayed += 1;
        totalWagered += pot;

        emit HostFlip(roomId, msg.sender, betAmount, playerWon, playerWon ? payout : 0, fee);
    }

    /// @notice Close a host table and refund its remaining bank to the creator.
    ///         The creator may close anytime; anyone else only after HOST_TIMEOUT of
    ///         no play (so an abandoned table auto-frees the creator's funds).
    function closeHostRoom(uint256 roomId) external {
        HostRoom storage hr = hostRooms[roomId];
        if (hr.id == 0 || !hr.open) revert HostRoomNotOpen();
        if (msg.sender != hr.creator && block.timestamp < hr.lastActivity + HOST_TIMEOUT) {
            revert HostRoomStillActive();
        }
        hr.open = false;
        _removeOpenHost(roomId);
        openTablesOf[hr.creator]--;
        uint256 refund = hr.bank;
        hr.bank = 0;
        if (refund > 0) balances[hr.creator] += refund; // withdrawable, no direct send
        emit HostRoomClosed(roomId, refund);
    }

    // --------------------------------------------------------------------- //
    //  Dice game (CH 09) — same house bankroll, settles synchronously
    // --------------------------------------------------------------------- //

    /// @notice Number of winning outcomes for a target + direction.
    ///         UNDER: win if roll < target  -> `target` winning outcomes.
    ///         OVER:  win if roll > target  -> `9999 - target` winning outcomes.
    function _diceWinOutcomes(uint16 target, bool rollOver) internal pure returns (uint256) {
        return rollOver ? (DICE_OUTCOMES - 1 - target) : target;
    }

    /// @notice Payout multiplier in bps (10000 = 1.00x) = (1 - edge) / winChance.
    function _diceMultiplierBps(uint256 winOutcomes) internal view returns (uint256) {
        return ((BPS_DENOMINATOR - diceEdgeBps) * DICE_OUTCOMES) / winOutcomes;
    }

    /// @notice Roll dice for `betAmount`. `target` in [0,9999]; if `rollOver` you
    ///         win when roll > target, else when roll < target. Settles instantly
    ///         from your in-game balance vs the house bankroll. Same prevrandao
    ///         caveat as the flip (planned Chainlink VRF upgrade).
    function playDice(uint256 betAmount, uint16 target, bool rollOver)
        external
        returns (uint256 gameId, uint16 roll, bool won, uint256 payout)
    {
        if (betAmount < MIN_BET) revert BetTooSmall();
        if (betAmount > maxBet) revert BetTooHigh();
        if (target > DICE_OUTCOMES - 1) revert DiceBadTarget();

        uint256 winOutcomes = _diceWinOutcomes(target, rollOver);
        if (winOutcomes < MIN_WIN_OUTCOMES || winOutcomes > MAX_WIN_OUTCOMES) revert DiceBadTarget();
        if (balances[msg.sender] < betAmount) revert InsufficientBalance();

        uint256 multiplierBps = _diceMultiplierBps(winOutcomes);
        // A win must actually pay more than the stake; otherwise (very high win
        // chance + edge) the subtraction below would underflow-revert opaquely.
        if (multiplierBps <= BPS_DENOMINATOR) revert DiceEdgeTooHigh();
        payout = (betAmount * multiplierBps) / BPS_DENOMINATOR; // total returned on a win
        uint256 maxProfit = payout - betAmount;                 // the house's max loss
        if (maxProfit > houseBankroll) revert HouseBankrollLow();
        // a single win can't drain more than maxPayoutBpsOfBankroll of the bankroll
        if (maxProfit > (houseBankroll * maxPayoutBpsOfBankroll) / BPS_DENOMINATOR) revert HouseBankrollLow();

        balances[msg.sender] -= betAmount; // escrow the stake

        gameId = nextDiceGameId++;
        roll = uint16(_random(gameId, msg.sender, treasury) % DICE_OUTCOMES);
        won = rollOver ? (roll > target) : (roll < target);

        if (won) {
            balances[msg.sender] += payout; // stake back + winnings
            houseBankroll -= maxProfit;     // house pays the profit
        } else {
            houseBankroll += betAmount;     // house keeps the stake
        }

        diceGames[gameId] = DiceGame({
            id: gameId, player: msg.sender, betAmount: betAmount, target: target, rollOver: rollOver,
            roll: roll, won: won, payout: won ? payout : 0, multiplierBps: multiplierBps, settledAt: block.timestamp
        });
        _diceIds.push(gameId);

        totalFeesCollected += (betAmount * diceEdgeBps) / BPS_DENOMINATOR; // expected edge (stats)
        totalGamesPlayed += 1;
        totalWagered += betAmount;

        emit DiceRolled(gameId, msg.sender, betAmount, target, rollOver, roll, won, won ? payout : 0, multiplierBps);
        return (gameId, roll, won, won ? payout : 0);
    }

    function setDiceEdge(uint256 newEdgeBps) external onlyOwner {
        if (newEdgeBps > MAX_DICE_EDGE_BPS) revert DiceEdgeTooHigh();
        diceEdgeBps = newEdgeBps;
        emit DiceEdgeUpdated(newEdgeBps);
    }

    /// @notice Tune the per-roll payout cap as a share of the bankroll (bps).
    ///         10000 = 100% (capped only by the real bankroll). Can't exceed 100%.
    function setMaxPayoutCap(uint256 newBps) external onlyOwner {
        if (newBps == 0 || newBps > BPS_DENOMINATOR) revert DiceBadTarget();
        maxPayoutBpsOfBankroll = newBps;
        emit MaxPayoutCapUpdated(newBps);
    }

    function diceCount() external view returns (uint256) { return _diceIds.length; }

    function getRecentDice(uint256 limit) external view returns (DiceGame[] memory recent) {
        uint256 n = _diceIds.length;
        uint256 count = limit > n ? n : limit;
        recent = new DiceGame[](count);
        for (uint256 i; i < count; ++i) recent[i] = diceGames[_diceIds[n - 1 - i]];
    }

    // --------------------------------------------------------------------- //
    //  Dice #2 (CH 10) — two d6 dice, sum 2..12, roll under/over a target
    // --------------------------------------------------------------------- //

    /// @notice Number of equally-likely combinations (out of 36) that produce a
    ///         given two-dice sum. ways(s) = 6 - |s - 7| for s in [2,12].
    function _waysForSum(uint256 s) internal pure returns (uint256) {
        uint256 d = s > 7 ? s - 7 : 7 - s;
        return 6 - d;
    }

    /// @notice Winning combinations for a target + direction.
    ///         UNDER: win if sum < target.   OVER: win if sum > target.
    function _twoDiceWinCombos(uint8 target, bool rollOver) internal pure returns (uint256 combos) {
        if (rollOver) {
            for (uint256 s = uint256(target) + 1; s <= 12; ++s) combos += _waysForSum(s);
        } else {
            for (uint256 s = 2; s < uint256(target); ++s) combos += _waysForSum(s);
        }
    }

    /// @notice Payout multiplier in bps (10000 = 1.00x) = (1 - edge) / winChance.
    function _twoDiceMultiplierBps(uint256 winCombos) internal view returns (uint256) {
        return ((BPS_DENOMINATOR - twoDiceEdgeBps) * TWO_DICE_COMBOS) / winCombos;
    }

    /// @notice Live multiplier for the UI. Returns 0 for a degenerate target
    ///         (no winning or no losing combos).
    function twoDiceMultiplier(uint8 target, bool rollOver) external view returns (uint256) {
        if (target < 2 || target > 12) return 0;
        uint256 c = _twoDiceWinCombos(target, rollOver);
        if (c == 0 || c >= TWO_DICE_COMBOS) return 0;
        return _twoDiceMultiplierBps(c);
    }

    /// @notice Roll two six-sided dice for `betAmount`. `target` in [2,12]; if
    ///         `rollOver` you win when the sum > target, else when sum < target.
    ///         Settles instantly from your in-game balance vs the house bankroll.
    function playTwoDice(uint256 betAmount, uint8 target, bool rollOver)
        external
        returns (uint256 gameId, uint8 d1, uint8 d2, bool won, uint256 payout)
    {
        if (betAmount < MIN_BET) revert BetTooSmall();
        if (betAmount > maxBet) revert BetTooHigh();
        if (target < 2 || target > 12) revert DiceBadTarget();

        uint256 winCombos = _twoDiceWinCombos(target, rollOver);
        if (winCombos == 0 || winCombos >= TWO_DICE_COMBOS) revert DiceBadTarget();
        if (balances[msg.sender] < betAmount) revert InsufficientBalance();

        uint256 multiplierBps = _twoDiceMultiplierBps(winCombos);
        if (multiplierBps <= BPS_DENOMINATOR) revert DiceEdgeTooHigh(); // win must pay over the stake
        payout = (betAmount * multiplierBps) / BPS_DENOMINATOR; // total returned on a win
        uint256 maxProfit = payout - betAmount;                 // the house's max loss
        if (maxProfit > houseBankroll) revert HouseBankrollLow();
        if (maxProfit > (houseBankroll * maxPayoutBpsOfBankroll) / BPS_DENOMINATOR) revert HouseBankrollLow();

        balances[msg.sender] -= betAmount; // escrow the stake

        gameId = nextTwoDiceGameId++;
        uint256 r = _random(gameId, msg.sender, treasury);
        d1 = uint8((r % 6) + 1);
        d2 = uint8(((r / 6) % 6) + 1);
        uint256 sum = uint256(d1) + uint256(d2);
        won = rollOver ? (sum > target) : (sum < target);

        if (won) {
            balances[msg.sender] += payout; // stake back + winnings
            houseBankroll -= maxProfit;     // house pays the profit
        } else {
            houseBankroll += betAmount;     // house keeps the stake
        }

        twoDiceGames[gameId] = TwoDiceGame({
            id: gameId, player: msg.sender, betAmount: betAmount, target: target, rollOver: rollOver,
            d1: d1, d2: d2, won: won, payout: won ? payout : 0, multiplierBps: multiplierBps, settledAt: block.timestamp
        });
        _twoDiceIds.push(gameId);

        totalFeesCollected += (betAmount * twoDiceEdgeBps) / BPS_DENOMINATOR; // expected edge (stats)
        totalGamesPlayed += 1;
        totalWagered += betAmount;

        emit TwoDiceRolled(gameId, msg.sender, betAmount, target, rollOver, d1, d2, won, won ? payout : 0, multiplierBps);
        return (gameId, d1, d2, won, won ? payout : 0);
    }

    function setTwoDiceEdge(uint256 newEdgeBps) external onlyOwner {
        if (newEdgeBps > MAX_DICE_EDGE_BPS) revert DiceEdgeTooHigh();
        twoDiceEdgeBps = newEdgeBps;
        emit TwoDiceEdgeUpdated(newEdgeBps);
    }

    function twoDiceCount() external view returns (uint256) { return _twoDiceIds.length; }

    function getRecentTwoDice(uint256 limit) external view returns (TwoDiceGame[] memory recent) {
        uint256 n = _twoDiceIds.length;
        uint256 count = limit > n ? n : limit;
        recent = new TwoDiceGame[](count);
        for (uint256 i; i < count; ++i) recent[i] = twoDiceGames[_twoDiceIds[n - 1 - i]];
    }

    // --------------------------------------------------------------------- //
    //  Views (lobby / UI helpers)
    // --------------------------------------------------------------------- //

    function getHostRoom(uint256 roomId) external view returns (HostRoom memory) {
        return hostRooms[roomId];
    }

    function hostRoomCount() external view returns (uint256) {
        return _hostRoomIds.length;
    }

    function getOpenHostRooms() external view returns (HostRoom[] memory openTables) {
        uint256 n = _openHostRoomIds.length; // O(open), not O(all-time)
        openTables = new HostRoom[](n);
        for (uint256 i; i < n; ++i) openTables[i] = hostRooms[_openHostRoomIds[i]];
    }

    function getRoom(uint256 roomId) external view returns (Room memory) {
        return rooms[roomId];
    }

    function roomCount() external view returns (uint256) {
        return _roomIds.length;
    }

    function getOpenRooms() external view returns (Room[] memory openRooms) {
        uint256 n = _openRoomIds.length; // O(open), not O(all-time)
        openRooms = new Room[](n);
        for (uint256 i; i < n; ++i) openRooms[i] = rooms[_openRoomIds[i]];
    }

    function getRecentRooms(uint256 limit) external view returns (Room[] memory recent) {
        uint256 n = _roomIds.length;
        uint256 count = limit > n ? n : limit;
        recent = new Room[](count);
        for (uint256 i; i < count; ++i) recent[i] = rooms[_roomIds[n - 1 - i]];
    }
}
