// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RoshMath as M} from "./RoshMath.sol";
import {PoolKey, ModifyLiquidityParams, IPoolManager, IERC20R, Delta} from "./IV4.sol";

interface IRoshToken {
    function initialize(string calldata name, string calldata symbol, string calldata uri, address pairCoin, address poolManager, address router, address creator) external;
    function addRewards(uint256 amount) external;
    function eligibleSupply() external view returns (uint256);
}

interface IFeedR {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title Roshpad launchpad
/// Launches a token quoted in a Robinhood Stock Token. The full supply goes into two single-sided Uniswap v4 positions
/// owned by this contract: 800M on a curve from a $5,000 to a $35,000 market cap and 200M above it. There is no code
/// path that removes liquidity. Trading fees paid in the Stock Token are split 40% to holders, 30% to the $ROSH
/// buyback and 30% to the protocol; fees paid in the market token are burned.
contract RoshLaunchpad {
    uint256 public constant TOTAL_SUPPLY = 1e27;
    uint256 public constant CURVE_TOKENS = 8e26;
    uint256 public constant RESERVE_TOKENS = 2e26;
    uint256 public constant OPENING_MCAP_USD = 5000;
    uint256 public constant CAP_MULTIPLE = 7;
    int24 public constant TICK_SPACING = 60;
    int24 public constant CURVE_TICKS = 19440;
    int24 internal constant MAX_TICK_60 = 887220;
    uint256 public constant HOLDERS_BPS = 4000;
    uint256 public constant BUYBACK_BPS = 3000;
    uint256 public constant MAX_PRICE_AGE = 7 days;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    address public immutable tokenImpl;
    address public owner;
    address public pendingOwner;
    address public treasury;
    address public buyback;
    address public router;

    /// feed: Chainlink Stock Token / USD. stockPool: Uniswap v3 USDG / Stock Token pool the router uses for USDG and ETH.
    struct Pair {
        address feed;
        address stockPool;
        bool enabled;
    }

    struct Market {
        address token;
        address pairCoin;
        address creator;
        uint24 fee;
        int24 openTick;
        int24 capTick;
        bool tokenIs0;
        uint64 createdAt;
        uint256 pairFees;
        uint256 holderRewards;
        uint256 tokenBurned;
    }

    mapping(address => Pair) public pairs;
    address[] internal _pairList;
    Market[] internal _markets;
    mapping(address => uint256) public marketIndex;

    event PairSet(address indexed coin, address feed, address stockPool, bool enabled);
    event MarketLaunched(address indexed token, address indexed pairCoin, address indexed creator, uint24 fee, int24 openTick, int24 capTick, string name, string symbol, string metadataURI);
    event FeesCollected(address indexed token, uint256 pairFees, uint256 toHolders, uint256 toBuyback, uint256 toProtocol, uint256 tokenBurned);
    event Recipients(address treasury, address buyback);
    event RouterSet(address router);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    constructor(address _poolManager, address _tokenImpl) {
        poolManager = IPoolManager(_poolManager);
        tokenImpl = _tokenImpl;
        owner = msg.sender;
        treasury = msg.sender;
        buyback = msg.sender;
    }

    // ---------------------------------------------------------------- launch

    /// `priceTick` is the tick of the opening price expressed as pair coin per token, rounded down to the 60 spacing.
    /// It is the same number whichever way the pool sorts its currencies, so a launch can be prepared before the token
    /// address is known.
    function launch(string calldata name, string calldata symbol, string calldata uri, address pairCoin, uint24 fee, int24 priceTick) external returns (address) {
        return _launch(msg.sender, name, symbol, uri, pairCoin, fee, priceTick);
    }

    /// Used by the router to launch and make the first buy in one transaction.
    function launchFor(address creator, string calldata name, string calldata symbol, string calldata uri, address pairCoin, uint24 fee, int24 priceTick) external returns (address) {
        require(msg.sender == router, "router");
        return _launch(creator, name, symbol, uri, pairCoin, fee, priceTick);
    }

    function _launch(address creator, string calldata name, string calldata symbol, string calldata uri, address pairCoin, uint24 fee, int24 priceTick) internal returns (address token) {
        require(router != address(0), "no router");
        Pair memory p = pairs[pairCoin];
        require(p.enabled, "pair");
        require(fee == 10000 || fee == 20000 || fee == 30000, "fee");
        uint256 nl = bytes(name).length;
        uint256 sl = bytes(symbol).length;
        require(nl >= 1 && nl <= 40 && sl >= 2 && sl <= 10 && bytes(uri).length <= 300, "text");
        require(priceTick % TICK_SPACING == 0, "spacing");
        require(_priceTickOk(p.feed, priceTick), "open tick");

        token = _clone(tokenImpl);
        IRoshToken(token).initialize(name, symbol, uri, pairCoin, address(poolManager), router, creator);
        bool tokenIs0 = token < pairCoin;
        int24 openTick = tokenIs0 ? priceTick : -priceTick - TICK_SPACING;

        int24 capTick = tokenIs0 ? openTick + CURVE_TICKS : openTick - CURVE_TICKS;
        require(capTick < MAX_TICK_60 && capTick > -MAX_TICK_60, "range");
        PoolKey memory key = PoolKey(tokenIs0 ? token : pairCoin, tokenIs0 ? pairCoin : token, fee, TICK_SPACING, address(0));
        uint160 start = M.sqrtAtTick(openTick);
        poolManager.initialize(key, start);
        poolManager.unlock(abi.encode(uint8(0), key, tokenIs0, openTick, capTick));

        uint256 left = IERC20R(token).balanceOf(address(this));
        if (left > 0) IERC20R(token).transfer(DEAD, left);

        _markets.push(Market(token, pairCoin, creator, fee, openTick, capTick, tokenIs0, uint64(block.timestamp), 0, 0, 0));
        marketIndex[token] = _markets.length;
        emit MarketLaunched(token, pairCoin, creator, fee, openTick, capTick, name, symbol, uri);
    }

    /// The price tick must bracket the Chainlink price of a $5,000 market cap: 5,000 USD / 1B tokens / stock price.
    /// Both tokens use 18 decimals, so the raw price of one token in the pair coin is 500 / answer (8 decimal answer).
    function _priceTickOk(address feed, int24 priceTick) internal view returns (bool) {
        (, int256 a,, uint256 updatedAt,) = IFeedR(feed).latestRoundData();
        require(a > 0 && updatedAt + MAX_PRICE_AGE >= block.timestamp, "price");
        uint256 target = M.sqrt(M.mulDiv(500, 1 << 192, uint256(a)));
        return M.sqrtAtTick(priceTick) <= target && target < M.sqrtAtTick(priceTick + TICK_SPACING);
    }

    // ---------------------------------------------------------------- fees

    /// Collects trading fees of both positions. Anyone can call it.
    function collectFees(address token) external returns (uint256 pairFees, uint256 tokenFees) {
        uint256 idx = marketIndex[token];
        require(idx > 0, "market");
        Market storage m = _markets[idx - 1];
        PoolKey memory key = PoolKey(m.tokenIs0 ? token : m.pairCoin, m.tokenIs0 ? m.pairCoin : token, m.fee, TICK_SPACING, address(0));
        bytes memory res = poolManager.unlock(abi.encode(uint8(1), key, m.tokenIs0, m.openTick, m.capTick));
        (uint256 f0, uint256 f1) = abi.decode(res, (uint256, uint256));
        (tokenFees, pairFees) = m.tokenIs0 ? (f0, f1) : (f1, f0);

        uint256 toHolders = pairFees * HOLDERS_BPS / 10000;
        uint256 toBuyback = pairFees * BUYBACK_BPS / 10000;
        uint256 toProtocol = pairFees - toHolders - toBuyback;
        if (toHolders > 0) {
            if (IRoshToken(token).eligibleSupply() >= 1e18) {
                _send(m.pairCoin, token, toHolders);
                IRoshToken(token).addRewards(toHolders);
            } else {
                toBuyback += toHolders;
                toHolders = 0;
            }
        }
        if (toBuyback > 0) _send(m.pairCoin, buyback, toBuyback);
        if (toProtocol > 0) _send(m.pairCoin, treasury, toProtocol);
        if (tokenFees > 0) _send(token, DEAD, tokenFees);
        m.pairFees += pairFees;
        m.holderRewards += toHolders;
        m.tokenBurned += tokenFees;
        emit FeesCollected(token, pairFees, toHolders, toBuyback, toProtocol, tokenFees);
    }

    // ---------------------------------------------------------------- v4 callback

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pool manager");
        (uint8 action, PoolKey memory key, bool tokenIs0, int24 openTick, int24 capTick) = abi.decode(data, (uint8, PoolKey, bool, int24, int24));
        (int24 cLo, int24 cHi, int24 rLo, int24 rHi) = tokenIs0 ? (openTick, capTick, capTick, MAX_TICK_60) : (capTick, openTick, -MAX_TICK_60, capTick);
        if (action == 0) {
            uint160 s = M.sqrtAtTick(openTick);
            uint256 a0c = tokenIs0 ? CURVE_TOKENS - 2 : 0;
            uint256 a1c = tokenIs0 ? 0 : CURVE_TOKENS - 2;
            uint256 a0r = tokenIs0 ? RESERVE_TOKENS - 2 : 0;
            uint256 a1r = tokenIs0 ? 0 : RESERVE_TOKENS - 2;
            uint128 lc = M.liquidityFor(s, M.sqrtAtTick(cLo), M.sqrtAtTick(cHi), a0c, a1c);
            uint128 lr = M.liquidityFor(s, M.sqrtAtTick(rLo), M.sqrtAtTick(rHi), a0r, a1r);
            (int256 d1,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(cLo, cHi, int256(uint256(lc)), bytes32(0)), "");
            (int256 d2,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(rLo, rHi, int256(uint256(lr)), bytes32(0)), "");
            int256 owed = tokenIs0 ? int256(Delta.amount0(d1)) + Delta.amount0(d2) : int256(Delta.amount1(d1)) + Delta.amount1(d2);
            int256 other = tokenIs0 ? int256(Delta.amount1(d1)) + Delta.amount1(d2) : int256(Delta.amount0(d1)) + Delta.amount0(d2);
            require(owed < 0 && other == 0, "single sided");
            address token = tokenIs0 ? key.currency0 : key.currency1;
            poolManager.sync(token);
            _send(token, address(poolManager), uint256(-owed));
            poolManager.settle();
            return "";
        }
        (int256 e1,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(cLo, cHi, 0, bytes32(0)), "");
        (int256 e2,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(rLo, rHi, 0, bytes32(0)), "");
        int256 t0 = int256(Delta.amount0(e1)) + Delta.amount0(e2);
        int256 t1 = int256(Delta.amount1(e1)) + Delta.amount1(e2);
        uint256 f0 = t0 > 0 ? uint256(t0) : 0;
        uint256 f1 = t1 > 0 ? uint256(t1) : 0;
        if (f0 > 0) poolManager.take(key.currency0, address(this), f0);
        if (f1 > 0) poolManager.take(key.currency1, address(this), f1);
        return abi.encode(f0, f1);
    }

