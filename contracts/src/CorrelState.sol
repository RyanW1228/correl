// contracts/src/CorrelState.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "openzeppelin-contracts/contracts/token/ERC1155/utils/ERC1155Holder.sol";

interface IConditionalTokens {
    function payoutDenominator(
        bytes32 conditionId
    ) external view returns (uint256);

    function payoutNumerators(
        bytes32 conditionId,
        uint256 index
    ) external view returns (uint256);

    function redeemPositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external;
}

/**
 * CorrelState
 * Centralized storage, core types, events, and constants.
 * All functional modules inherit this contract and share its storage.
 */
abstract contract CorrelState is ERC1155Holder {
    // ----------------------------
    // Config
    // ----------------------------
    IERC20 public immutable usdc;
    address public admin; // single privileged admin address

    // ----------------------------
    // Asset registry (admin-controlled)
    // ----------------------------
    enum Polarity {
        POS, // YES-like
        NEG // NO-like
    }

    enum AssetStatus {
        ACTIVE,
        DISABLED
    }

    struct AssetInfo {
        IERC1155 token; // ERC1155 token contract (e.g. ConditionalTokens)
        uint256 tokenId; // position tokenId within the ERC1155 contract
        bytes32 classId; // equivalence class identifier
        Polarity polarity; // POS/NEG
        bool exists;
        AssetStatus status; // ACTIVE / DISABLED
        // Settlement metadata (CTF)
        bytes32 conditionId; // CTF conditionId (used to verify resolution and redeem)
        bytes32 parentCollectionId; // parent collection for CTF redemption
        IERC20 collateralToken; // collateral token returned on redemption
        uint256 indexSet; // outcome index set for this position
    }

    mapping(bytes32 => AssetInfo) public assets; // assetId => AssetInfo

    // ----------------------------
    // Pools
    // ----------------------------
    struct PoolBase {
        uint256 totalShares; // total LP shares outstanding
        uint256 locked; // reserved asset units (cannot be withdrawn)
        mapping(address => uint256) shares; // LP => shares
    }

    // Single USDC pool
    PoolBase internal usdcPool;

    // ----------------------------
    // Cross-pool migration (token-share rewards)
    // ----------------------------
    struct CrossReward {
        // cumulative rewardPoolShares per earningPoolShare (scaled by ACC)
        uint256 accRewardSharesPerEarnShare;
        // LP => debt in rewardPoolShares terms
        mapping(address => uint256) rewardDebt;
    }

    // earningAssetId (E) => rewardAssetId (R) => CrossReward
    mapping(bytes32 => mapping(bytes32 => CrossReward)) internal crossReward;

    // Tracks active reward assets per earning pool for safe sync and claim operations
    mapping(bytes32 => bytes32[]) internal activeRewardAssets; // E => [R...]
    mapping(bytes32 => mapping(bytes32 => bool)) internal isActiveRewardAsset; // E => R => active?

    // ----------------------------
    // Cross-pool migration with USDC as the earning pool
    // ----------------------------
    bytes32 internal constant USDC_EARNING_POOL_ID =
        keccak256("CORREL_USDC_POOL");

    mapping(bytes32 => CrossReward) internal usdcCrossReward; // rewardAssetId => CrossReward
    bytes32[] internal usdcActiveRewardAssets; // [rewardAssetId...]
    mapping(bytes32 => bool) internal usdcIsActiveRewardAsset; // rewardAssetId => active?

    // ----------------------------
    // Token pools (per assetId)
    // ----------------------------
    struct TokenPool {
        PoolBase base;
        // Swap fee distribution as USDC-pool shares
        uint256 accUsdcSharesPerTokenShare; // scaled by ACC
        mapping(address => uint256) rewardDebt; // debt in USDC-pool shares
        uint256 usdcShareBucket; // unclaimed USDC-pool shares reserved for this pool
    }

    // One pool per outcome token assetId
    mapping(bytes32 => TokenPool) internal tokenPool; // assetId => TokenPool

    enum TokenPoolStatus {
        ACTIVE,
        SETTLED,
        DORMANT
    }

    mapping(bytes32 => TokenPoolStatus) public tokenPoolStatus; // assetId => status

    // ----------------------------
    // LP position tracking
    // ----------------------------
    mapping(address => bytes32[]) internal lpTokenAssets; // LP => assetIds with token-pool shares
    mapping(address => mapping(bytes32 => uint256))
        internal lpTokenAssetIndexPlus1; // LP => assetId => index+1 (0 = not present)

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
        bool consumed; // true once executed or expired
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

    mapping(bytes32 => Lock) public locks; // lockId => Lock

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

    event TokenPoolSettled(bytes32 indexed assetId, uint256 usdcReceived);

    // ----------------------------
    // Constants
    // ----------------------------
    uint256 internal constant ACC = 1e18;

    // Fee: 50 bps = 0.50%
    uint256 public constant FEE_BPS = 50;
    uint256 public constant BPS_DENOM = 10_000;

    // Uses ceil division to avoid undercharging due to truncation.
    function _feeFromNotional(
        uint256 notionalUsdc
    ) internal pure returns (uint256) {
        return (notionalUsdc * FEE_BPS + (BPS_DENOM - 1)) / BPS_DENOM;
    }

    uint256 public constant MAX_LOCK_DURATION = 120; // seconds

    // ----------------------------
    // Constructor
    // ----------------------------
    constructor(IERC20 usdc_) {
        require(address(usdc_) != address(0), "USDC=0");
        usdc = usdc_;
        admin = msg.sender;
    }

    // ----------------------------
    // Shared internal helper functions
    // ----------------------------
    function _requireAsset(
        bytes32 assetId
    ) internal view returns (AssetInfo storage a) {
        a = assets[assetId];
        require(a.exists, "unknown asset");
    }

    // Returns a deterministic internal address used to hold cross-pool shares.
    function _crossHolder(
        bytes32 earningAssetId,
        bytes32 rewardAssetId
    ) internal pure returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                "CORREL_CROSS_HOLDER",
                earningAssetId,
                rewardAssetId
            )
        );
        return address(uint160(uint256(h)));
    }
}
