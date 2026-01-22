// contracts/src/modules/CorrelAdmin.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155.sol";

import {CorrelState} from "../CorrelState.sol";
import {CorrelViews} from "./CorrelViews.sol";

/**
 * CorrelAdmin
 * - Admin-gated operations live here.
 * - Asset registry writes live here (register assets, fix class/polarity metadata).
 *
 * Notes:
 * - The deployed entrypoint is CorrelClearinghouse; it inherits this module chain.
 * - assetId is provided by admin (no derivation/guessing on-chain).
 */
abstract contract CorrelAdmin is CorrelViews {
    // ----------------------------
    // Admin gating
    // ----------------------------

    /**
     * Reverts unless msg.sender is the current admin.
     */
    function _requireAdmin() internal view {
        require(msg.sender == admin, "not admin");
    }

    // ----------------------------
    // Admin ops
    // ----------------------------

    /**
     * Updates the admin address.
     */
    function setAdmin(address newAdmin) external {
        _requireAdmin();
        require(newAdmin != address(0), "admin=0");
        admin = newAdmin;
        emit AdminUpdated(newAdmin);
    }

    // ----------------------------
    // Asset registry ops
    // ----------------------------

    /**
     * Registers an ERC-1155 position token into Correl as an assetId.
     *
     * Intended usage:
     * - token/tokenId: the ERC-1155 contract + token id representing the position
     * - classId/polarity: equivalence class metadata used for swaps/redeems
     * - settlement fields (conditionId/parentCollectionId/collateralToken/indexSet):
     *   stored so settlement can validate resolution and call CTF redeemPositions.
     *
     * Requirements:
     * - assetId is chosen by admin and must be unique and non-zero.
     * - token and collateralToken must be non-zero addresses.
     */
    function registerAsset(
        bytes32 assetId,
        IERC1155 token,
        uint256 tokenId,
        bytes32 classId,
        Polarity polarity,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        IERC20 collateralToken,
        uint256 indexSet
    ) external {
        _requireAdmin();

        require(assetId != bytes32(0), "assetId=0");
        require(address(token) != address(0), "token=0");
        require(address(collateralToken) != address(0), "collateral=0");
        require(!assets[assetId].exists, "asset exists");

        AssetInfo storage A = assets[assetId];

        A.token = token;
        A.tokenId = tokenId;
        A.classId = classId;
        A.polarity = polarity;
        A.exists = true;

        // Settlement metadata (CTF-compatible fields).
        A.conditionId = conditionId;
        A.parentCollectionId = parentCollectionId;
        A.collateralToken = collateralToken;
        A.indexSet = indexSet;

        emit AssetRegistered(
            assetId,
            address(token),
            tokenId,
            classId,
            polarity
        );
    }

    /**
     * Updates equivalence metadata (classId/polarity) for an already-registered asset.
     * Does NOT modify settlement metadata (conditionId/collection/collateral/indexSet).
     *
     * Use this to correct mapping mistakes without re-registering the asset.
     */
    function updateAssetClassAndPolarity(
        bytes32 assetId,
        bytes32 newClassId,
        Polarity newPolarity
    ) external {
        _requireAdmin();

        AssetInfo storage A = _requireAsset(assetId);
        A.classId = newClassId;
        A.polarity = newPolarity;

        // No event (keeping minimal). Add one later if you want an on-chain audit trail.
    }
}
