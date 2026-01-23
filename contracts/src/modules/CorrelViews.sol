// contracts/src/modules/CorrelViews.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {CorrelState} from "../CorrelState.sol";
import {CorrelRewards} from "./CorrelRewards.sol";

abstract contract CorrelViews is CorrelRewards {
    // ----------------------------
    // Views
    // ----------------------------

    /**
     * Returns a summary of an LP's positions:
     * - USDC pool shares and currently withdrawable USDC
     * - Token pool shares and currently withdrawable token qty (ACTIVE pools only)
     */
    function lpPositions(
        address lp
    )
        external
        view
        returns (
            uint256 usdcShares,
            uint256 usdcWithdrawable,
            bytes32[] memory assetIds,
            AssetStatus[] memory assetStatuses,
            uint256[] memory tokenShares,
            uint256[] memory tokenWithdrawableQty
        )
    {
        // USDC side
        usdcShares = usdcPool.shares[lp];
        {
            uint256 B = usdcPoolBalance();
            uint256 S = usdcPool.totalShares;
            uint256 amountOut = (S == 0) ? 0 : (usdcShares * B) / S;

            uint256 available = (B > usdcPool.locked)
                ? (B - usdcPool.locked)
                : 0;
            usdcWithdrawable = (amountOut <= available) ? amountOut : 0;
        }

        // Token side (ACTIVE pools only)
        bytes32[] storage tracked = lpTokenAssets[lp];

        // Pass 1: count ACTIVE pools
        uint256 activeCount = 0;
        for (uint256 i = 0; i < tracked.length; i++) {
            if (tokenPoolStatus[tracked[i]] == TokenPoolStatus.ACTIVE) {
                activeCount++;
            }
        }

        // Allocate outputs to activeCount
        assetIds = new bytes32[](activeCount);
        assetStatuses = new AssetStatus[](activeCount);
        tokenShares = new uint256[](activeCount);
        tokenWithdrawableQty = new uint256[](activeCount);

        // Pass 2: fill outputs
        uint256 k = 0;
        for (uint256 i = 0; i < tracked.length; i++) {
            bytes32 assetId = tracked[i];
            if (tokenPoolStatus[assetId] != TokenPoolStatus.ACTIVE) continue;

            TokenPool storage p = tokenPool[assetId];

            uint256 s = p.base.shares[lp];
            assetIds[k] = assetId;
            assetStatuses[k] = assets[assetId].status;
            tokenShares[k] = s;

            if (s == 0) {
                tokenWithdrawableQty[k] = 0;
                k++;
                continue;
            }

            uint256 B = tokenPoolBalance(assetId);
            uint256 S = p.base.totalShares;

            uint256 qtyOut = (S == 0) ? 0 : (s * B) / S;
            uint256 available = (B > p.base.locked) ? (B - p.base.locked) : 0;

            tokenWithdrawableQty[k] = (qtyOut <= available) ? qtyOut : 0;
            k++;
        }
    }

    /**
     * Pending (unclaimed) USDC->token cross rewards for a USDC LP.
     * Returns one entry per rewardAssetId in usdcActiveRewardAssets.
     */
    function usdcCrossPendingAll(
        address lp
    )
        external
        view
        returns (
            bytes32[] memory rewardAssetIds,
            uint256[] memory pendingShares
        )
    {
        uint256 n = usdcActiveRewardAssets.length;
        rewardAssetIds = new bytes32[](n);
        pendingShares = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            bytes32 r = usdcActiveRewardAssets[i];
            rewardAssetIds[i] = r;
            pendingShares[i] = _pendingUsdcCrossRewardShares(r, lp);
        }
    }

    /**
     * Pending (unclaimed) token->token cross rewards for a token LP in an earning pool.
     * Returns one entry per rewardAssetId in activeRewardAssets[earningAssetId].
     */
    function tokenCrossPendingAll(
        bytes32 earningAssetId,
        address lp
    )
        external
        view
        returns (
            bytes32[] memory rewardAssetIds,
            uint256[] memory pendingShares
        )
    {
        _requireAsset(earningAssetId);

        bytes32[] storage list = activeRewardAssets[earningAssetId];
        uint256 n = list.length;

        rewardAssetIds = new bytes32[](n);
        pendingShares = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            bytes32 r = list[i];
            rewardAssetIds[i] = r;
            pendingShares[i] = _pendingCrossRewardShares(earningAssetId, r, lp);
        }
    }

    // ----------------------------
    // USDC pool views
    // ----------------------------

    function usdcPoolSharesOf(address lp) external view returns (uint256) {
        return usdcPool.shares[lp];
    }

    function usdcPoolTotalShares() external view returns (uint256) {
        return usdcPool.totalShares;
    }

    function usdcPoolLocked() external view returns (uint256) {
        return usdcPool.locked;
    }

    function usdcPoolBalance() public view returns (uint256) {
        // All USDC held by this contract is treated as USDC pool liquidity.
        return usdc.balanceOf(address(this));
    }

    // ----------------------------
    // Token pool views
    // ----------------------------

    function tokenPoolSharesOf(
        bytes32 assetId,
        address lp
    ) external view returns (uint256) {
        return tokenPool[assetId].base.shares[lp];
    }

    function tokenPoolTotalShares(
        bytes32 assetId
    ) external view returns (uint256) {
        return tokenPool[assetId].base.totalShares;
    }

    function tokenPoolLocked(bytes32 assetId) external view returns (uint256) {
        return tokenPool[assetId].base.locked;
    }

    function tokenPoolUsdcShareBucket(
        bytes32 assetId
    ) external view returns (uint256) {
        return tokenPool[assetId].usdcShareBucket;
    }

    function tokenPoolAccUsdcSharesPerTokenShare(
        bytes32 assetId
    ) external view returns (uint256) {
        return tokenPool[assetId].accUsdcSharesPerTokenShare;
    }

    function pendingSwapFeeUsdcShares(
        bytes32 assetId,
        address lp
    ) external view returns (uint256) {
        _requireAsset(assetId);
        return _pendingUsdcShares(assetId, lp);
    }

    function lpTokenAssetsOf(
        address lp
    ) external view returns (bytes32[] memory) {
        return lpTokenAssets[lp];
    }

    // ----------------------------
    // Cross-migration views
    // ----------------------------

    function activeRewardAssetsFor(
        bytes32 earningAssetId
    ) external view returns (bytes32[] memory) {
        return activeRewardAssets[earningAssetId];
    }

    function pendingCrossRewardPoolShares(
        bytes32 earningAssetId,
        bytes32 rewardAssetId,
        address lp
    ) external view returns (uint256) {
        _requireAsset(earningAssetId);
        _requireAsset(rewardAssetId);
        return _pendingCrossRewardShares(earningAssetId, rewardAssetId, lp);
    }

    function pendingUsdcCrossRewardPoolShares(
        bytes32 rewardAssetId,
        address lp
    ) external view returns (uint256) {
        _requireAsset(rewardAssetId);
        return _pendingUsdcCrossRewardShares(rewardAssetId, lp);
    }

    function tokenPoolBalance(bytes32 assetId) public view returns (uint256) {
        AssetInfo memory a = _requireAsset(assetId);
        return a.token.balanceOf(address(this), a.tokenId);
    }

    // ----------------------------
    // Internal view helpers
    // ----------------------------

    function _pendingUsdcShares(
        bytes32 assetId,
        address lp
    ) internal view returns (uint256) {
        TokenPool storage p = tokenPool[assetId];
        return _pendingUsdcShares(assetId, lp, p);
    }

    function _pendingCrossRewardShares(
        bytes32 earningAssetId,
        bytes32 rewardAssetId,
        address lp
    ) internal view returns (uint256) {
        CrossReward storage cr = crossReward[earningAssetId][rewardAssetId];
        TokenPool storage ep = tokenPool[earningAssetId];

        uint256 lpEarnShares = ep.base.shares[lp];
        uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) / ACC;
        uint256 debt = cr.rewardDebt[lp];
        if (accrued <= debt) return 0;
        return accrued - debt;
    }

    function _pendingUsdcCrossRewardShares(
        bytes32 rewardAssetId,
        address lp
    ) internal view returns (uint256) {
        CrossReward storage cr = usdcCrossReward[rewardAssetId];

        uint256 lpEarnShares = usdcPool.shares[lp];
        uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) / ACC;
        uint256 debt = cr.rewardDebt[lp];
        if (accrued <= debt) return 0;
        return accrued - debt;
    }
}
