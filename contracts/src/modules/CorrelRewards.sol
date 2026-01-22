// contracts/src/modules/CorrelRewards.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {CorrelState} from "../CorrelState.sol";

/**
 * Rewards + accounting helpers:
 * - swap-fee accrual (USDC-pool shares) for token-pool LPs
 * - token->token cross rewards (migrated token-pool shares across pools)
 * - USDC->token cross rewards (USDC LPs earn token-pool shares)
 *
 * Notes:
 * - Accrual uses the standard "accumulator + rewardDebt" pattern:
 *   pending = accrued(lpShares) - rewardDebt[lp]
 * - These functions move "shares" (not underlying tokens):
 *   - swap fees: token-pool LP -> usdcPool.shares[lp]
 *   - cross rewards: deterministic holder -> tokenPool[rewardAssetId].base.shares[lp]
 */
abstract contract CorrelRewards is CorrelState {
    // ----------------------------
    // Optional manual claims
    // ----------------------------

    /**
     * Claims pending swap-fee rewards for a token-pool LP.
     * Moves USDC-pool shares from the token pool's usdcShareBucket into usdcPool.shares[msg.sender].
     */
    function claimSwapFees(
        bytes32 assetId
    ) external returns (uint256 claimedUsdcPoolShares) {
        _requireAsset(assetId);

        TokenPool storage p = tokenPool[assetId];

        // Compute pending based on current LP token shares and pool accumulator.
        claimedUsdcPoolShares = _pendingUsdcShares(assetId, msg.sender, p);
        require(claimedUsdcPoolShares > 0, "nothing to claim");
        require(p.usdcShareBucket >= claimedUsdcPoolShares, "bucket short");

        // Debit pool bucket, credit LP in USDC pool.
        unchecked {
            p.usdcShareBucket -= claimedUsdcPoolShares;
        }
        usdcPool.shares[msg.sender] += claimedUsdcPoolShares;

        // Sync rewardDebt to current accrued so future pending math is correct.
        _syncRewardDebt(assetId, msg.sender, p);

        emit SwapFeeClaimed(assetId, msg.sender, claimedUsdcPoolShares);
    }

    /**
     * Claims all pending USDC->token cross rewards for msg.sender.
     * Does NOT change usdcPool.shares[msg.sender]; it only transfers token-pool shares
     * from deterministic holder buckets to msg.sender.
     */
    function claimUsdcCrossRewards() external {
        _autoClaimUsdcCrossRewards(msg.sender);
        _syncUsdcCrossDebts(msg.sender);
    }

    /**
     * Claims USDC->token cross rewards, restricted to a provided list of rewardAssetIds.
     * Useful when callers want deterministic gas usage or only care about some assets.
     */
    function claimUsdcCrossRewardsFor(
        bytes32[] calldata rewardAssetIds
    ) external {
        uint256 m = rewardAssetIds.length;
        require(m > 0, "empty");

        // Earnings are proportional to current USDC pool shares.
        uint256 lpEarnShares = usdcPool.shares[msg.sender];

        for (uint256 i = 0; i < m; i++) {
            bytes32 rewardAssetId = rewardAssetIds[i];
            _requireAsset(rewardAssetId);

            CrossReward storage cr = usdcCrossReward[rewardAssetId];

            // Accrued reward shares for this reward asset.
            uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) /
                ACC;
            uint256 debt = cr.rewardDebt[msg.sender];

            // Always sync debt forward (even if nothing is pending).
            if (accrued <= debt) {
                cr.rewardDebt[msg.sender] = accrued;
                continue;
            }

            uint256 pending = accrued - debt;

            // Move reward shares from the deterministic holder into the LP.
            TokenPool storage rewardPool = tokenPool[rewardAssetId];
            address holder = _crossHolder(USDC_EARNING_POOL_ID, rewardAssetId);

            require(rewardPool.base.shares[holder] >= pending, "holder short");
            unchecked {
                rewardPool.base.shares[holder] -= pending;
            }

            // NOTE: tracking of token assets lives in Pools module; keep it there.
            // If you want this behavior here, route it through an internal hook.
            rewardPool.base.shares[msg.sender] += pending;

            cr.rewardDebt[msg.sender] = accrued;
        }
    }

    // ----------------------------
    // Internals: swap-fee reward accounting (token pool -> USDC pool shares)
    // ----------------------------

    /**
     * Pending swap-fee USDC-pool shares for a token-pool LP.
     * pending = (lpTokenShares * accUsdcSharesPerTokenShare / ACC) - rewardDebt[lp]
     */
    function _pendingUsdcShares(
        bytes32 /*assetId*/,
        address lp,
        TokenPool storage p
    ) internal view returns (uint256) {
        uint256 lpTokenShares = p.base.shares[lp];
        uint256 accrued = (lpTokenShares * p.accUsdcSharesPerTokenShare) / ACC;
        uint256 debt = p.rewardDebt[lp];
        if (accrued <= debt) return 0;
        return accrued - debt;
    }

    /**
     * Syncs rewardDebt[lp] to the current accrued swap-fee amount.
     * Call after:
     * - mint/burn/transfer of token-pool shares (to prevent retroactive rewards)
     * - a claim (to zero-out pending)
     */
    function _syncRewardDebt(
        bytes32 /*assetId*/,
        address lp,
        TokenPool storage p
    ) internal {
        uint256 lpTokenShares = p.base.shares[lp];
        p.rewardDebt[lp] = (lpTokenShares * p.accUsdcSharesPerTokenShare) / ACC;
    }

    /**
     * Auto-claims swap-fee rewards for a token-pool LP.
     * Intended to be called from pool actions (deposit/withdraw/swap paths).
     */
    function _autoClaimSwapFees(
        bytes32 assetId,
        address lp,
        TokenPool storage p
    ) internal {
        uint256 pending = _pendingUsdcShares(assetId, lp, p);

        // Always sync debt forward, even if nothing is pending.
        if (pending == 0) {
            _syncRewardDebt(assetId, lp, p);
            return;
        }

        require(p.usdcShareBucket >= pending, "bucket short");
        unchecked {
            p.usdcShareBucket -= pending;
        }

        usdcPool.shares[lp] += pending;
        _syncRewardDebt(assetId, lp, p);

        emit SwapFeeClaimed(assetId, lp, pending);
    }

    // ----------------------------
    // Internals: token->token cross rewards (migrated token-pool shares)
    // ----------------------------

    /**
     * Syncs cross reward debt for an LP in an earning pool for a specific reward pool.
     * rewardDebt[lp] = lpEarnShares * accRewardSharesPerEarnShare / ACC
     */
    function _syncCrossDebt(
        bytes32 earningAssetId,
        bytes32 rewardAssetId,
        address lp
    ) internal {
        CrossReward storage cr = crossReward[earningAssetId][rewardAssetId];
        TokenPool storage ep = tokenPool[earningAssetId];

        uint256 lpEarnShares = ep.base.shares[lp];
        cr.rewardDebt[lp] =
            (lpEarnShares * cr.accRewardSharesPerEarnShare) /
            ACC;
    }

    /**
     * Auto-claims all token->token cross rewards for a token-pool LP.
     * For each active reward asset, transfers pending reward shares from the deterministic holder to lp.
     */
    function _autoClaimCrossRewards(
        bytes32 earningAssetId,
        address lp
    ) internal {
        bytes32[] storage list = activeRewardAssets[earningAssetId];
        uint256 n = list.length;
        if (n == 0) return;

        // LP earnings are proportional to their earning-pool shares.
        TokenPool storage earningPool = tokenPool[earningAssetId];
        uint256 lpEarnShares = earningPool.base.shares[lp];

        for (uint256 i = 0; i < n; i++) {
            bytes32 rewardAssetId = list[i];
            CrossReward storage cr = crossReward[earningAssetId][rewardAssetId];

            uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) /
                ACC;
            uint256 debt = cr.rewardDebt[lp];

            // Always sync debt forward.
            if (accrued <= debt) {
                cr.rewardDebt[lp] = accrued;
                continue;
            }

            uint256 pending = accrued - debt;

            TokenPool storage rewardPool = tokenPool[rewardAssetId];
            address holder = _crossHolder(earningAssetId, rewardAssetId);

            require(rewardPool.base.shares[holder] >= pending, "holder short");
            unchecked {
                rewardPool.base.shares[holder] -= pending;
            }

            rewardPool.base.shares[lp] += pending;
            cr.rewardDebt[lp] = accrued;
        }
    }

    // ----------------------------
    // Internals: USDC->token cross rewards (USDC LPs earn token-pool shares)
    // ----------------------------

    /**
     * Auto-claims all USDC->token cross rewards for a USDC LP.
     * For each rewardAssetId in usdcActiveRewardAssets:
     * - computes pending = accrued(usdcShares) - rewardDebt[lp]
     * - transfers token-pool shares from the deterministic holder to lp
     */
    function _autoClaimUsdcCrossRewards(address lp) internal {
        uint256 n = usdcActiveRewardAssets.length;
        if (n == 0) return;

        uint256 lpEarnShares = usdcPool.shares[lp];

        for (uint256 i = 0; i < n; i++) {
            bytes32 rewardAssetId = usdcActiveRewardAssets[i];
            CrossReward storage cr = usdcCrossReward[rewardAssetId];

            uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) /
                ACC;
            uint256 debt = cr.rewardDebt[lp];

            // Always sync debt forward.
            if (accrued <= debt) {
                cr.rewardDebt[lp] = accrued;
                continue;
            }

            uint256 pending = accrued - debt;

            TokenPool storage rewardPool = tokenPool[rewardAssetId];
            address holder = _crossHolder(USDC_EARNING_POOL_ID, rewardAssetId);

            require(rewardPool.base.shares[holder] >= pending, "holder short");
            unchecked {
                rewardPool.base.shares[holder] -= pending;
            }

            rewardPool.base.shares[lp] += pending;
            cr.rewardDebt[lp] = accrued;
        }
    }

    /**
     * Syncs rewardDebt for all USDC->token cross reward assets for a USDC LP.
     * Call after changing usdcPool.shares[lp] (deposit/withdraw/claim swap fees, etc.).
     */
    function _syncUsdcCrossDebts(address lp) internal {
        uint256 n = usdcActiveRewardAssets.length;
        if (n == 0) return;

        uint256 lpEarnShares = usdcPool.shares[lp];

        for (uint256 i = 0; i < n; i++) {
            bytes32 rewardAssetId = usdcActiveRewardAssets[i];
            CrossReward storage cr = usdcCrossReward[rewardAssetId];

            cr.rewardDebt[lp] =
                (lpEarnShares * cr.accRewardSharesPerEarnShare) /
                ACC;
        }
    }

    // ----------------------------
    // Internals: "auto-claim everything" + "sync everything"
    // ----------------------------

    /**
     * Auto-claims:
     * - swap-fee rewards for this token pool
     * - all token->token cross rewards earned from this token pool
     */
    function _autoClaimAll(
        bytes32 assetId,
        address lp,
        TokenPool storage p
    ) internal {
        _autoClaimSwapFees(assetId, lp, p);
        _autoClaimCrossRewards(assetId, lp);
    }

    /**
     * Syncs all reward debts for an LP for:
     * - swap-fee rewards for this token pool
     * - all token->token cross rewards earned from this token pool
     *
     * Use when LP share balances change to prevent retroactive rewards.
     */
    function _syncAllDebts(
        bytes32 assetId,
        address lp,
        TokenPool storage p
    ) internal {
        _syncRewardDebt(assetId, lp, p);

        bytes32[] storage list = activeRewardAssets[assetId];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            _syncCrossDebt(assetId, list[i], lp);
        }
    }
}
