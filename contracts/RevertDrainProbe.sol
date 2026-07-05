// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./CoinFlipBetting.sol";

/// @dev Minimal probe kept from Pass 4. The on-chain settling games it used to
///      poke were RETIRED in the F5 trim, so those wrappers are gone; only the
///      escrow-funding helper remains so the contract still compiles against the
///      trimmed CoinFlipBetting.
contract RevertDrainProbe {
    CoinFlipBetting public game;

    constructor(address game_) {
        game = CoinFlipBetting(payable(game_));
    }

    receive() external payable {}

    function fund() external payable {
        game.deposit{value: msg.value}();
    }
}
