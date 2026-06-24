// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// This file exists only so Hardhat compiles the Chainlink VRF v2.5 mock,
// which we deploy on the local network (and in tests) to stand in for the
// real Chainlink oracle. It is never deployed to a public testnet.
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
