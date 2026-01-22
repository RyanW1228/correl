// contracts/src/CorrelClearinghouse.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CorrelState} from "./CorrelState.sol";
import {CorrelExecution} from "./modules/CorrelExecution.sol";

/// @notice Deployment entrypoint + composition root.
/// All business logic lives in inherited modules.
contract CorrelClearinghouse is CorrelExecution {
    /// @dev Bump on any deployed-code change (useful for explorers/scripts).
    string public constant VERSION = "Correl v0.1";

    constructor(IERC20 usdc_) CorrelState(usdc_) {}
}
