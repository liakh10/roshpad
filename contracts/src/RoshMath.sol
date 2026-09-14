// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Uniswap v3 math ported to 0.8 (TickMath, FullMath, LiquidityAmounts) plus the helpers Roshpad needs.
library RoshMath {
    uint256 internal constant Q96 = 0x1000000000000000000000000;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT = 4295128739;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;

    /// floor(a*b/d) with full 512-bit precision
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(d > 0);
                assembly ("memory-safe") { result := div(prod0, d) }
                return result;
            }
            require(d > prod1);
            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly ("memory-safe") {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }

    function mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 r) {
        r = mulDiv(a, b, d);
        if (mulmod(a, b, d) > 0) r++;
    }

    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        unchecked {
            uint256 xx = x;
            uint256 r = 1;
            if (xx >= 1 << 128) { xx >>= 128; r <<= 64; }
            if (xx >= 1 << 64) { xx >>= 64; r <<= 32; }
            if (xx >= 1 << 32) { xx >>= 32; r <<= 16; }
            if (xx >= 1 << 16) { xx >>= 16; r <<= 8; }
            if (xx >= 1 << 8) { xx >>= 8; r <<= 4; }
            if (xx >= 1 << 4) { xx >>= 4; r <<= 2; }
            if (xx >= 1 << 2) { r <<= 1; }
            r = (r + x / r) >> 1; r = (r + x / r) >> 1; r = (r + x / r) >> 1; r = (r + x / r) >> 1;
            r = (r + x / r) >> 1; r = (r + x / r) >> 1; r = (r + x / r) >> 1;
            uint256 r1 = x / r;
            z = r < r1 ? r : r1;
        }
    }

    function sqrtAtTick(int24 tick) internal pure returns (uint160) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)), "T");
            uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) ratio = type(uint256).max / ratio;
            return uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// liquidity for amounts in a range at price s
    function liquidityFor(uint160 s, uint160 sa, uint160 sb, uint256 a0, uint256 a1) internal pure returns (uint128) {
        uint256 l;
        if (s <= sa) {
            l = mulDiv(a0, mulDiv(sa, sb, Q96), sb - sa);
        } else if (s < sb) {
            uint256 l0 = mulDiv(a0, mulDiv(s, sb, Q96), sb - s);
            uint256 l1 = mulDiv(a1, Q96, s - sa);
            l = l0 < l1 ? l0 : l1;
        } else {
            l = mulDiv(a1, Q96, sb - sa);
        }
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    /// token amounts held by liquidity l in a range at price s (rounded down)
    function amountsFor(uint160 s, uint160 sa, uint160 sb, uint128 l) internal pure returns (uint256 a0, uint256 a1) {
        if (s <= sa) {
            a0 = mulDiv(uint256(l) << 96, sb - sa, sb) / sa;
        } else if (s < sb) {
            a0 = mulDiv(uint256(l) << 96, sb - s, sb) / s;
            a1 = mulDiv(l, s - sa, Q96);
        } else {
            a1 = mulDiv(l, sb - sa, Q96);
        }
    }

    /// share of total value (in token1 terms, 1e18 = 100%) that a position in [sa, sb) holds as token1 at price s
    function token1Share(uint160 s, uint160 sa, uint160 sb) internal pure returns (uint256) {
        if (s <= sa) return 0;
        if (s >= sb) return 1e18;
        uint256 v1 = uint256(s - sa);
        uint256 v0 = mulDiv(uint256(sb - s), s, sb);
        return mulDiv(v1, 1e18, v0 + v1);
    }

    /// value of token0 amount expressed in token1 at sqrt price s
    function toToken1(uint256 a0, uint160 s) internal pure returns (uint256) {
        return mulDiv(mulDiv(a0, s, Q96), s, Q96);
    }

    /// value of token1 amount expressed in token0 at sqrt price s
    function toToken0(uint256 a1, uint160 s) internal pure returns (uint256) {
        return mulDiv(mulDiv(a1, Q96, s), Q96, s);
    }
}