    // ---------------------------------------------------------------- admin

    struct PairInit {
        address coin;
        address feed;
        address stockPool;
        bool enabled;
    }

    function setPairs(PairInit[] calldata list) external onlyOwner {
        for (uint256 i = 0; i < list.length; i++) {
            PairInit calldata p = list[i];
            require(IERC20R(p.coin).decimals() == 18, "decimals");
            if (pairs[p.coin].feed == address(0)) _pairList.push(p.coin);
            pairs[p.coin] = Pair(p.feed, p.stockPool, p.enabled);
            emit PairSet(p.coin, p.feed, p.stockPool, p.enabled);
        }
    }

    function setRouter(address _router) external onlyOwner {
        router = _router;
        emit RouterSet(_router);
    }

    function setRecipients(address _treasury, address _buyback) external onlyOwner {
        require(_treasury != address(0) && _buyback != address(0), "zero");
        treasury = _treasury;
        buyback = _buyback;
        emit Recipients(_treasury, _buyback);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "pending");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- views

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 i) external view returns (Market memory) {
        return _markets[i];
    }

    function marketOf(address token) external view returns (Market memory m) {
        uint256 idx = marketIndex[token];
        if (idx > 0) m = _markets[idx - 1];
    }

    function markets(uint256 from, uint256 count) external view returns (Market[] memory list) {
        uint256 n = _markets.length;
        if (from >= n) return new Market[](0);
        uint256 end = from + count > n ? n : from + count;
        list = new Market[](end - from);
        for (uint256 i = from; i < end; i++) list[i - from] = _markets[i];
    }

    function pairList() external view returns (address[] memory) {
        return _pairList;
    }

    function poolKeyOf(address token) public view returns (PoolKey memory key) {
        uint256 idx = marketIndex[token];
        require(idx > 0, "market");
        Market storage m = _markets[idx - 1];
        key = PoolKey(m.tokenIs0 ? token : m.pairCoin, m.tokenIs0 ? m.pairCoin : token, m.fee, TICK_SPACING, address(0));
    }

    // ---------------------------------------------------------------- internals

    function _send(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer");
    }

    function _clone(address impl) internal returns (address inst) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            inst := create(0, ptr, 0x37)
        }
        require(inst != address(0), "clone");
    }
}
