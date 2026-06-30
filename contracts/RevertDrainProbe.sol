// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./CoinFlipBetting.sol";

/// @dev Minimal probe for Pass 4 — confirms _betGuard blocks contract callers.
contract RevertDrainProbe {
    CoinFlipBetting public game;

    constructor(address game_) {
        game = CoinFlipBetting(payable(game_));
    }

    receive() external payable {}

    function fund() external payable {
        game.deposit{value: msg.value}();
    }

    function tryPlayHouse(uint256 bet, bool wantsHeads) external {
        game.playHouse(bet, wantsHeads);
    }

    function tryPlayDice(uint256 bet, uint16 target, bool rollOver) external {
        game.playDice(bet, target, rollOver);
    }
}
