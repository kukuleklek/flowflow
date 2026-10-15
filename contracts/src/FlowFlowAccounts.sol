// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title FlowFlow accounts on Avalanche
/// @notice One account contract per FlowFlow user (CREATE2, address known in advance), and a public count of the
///         withdrawals each user signed in FlowFlow. Holds NO funds: money moves on Hyperliquid and Relay; every
///         recorded withdrawal carries its Hyperliquid tx hash, so anyone can check it there.

/// @notice A user's FlowFlow account: who owns it, and which factory made it. It cannot receive AVAX or call out.
contract FlowFlowAccount {
    address public immutable owner;
    address public immutable factory;

    constructor(address owner_) {
        owner = owner_;
        factory = msg.sender;
    }
}

contract FlowFlowAccountFactory {
    /// @notice Can change the recorder and hand over admin.
    address public admin;
    /// @notice FlowFlow's server key: records a withdrawal only after it read it on Hyperliquid.
    address public recorder;

    mapping(address => address) public accountOf;
    mapping(address => uint256) public withdrawCount;
    /// @notice USDC, 6 decimals.
    mapping(address => uint256) public withdrawnUsdc;
    /// @notice Hyperliquid tx hashes already counted: one withdrawal is never counted twice.
    mapping(bytes32 => bool) public recorded;

    uint256 public totalAccounts;
    uint256 public totalWithdrawals;
    uint256 public totalWithdrawnUsdc;

    event AccountCreated(address indexed user, address indexed account);
    event WithdrawRecorded(
        address indexed user, address indexed account, uint256 amountUsdc, uint256 destChainId, bytes32 indexed hlTxHash, bool isPrivate
    );
    event RecorderChanged(address recorder);
    event AdminChanged(address admin);

    error NotAdmin();
    error NotRecorder();
    error ZeroAddress();
    error AlreadyRecorded();

    constructor(address recorder_) {
        if (recorder_ == address(0)) revert ZeroAddress();
        admin = msg.sender;
        recorder = recorder_;
        emit AdminChanged(msg.sender);
        emit RecorderChanged(recorder_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @notice The account address a user has, or will have.
    function predictAccount(address user) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), _salt(user), keccak256(abi.encodePacked(type(FlowFlowAccount).creationCode, abi.encode(user))))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice A user makes their own account (the recorder also makes it on their first recorded withdrawal).
    function createAccount() external returns (address) {
        return _accountFor(msg.sender);
    }

    /// @notice Count one withdrawal the user signed in FlowFlow, read on Hyperliquid first.
    function recordWithdraw(address user, uint256 amountUsdc, uint256 destChainId, bytes32 hlTxHash, bool isPrivate) external {
        if (msg.sender != recorder) revert NotRecorder();
        if (user == address(0)) revert ZeroAddress();
        if (recorded[hlTxHash]) revert AlreadyRecorded();
        recorded[hlTxHash] = true;
        address account = _accountFor(user);
        withdrawCount[user] += 1;
        withdrawnUsdc[user] += amountUsdc;
        totalWithdrawals += 1;
        totalWithdrawnUsdc += amountUsdc;
        emit WithdrawRecorded(user, account, amountUsdc, destChainId, hlTxHash, isPrivate);
    }

    function setRecorder(address recorder_) external onlyAdmin {
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
        emit RecorderChanged(recorder_);
    }

    function setAdmin(address admin_) external onlyAdmin {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminChanged(admin_);
    }

    function _salt(address user) private pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    function _accountFor(address user) private returns (address account) {
        account = accountOf[user];
        if (account != address(0)) return account;
        account = address(new FlowFlowAccount{salt: _salt(user)}(user));
        accountOf[user] = account;
        totalAccounts += 1;
        emit AccountCreated(user, account);
    }
}
