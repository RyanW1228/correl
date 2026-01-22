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
     * Registers a single binary YES/NO market in ONE transaction.
     *
     * Semantics:
     * - YES is always the position with indexSet = 1
     * - NO  is always the position with indexSet = 2
     * - The admin chooses the polarity of the YES side
     * - The NO side is automatically assigned the opposite polarity
     *
     * Notes:
     * - assetIds are admin-chosen (no on-chain derivation).
     * - Polarity is a logical role (POS/NEG) and is NOT inherently tied to YES/NO.
     */
    function registerBinaryMarketPair(
        bytes32 yesAssetId,
        bytes32 noAssetId,
        IERC1155 token,
        uint256 yesTokenId,
        uint256 noTokenId,
        bytes32 classId,
        Polarity yesPolarity,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        IERC20 collateralToken
    ) external {
        _requireAdmin();

        require(yesAssetId != bytes32(0), "yesAssetId=0");
        require(noAssetId != bytes32(0), "noAssetId=0");
        require(yesAssetId != noAssetId, "same assetId");

        require(address(token) != address(0), "token=0");
        require(address(collateralToken) != address(0), "collateral=0");

        require(!assets[yesAssetId].exists, "yes exists");
        require(!assets[noAssetId].exists, "no exists");

        require(yesTokenId != noTokenId, "same tokenId");

        require(
            yesPolarity == Polarity.POS || yesPolarity == Polarity.NEG,
            "bad yesPolarity"
        );

        Polarity noPolarity = (yesPolarity == Polarity.POS)
            ? Polarity.NEG
            : Polarity.POS;

        // YES leg (indexSet = 1)
        _registerAssetInternal(
            yesAssetId,
            token,
            yesTokenId,
            classId,
            yesPolarity,
            conditionId,
            parentCollectionId,
            collateralToken,
            1
        );

        // NO leg (indexSet = 2)
        _registerAssetInternal(
            noAssetId,
            token,
            noTokenId,
            classId,
            noPolarity,
            conditionId,
            parentCollectionId,
            collateralToken,
            2
        );
    }

    function _registerAssetInternal(
        bytes32 assetId,
        IERC1155 token,
        uint256 tokenId,
        bytes32 classId,
        Polarity polarity,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        IERC20 collateralToken,
        uint256 indexSet
    ) internal {
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
    function updateBinaryMarketPairClassAndPolarity(
        bytes32 yesAssetId,
        bytes32 noAssetId,
        bytes32 newClassId,
        Polarity newYesPolarity
    ) external {
        _requireAdmin();

        AssetInfo storage yesA = _requireAsset(yesAssetId);
        AssetInfo storage noA = _requireAsset(noAssetId);

        require(yesAssetId != noAssetId, "same assetId");
        require(
            newYesPolarity == Polarity.POS || newYesPolarity == Polarity.NEG,
            "bad yesPolarity"
        );

        // Safety: ensure these are actually the two legs of the same market.
        require(yesA.conditionId == noA.conditionId, "condition mismatch");
        require(
            yesA.parentCollectionId == noA.parentCollectionId,
            "collection mismatch"
        );
        require(
            yesA.collateralToken == noA.collateralToken,
            "collateral mismatch"
        );
        require(address(yesA.token) == address(noA.token), "token mismatch");

        // For binary CTF positions, enforce YES indexSet=1 and NO indexSet=2.
        require(yesA.indexSet == 1, "yes indexSet != 1");
        require(noA.indexSet == 2, "no indexSet != 2");

        Polarity newNoPolarity = (newYesPolarity == Polarity.POS)
            ? Polarity.NEG
            : Polarity.POS;

        // Update classId + polarities atomically.
        yesA.classId = newClassId;
        yesA.polarity = newYesPolarity;

        noA.classId = newClassId;
        noA.polarity = newNoPolarity;
    }
}
