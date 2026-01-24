// contracts/src/modules/CorrelPools.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {CorrelLocks} from "./CorrelLocks.sol";

/**
 * CorrelPools
 * - Step 2: LP deposit/withdraw for the USDC pool and per-asset token pools
 * - withdrawAll and settled-pool exit mechanics
 * - LP token-asset enumeration helpers (track/untrack assetIds with positions)
 *
 * Notes:
 * - Share minting uses the standard pro-rata rule:
 *   - if S == 0: shares = amount (1 share per 1 base unit)
 *   - else: shares = amount * S / poolBalanceBefore
 * - Rewards must be handled around share balance changes:
 *   - auto-claim BEFORE shares change (prevents retroactive claims)
 *   - sync reward debts AFTER shares change (keeps pending math correct)
 */
abstract contract CorrelPools is CorrelLocks {
    // ----------------------------
    // Step 2: LP deposit/withdraw — USDC pool
    // ----------------------------

    /**
     * Deposits USDC into the USDC pool and mints USDC-pool shares.
     * Auto-claims USDC->token cross rewards before share balance changes, then syncs debts after.
     */
    function depositUsdc(
        uint256 amount
    ) external returns (uint256 sharesMinted) {
        require(amount > 0, "amt=0");

        // Auto-claim USDC->token cross rewards BEFORE share balance changes.
        _autoClaimUsdcCrossRewards(msg.sender);

        uint256 balBefore = usdcPoolBalance();
        uint256 S = usdcPool.totalShares;

        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "usdc tf failed"
        );

        // Mint shares pro-rata to existing pool size.
        if (S == 0) {
            sharesMinted = amount; // 1 share per 1 USDC base unit
        } else {
            require(balBefore > 0, "bad pool bal");
            sharesMinted = (amount * S) / balBefore;
            require(sharesMinted > 0, "mint=0");
        }

        usdcPool.totalShares = S + sharesMinted;
        usdcPool.shares[msg.sender] += sharesMinted;

        // Sync debts AFTER share balance changes.
        _syncUsdcCrossDebts(msg.sender);

        emit DepositedUsdc(msg.sender, amount, sharesMinted);
    }

    /**
     * Burns USDC-pool shares for msg.sender and withdraws the corresponding USDC amount.
     */
    function withdrawUsdc(
        uint256 sharesBurned
    ) external returns (uint256 amountOut) {
        return _withdrawUsdcFor(msg.sender, sharesBurned);
    }

    /**
     * Shared withdraw implementation (used by withdrawAll and other internals).
     */
    function _withdrawUsdcFor(
        address lp,
        uint256 sharesBurned
    ) internal returns (uint256 amountOut) {
        require(sharesBurned > 0, "shares=0");

        // Auto-claim USDC->token cross rewards BEFORE share balance changes.
        _autoClaimUsdcCrossRewards(lp);

        uint256 userShares = usdcPool.shares[lp];
        require(userShares >= sharesBurned, "insufficient shares");

        uint256 B = usdcPoolBalance();
        uint256 S = usdcPool.totalShares;
        require(S > 0, "no shares");

        // Compute pro-rata USDC redemption.
        amountOut = (sharesBurned * B) / S;
        require(amountOut > 0, "out=0");

        // Enforce lock: only withdraw from the unlocked portion of the pool.
        uint256 available = (B > usdcPool.locked) ? (B - usdcPool.locked) : 0;
        require(amountOut <= available, "locked");

        // Burn shares (effects before transfer).
        unchecked {
            usdcPool.shares[lp] = userShares - sharesBurned;
            usdcPool.totalShares = S - sharesBurned;
        }

        // Sync debts AFTER share balance changes.
        _syncUsdcCrossDebts(lp);

        require(usdc.transfer(lp, amountOut), "usdc transfer failed");
        emit WithdrawnUsdc(lp, sharesBurned, amountOut);
    }

    // ----------------------------
    // Step 2: LP deposit/withdraw — Token pools (per assetId)
    // Includes auto-claim of:
    //  - swap-fee entitlements (USDC-pool shares)
    //  - token->token cross rewards (migrated reward-pool shares)
    // ----------------------------

    /**
     * Deposits ERC-1155 outcome tokens for a given assetId and mints token-pool shares.
     * Auto-claims all entitlements before share changes, then syncs debts after.
     */
    function depositToken(
        bytes32 assetId,
        uint256 qty
    ) external returns (uint256 sharesMinted) {
        require(qty > 0, "qty=0");
        require(
            tokenPoolStatus[assetId] == TokenPoolStatus.ACTIVE,
            "pool settled"
        );

        AssetInfo memory a = _requireAsset(assetId);

        require(a.status == AssetStatus.ACTIVE, "asset disabled");
        TokenPool storage p = tokenPool[assetId];

        // Auto-claim ALL entitlements BEFORE share balance changes.
        _autoClaimAll(assetId, msg.sender, p);

        uint256 balBefore = tokenPoolBalance(assetId);
        uint256 S = p.base.totalShares;

        a.token.safeTransferFrom(msg.sender, address(this), a.tokenId, qty, "");

        // Mint shares pro-rata to existing pool size.
        if (S == 0) {
            sharesMinted = qty; // 1 share per 1 token base unit
        } else {
            require(balBefore > 0, "bad pool bal");
            sharesMinted = (qty * S) / balBefore;
            require(sharesMinted > 0, "mint=0");
        }

        p.base.totalShares = S + sharesMinted;
        p.base.shares[msg.sender] += sharesMinted;

        // Track this asset so views/withdrawAll can enumerate positions later.
        _trackLpTokenAsset(msg.sender, assetId);

        // Sync debts AFTER share balance changes.
        _syncAllDebts(assetId, msg.sender, p);

        emit DepositedToken(assetId, msg.sender, qty, sharesMinted);
    }

    /**
     * Burns token-pool shares for msg.sender and withdraws the corresponding ERC-1155 qty.
     */
    function withdrawToken(
        bytes32 assetId,
        uint256 sharesBurned
    ) external returns (uint256 qtyOut) {
        return _withdrawTokenFor(msg.sender, assetId, sharesBurned);
    }

    /**
     * Shared withdraw implementation (used by withdrawAll and other internals).
     */
    function _withdrawTokenFor(
        address lp,
        bytes32 assetId,
        uint256 sharesBurned
    ) internal returns (uint256 qtyOut) {
        require(sharesBurned > 0, "shares=0");

        AssetInfo memory a = _requireAsset(assetId);
        TokenPool storage p = tokenPool[assetId];

        // Auto-claim ALL entitlements BEFORE share balance changes.
        _autoClaimAll(assetId, lp, p);

        uint256 userShares = p.base.shares[lp];
        require(userShares >= sharesBurned, "insufficient shares");

        uint256 B = tokenPoolBalance(assetId);
        uint256 S = p.base.totalShares;
        require(S > 0, "no shares");

        // Compute pro-rata token redemption.
        qtyOut = (sharesBurned * B) / S;
        require(qtyOut > 0, "out=0");

        // Enforce lock: only withdraw from the unlocked portion of the pool.
        uint256 available = B - p.base.locked;
        require(qtyOut <= available, "locked");

        // Burn shares (effects before transfer).
        unchecked {
            p.base.shares[lp] = userShares - sharesBurned;
            p.base.totalShares = S - sharesBurned;
        }

        // If fully exited, stop tracking this assetId for enumeration.
        if (p.base.shares[lp] == 0) {
            _untrackLpTokenAsset(lp, assetId);
        }

        // Sync debts AFTER share balance changes.
        _syncAllDebts(assetId, lp, p);

        a.token.safeTransferFrom(address(this), lp, a.tokenId, qtyOut, "");
        emit WithdrawnToken(assetId, lp, sharesBurned, qtyOut);
    }

    // ----------------------------
    // Settled-pool exit
    // ----------------------------

    /**
     * Exits a SETTLED token pool "as if it's gone":
     * - auto-claims any owed swap-fee/settlement USDC-share rewards and token cross rewards
     * - burns the LP's token-pool shares (no ERC-1155 transfer)
     * - untracks the assetId so it disappears from lpPositions / withdrawAll
     *
     * Expected usage:
     * - after settlement, token pools are expected to hold ~0 ERC-1155 balance,
     *   and proceeds are distributed via swap-fee style accounting into USDC shares.
     */
    function exitSettledTokenPool(bytes32 assetId) external {
        _exitSettledTokenPoolFor(msg.sender, assetId);
    }

    function _exitSettledTokenPoolFor(address lp, bytes32 assetId) internal {
        _requireAsset(assetId);

        require(
            tokenPoolStatus[assetId] == TokenPoolStatus.SETTLED,
            "not settled"
        );

        TokenPool storage p = tokenPool[assetId];

        uint256 userShares = p.base.shares[lp];
        if (userShares == 0) {
            // Nothing to burn; ensure enumeration is clean.
            _untrackLpTokenAsset(lp, assetId);
            return;
        }

        // Claim everything FIRST (settlement proceeds distribute via usdcShareBucket/accumulators).
        _autoClaimAll(assetId, lp, p);

        // Burn their shares (no ERC-1155 transfer).
        require(p.base.totalShares >= userShares, "bad totalShares");
        unchecked {
            p.base.shares[lp] = 0;
            p.base.totalShares -= userShares;
        }

        // Remove from enumeration so the position "disappears".
        _untrackLpTokenAsset(lp, assetId);

        // After share balance changes, sync debts (sets debts to the current accrued baseline).
        _syncAllDebts(assetId, lp, p);
    }

    // ----------------------------
    // withdrawAll
    // ----------------------------

    /**
     * Best-effort full exit:
     * 1) Claim USDC->token cross rewards first so token positions are realized as token-pool shares
     * 2) Withdraw all token positions (ACTIVE), or exit settled pools (SETTLED), and cleanup (DORMANT)
     * 3) Withdraw all USDC shares
     */
    function withdrawAll() external {
        // 1) Realize USDC->token cross rewards into token-pool shares first.
        _autoClaimUsdcCrossRewards(msg.sender);
        _syncUsdcCrossDebts(msg.sender);

        // 2) Snapshot list because withdrawals will mutate/untrack.
        bytes32[] memory list = lpTokenAssets[msg.sender];

        // 3) Exit token pools using the full current share balances.
        for (uint256 i = 0; i < list.length; i++) {
            bytes32 assetId = list[i];
            uint256 s = tokenPool[assetId].base.shares[msg.sender];
            if (s == 0) continue;

            TokenPoolStatus st = tokenPoolStatus[assetId];

            if (st == TokenPoolStatus.ACTIVE) {
                _withdrawTokenFor(msg.sender, assetId, s);
            } else if (st == TokenPoolStatus.SETTLED) {
                // Burn shares + untrack, no token transfer.
                _exitSettledTokenPoolFor(msg.sender, assetId);
            } else {
                // DORMANT: treat as gone (best-effort cleanup).
                _untrackLpTokenAsset(msg.sender, assetId);
            }
        }

        // 4) Withdraw all USDC shares last.
        uint256 us = usdcPool.shares[msg.sender];
        if (us > 0) {
            _withdrawUsdcFor(msg.sender, us);
        }
    }

    // ----------------------------
    // Internals: LP token-asset enumeration
    // ----------------------------

    /**
     * Tracks an assetId for lp if not already tracked.
     * Uses index+1 mapping so "0" can mean "not tracked".
     */
    function _trackLpTokenAsset(address lp, bytes32 assetId) internal {
        if (lpTokenAssetIndexPlus1[lp][assetId] != 0) return; // already tracked
        lpTokenAssets[lp].push(assetId);
        lpTokenAssetIndexPlus1[lp][assetId] = lpTokenAssets[lp].length; // index+1
    }

    /**
     * Untracks an assetId for lp using swap-and-pop.
     * Safe to call even if not tracked.
     */
    function _untrackLpTokenAsset(address lp, bytes32 assetId) internal {
        uint256 idxPlus1 = lpTokenAssetIndexPlus1[lp][assetId];
        if (idxPlus1 == 0) return; // not tracked

        uint256 idx = idxPlus1 - 1;
        uint256 lastIdx = lpTokenAssets[lp].length - 1;

        if (idx != lastIdx) {
            bytes32 lastAssetId = lpTokenAssets[lp][lastIdx];
            lpTokenAssets[lp][idx] = lastAssetId;
            lpTokenAssetIndexPlus1[lp][lastAssetId] = idx + 1;
        }

        lpTokenAssets[lp].pop();
        lpTokenAssetIndexPlus1[lp][assetId] = 0;
    }
}
