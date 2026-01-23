// contracts/src/modules/CorrelLocks.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {CorrelAdmin} from "./CorrelAdmin.sol";

/**
 * CorrelLocks
 * - Step 3: Quote locking (reserve liquidity) + expiry/release
 *
 * Lock types:
 * - SWAP: reserves qty of ERC-1155 liquidity from the destination token pool
 * - REDEEM: reserves netUsdc from the USDC pool for POS+NEG redemption payout
 *
 * Assumes the following are defined in inherited state (via CorrelAdmin -> CorrelViews -> CorrelState):
 * - structs/enums: Lock, LockKind, TokenPool, TokenPoolStatus, AssetInfo, Polarity
 * - storage: locks, tokenPool, tokenPoolStatus, usdcPool
 * - constants: MAX_LOCK_DURATION
 * - helpers: _feeFromNotional, _requireAsset, tokenPoolBalance, usdcPoolBalance
 * - events: QuoteLocked, LockExpired
 */
abstract contract CorrelLocks is CorrelAdmin {
    // ----------------------------
    // Step 3: Quote locking (reserve liquidity)
    // ----------------------------

    /**
     * Locks liquidity for a swap quote:
     * - validates asset compatibility (same classId + same polarity)
     * - reserves qty from the toAsset token pool by increasing tp.base.locked
     *
     * lockId must be unique and non-zero. deadline must be within MAX_LOCK_DURATION.
     */
    function lockSwap(
        bytes32 lockId,
        bytes32 fromAssetId,
        bytes32 toAssetId,
        uint256 qty,
        uint256 feeUsdc,
        uint256 deadline
    ) external {
        require(lockId != bytes32(0), "lockId=0");
        require(locks[lockId].taker == address(0), "lock exists");
        require(qty > 0, "qty=0");

        // Fee is derived deterministically from notional (qty).
        uint256 expectedFee = _feeFromNotional(qty);
        require(feeUsdc == expectedFee, "bad fee");

        // Deadline bounds (prevents long-lived reserve griefing).
        require(deadline >= block.timestamp, "deadline<now");
        require(
            deadline <= block.timestamp + MAX_LOCK_DURATION,
            "deadline too far"
        );

        address taker = msg.sender;

        AssetInfo memory fromA = _requireAsset(fromAssetId);
        AssetInfo memory toA = _requireAsset(toAssetId);

        require(fromA.status == AssetStatus.ACTIVE, "from asset disabled");
        require(toA.status == AssetStatus.ACTIVE, "to asset disabled");

        require(
            tokenPoolStatus[toAssetId] == TokenPoolStatus.ACTIVE,
            "to pool settled"
        );

        require(
            tokenPoolStatus[fromAssetId] == TokenPoolStatus.ACTIVE,
            "from pool settled"
        );

        // Swap only allowed within the same equivalence class and polarity.
        require(fromAssetId != toAssetId, "same asset");
        require(fromA.classId == toA.classId, "class mismatch");
        require(fromA.polarity == toA.polarity, "polarity mismatch");

        // Reserve liquidity from the destination pool (toAsset).
        TokenPool storage tp = tokenPool[toAssetId];
        uint256 B = tokenPoolBalance(toAssetId);
        uint256 available = B - tp.base.locked;
        require(qty <= available, "insufficient liquidity");

        tp.base.locked += qty;

        // Persist lock details for later consume/expire paths.
        locks[lockId] = Lock({
            kind: LockKind.SWAP,
            taker: taker,
            deadline: deadline,
            consumed: false,
            fromAssetId: fromAssetId,
            toAssetId: toAssetId,
            qty: qty,
            posAssetId: bytes32(0),
            negAssetId: bytes32(0),
            qtyPairs: 0,
            netUsdc: 0,
            feeUsdc: feeUsdc
        });

        emit QuoteLocked(lockId, LockKind.SWAP, taker, deadline);
    }

    /**
     * Locks liquidity for a redeem quote (POS+NEG -> USDC):
     * - validates class match and required polarities
     * - computes expected fee and net payout
     * - reserves netUsdc from the USDC pool by increasing usdcPool.locked
     *
     * lockId must be unique and non-zero. deadline must be within MAX_LOCK_DURATION.
     */
    function lockRedeem(
        bytes32 lockId,
        bytes32 posAssetId,
        bytes32 negAssetId,
        uint256 qtyPairs,
        uint256 netUsdc,
        uint256 feeUsdc,
        uint256 deadline
    ) external {
        require(lockId != bytes32(0), "lockId=0");
        require(locks[lockId].taker == address(0), "lock exists");
        require(qtyPairs > 0, "pairs=0");

        // Deadline bounds (prevents long-lived reserve griefing).
        require(deadline >= block.timestamp, "deadline<now");
        require(
            deadline <= block.timestamp + MAX_LOCK_DURATION,
            "deadline too far"
        );

        address taker = msg.sender;

        AssetInfo memory posA = _requireAsset(posAssetId);
        AssetInfo memory negA = _requireAsset(negAssetId);

        require(posA.status == AssetStatus.ACTIVE, "pos asset disabled");
        require(negA.status == AssetStatus.ACTIVE, "neg asset disabled");

        // Redeem requires matching classId and opposite polarities (one POS and one NEG).
        require(posAssetId != negAssetId, "same asset");
        require(posA.classId == negA.classId, "class mismatch");
        require(posA.polarity != negA.polarity, "polarity not opposite");

        // Fee/net are derived deterministically from notional (qtyPairs).
        uint256 expectedFee = _feeFromNotional(qtyPairs);
        require(feeUsdc == expectedFee, "bad fee");
        require(netUsdc == qtyPairs - expectedFee, "bad net");

        // Reserve liquidity from the USDC pool (net payout only).
        uint256 B = usdcPoolBalance();
        uint256 available = B - usdcPool.locked;
        require(netUsdc <= available, "insufficient usdc");

        usdcPool.locked += netUsdc;

        // Persist lock details for later consume/expire paths.
        locks[lockId] = Lock({
            kind: LockKind.REDEEM,
            taker: taker,
            deadline: deadline,
            consumed: false,
            fromAssetId: bytes32(0),
            toAssetId: bytes32(0),
            qty: 0,
            posAssetId: posAssetId,
            negAssetId: negAssetId,
            qtyPairs: qtyPairs,
            netUsdc: netUsdc,
            feeUsdc: feeUsdc
        });

        emit QuoteLocked(lockId, LockKind.REDEEM, taker, deadline);
    }

    /**
     * Expires an unconsumed lock after its deadline and releases reserved liquidity.
     * Anyone may call this; only time and lock state gate the action.
     */
    function expireLock(bytes32 lockId) external {
        Lock storage L = locks[lockId];
        require(L.taker != address(0), "unknown lock");
        require(!L.consumed, "closed");
        require(block.timestamp > L.deadline, "not expired");

        _releaseLock(L);

        L.consumed = true;
        emit LockExpired(lockId);
    }

    // ----------------------------
    // Internals: Lock release (used by expireLock)
    // ----------------------------

    /**
     * Releases reserved liquidity for an expired lock.
     * - SWAP: decrements tokenPool[toAssetId].base.locked by qty
     * - REDEEM: decrements usdcPool.locked by netUsdc
     */
    function _releaseLock(Lock storage L) internal {
        if (L.kind == LockKind.SWAP) {
            TokenPool storage tp = tokenPool[L.toAssetId];
            require(tp.base.locked >= L.qty, "bad locked");
            unchecked {
                tp.base.locked -= L.qty;
            }
        } else {
            require(usdcPool.locked >= L.netUsdc, "bad locked");
            unchecked {
                usdcPool.locked -= L.netUsdc;
            }
        }
    }
}
