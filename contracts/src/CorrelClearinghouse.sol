// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "openzeppelin-contracts/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/**
 * Correl v0 on-chain skeleton:
 * - Execution model B: one authorized signer (overseer) approves Swap/Redeem via EIP-712 signatures.
 * - Replay protection: per-user monotonically increasing nonce.
 * - Quote expiration: deadline timestamp.
 * - Custody model (2A): users deposit ERC-1155 outcome tokens into this contract; internal ledger tracks balances.
 * - USDC is used for fees and redemption payouts.
 *
 * IMPORTANT: This is a skeleton to get you compiling + ready for wiring.
 * We'll add pause controls, safer admin separation, and better events later if you want.
 */
contract CorrelClearinghouse is EIP712, ERC1155Holder {
    using ECDSA for bytes32;

    // ----------------------------
    // Config
    // ----------------------------
    IERC20 public immutable usdc;
    address public signer; // authorized overseer signer
    address public feeRecipient; // where fees go

    // ----------------------------
    // Internal ledger: user => assetId => qty
    // assetId is bytes32 (you can use keccak256 of your engine OutcomeAsset.id string)
    // ----------------------------
    mapping(address => mapping(bytes32 => uint256)) public bal;

    // Replay protection: per-user nonce. Each successful auth increments it by 1.
    mapping(address => uint256) public nonces;

    // ----------------------------
    // Asset registry (overseer-controlled)
    // ----------------------------
    enum Polarity {
        POS,
        NEG
    }

    struct AssetInfo {
        IERC1155 token; // ERC1155 contract
        uint256 tokenId; // token id inside that ERC1155
        bytes32 classId; // equivalence class
        Polarity polarity;
        bool exists;
    }

    mapping(bytes32 => AssetInfo) public assets;

    // ----------------------------
    // EIP-712 typed data
    // ----------------------------
    bytes32 public constant SWAP_TYPEHASH =
        keccak256(
            "SwapAuth(address user,bytes32 fromAssetId,bytes32 toAssetId,uint256 qty,uint256 feeUsdc,uint256 nonce,uint256 deadline)"
        );

    bytes32 public constant REDEEM_TYPEHASH =
        keccak256(
            "RedeemAuth(address user,bytes32 posAssetId,bytes32 negAssetId,uint256 qtyPairs,uint256 netUsdc,uint256 feeUsdc,uint256 nonce,uint256 deadline)"
        );

    // ----------------------------
    // Events
    // ----------------------------
    event SignerUpdated(address indexed newSigner);
    event FeeRecipientUpdated(address indexed newFeeRecipient);

    event AssetRegistered(
        bytes32 indexed assetId,
        address indexed token,
        uint256 tokenId,
        bytes32 indexed classId,
        Polarity polarity
    );

    event Deposited(address indexed user, bytes32 indexed assetId, uint256 qty);
    event Withdrawn(address indexed user, bytes32 indexed assetId, uint256 qty);

    event SwapExecuted(
        address indexed user,
        bytes32 indexed fromAssetId,
        bytes32 indexed toAssetId,
        uint256 qty,
        uint256 feeUsdc
    );

    event RedeemExecuted(
        address indexed user,
        bytes32 indexed posAssetId,
        bytes32 indexed negAssetId,
        uint256 qtyPairs,
        uint256 netUsdc,
        uint256 feeUsdc
    );

    constructor(
        IERC20 usdc_,
        address signer_,
        address feeRecipient_
    ) EIP712("CorrelClearinghouse", "1") {
        require(address(usdc_) != address(0), "USDC=0");
        require(signer_ != address(0), "signer=0");
        require(feeRecipient_ != address(0), "feeRecipient=0");

        usdc = usdc_;
        signer = signer_;
        feeRecipient = feeRecipient_;
    }

    // ----------------------------
    // Admin (v0: signer is admin too)
    // ----------------------------
    modifier onlyAdmin() {
        require(msg.sender == signer, "not admin");
        _;
    }

    function setSigner(address newSigner) external onlyAdmin {
        require(newSigner != address(0), "signer=0");
        signer = newSigner;
        emit SignerUpdated(newSigner);
    }

    function setFeeRecipient(address newFeeRecipient) external onlyAdmin {
        require(newFeeRecipient != address(0), "feeRecipient=0");
        feeRecipient = newFeeRecipient;
        emit FeeRecipientUpdated(newFeeRecipient);
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
    // Funding / custody
    // ----------------------------

    function deposit(bytes32 assetId, uint256 qty) external {
        require(qty > 0, "qty=0");
        AssetInfo memory a = _requireAsset(assetId);

        // user must have setApprovalForAll(this, true) on the ERC1155 token contract
        a.token.safeTransferFrom(msg.sender, address(this), a.tokenId, qty, "");

        bal[msg.sender][assetId] += qty;
        emit Deposited(msg.sender, assetId, qty);
    }

    function withdraw(bytes32 assetId, uint256 qty) external {
        require(qty > 0, "qty=0");
        AssetInfo memory a = _requireAsset(assetId);

        uint256 have = bal[msg.sender][assetId];
        require(have >= qty, "insufficient asset");

        unchecked {
            bal[msg.sender][assetId] = have - qty;
        }

        a.token.safeTransferFrom(address(this), msg.sender, a.tokenId, qty, "");
        emit Withdrawn(msg.sender, assetId, qty);
    }

    // fund contract with USDC for payouts (overseer can seed redemption liquidity)
    function fundUsdc(uint256 amount) external {
        require(amount > 0, "amt=0");
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "usdc transferFrom failed"
        );
    }

    // ----------------------------
    // Swap / Redeem execution (signed auth)
    // ----------------------------
    struct SwapAuth {
        address user;
        bytes32 fromAssetId;
        bytes32 toAssetId;
        uint256 qty;
        uint256 feeUsdc;
        uint256 nonce;
        uint256 deadline; // unix timestamp
    }

    function swap(SwapAuth calldata a, bytes calldata sig) external {
        _checkAuthCommon(a.user, a.nonce, a.deadline);
        require(msg.sender == a.user, "not user");

        require(a.qty > 0, "qty=0");
        require(a.fromAssetId != a.toAssetId, "same asset");

        AssetInfo memory fromA = _requireAsset(a.fromAssetId);
        AssetInfo memory toA = _requireAsset(a.toAssetId);

        // on-chain enforcement of your engine rule: same classId + same polarity
        require(fromA.classId == toA.classId, "class mismatch");
        require(fromA.polarity == toA.polarity, "polarity mismatch");

        _verifySwapSig(a, sig);

        // internal ledger move
        uint256 have = bal[a.user][a.fromAssetId];
        require(have >= a.qty, "insufficient fromAsset");
        unchecked {
            bal[a.user][a.fromAssetId] = have - a.qty;
        }
        bal[a.user][a.toAssetId] += a.qty;

        // collect USDC fee from user to feeRecipient
        if (a.feeUsdc > 0) {
            require(
                usdc.transferFrom(a.user, feeRecipient, a.feeUsdc),
                "fee transfer failed"
            );
        }

        emit SwapExecuted(a.user, a.fromAssetId, a.toAssetId, a.qty, a.feeUsdc);
    }

    struct RedeemAuth {
        address user;
        bytes32 posAssetId;
        bytes32 negAssetId;
        uint256 qtyPairs;
        uint256 netUsdc;
        uint256 feeUsdc;
        uint256 nonce;
        uint256 deadline;
    }

    function redeem(RedeemAuth calldata a, bytes calldata sig) external {
        _checkAuthCommon(a.user, a.nonce, a.deadline);
        require(msg.sender == a.user, "not user");

        require(a.qtyPairs > 0, "qtyPairs=0");
        require(a.posAssetId != a.negAssetId, "same asset");

        AssetInfo memory posA = _requireAsset(a.posAssetId);
        AssetInfo memory negA = _requireAsset(a.negAssetId);

        // on-chain enforcement of your engine rule: same classId + POS/NEG polarity
        require(posA.classId == negA.classId, "class mismatch");
        require(posA.polarity == Polarity.POS, "pos not POS");
        require(negA.polarity == Polarity.NEG, "neg not NEG");

        _verifyRedeemSig(a, sig);

        // debit both legs from internal ledger
        uint256 posHave = bal[a.user][a.posAssetId];
        uint256 negHave = bal[a.user][a.negAssetId];
        require(posHave >= a.qtyPairs, "insufficient pos");
        require(negHave >= a.qtyPairs, "insufficient neg");

        unchecked {
            bal[a.user][a.posAssetId] = posHave - a.qtyPairs;
            bal[a.user][a.negAssetId] = negHave - a.qtyPairs;
        }

        // pay user net
        if (a.netUsdc > 0) {
            require(usdc.transfer(a.user, a.netUsdc), "payout transfer failed");
        }

        // pay fee recipient fee (optional; matches your engine quote fields)
        if (a.feeUsdc > 0) {
            require(
                usdc.transfer(feeRecipient, a.feeUsdc),
                "fee transfer failed"
            );
        }

        emit RedeemExecuted(
            a.user,
            a.posAssetId,
            a.negAssetId,
            a.qtyPairs,
            a.netUsdc,
            a.feeUsdc
        );
    }

    // ----------------------------
    // Internals
    // ----------------------------
    function _requireAsset(
        bytes32 assetId
    ) internal view returns (AssetInfo memory) {
        AssetInfo memory a = assets[assetId];
        require(a.exists, "unknown asset");
        return a;
    }

    function _checkAuthCommon(
        address user,
        uint256 nonce,
        uint256 deadline
    ) internal view {
        require(user != address(0), "user=0");
        require(block.timestamp <= deadline, "expired");
        require(nonce == nonces[user], "bad nonce");
    }

    function _useNonce(address user) internal {
        nonces[user] += 1;
    }

    function _verifySwapSig(
        SwapAuth calldata a,
        bytes calldata sig
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                SWAP_TYPEHASH,
                a.user,
                a.fromAssetId,
                a.toAssetId,
                a.qty,
                a.feeUsdc,
                a.nonce,
                a.deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = digest.recover(sig);
        require(recovered == signer, "bad sig");
    }

    function _verifyRedeemSig(
        RedeemAuth calldata a,
        bytes calldata sig
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                REDEEM_TYPEHASH,
                a.user,
                a.posAssetId,
                a.negAssetId,
                a.qtyPairs,
                a.netUsdc,
                a.feeUsdc,
                a.nonce,
                a.deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = digest.recover(sig);
        require(recovered == signer, "bad sig");
    }
}
