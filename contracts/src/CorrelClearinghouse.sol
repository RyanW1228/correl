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

    // ----------------------------
    // Cross-pool migration (token-share rewards)
    // ----------------------------
    // For an "earning pool" E (the pool whose liquidity was consumed; i.e. toAsset in A->B),
    // we pay LPs of E with shares in some "reward pool" R (i.e. fromAsset pool).
    //
    // Key: We DO NOT mint reward-pool shares directly to each LP at swap time (can't iterate).
    // Instead:
    //  1) We mint reward-pool shares to a deterministic "holder address" H(E,R)
    //     so those shares EXIST immediately and participate in downstream accrual (multi-hop).
    //  2) We run an accumulator inside E for each R, so E-LPs can be auto-credited
    //     with their pro-rata portion of those reward-pool shares on any interaction.
    struct CrossReward {
        // cumulative rewardPoolShares-per-earningPoolShare (scaled by ACC)
        uint256 accRewardSharesPerEarnShare;
        // LP -> debt in rewardPoolShares terms
        mapping(address => uint256) rewardDebt;
    }

    // earningAssetId (E) => rewardAssetId (R) => CrossReward
    mapping(bytes32 => mapping(bytes32 => CrossReward)) private crossReward;

    // Track active reward assets per earning pool so we can auto-sync/auto-claim safely
    mapping(bytes32 => bytes32[]) private activeRewardAssets; // E => [R...]
    mapping(bytes32 => mapping(bytes32 => bool)) private isActiveRewardAsset; // E => R => bool

    // ----------------------------
    // Cross-pool migration where the EARNING pool is the USDC pool
    // ----------------------------
    // Here, "earning shares" are USDC-pool shares (usdcPool.shares[lp]).
    // Reward pools are token pools (tokenPool[rewardAssetId]).
    // We reuse CrossReward (accumulator + per-LP debt), but keyed differently.
    bytes32 private constant USDC_EARNING_POOL_ID =
        keccak256("CORREL_USDC_POOL");

    mapping(bytes32 => CrossReward) private usdcCrossReward; // rewardAssetId => CrossReward

    bytes32[] private usdcActiveRewardAssets; // [rewardAssetId...]
    mapping(bytes32 => bool) private usdcIsActiveRewardAsset; // rewardAssetId => active?

    // ----------------------------
    // Token pool = base pool + swap-fee distribution state
    // ----------------------------
    struct TokenPool {
        PoolBase base;
        // Swap fee distribution as USDC-pool shares:
        uint256 accUsdcSharesPerTokenShare; // scaled by ACC
        mapping(address => uint256) rewardDebt; // debt in "USDC-pool shares"
        uint256 usdcShareBucket; // claimable USDC-pool shares reserved for this token pool’s LPs
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

    // Cross-pool migration credit (E pool earns R-pool shares)
    event CrossPoolShareCredited(
        bytes32 indexed earningAssetId,
        bytes32 indexed rewardAssetId,
        uint256 rewardPoolSharesMinted
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

    // Cross migration views
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

    function tokenPoolBalance(bytes32 assetId) public view returns (uint256) {
        AssetInfo memory a = _requireAsset(assetId);
        return a.token.balanceOf(address(this), a.tokenId);
    }

    // ----------------------------
    // Step 2: LP deposit/withdraw — USDC pool
    // ----------------------------
    function depositUsdc(
        uint256 amount
    ) external returns (uint256 sharesMinted) {
        require(amount > 0, "amt=0");
        // auto-claim USDC->token cross rewards BEFORE share balance changes
        _autoClaimUsdcCrossRewards(msg.sender);

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

        // sync debts AFTER share balance changes
        _syncUsdcCrossDebts(msg.sender);

        emit DepositedUsdc(msg.sender, amount, sharesMinted);
    }

    function withdrawUsdc(
        uint256 sharesBurned
    ) external returns (uint256 amountOut) {
        require(sharesBurned > 0, "shares=0");

        // auto-claim USDC->token cross rewards BEFORE share balance changes
        _autoClaimUsdcCrossRewards(msg.sender);

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

        // sync debts AFTER share balance changes
        _syncUsdcCrossDebts(msg.sender);

        require(usdc.transfer(msg.sender, amountOut), "usdc transfer failed");
        emit WithdrawnUsdc(msg.sender, sharesBurned, amountOut);
    }

    // ----------------------------
    // Step 2: LP deposit/withdraw — Token pools (per assetId)
    // Includes auto-claim of:
    //  - swap-fee entitlements (USDC-pool shares)
    //  - cross-pool migrated token-share entitlements (reward-pool shares)
    // ----------------------------
    function depositToken(
        bytes32 assetId,
        uint256 qty
    ) external returns (uint256 sharesMinted) {
        require(qty > 0, "qty=0");
        AssetInfo memory a = _requireAsset(assetId);

        TokenPool storage p = tokenPool[assetId];

        // auto-claim ALL entitlements before share change (prevents retroactive claims)
        _autoClaimAll(assetId, msg.sender, p);

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

        // sync debts after share change
        _syncAllDebts(assetId, msg.sender, p);

        emit DepositedToken(assetId, msg.sender, qty, sharesMinted);
    }

    function withdrawToken(
        bytes32 assetId,
        uint256 sharesBurned
    ) external returns (uint256 qtyOut) {
        require(sharesBurned > 0, "shares=0");
        AssetInfo memory a = _requireAsset(assetId);

        TokenPool storage p = tokenPool[assetId];

        // auto-claim ALL entitlements before share change (prevents retroactive claims)
        _autoClaimAll(assetId, msg.sender, p);

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

        // sync debts after share change
        _syncAllDebts(assetId, msg.sender, p);

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
    // Optional manual claim: swap-fee entitlement
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
    // ----------------------------
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
     * CHANGE IMPLEMENTED:
     * - When swapping A -> B (fromAsset -> toAsset), the "toAsset" pool liquidity is consumed.
     * - Therefore the LPs of the toAsset pool earn:
     *     (1) fromAsset-pool shares representing the incoming fromAsset tokens, AND
     *     (2) USDC-pool shares representing the swap fee.
     *
     * This is implemented without iterating LPs:
     * - fromAsset tokens arrive in contract
     * - we mint fromAsset pool shares to a holder H(toAsset, fromAsset)
     * - we update an accumulator so toAsset LPs can be auto-credited those shares on interaction
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

        // Consume reservation (toAsset liquidity)
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

        // Cross-pool migration: toAsset LPs earn fromAsset-pool shares (for the incoming tokens)
        _creditIncomingTokenToEarningPoolAsShares(
            /*earningAssetId=*/ L.toAssetId,
            /*rewardAssetId=*/ L.fromAssetId,
            /*incomingQty=*/ L.qty
        );

        // Fee on top (USDC): credited ONLY to the toAsset pool LPs as USDC-pool shares
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

        // NEW: USDC LPs earn token-pool shares representing the incoming redeem legs
        _creditIncomingTokenToUsdcEarnersAsShares(L.posAssetId, L.qtyPairs);
        _creditIncomingTokenToUsdcEarnersAsShares(L.negAssetId, L.qtyPairs);

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
    // Internals: Cross-pool migration (incoming token -> reward-pool shares)
    // ----------------------------

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

        // Ensure reward asset is active so future LP interactions sync debts safely
        _activateRewardAssetIfNeeded(earningAssetId, rewardAssetId);

        // Mint reward-asset pool shares equivalent to the incoming tokens.
        // Tokens already arrived, so balance-before-incoming = currentBalance - incomingQty.
        TokenPool storage rewardPool = tokenPool[rewardAssetId];
        uint256 balBeforeIncoming = tokenPoolBalance(rewardAssetId) -
            incomingQty;
        uint256 S = rewardPool.base.totalShares;

        uint256 mintedRewardPoolShares;
        if (S == 0) {
            // 1 share per 1 token base unit
            mintedRewardPoolShares = incomingQty;
        } else {
            require(balBeforeIncoming > 0, "bad reward bal");
            mintedRewardPoolShares = (incomingQty * S) / balBeforeIncoming;
            require(mintedRewardPoolShares > 0, "mint=0");
        }

        // Shares must EXIST immediately (for downstream accrual), so mint into totalShares now,
        // and assign them to a deterministic holder that represents (earningPool -> rewardPool).
        rewardPool.base.totalShares = S + mintedRewardPoolShares;

        address holder = _crossHolder(earningAssetId, rewardAssetId);
        rewardPool.base.shares[holder] += mintedRewardPoolShares;

        // Attribute those holder-owned rewardPool shares to earningPool LPs via accumulator
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

    function _activateRewardAssetIfNeeded(
        bytes32 earningAssetId,
        bytes32 rewardAssetId
    ) internal {
        if (isActiveRewardAsset[earningAssetId][rewardAssetId]) return;
        isActiveRewardAsset[earningAssetId][rewardAssetId] = true;
        activeRewardAssets[earningAssetId].push(rewardAssetId);
    }

    function _activateUsdcRewardAssetIfNeeded(bytes32 rewardAssetId) internal {
        if (usdcIsActiveRewardAsset[rewardAssetId]) return;
        usdcIsActiveRewardAsset[rewardAssetId] = true;
        usdcActiveRewardAssets.push(rewardAssetId);
    }

    /**
     * USDC pool is the EARNING pool.
     * Reward pool is a TOKEN pool (rewardAssetId).
     *
     * Called when tokens arrive into the contract (e.g. redeem),
     * to attribute those incoming tokens to USDC LPs as reward-pool shares.
     */
    function _creditIncomingTokenToUsdcEarnersAsShares(
        bytes32 rewardAssetId,
        uint256 incomingQty
    ) internal {
        _requireAsset(rewardAssetId);
        require(incomingQty > 0, "qty=0");

        // USDC LPs must exist
        require(usdcPool.totalShares > 0, "no usdc LPs");

        // Ensure reward asset is active (so future USDC LP interactions sync/claim safely)
        _activateUsdcRewardAssetIfNeeded(rewardAssetId);

        // Mint reward-asset pool shares equivalent to the incoming tokens.
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

        // Shares must exist immediately, so mint into totalShares now
        rewardPool.base.totalShares = S + mintedRewardPoolShares;

        // Assign to deterministic holder representing (USDC pool -> reward token pool)
        address holder = _crossHolder(USDC_EARNING_POOL_ID, rewardAssetId);
        rewardPool.base.shares[holder] += mintedRewardPoolShares;

        // Attribute those holder-owned rewardPool shares to USDC LPs via accumulator
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

    function _crossHolder(
        bytes32 earningAssetId,
        bytes32 rewardAssetId
    ) internal pure returns (address) {
        // Deterministic pseudo-address. Only used as a key in mappings.
        // No one has the private key; it is not meant to be an EOA.
        bytes32 h = keccak256(
            abi.encodePacked(
                "CORREL_CROSS_HOLDER",
                earningAssetId,
                rewardAssetId
            )
        );
        return address(uint160(uint256(h)));
    }

    // ----------------------------
    // Internals: Fee crediting (swap fees -> token-pool LPs ONLY)
    // ----------------------------
    function _creditSwapFeeToTokenPool(
        bytes32 earningAssetId,
        uint256 feeUsdc
    ) internal {
        TokenPool storage p = tokenPool[earningAssetId];
        require(p.base.totalShares > 0, "no token LPs");

        // Fee already arrived into contract balance, so balance-before-fee = currentBalance - feeUsdc.
        uint256 balBeforeFee = usdcPoolBalance() - feeUsdc;
        uint256 S = usdcPool.totalShares;

        uint256 feeShares;
        if (S == 0) {
            feeShares = feeUsdc;
        } else {
            require(balBeforeFee > 0, "bad usdc bal");
            feeShares = (feeUsdc * S) / balBeforeFee;
            require(feeShares > 0, "feeShares=0");
        }

        // Mint into existence (unowned) and park in bucket for this token pool
        usdcPool.totalShares = S + feeShares;
        p.usdcShareBucket += feeShares;

        p.accUsdcSharesPerTokenShare += (feeShares * ACC) / p.base.totalShares;
    }

    // ----------------------------
    // Internals: Reward accounting helpers (swap fees)
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
    // Manual claim: USDC-pool cross rewards (redeem legs -> token-pool shares)
    // ----------------------------
    function claimUsdcCrossRewards() external {
        // This does NOT change usdcPool.shares[msg.sender].
        // It only moves reward-pool shares from the deterministic holder bucket to msg.sender.
        _autoClaimUsdcCrossRewards(msg.sender);

        // After claiming, sync debts so future pending math is correct.
        _syncUsdcCrossDebts(msg.sender);
    }

    function claimUsdcCrossRewardsFor(
        bytes32[] calldata rewardAssetIds
    ) external {
        uint256 m = rewardAssetIds.length;
        require(m > 0, "empty");

        uint256 lpEarnShares = usdcPool.shares[msg.sender];

        for (uint256 i = 0; i < m; i++) {
            bytes32 rewardAssetId = rewardAssetIds[i];
            _requireAsset(rewardAssetId);

            CrossReward storage cr = usdcCrossReward[rewardAssetId];

            uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) /
                ACC;
            uint256 debt = cr.rewardDebt[msg.sender];
            if (accrued <= debt) {
                cr.rewardDebt[msg.sender] = accrued; // still sync
                continue;
            }

            uint256 pending = accrued - debt;

            TokenPool storage rewardPool = tokenPool[rewardAssetId];
            address holder = _crossHolder(USDC_EARNING_POOL_ID, rewardAssetId);

            require(rewardPool.base.shares[holder] >= pending, "holder short");
            unchecked {
                rewardPool.base.shares[holder] -= pending;
            }
            rewardPool.base.shares[msg.sender] += pending;

            cr.rewardDebt[msg.sender] = accrued;
        }
    }

    // ----------------------------
    // Internals: Reward accounting helpers (cross-pool migrated token shares)
    // ----------------------------
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

    function _autoClaimCrossRewards(
        bytes32 earningAssetId,
        address lp
    ) internal {
        bytes32[] storage list = activeRewardAssets[earningAssetId];
        uint256 n = list.length;
        if (n == 0) return;

        for (uint256 i = 0; i < n; i++) {
            bytes32 rewardAssetId = list[i];
            CrossReward storage cr = crossReward[earningAssetId][rewardAssetId];

            TokenPool storage earningPool = tokenPool[earningAssetId];
            uint256 lpEarnShares = earningPool.base.shares[lp];

            uint256 accrued = (lpEarnShares * cr.accRewardSharesPerEarnShare) /
                ACC;
            uint256 debt = cr.rewardDebt[lp];

            if (accrued > debt) {
                uint256 pending = accrued - debt;

                // Move reward-pool shares from the holder to the LP (no token transfer).
                TokenPool storage rewardPool = tokenPool[rewardAssetId];
                address holder = _crossHolder(earningAssetId, rewardAssetId);

                require(
                    rewardPool.base.shares[holder] >= pending,
                    "holder short"
                );
                unchecked {
                    rewardPool.base.shares[holder] -= pending;
                }
                rewardPool.base.shares[lp] += pending;

                // Update debt to current accrued
                cr.rewardDebt[lp] = accrued;
            } else {
                // Still sync debt to accrued (noop)
                cr.rewardDebt[lp] = accrued;
            }
        }
    }

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

            if (accrued > debt) {
                uint256 pending = accrued - debt;

                TokenPool storage rewardPool = tokenPool[rewardAssetId];
                address holder = _crossHolder(
                    USDC_EARNING_POOL_ID,
                    rewardAssetId
                );

                require(
                    rewardPool.base.shares[holder] >= pending,
                    "holder short"
                );
                unchecked {
                    rewardPool.base.shares[holder] -= pending;
                }
                rewardPool.base.shares[lp] += pending;

                cr.rewardDebt[lp] = accrued;
            } else {
                cr.rewardDebt[lp] = accrued;
            }
        }
    }

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
    function _autoClaimAll(
        bytes32 assetId,
        address lp,
        TokenPool storage p
    ) internal {
        // 1) swap-fee USDC-share rewards
        _autoClaimSwapFees(assetId, lp, p);
        // 2) cross-pool migrated token-share rewards
        _autoClaimCrossRewards(assetId, lp);
    }

    function _syncAllDebts(
        bytes32 assetId,
        address lp,
        TokenPool storage p
    ) internal {
        // swap-fee debt
        _syncRewardDebt(assetId, lp, p);
        // cross debts (for all active reward assets)
        bytes32[] storage list = activeRewardAssets[assetId];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            _syncCrossDebt(assetId, list[i], lp);
        }
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
