// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Roshpad market token
/// Fixed 1B supply minted to the Launchpad, which puts all of it into permanent Uniswap v4 liquidity.
/// Holders accrue the pair Stock Token: every fee collection adds rewards per eligible token, and any wallet can
/// claim for itself or push claims to a list of holders. Pool, Launchpad, router and dead address never accrue.
contract RoshToken {
    uint256 public constant totalSupply = 1e27;
    uint8 public constant decimals = 18;
    uint256 internal constant MAG = 2 ** 128;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    string public name;
    string public symbol;
    string public metadataURI;
    address public launchpad;
    address public router;
    address public pairCoin;
    address public poolManager;
    address public creator;
    uint64 public createdAt;
    bool internal initialized;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public rewardPerShare;
    uint256 public eligibleSupply;
    uint256 public totalRewards;
    uint256 public totalClaimed;
    mapping(address => int256) internal corrections;
    mapping(address => uint256) public claimed;
    mapping(address => bool) public excluded;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event RewardsAdded(uint256 amount, uint256 rewardPerShare, uint256 eligibleSupply);
    event RewardClaimed(address indexed holder, address indexed caller, uint256 amount);

    constructor() {
        initialized = true;
    }

    function initialize(string calldata _name, string calldata _symbol, string calldata _uri, address _pairCoin, address _poolManager, address _router, address _creator) external {
        require(!initialized, "init");
        initialized = true;
        launchpad = msg.sender;
        name = _name;
        symbol = _symbol;
        metadataURI = _uri;
        pairCoin = _pairCoin;
        poolManager = _poolManager;
        router = _router;
        creator = _creator;
        createdAt = uint64(block.timestamp);
        excluded[msg.sender] = true;
        excluded[_poolManager] = true;
        excluded[_router] = true;
        excluded[DEAD] = true;
        excluded[address(this)] = true;
        excluded[address(0)] = true;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    // ---------------------------------------------------------------- ERC-20

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// The Roshpad router moves tokens without an allowance, so selling needs no approval transaction.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != router) {
            uint256 a = allowance[from][msg.sender];
            if (a != type(uint256).max) {
                require(a >= amount, "allowance");
                allowance[from][msg.sender] = a - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "to");
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        unchecked { balanceOf[from] = b - amount; }
        balanceOf[to] += amount;
        bool ef = excluded[from];
        bool et = excluded[to];
        int256 m = int256(rewardPerShare * amount);
        if (!ef) corrections[from] += m;
        if (!et) corrections[to] -= m;
        if (ef && !et) eligibleSupply += amount;
        else if (!ef && et) eligibleSupply -= amount;
        emit Transfer(from, to, amount);
    }

    // ---------------------------------------------------------------- rewards

    /// Called by the Launchpad after it has transferred `amount` of the pair coin to this contract.
    function addRewards(uint256 amount) external {
        require(msg.sender == launchpad, "launchpad");
        require(eligibleSupply >= 1e18, "no holders");
        rewardPerShare += amount * MAG / eligibleSupply;
        totalRewards += amount;
        emit RewardsAdded(amount, rewardPerShare, eligibleSupply);
    }

    function claimable(address holder) public view returns (uint256) {
        if (excluded[holder]) return 0;
        int256 acc = int256(rewardPerShare * balanceOf[holder]) + corrections[holder];
        uint256 total = acc > 0 ? uint256(acc) / MAG : 0;
        uint256 c = claimed[holder];
        return total > c ? total - c : 0;
    }

    function claim() external returns (uint256) {
        return _claim(msg.sender);
    }

    /// Pays every listed holder what they have accrued. Anyone can call it; a holder whose transfer fails is skipped.
    function claimFor(address[] calldata holders) external returns (uint256 paid) {
        for (uint256 i = 0; i < holders.length; i++) paid += _claim(holders[i]);
    }

    function _claim(address holder) internal returns (uint256 amount) {
        amount = claimable(holder);
        if (amount == 0) return 0;
        claimed[holder] += amount;
        totalClaimed += amount;
        (bool ok, bytes memory data) = pairCoin.call(abi.encodeWithSelector(0xa9059cbb, holder, amount));
        if (!(ok && (data.length == 0 || abi.decode(data, (bool))))) {
            claimed[holder] -= amount;
            totalClaimed -= amount;
            return 0;
        }
        emit RewardClaimed(holder, msg.sender, amount);
    }
}
