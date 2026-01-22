// contracts/src/modules/CorrelExecution.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {CorrelState, IConditionalTokens} from "../CorrelState.sol";
import {CorrelPools} from "./CorrelPools.sol";

/**
 * CorrelExecution
 * - Step 4: Execution (consume locks)
 * - Settlement of token pools via Conditional Tokens Framework (CTF)
 *
 * Execution principles:
 * - Locks reserve liquidity up-front (Step 3), then execution consumes the reservation.
 * - Swaps consume destination-pool liquidity (toAsset pool), so toAsset LPs earn:
 *   (1) reward-asset pool shares for incoming fromAsset tokens (token->token cross rewards)
 *   (2) USDC-pool shares for the swap fee (swap-fee accrual via per-pool bucket/accumulator)
 *
 * This avoids iterating LPs by using:
 * - deterministic holder addresses that temporarily own reward-pool shares, and
 * - per-earning-pool accumulators so LPs can claim on interaction.
 */
abstract contract CorrelExecution is CorrelPools {
    // ----------------------------
    // Step 4: Execution (consume locks)
    // ----------------------------

    /**
     * Executes a locked SWAP quote (A -> B):
     * - consumes the locked reservation from the toAsset pool
     * - transfers fromAsset in and toAsset out
     * - credits toAsset LPs with:
     *   - fromAsset-pool shares representing the incoming fromAsset tokens
     *   - USDC-pool shares representing the swap fee (if any)
     */
    function executeSwap(bytes32 lockId) external {
        Lock storage L = locks[lockId];
        require(L.taker != address(0), "unknown lock");
        require(!L.consumed, "closed");
        require(L.kind == LockKind.SWAP, "not swap");
        require(msg.sender == L.taker, "not taker");
        require(block.timestamp <= L.deadline, "expired");
        require(L.qty > 0, "qty=0");

        AssetInfo memory fromA = _requireAsset(L.fromAssetId);
        AssetInfo memory toA = _requireAsset(L.toAssetId);

        // Consume reservation (toAsset liquidity).
        TokenPool storage tp = tokenPool[L.toAssetId];
        require(tp.base.locked >= L.qty, "bad locked");
        unchecked {
            tp.base.locked -= L.qty;
        }

        // Transfers:
        // - taker sends fromAsset into contract custody
        // - contract sends toAsset out to the taker
        fromA.token.safeTransferFrom(
            L.taker,
            address(this),
            fromA.tokenId,
            L.qty,
            ""
        );
        toA.token.safeTransferFrom(
            address(this),
            L.taker,
            toA.tokenId,
            L.qty,
            ""
        );

        // Cross-pool migration: toAsset LPs earn fromAsset-pool shares for the incoming tokens.
        _creditIncomingTokenToEarningPoolAsShares(
            /*earningAssetId=*/ L.toAssetId,
            /*rewardAssetId=*/ L.fromAssetId,
            /*incomingQty=*/ L.qty
        );

        // Swap fee (USDC): credited only to the toAsset pool LPs as USDC-pool shares.
        if (L.feeUsdc > 0) {
            require(
                usdc.transferFrom(L.taker, address(this), L.feeUsdc),
                "fee tf failed"
            );
            _creditSwapFeeToTokenPool(L.toAssetId, L.feeUsdc);
        }

        L.consumed = true;
        emit LockConsumed(lockId);
        emit SwapExecuted(
            lockId,
            L.taker,
            L.fromAssetId,
            L.toAssetId,
            L.qty,
            L.feeUsdc
        );
    }

    /**
     * Executes a locked REDEEM quote (POS + NEG -> USDC):
     * - consumes the locked reservation from the USDC pool (net payout only)
     * - transfers both legs (POS and NEG) into contract custody
     * - credits USDC LPs with token-pool shares for the incoming legs (USDC->token cross rewards)
     * - pays net USDC to the taker
     */
    function executeRedeem(bytes32 lockId) external {
        Lock storage L = locks[lockId];
        require(L.taker != address(0), "unknown lock");
        require(!L.consumed, "closed");
        require(L.kind == LockKind.REDEEM, "not redeem");
        require(msg.sender == L.taker, "not taker");
        require(block.timestamp <= L.deadline, "expired");
        require(L.qtyPairs > 0, "pairs=0");

        AssetInfo memory posA = _requireAsset(L.posAssetId);
        AssetInfo memory negA = _requireAsset(L.negAssetId);

        // Consume reservation (net payout).
        require(usdcPool.locked >= L.netUsdc, "bad locked");
        unchecked {
            usdcPool.locked -= L.netUsdc;
        }

        // Taker sends both legs into contract custody.
        posA.token.safeTransferFrom(
            L.taker,
            address(this),
            posA.tokenId,
            L.qtyPairs,
            ""
        );
        negA.token.safeTransferFrom(
            L.taker,
            address(this),
            negA.tokenId,
            L.qtyPairs,
            ""
        );

        // USDC LPs earn token-pool shares representing the incoming redeem legs.
        _creditIncomingTokenToUsdcEarnersAsShares(L.posAssetId, L.qtyPairs);
        _creditIncomingTokenToUsdcEarnersAsShares(L.negAssetId, L.qtyPairs);

        // Pay net USDC to the taker.
        if (L.netUsdc > 0) {
            require(usdc.transfer(L.taker, L.netUsdc), "payout failed");
        }

        L.consumed = true;
        emit LockConsumed(lockId);
        emit RedeemExecuted(
            lockId,
            L.taker,
            L.posAssetId,
            L.negAssetId,
            L.qtyPairs,
            L.netUsdc,
            L.feeUsdc
        );
    }

    // ----------------------------
    // Settlement
    // ----------------------------

    /**
     * Permissionless settlement of a token pool once the underlying CTF condition resolves.
     *
     * Pattern A (v0 settlement):
     * - Redeem this contract's inventory of the position via CTF into collateral (USDC).
     * - Credit received USDC to the pool's LPs pro-rata using the same mechanism as swap fees:
     *   mint USDC-pool shares into a per-pool bucket and update the per-token-share accumulator.
     * - Mark pool as SETTLED (one-way).
     */
    function settleTokenPool(bytes32 assetId) external {
        AssetInfo memory a = _requireAsset(assetId);

        require(
            tokenPoolStatus[assetId] == TokenPoolStatus.ACTIVE,
            "not active"
        );

        // Must be resolved on CTF.
        // NOTE: This assumes `a.token` is the ConditionalTokens (CTF) contract.
        IConditionalTokens ct = IConditionalTokens(address(a.token));
        uint256 denom = ct.payoutDenominator(a.conditionId);
        require(denom != 0, "not resolved");

        // Redeem this position into collateral (USDC).
        uint256 usdcBefore = usdc.balanceOf(address(this));

        uint256[] memory indexSets = new uint256[](1);
        indexSets[0] = a.indexSet;

        ct.redeemPositions(
            a.collateralToken,
            a.parentCollectionId,
            a.conditionId,
            indexSets
        );

        uint256 usdcAfter = usdc.balanceOf(address(this));
        uint256 received = (usdcAfter > usdcBefore)
            ? (usdcAfter - usdcBefore)
            : 0;

        // Credit proceeds to this pool's LPs (via USDC-pool shares in a per-pool bucket).
        _creditUsdcProceedsToTokenPool(assetId, received);

        // Mark settled (one-way).
        tokenPoolStatus[assetId] = TokenPoolStatus.SETTLED;

        emit TokenPoolSettled(assetId, received);
    }

    // ----------------------------
    // Internals: Cross-pool migration (incoming token -> reward-pool shares)
    // ----------------------------

    /**
     * Credits an incoming token flow to an earning token pool as reward-pool shares.
     *
     * Example (swap A -> B):
     * - earningAssetId = B (LPs whose liquidity was consumed)
     * - rewardAssetId  = A (incoming tokens)
     *
     * Mechanism:
     * - mint rewardAssetId pool shares corresponding to incomingQty
     * - assign minted shares to a deterministic holder H(earningAssetId, rewardAssetId)
     * - increase an accumulator so earning-pool LPs can claim pro-rata on interaction
     */
    function _creditIncomingTokenToEarningPoolAsShares(
        bytes32 earningAssetId,
        bytes32 rewardAssetId,
        uint256 incomingQty
    ) internal {
        _requireAsset(earningAssetId);
        _requireAsset(rewardAssetId);
        require(incomingQty > 0, "qty=0");

        TokenPool storage earningPool = tokenPool[earningAssetId];
        require(earningPool.base.totalShares > 0, "no earning LPs");

        // Ensure reward asset is active so future LP interactions can sync/claim safely.
        _activateRewardAssetIfNeeded(earningAssetId, rewardAssetId);

        // Mint reward-pool shares equivalent to incomingQty.
        // Tokens already arrived, so balance-before-incoming = currentBalance - incomingQty.
        TokenPool storage rewardPool = tokenPool[rewardAssetId];
        uint256 balBeforeIncoming = tokenPoolBalance(rewardAssetId) -
            incomingQty;
        uint256 S = rewardPool.base.totalShares;

        uint256 mintedRewardPoolShares;
        if (S == 0) {
            mintedRewardPoolShares = incomingQty; // 1 share per 1 token base unit
        } else {
            require(balBeforeIncoming > 0, "bad reward bal");
            mintedRewardPoolShares = (incomingQty * S) / balBeforeIncoming;
            require(mintedRewardPoolShares > 0, "mint=0");
        }

        // Shares must exist immediately, so mint into totalShares now.
        rewardPool.base.totalShares = S + mintedRewardPoolShares;

        // Assign minted shares to the deterministic holder for (earning -> reward).
        address holder = _crossHolder(earningAssetId, rewardAssetId);
        rewardPool.base.shares[holder] += mintedRewardPoolShares;

        // Attribute holder-owned rewardPool shares to earningPool LPs via accumulator.
        CrossReward storage cr = crossReward[earningAssetId][rewardAssetId];
        cr.accRewardSharesPerEarnShare +=
            (mintedRewardPoolShares * ACC) /
            earningPool.base.totalShares;

        emit CrossPoolShareCredited(
            earningAssetId,
            rewardAssetId,
            mintedRewardPoolShares
        );
    }

    /**
     * Marks a reward asset as active for a given earning token pool.
     * Active reward assets are iterated in reward claiming/sync paths.
     */
    function _activateRewardAssetIfNeeded(
        bytes32 earningAssetId,
        bytes32 rewardAssetId
    ) internal {
        if (isActiveRewardAsset[earningAssetId][rewardAssetId]) return;
        isActiveRewardAsset[earningAssetId][rewardAssetId] = true;
        activeRewardAssets[earningAssetId].push(rewardAssetId);
    }

    /**
     * Marks a reward asset as active for the USDC earning pool.
     * Active reward assets are iterated in USDC cross reward claiming/sync paths.
     */
    function _activateUsdcRewardAssetIfNeeded(bytes32 rewardAssetId) internal {
        if (usdcIsActiveRewardAsset[rewardAssetId]) return;
        usdcIsActiveRewardAsset[rewardAssetId] = true;
        usdcActiveRewardAssets.push(rewardAssetId);
    }

    /**
     * Credits an incoming token flow to USDC LPs as reward-pool shares.
     * Used when tokens arrive into custody (e.g. redeem legs on executeRedeem).
     */
    function _creditIncomingTokenToUsdcEarnersAsShares(
        bytes32 rewardAssetId,
        uint256 incomingQty
    ) internal {
        _requireAsset(rewardAssetId);
        require(incomingQty > 0, "qty=0");

        // USDC LPs must exist.
        require(usdcPool.totalShares > 0, "no usdc LPs");

        // Ensure reward asset is active so future USDC LP interactions can sync/claim safely.
        _activateUsdcRewardAssetIfNeeded(rewardAssetId);

        // Mint reward-pool shares equivalent to incomingQty.
        // Tokens already arrived, so balance-before-incoming = currentBalance - incomingQty.
        TokenPool storage rewardPool = tokenPool[rewardAssetId];
        uint256 balBeforeIncoming = tokenPoolBalance(rewardAssetId) -
            incomingQty;
        uint256 S = rewardPool.base.totalShares;

        uint256 mintedRewardPoolShares;
        if (S == 0) {
            mintedRewardPoolShares = incomingQty; // 1 share per 1 token base unit
        } else {
            require(balBeforeIncoming > 0, "bad reward bal");
            mintedRewardPoolShares = (incomingQty * S) / balBeforeIncoming;
            require(mintedRewardPoolShares > 0, "mint=0");
        }

        // Shares must exist immediately, so mint into totalShares now.
        rewardPool.base.totalShares = S + mintedRewardPoolShares;

        // Assign minted shares to the deterministic holder for (USDC -> reward token pool).
        address holder = _crossHolder(USDC_EARNING_POOL_ID, rewardAssetId);
        rewardPool.base.shares[holder] += mintedRewardPoolShares;

        // Attribute holder-owned rewardPool shares to USDC LPs via accumulator.
        CrossReward storage cr = usdcCrossReward[rewardAssetId];
        cr.accRewardSharesPerEarnShare +=
            (mintedRewardPoolShares * ACC) /
            usdcPool.totalShares;

        emit CrossPoolShareCredited(
            USDC_EARNING_POOL_ID,
            rewardAssetId,
            mintedRewardPoolShares
        );
    }

    // ----------------------------
    // Internals: Fee crediting (swap fees -> token-pool LPs only)
    // ----------------------------

    /**
     * Credits a swap fee (USDC) to a specific token pool's LPs:
     * - mints USDC-pool shares representing feeUsdc
     * - deposits those shares into the token pool's usdcShareBucket
     * - updates accUsdcSharesPerTokenShare for pro-rata claiming by token LPs
     */
    function _creditSwapFeeToTokenPool(
        bytes32 earningAssetId,
        uint256 feeUsdc
    ) internal {
        TokenPool storage p = tokenPool[earningAssetId];
        require(p.base.totalShares > 0, "no token LPs");

        // Fee already arrived, so balance-before-fee = current USDC pool balance - feeUsdc.
        uint256 balBeforeFee = usdcPoolBalance() - feeUsdc;
        uint256 S = usdcPool.totalShares;

        uint256 feeShares;
        if (S == 0) {
            feeShares = feeUsdc; // 1 share per 1 USDC base unit
        } else {
            require(balBeforeFee > 0, "bad usdc bal");
            feeShares = (feeUsdc * S) / balBeforeFee;
            require(feeShares > 0, "feeShares=0");
        }

        // Mint USDC-pool shares and earmark them for this token pool.
        usdcPool.totalShares = S + feeShares;
        p.usdcShareBucket += feeShares;

        // Update per-token-share accumulator for this pool's LPs.
        p.accUsdcSharesPerTokenShare += (feeShares * ACC) / p.base.totalShares;
    }

    /**
     * Credits arbitrary USDC proceeds (e.g. settlement redemption) to a token pool's LPs.
     * Uses the same mechanism as swap fees:
     * - mint USDC-pool shares into a per-pool bucket
     * - update accUsdcSharesPerTokenShare for pro-rata claiming
     *
     * If there are no LPs, do nothing (USDC remains globally in the USDC pool).
     */
    function _creditUsdcProceedsToTokenPool(
        bytes32 assetId,
        uint256 amountUsdc
    ) internal {
        if (amountUsdc == 0) return;

        TokenPool storage p = tokenPool[assetId];
        if (p.base.totalShares == 0) return;

        // Proceeds already arrived, so balance-before-proceeds = current USDC pool balance - amountUsdc.
        uint256 balBefore = usdcPoolBalance() - amountUsdc;
        uint256 S = usdcPool.totalShares;

        uint256 sharesMinted;
        if (S == 0) {
            sharesMinted = amountUsdc; // 1 share per 1 USDC base unit
        } else {
            require(balBefore > 0, "bad usdc bal");
            sharesMinted = (amountUsdc * S) / balBefore;
            require(sharesMinted > 0, "shares=0");
        }

        // Mint USDC-pool shares and earmark them for this token pool.
        usdcPool.totalShares = S + sharesMinted;
        p.usdcShareBucket += sharesMinted;

        // Update per-token-share accumulator for this pool's LPs.
        p.accUsdcSharesPerTokenShare +=
            (sharesMinted * ACC) /
            p.base.totalShares;
    }
}
