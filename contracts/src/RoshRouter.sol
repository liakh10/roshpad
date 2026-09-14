// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RoshMath as M} from "./RoshMath.sol";
import {PoolKey, SwapParams, IPoolManager, Delta} from "./IV4.sol";

interface ILaunchpadR {
    function launchFor(address creator, string calldata name, string calldata symbol, string calldata uri, address pairCoin, uint24 fee, int24 openTick) external returns (address);
    function poolKeyOf(address token) external view returns (PoolKey memory);
    function pairs(address coin) external view returns (address feed, address stockPool, bool enabled);
    function marketIndex(address token) external view returns (uint256);
}

interface IV3PoolR {
    function token0() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title Roshpad router
/// Buys and sells market tokens in one transaction with the pair Stock Token, with USDG, or with ETH.
/// ETH and USDG go through Uniswap v3 (WETH/USDG, then the USDG/Stock Token pool), the last hop through the market's
/// Uniswap v4 pool. `minOut` guards the final amount.
contract RoshRouter {
    IPoolManager public immutable poolManager;
    ILaunchpadR public immutable launchpad;
    address public immutable weth;
    address public immutable usdg;
    address public immutable wethUsdgPool;
    address internal active;

    uint8 internal constant BUY = 0;
    uint8 internal constant SELL = 1;

    event Buy(address indexed token, address indexed buyer, uint8 asset, uint256 amountIn, uint256 tokensOut);
    event Sell(address indexed token, address indexed seller, uint8 asset, uint256 tokensIn, uint256 amountOut);

    constructor(address _poolManager, address _launchpad, address _weth, address _usdg, address _wethUsdgPool) {
        poolManager = IPoolManager(_poolManager);
        launchpad = ILaunchpadR(_launchpad);
        weth = _weth;
        usdg = _usdg;
        wethUsdgPool = _wethUsdgPool;
    }

    receive() external payable {
        require(msg.sender == weth, "eth");
    }

    // ---------------------------------------------------------------- buys (asset 0 = coin, 1 = USDG, 2 = ETH)

    function buyWithCoin(address token, uint256 coinIn, uint256 minOut, address to) external returns (uint256 out) {
        _pull(_coin(token), msg.sender, coinIn);
        out = _buy(token, coinIn, minOut, to);
        emit Buy(token, to, 0, coinIn, out);
    }

    function buyWithUsd(address token, uint256 usdIn, uint256 minOut, address to) external returns (uint256 out) {
        _pull(usdg, msg.sender, usdIn);
        out = _buy(token, _usdToCoin(token, usdIn), minOut, to);
        emit Buy(token, to, 1, usdIn, out);
    }

    function buyWithEth(address token, uint256 minOut, address to) public payable returns (uint256 out) {
        out = _buy(token, _ethToCoin(token, msg.value), minOut, to);
        emit Buy(token, to, 2, msg.value, out);
    }

    /// Launches a market for the caller and, if ETH is sent, makes the first buy in the same transaction.
    function launchAndBuy(string calldata name, string calldata symbol, string calldata uri, address pairCoin, uint24 fee, int24 priceTick, uint256 minOut) external payable returns (address token, uint256 out) {
        token = launchpad.launchFor(msg.sender, name, symbol, uri, pairCoin, fee, priceTick);
        if (msg.value > 0) {
            out = _buy(token, _ethToCoin(token, msg.value), minOut, msg.sender);
            emit Buy(token, msg.sender, 2, msg.value, out);
        }
    }

    // ---------------------------------------------------------------- sells

    function sellForCoin(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        out = _sellToRouter(token, amountIn);
        require(out >= minOut, "min out");
        _send(_coin(token), to, out);
        emit Sell(token, msg.sender, 0, amountIn, out);
    }

    function sellForUsd(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        address coin = _coin(token);
        out = _v3(_stockPool(coin), coin, _sellToRouter(token, amountIn));
        require(out >= minOut, "min out");
        _send(usdg, to, out);
        emit Sell(token, msg.sender, 1, amountIn, out);
    }

    function sellForEth(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        address coin = _coin(token);
        uint256 usd = _v3(_stockPool(coin), coin, _sellToRouter(token, amountIn));
        out = _v3(wethUsdgPool, usdg, usd);
        require(out >= minOut, "min out");
        IWETH(weth).withdraw(out);
        (bool ok,) = to.call{value: out}("");
        require(ok, "eth send");
        emit Sell(token, msg.sender, 2, amountIn, out);
    }

    // ---------------------------------------------------------------- internals

    function _coin(address token) internal view returns (address) {
        require(launchpad.marketIndex(token) > 0, "market");
        PoolKey memory k = launchpad.poolKeyOf(token);
        return k.currency0 == token ? k.currency1 : k.currency0;
    }

    function _stockPool(address coin) internal view returns (address pool) {
        (, pool,) = launchpad.pairs(coin);
    }

    function _ethToCoin(address token, uint256 value) internal returns (uint256) {
        require(value > 0, "zero");
        IWETH(weth).deposit{value: value}();
        uint256 usd = _v3(wethUsdgPool, weth, value);
        return _usdToCoin(token, usd);
    }

    function _usdToCoin(address token, uint256 usd) internal returns (uint256) {
        address coin = _coin(token);
        return _v3(_stockPool(coin), usdg, usd);
    }

    function _buy(address token, uint256 coinIn, uint256 minOut, address to) internal returns (uint256) {
        require(coinIn > 0, "zero");
        return abi.decode(poolManager.unlock(abi.encode(BUY, token, coinIn, minOut, msg.sender, to)), (uint256));
    }

    function _sellToRouter(address token, uint256 amountIn) internal returns (uint256) {
        require(amountIn > 0, "zero");
        require(launchpad.marketIndex(token) > 0, "market");
        return abi.decode(poolManager.unlock(abi.encode(SELL, token, amountIn, uint256(0), msg.sender, address(this))), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pool manager");
        (uint8 kind, address token, uint256 amountIn, uint256 minOut, address payer, address to) = abi.decode(data, (uint8, address, uint256, uint256, address, address));
        PoolKey memory key = launchpad.poolKeyOf(token);
        address coin = key.currency0 == token ? key.currency1 : key.currency0;
        address tokenIn = kind == BUY ? coin : token;
        poolManager.sync(tokenIn);
        if (kind == BUY) _send(coin, address(poolManager), amountIn);
        else _pullTo(token, payer, address(poolManager), amountIn);
        poolManager.settle();
        bool zeroForOne = key.currency0 == tokenIn;
        int256 d = poolManager.swap(key, SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? M.MIN_SQRT + 1 : M.MAX_SQRT - 1), "");
        int128 spent = zeroForOne ? Delta.amount0(d) : Delta.amount1(d);
        int128 got = zeroForOne ? Delta.amount1(d) : Delta.amount0(d);
        require(-int256(spent) == int256(amountIn) && got > 0, "partial fill");
        uint256 out = uint256(int256(got));
        require(out >= minOut, "min out");
        poolManager.take(kind == BUY ? token : coin, to, out);
        return abi.encode(out);
    }

    function _v3(address pool, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        require(pool != address(0) && amountIn > 0, "route");
        bool zeroForOne = IV3PoolR(pool).token0() == tokenIn;
        active = pool;
        (int256 a0, int256 a1) = IV3PoolR(pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? M.MIN_SQRT + 1 : M.MAX_SQRT - 1, abi.encode(tokenIn));
        active = address(0);
        out = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        require(msg.sender == active && active != address(0), "pool");
        address tokenIn = abi.decode(data, (address));
        _send(tokenIn, msg.sender, uint256(a0 > 0 ? a0 : a1));
    }

    function _pull(address token, address from, uint256 amount) internal {
        _pullTo(token, from, address(this), amount);
    }

    function _pullTo(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom");
    }

    function _send(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer");
    }
}
