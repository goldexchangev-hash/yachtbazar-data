// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GameRegistry
/// @notice A tiny, IMMUTABLE pointer to the site's currently-active game contract.
///         Its own address is baked into the site once and never changes; the
///         owner (the locked house wallet) flips `activeGame` with a single tx
///         after deploying a new game, and every visitor's site resolves the new
///         contract automatically on load — no code push required.
contract GameRegistry {
    address public owner;
    address public activeGame;

    event ActiveGameSet(address indexed game, address indexed by);
    event OwnerTransferred(address indexed newOwner);

    error NotOwner();

    constructor(address _owner, address _initialGame) {
        owner = _owner == address(0) ? msg.sender : _owner;
        activeGame = _initialGame;
        emit ActiveGameSet(_initialGame, msg.sender);
    }

    function setActiveGame(address game) external {
        if (msg.sender != owner) revert NotOwner();
        activeGame = game;
        emit ActiveGameSet(game, msg.sender);
    }

    function transferOwner(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
        emit OwnerTransferred(newOwner);
    }
}
