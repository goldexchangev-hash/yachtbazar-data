// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/// @title CoinFlipBetting
/// @notice A provably-fair two-player coin-flip betting game.
///         Randomness is supplied by Chainlink VRF v2.5 (subscription model).
///         Players deposit ETH into the contract, create or join rooms with a
///         fixed bet (capped at MAX_BET), and the winner takes the pot minus a
///         10% house fee that is credited to the treasury.
/// @dev    All settlement happens by crediting internal balances only — never
///         by making external calls inside the VRF callback — so a single
///         player can never grief or block a flip. Players withdraw on their own.
contract CoinFlipBetting is VRFConsumerBaseV2Plus {
    // --------------------------------------------------------------------- //
    //  Constants / config
    // --------------------------------------------------------------------- //

    /// @notice Minimum bet per player, in wei. Stops dust bets from draining the
    ///         VRF (LINK) subscription with no house fee. 0.0001 ETH.
    uint256 public constant MIN_BET = 0.0001 ether;

    /// @notice Maximum bet per player, in wei. Everything in this contract is
    ///         pure ETH — there are no tokens, swaps, or conversion fees of any
    ///         kind. Defaults to 0.03 ETH (~$100) but the owner/treasurer can
    ///         raise or lower it so you can wager whatever ETH you like.
    uint256 public maxBet = 0.03 ether;

    /// @notice House fee in basis points (1000 = 10%).
    uint256 public constant HOUSE_FEE_BPS = 1000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Wallet that receives the house fee. Set once at deploy time.
    address public immutable treasury;

    // Chainlink VRF v2.5 configuration.
    bytes32 public immutable keyHash;
    uint256 public immutable subscriptionId;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;
    uint32 public callbackGasLimit = 250_000;

    // --------------------------------------------------------------------- //
    //  Game state
    // --------------------------------------------------------------------- //

    enum Status {
        Open, // waiting for a second player
        Flipping, // both players in, VRF requested
        Settled, // winner decided & paid (internally)
        Cancelled // creator cancelled before anyone joined
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
        bool headsWon; // true => player1 won
        uint256 requestId;
        uint256 createdAt;
        uint256 settledAt;
        bool isHouseGame; // true => player2 is the house bankroll
    }

    uint256 public nextRoomId = 1;
    mapping(uint256 => Room) public rooms;
    uint256[] private _roomIds;
    mapping(uint256 => uint256) public requestIdToRoomId;

    /// @notice Withdrawable balance per address (deposits + winnings + fees).
    mapping(address => uint256) public balances;

    /// @notice Lifetime stats for the UI.
    uint256 public totalFeesCollected;
    uint256 public totalGamesPlayed;
    uint256 public totalWagered;

    /// @notice ETH pool that funds the house's side of "play vs house" games.
    ///         Funded by the owner/treasurer; refilled by house wins; the 10%
    ///         fee on every game still flows to the treasury wallet.
    uint256 public houseBankroll;

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
    event FlipRequested(uint256 indexed roomId, uint256 indexed requestId);
    event FlipSettled(
        uint256 indexed roomId,
        address indexed winner,
        bool headsWon,
        uint256 payout,
        uint256 fee
    );

    // --------------------------------------------------------------------- //
    //  Errors
    // --------------------------------------------------------------------- //

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

    // --------------------------------------------------------------------- //
    //  Constructor
    // --------------------------------------------------------------------- //

    constructor(
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subscriptionId,
        address _treasury
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        keyHash = _keyHash;
        subscriptionId = _subscriptionId;
        // Fall back to the deployer as the fee recipient if none is given.
        treasury = _treasury == address(0) ? msg.sender : _treasury;
    }

    // --------------------------------------------------------------------- //
    //  Bankroll: deposit / withdraw
    // --------------------------------------------------------------------- //

    /// @notice Deposit ETH into your in-contract balance.
    function deposit() external payable {
        if (msg.value == 0) revert BetIsZero();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    /// @notice Withdraw part or all of your in-contract balance.
    function withdraw(uint256 amount) external {
        uint256 bal = balances[msg.sender];
        if (amount == 0 || amount > bal) revert InsufficientBalance();
        // Checks-effects-interactions.
        balances[msg.sender] = bal - amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    /// @notice Withdraw the entire balance in one call.
    function withdrawAll() external {
        uint256 bal = balances[msg.sender];
        if (bal == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, bal, 0);
    }

    // --------------------------------------------------------------------- //
    //  Rooms: create / cancel / join
    // --------------------------------------------------------------------- //

    /// @notice Create a room and escrow your bet from your balance.
    /// @param betAmount Wager per player (<= MAX_BET).
    /// @param name      Friendly room label shown in the lobby.
    function createRoom(uint256 betAmount, string calldata name) external returns (uint256 roomId) {
        if (betAmount < MIN_BET) revert BetTooSmall();
        if (betAmount > maxBet) revert BetTooHigh();
        if (balances[msg.sender] < betAmount) revert InsufficientBalance();

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
            requestId: 0,
            createdAt: block.timestamp,
            settledAt: 0,
            isHouseGame: false
        });
        _roomIds.push(roomId);

        emit RoomCreated(roomId, msg.sender, betAmount, rooms[roomId].name);
    }

    /// @notice Creator adjusts the room's bet while it's still open (used by the
    ///         off-chain bet negotiation: once both players agree on an amount,
    ///         the creator moves the room to that amount). Escrow is topped up
    ///         or partially refunded to match. Pure ETH.
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
            balances[msg.sender] -= diff; // top up escrow
        } else if (newBet < old) {
            balances[msg.sender] += (old - newBet); // refund the difference
        }
        room.betAmount = newBet;
        emit RoomBetUpdated(roomId, newBet);
    }

    /// @notice Cancel your own still-open room and refund the escrowed bet.
    function cancelRoom(uint256 roomId) external {
        Room storage room = rooms[roomId];
        if (room.id == 0) revert UnknownRoom();
        if (room.creator != msg.sender) revert NotRoomCreator();
        if (room.status != Status.Open) revert RoomNotOpen();

        room.status = Status.Cancelled;
        balances[room.player1] += room.betAmount; // refund
        emit RoomCancelled(roomId);
    }

    /// @notice Join an open room, escrow your matching bet, and trigger the flip.
    function joinRoom(uint256 roomId) external {
        Room storage room = rooms[roomId];
        if (room.id == 0) revert UnknownRoom();
        if (room.status != Status.Open) revert RoomNotOpen();
        if (room.creator == msg.sender) revert CannotJoinOwnRoom();
        if (balances[msg.sender] < room.betAmount) revert InsufficientBalance();

        balances[msg.sender] -= room.betAmount; // escrowed in the room
        room.player2 = msg.sender;
        room.status = Status.Flipping;

        emit PlayerJoined(roomId, msg.sender);

        uint256 requestId = _requestFlip();
        room.requestId = requestId;
        requestIdToRoomId[requestId] = roomId;
        emit FlipRequested(roomId, requestId);
    }

    // --------------------------------------------------------------------- //
    //  Play vs House
    // --------------------------------------------------------------------- //

    /// @notice Owner/treasurer funds the house bankroll so visitors can play
    ///         against the house instantly. Pure ETH.
    function fundHouse() external payable onlyOwner {
        if (msg.value == 0) revert BetIsZero();
        houseBankroll += msg.value;
        emit HouseFunded(msg.value, houseBankroll);
    }

    /// @notice Owner/treasurer withdraws unused house bankroll back to wallet.
    function withdrawHouse(uint256 amount) external onlyOwner {
        if (amount == 0 || amount > houseBankroll) revert HouseBankrollLow();
        houseBankroll -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawn(amount, houseBankroll);
    }

    /// @notice Play a one-tap coin flip against the house. Your bet is matched
    ///         from the house bankroll; the winner takes the pot minus the 10%
    ///         fee, which always goes to the treasury. You are "heads" (player1).
    function playHouse(uint256 betAmount) external returns (uint256 roomId) {
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
            player1: msg.sender, // heads = you
            player2: treasury, // tails = the house
            status: Status.Flipping,
            winner: address(0),
            headsWon: false,
            requestId: 0,
            createdAt: block.timestamp,
            settledAt: 0,
            isHouseGame: true
        });
        _roomIds.push(roomId);

        emit HouseGameStarted(roomId, msg.sender, betAmount);

        uint256 requestId = _requestFlip();
        rooms[roomId].requestId = requestId;
        requestIdToRoomId[requestId] = roomId;
        emit FlipRequested(roomId, requestId);
    }

    function _requestFlip() internal returns (uint256 requestId) {
        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                // Pay the VRF fee in LINK from the subscription.
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );
    }

    // --------------------------------------------------------------------- //
    //  VRF callback: settle the flip
    // --------------------------------------------------------------------- //

    /// @dev Called by the VRF coordinator. Pure internal bookkeeping only.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 roomId = requestIdToRoomId[requestId];
        Room storage room = rooms[roomId];
        if (room.status != Status.Flipping) return; // defensive; should never happen

        bool headsWon = (randomWords[0] % 2 == 0);
        address winner = headsWon ? room.player1 : room.player2;

        uint256 pot = room.betAmount * 2;
        uint256 fee = (pot * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        uint256 payout = pot - fee;

        // The 10% fee always goes to the treasury (the host's account).
        balances[treasury] += fee;

        if (room.isHouseGame && !headsWon) {
            // House (player2) won — its winnings refill the bankroll.
            houseBankroll += payout;
        } else {
            // A human winner (PvP, or the visitor beating the house).
            balances[winner] += payout;
        }

        room.status = Status.Settled;
        room.winner = winner;
        room.headsWon = headsWon;
        room.settledAt = block.timestamp;

        totalFeesCollected += fee;
        totalGamesPlayed += 1;
        totalWagered += pot;

        emit FlipSettled(roomId, winner, headsWon, payout, fee);
    }

    // --------------------------------------------------------------------- //
    //  Owner config
    // --------------------------------------------------------------------- //

    /// @notice Owner may tune the VRF callback gas limit if needed.
    function setCallbackGasLimit(uint32 newLimit) external onlyOwner {
        if (newLimit < 100_000) revert BetIsZero(); // floor: callback must not be starved
        callbackGasLimit = newLimit;
    }

    /// @notice Safety hatch: if a VRF request never gets fulfilled (e.g. the
    ///         subscription ran out of LINK), the owner can refund a stuck
    ///         flip's escrow so funds are never permanently locked. A later
    ///         (late) fulfillment is ignored because the room is no longer
    ///         in the Flipping state.
    function refundStuckFlip(uint256 roomId) external onlyOwner {
        Room storage room = rooms[roomId];
        if (room.status != Status.Flipping) revert RoomNotOpen();
        room.status = Status.Cancelled;
        balances[room.player1] += room.betAmount;
        if (room.isHouseGame) {
            houseBankroll += room.betAmount; // return the house's matching stake
        } else {
            balances[room.player2] += room.betAmount;
        }
        emit RoomCancelled(roomId);
    }

    /// @notice Owner/treasurer may change the maximum bet (in wei). Pure ETH.
    function setMaxBet(uint256 newMaxBet) external onlyOwner {
        if (newMaxBet == 0) revert BetIsZero();
        maxBet = newMaxBet;
        emit MaxBetUpdated(newMaxBet);
    }

    // --------------------------------------------------------------------- //
    //  Views (lobby / UI helpers)
    // --------------------------------------------------------------------- //

    function getRoom(uint256 roomId) external view returns (Room memory) {
        return rooms[roomId];
    }

    function roomCount() external view returns (uint256) {
        return _roomIds.length;
    }

    /// @notice All rooms currently waiting for an opponent.
    function getOpenRooms() external view returns (Room[] memory openRooms) {
        uint256 n = _roomIds.length;
        uint256 count;
        for (uint256 i; i < n; ++i) {
            if (rooms[_roomIds[i]].status == Status.Open) count++;
        }
        openRooms = new Room[](count);
        uint256 j;
        for (uint256 i; i < n; ++i) {
            Room storage r = rooms[_roomIds[i]];
            if (r.status == Status.Open) openRooms[j++] = r;
        }
    }

    /// @notice The most recent `limit` rooms (any status), newest first — used
    ///         for the activity feed.
    function getRecentRooms(uint256 limit) external view returns (Room[] memory recent) {
        uint256 n = _roomIds.length;
        uint256 count = limit > n ? n : limit;
        recent = new Room[](count);
        for (uint256 i; i < count; ++i) {
            recent[i] = rooms[_roomIds[n - 1 - i]];
        }
    }
}
