// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "openzeppelin-contracts/contracts/token/ERC1155/utils/ERC1155Holder.sol";

contract CorrelClearinghouse is ERC1155Holder {
    // ----------------------------
    // Config
    // ----------------------------
    IERC20 public immutable usdc;
    address public admin; // v0: single admin/overseer

    // ----------------------------
    // Asset registry (admin-controlled)
    // ----------------------------
    enum Polarity {
        POS, // YES-like
        NEG // NO-like
    }

    struct AssetInfo {
        IERC1155 token; // ERC1155 contract (e.g. Polymarket CTF)
        uint256 tokenId; // positionId inside ERC1155
        bytes32 classId; // equivalence class
        Polarity polarity; // POS/NEG
        bool exists;
    }

    mapping(bytes32 => AssetInfo) public assets; // assetId -> info

    // ----------------------------
    // Pools (single-asset)
    // ----------------------------
    struct PoolBase {
        uint256 totalShares; // total LP shares outstanding
        uint256 locked; // reserved asset units (cannot withdraw)
        mapping(address => uint256) shares; // LP -> shares
    }

    // Exactly one USDC pool
    PoolBase private usdcPool;

    // Token pool = base pool + swap-fee distribution state
    struct TokenPool {
        PoolBase base;
        // Swap fee distribution as USDC-pool shares:
        // accumulator: cumulative USDC-pool-shares-per-token-share (scaled by 1e18)
        uint256 accUsdcSharesPerTokenShare;
        // LP -> reward debt in "USDC-pool shares" terms (prevents double-claim)
        mapping(address => uint256) rewardDebt;
        // USDC-pool shares reserved for this token pool’s LPs to claim
        uint256 usdcShareBucket;
    }

    // One pool per outcome token assetId
    mapping(bytes32 => TokenPool) private tokenPool; // assetId -> TokenPool

    // ----------------------------
    // Locks (quote-time reservation)
    // ----------------------------
    enum LockKind {
        SWAP, // reserves qty in toAsset token pool
        REDEEM // reserves netUsdc in USDC pool
    }

    struct Lock {
        LockKind kind;
        address taker;
        uint256 deadline; // unix timestamp
        bool consumed; // used as "closed" for both executed and expired in v0
        // SWAP lock fields
        bytes32 fromAssetId;
        bytes32 toAssetId;
        uint256 qty; // reserved qty in toAsset pool
        // REDEEM lock fields
        bytes32 posAssetId;
        bytes32 negAssetId;
        uint256 qtyPairs;
        uint256 netUsdc; // reserved in USDC pool for payout
        uint256 feeUsdc; // stored for accounting / later reference
    }

    mapping(bytes32 => Lock) public locks; // lockId -> Lock

    // ----------------------------
    // Events
    // ----------------------------
    event AdminUpdated(address indexed newAdmin);

    event AssetRegistered(
        bytes32 indexed assetId,
        address indexed token,
        uint256 tokenId,
        bytes32 indexed classId,
        Polarity polarity
    );

    // LP actions
    event DepositedUsdc(
        address indexed lp,
        uint256 amount,
        uint256 sharesMinted
    );
    event WithdrawnUsdc(
        address indexed lp,
        uint256 sharesBurned,
        uint256 amountOut
    );

    event DepositedToken(
        bytes32 indexed assetId,
        address indexed lp,
        uint256 qty,
        uint256 sharesMinted
    );
    event WithdrawnToken(
        bytes32 indexed assetId,
        address indexed lp,
        uint256 sharesBurned,
        uint256 qtyOut
    );

    // Locks
    event QuoteLocked(
        bytes32 indexed lockId,
        LockKind kind,
        address indexed taker,
        uint256 deadline
    );
    event LockConsumed(bytes32 indexed lockId);
    event LockExpired(bytes32 indexed lockId);

    // Execution
    event SwapExecuted(
        bytes32 indexed lockId,
        address indexed taker,
        bytes32 fromAssetId,
        bytes32 toAssetId,
        uint256 qty,
        uint256 feeUsdc
    );

    event RedeemExecuted(
        bytes32 indexed lockId,
        address indexed taker,
        bytes32 posAssetId,
        bytes32 negAssetId,
        uint256 qtyPairs,
        uint256 netUsdc,
        uint256 feeUsdc
    );

    // Fee claims (swap fees credited to token-pool LPs)
    event SwapFeeClaimed(
        bytes32 indexed assetId,
        address indexed lp,
        uint256 usdcPoolShares
    );

    // ----------------------------
    // Constants
    // ----------------------------
    uint256 private constant ACC = 1e18;

    // ----------------------------
    // Constructor / Admin
    // ----------------------------
    constructor(IERC20 usdc_) {
        require(address(usdc_) != address(0), "USDC=0");
        usdc = usdc_;
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "admin=0");
        admin = newAdmin;
        emit AdminUpdated(newAdmin);
    }

    function registerAsset(
        bytes32 assetId,
        IERC1155 token,
        uint256 tokenId,
        bytes32 classId,
        Polarity polarity
    ) external onlyAdmin {
        require(assetId != bytes32(0), "assetId=0");
        require(address(token) != address(0), "token=0");
        require(classId != bytes32(0), "classId=0");
        require(!assets[assetId].exists, "asset exists");

        assets[assetId] = AssetInfo({
            token: token,
            tokenId: tokenId,
            classId: classId,
            polarity: polarity,
            exists: true
        });

        emit AssetRegistered(
            assetId,
            address(token),
            tokenId,
            classId,
            polarity
        );
    }

    // ----------------------------
    // Views (so you can inspect state easily)
    // ----------------------------

    // USDC pool
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
        // v0 rule: ALL USDC in this contract is USDC pool liquidity
        return usdc.balanceOf(address(this));
    }

    // Token pools
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

    function tokenPoolBalance(bytes32 assetId) public view returns (uint256) {
        AssetInfo memory a = _requireAsset(assetId);
        return a.token.balanceOf(address(this), a.tokenId);
    }

    // ----------------------------
    // Step 2: LP deposit/withdraw — USDC pool
    // ----------------------------

    /**
     * Deposit USDC into the USDC pool and receive USDC-pool shares.
     * LP must approve USDC to this contract first.
     */
    function depositUsdc(
        uint256 amount
    ) external returns (uint256 sharesMinted) {
        require(amount > 0, "amt=0");

        uint256 balBefore = usdcPoolBalance();
        uint256 S = usdcPool.totalShares;

        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "usdc tf failed"
        );

        if (S == 0) {
            sharesMinted = amount; // 1 share per 1 USDC base unit
        } else {
            require(balBefore > 0, "bad pool bal");
            sharesMinted = (amount * S) / balBefore;
            require(sharesMinted > 0, "mint=0");
        }

        usdcPool.totalShares = S + sharesMinted;
        usdcPool.shares[msg.sender] += sharesMinted;

        emit DepositedUsdc(msg.sender, amount, sharesMinted);
    }

    /**
     * Withdraw USDC by burning USDC-pool shares.
     * Withdrawal is limited by available liquidity = balance - locked.
     */
    function withdrawUsdc(
        uint256 sharesBurned
    ) external returns (uint256 amountOut) {
        require(sharesBurned > 0, "shares=0");

        uint256 userShares = usdcPool.shares[msg.sender];
        require(userShares >= sharesBurned, "insufficient shares");

        uint256 B = usdcPoolBalance();
        uint256 S = usdcPool.totalShares;
        require(S > 0, "no shares");

        amountOut = (sharesBurned * B) / S;
        require(amountOut > 0, "out=0");

        uint256 available = B - usdcPool.locked;
        require(amountOut <= available, "locked");

        unchecked {
            usdcPool.shares[msg.sender] = userShares - sharesBurned;
            usdcPool.totalShares = S - sharesBurned;
        }

        require(usdc.transfer(msg.sender, amountOut), "usdc transfer failed");
        emit WithdrawnUsdc(msg.sender, sharesBurned, amountOut);
    }

    // ----------------------------
    // Step 2: LP deposit/withdraw — Token pools (per assetId)
    // Includes auto-claim of swap-fee entitlements
    // ----------------------------

    /**
     * Deposit ERC1155 outcome tokens for a specific assetId into its token pool.
     * LP must setApprovalForAll(this, true) on the ERC1155 contract first.
     *
     * Auto-claims any pending swap-fee USDC-pool shares BEFORE changing token shares.
     */
    function depositToken(
        bytes32 assetId,
        uint256 qty
    ) external returns (uint256 sharesMinted) {
        require(qty > 0, "qty=0");
        AssetInfo memory a = _requireAsset(assetId);

        TokenPool storage p = tokenPool[assetId];

        // auto-claim pending before share change
        _autoClaimSwapFees(assetId, msg.sender, p);

        uint256 balBefore = tokenPoolBalance(assetId);
        uint256 S = p.base.totalShares;

        a.token.safeTransferFrom(msg.sender, address(this), a.tokenId, qty, "");

        if (S == 0) {
            sharesMinted = qty;
        } else {
            require(balBefore > 0, "bad pool bal");
            sharesMinted = (qty * S) / balBefore;
            require(sharesMinted > 0, "mint=0");
        }

        p.base.totalShares = S + sharesMinted;
        p.base.shares[msg.sender] += sharesMinted;

        // sync reward debt after share change
        _syncRewardDebt(assetId, msg.sender, p);

        emit DepositedToken(assetId, msg.sender, qty, sharesMinted);
    }

    /**
     * Withdraw ERC1155 outcome tokens by burning token-pool shares.
     * Withdrawal is limited by available = balance - locked.
     *
     * Auto-claims any pending swap-fee USDC-pool shares BEFORE changing token shares.
     */
    function withdrawToken(
        bytes32 assetId,
        uint256 sharesBurned
    ) external returns (uint256 qtyOut) {
        require(sharesBurned > 0, "shares=0");
        AssetInfo memory a = _requireAsset(assetId);

        TokenPool storage p = tokenPool[assetId];

        // auto-claim pending before share change
        _autoClaimSwapFees(assetId, msg.sender, p);

        uint256 userShares = p.base.shares[msg.sender];
        require(userShares >= sharesBurned, "insufficient shares");

        uint256 B = tokenPoolBalance(assetId);
        uint256 S = p.base.totalShares;
        require(S > 0, "no shares");

        qtyOut = (sharesBurned * B) / S;
        require(qtyOut > 0, "out=0");

        uint256 available = B - p.base.locked;
        require(qtyOut <= available, "locked");

        unchecked {
            p.base.shares[msg.sender] = userShares - sharesBurned;
            p.base.totalShares = S - sharesBurned;
        }

        // sync reward debt after share change
        _syncRewardDebt(assetId, msg.sender, p);

        a.token.safeTransferFrom(
            address(this),
            msg.sender,
            a.tokenId,
            qtyOut,
            ""
        );
        emit WithdrawnToken(assetId, msg.sender, sharesBurned, qtyOut);
    }

    // ----------------------------
    // Step 4: LP claims swap-fee entitlement (manual claim)
    // (deposit/withdraw already auto-claims; this is optional convenience)
    // ----------------------------

    function claimSwapFees(
        bytes32 assetId
    ) external returns (uint256 claimedUsdcPoolShares) {
        _requireAsset(assetId);

        TokenPool storage p = tokenPool[assetId];

        claimedUsdcPoolShares = _pendingUsdcShares(assetId, msg.sender, p);
        require(claimedUsdcPoolShares > 0, "nothing to claim");
        require(p.usdcShareBucket >= claimedUsdcPoolShares, "bucket short");

        unchecked {
            p.usdcShareBucket -= claimedUsdcPoolShares;
        }

        usdcPool.shares[msg.sender] += claimedUsdcPoolShares;

        _syncRewardDebt(assetId, msg.sender, p);

        emit SwapFeeClaimed(assetId, msg.sender, claimedUsdcPoolShares);
    }

    // ----------------------------
    // Step 3: Quote locking (reserve liquidity)
    // Admin-only because off-chain overseer decides fillability.
    // ----------------------------

    /**
     * Create a SWAP lock:
     * - Reserves `qty` units in the toAsset token pool.
     * - Enforces same class + same polarity.
     */
    function lockSwap(
        bytes32 lockId,
        address taker,
        bytes32 fromAssetId,
        bytes32 toAssetId,
        uint256 qty,
        uint256 feeUsdc,
        uint256 deadline
    ) external onlyAdmin {
        require(lockId != bytes32(0), "lockId=0");
        require(locks[lockId].taker == address(0), "lock exists");
        require(taker != address(0), "taker=0");
        require(qty > 0, "qty=0");
        require(deadline >= block.timestamp, "deadline<now");

        AssetInfo memory fromA = _requireAsset(fromAssetId);
        AssetInfo memory toA = _requireAsset(toAssetId);

        require(fromAssetId != toAssetId, "same asset");
        require(fromA.classId == toA.classId, "class mismatch");
        require(fromA.polarity == toA.polarity, "polarity mismatch");

        // Reserve liquidity from the toAsset pool
        TokenPool storage tp = tokenPool[toAssetId];
        uint256 B = tokenPoolBalance(toAssetId);
        uint256 available = B - tp.base.locked;
        require(qty <= available, "insufficient liquidity");

        tp.base.locked += qty;

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
     * Create a REDEEM lock:
     * - Reserves `netUsdc` units in the USDC pool for payout.
     * - Enforces same class + POS/NEG pairing.
     * - Enforces net + fee = qtyPairs (all in USDC base units).
     */
    function lockRedeem(
        bytes32 lockId,
        address taker,
        bytes32 posAssetId,
        bytes32 negAssetId,
        uint256 qtyPairs,
        uint256 netUsdc,
        uint256 feeUsdc,
        uint256 deadline
    ) external onlyAdmin {
        require(lockId != bytes32(0), "lockId=0");
        require(locks[lockId].taker == address(0), "lock exists");
        require(taker != address(0), "taker=0");
        require(qtyPairs > 0, "pairs=0");
        require(deadline >= block.timestamp, "deadline<now");

        AssetInfo memory posA = _requireAsset(posAssetId);
        AssetInfo memory negA = _requireAsset(negAssetId);

        require(posAssetId != negAssetId, "same asset");
        require(posA.classId == negA.classId, "class mismatch");
        require(posA.polarity == Polarity.POS, "pos not POS");
        require(negA.polarity == Polarity.NEG, "neg not NEG");

        require(netUsdc + feeUsdc == qtyPairs, "bad payout split");

        // Reserve liquidity from the USDC pool (net payout only)
        uint256 B = usdcPoolBalance();
        uint256 available = B - usdcPool.locked;
        require(netUsdc <= available, "insufficient usdc");

        usdcPool.locked += netUsdc;

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
     * Expire an unconsumed lock after its deadline:
     * - Releases reserved liquidity back to the pool.
     * - Marks the lock as closed (consumed=true in v0).
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
    // Step 4: Execution (consume locks)
    // ----------------------------

    /**
     * Execute a SWAP lock:
     * - Caller must be the taker.
     * - Consumes the reserved qty from the toAsset pool.
     * - Moves ERC1155 tokens:
     *     taker -> contract: qty fromAsset
     *     contract -> taker: qty toAsset
     * - Collects fee in USDC from taker (on top).
     * - Credits that fee ONLY to the toAsset pool LPs via USDC-pool shares accumulator.
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

        // Consume reservation
        TokenPool storage tp = tokenPool[L.toAssetId];
        require(tp.base.locked >= L.qty, "bad locked");
        unchecked {
            tp.base.locked -= L.qty;
        }

        // Transfers:
        // taker sends fromAsset into contract custody
        fromA.token.safeTransferFrom(
            L.taker,
            address(this),
            fromA.tokenId,
            L.qty,
            ""
        );
        // contract sends toAsset out
        toA.token.safeTransferFrom(
            address(this),
            L.taker,
            toA.tokenId,
            L.qty,
            ""
        );

        // Fee on top (USDC)
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
     * Execute a REDEEM lock:
     * - Caller must be the taker.
     * - Consumes reserved netUsdc from USDC pool.
     * - Moves ERC1155 tokens:
     *     taker -> contract: qtyPairs POS token
     *     taker -> contract: qtyPairs NEG token
     * - Pays net USDC to taker.
     * - Fee is "kept" by paying net (no extra transfers needed).
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

        // Consume reservation (net payout)
        require(usdcPool.locked >= L.netUsdc, "bad locked");
        unchecked {
            usdcPool.locked -= L.netUsdc;
        }

        // taker sends both legs into contract custody
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

        // pay net USDC
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
    // Internals: Fee crediting (swap fees -> token-pool LPs ONLY)
    // ----------------------------

    /**
     * Convert fee USDC into USDC-pool shares, and attribute those shares ONLY to
     * the LPs of the specified token pool using an accumulator model.
     *
     * Rule:
     * - swap fee earned by "toAsset pool" LPs
     *
     * NOTE: If there are no token LPs, we revert (so the fee cannot fall through to USDC LPs).
     */
    function _creditSwapFeeToTokenPool(
        bytes32 earningAssetId,
        uint256 feeUsdc
    ) internal {
        TokenPool storage p = tokenPool[earningAssetId];
        require(p.base.totalShares > 0, "no token LPs");

        // Mint USDC-pool shares equivalent to feeUsdc.
        // Fee already arrived into contract balance, so balance-before-fee = currentBalance - feeUsdc.
        uint256 balBeforeFee = usdcPoolBalance() - feeUsdc;
        uint256 S = usdcPool.totalShares;

        uint256 feeShares;
        if (S == 0) {
            // first shares in USDC pool: 1 share per 1 USDC base unit
            feeShares = feeUsdc;
        } else {
            require(balBeforeFee > 0, "bad usdc bal");
            feeShares = (feeUsdc * S) / balBeforeFee;
            require(feeShares > 0, "feeShares=0");
        }

        // Mint shares into existence (no owner yet; they sit in the token pool bucket)
        usdcPool.totalShares = S + feeShares;

        // Bucket holds claimable USDC-pool shares for this token pool's LPs
        p.usdcShareBucket += feeShares;

        // Increase accumulator so LPs can claim pro-rata WITHOUT iterating
        p.accUsdcSharesPerTokenShare += (feeShares * ACC) / p.base.totalShares;
    }

    // ----------------------------
    // Internals: Reward accounting helpers
    // ----------------------------

    function _pendingUsdcShares(
        bytes32 assetId,
        address lp
    ) internal view returns (uint256) {
        TokenPool storage p = tokenPool[assetId];
        return _pendingUsdcShares(assetId, lp, p);
    }

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

    function _syncRewardDebt(
        bytes32 /*assetId*/,
        address lp,
        TokenPool storage p
    ) internal {
        uint256 lpTokenShares = p.base.shares[lp];
        p.rewardDebt[lp] = (lpTokenShares * p.accUsdcSharesPerTokenShare) / ACC;
    }

    function _autoClaimSwapFees(
        bytes32 assetId,
        address lp,
        TokenPool storage p
    ) internal {
        uint256 pending = _pendingUsdcShares(assetId, lp, p);
        if (pending == 0) {
            // still keep debt aligned
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
    // Internals: Lock release (used by expiration)
    // ----------------------------
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

    // ----------------------------
    // Internals: asset existence
    // ----------------------------
    function _requireAsset(
        bytes32 assetId
    ) internal view returns (AssetInfo memory) {
        AssetInfo memory a = assets[assetId];
        require(a.exists, "unknown asset");
        return a;
    }
}
