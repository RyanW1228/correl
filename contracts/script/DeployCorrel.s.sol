// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {CorrelClearinghouse} from "../src/CorrelClearinghouse.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract DeployCorrel is Script {
    function run() external returns (CorrelClearinghouse deployed) {
        // Load env
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC");

        // For v0: set signer = deployer EOA.
        // You can later call setSigner(newSigner) from this same EOA.
        address signer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);

        deployed = new CorrelClearinghouse(IERC20(usdc));

        vm.stopBroadcast();

        console2.log("CorrelClearinghouse deployed at:", address(deployed));
        console2.log("Signer:", signer);
        console2.log("USDC:", usdc);
    }
}
