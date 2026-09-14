/* For each Stock Token with a Chainlink feed: the deepest native-ETH Uniswap v4 pool whose price agrees with Chainlink (ETH/USD × stock/USD). */
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, encodeAbiParameters, keccak256, getAddress } from 'viem';
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const chain = { id: 4663, name: 'rh', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const SVA = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const ETHUSD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const TIERS = [{ fee: 100, tickSpacing: 1 }, { fee: 500, tickSpacing: 10 }, { fee: 3000, tickSpacing: 60 }, { fee: 10000, tickSpacing: 200 }];
const id = (t, tier) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], ['0x0000000000000000000000000000000000000000', t, tier.fee, tier.tickSpacing, '0x0000000000000000000000000000000000000000']));
const stocks = JSON.parse(fs.readFileSync('data/stocks_v3.json', 'utf8'));
const eth = await pub.readContract({ address: ETHUSD, abi: FEED, functionName: 'latestRoundData' });
const ethUsd = Number(eth[1]) / 1e8;
console.log('ETH/USD', ethUsd);
const out = [];
for (const s of stocks) {
  const r = await pub.multicall({ allowFailure: true, contracts: [{ address: s.feed, abi: FEED, functionName: 'latestRoundData' }, ...TIERS.flatMap(t => [{ address: SV, abi: SVA, functionName: 'getSlot0', args: [id(s.stock, t)] }, { address: SV, abi: SVA, functionName: 'getLiquidity', args: [id(s.stock, t)] }])] });
  const usd = Number(r[0].result[1]) / 1e8;
  let best = null;
  TIERS.forEach((t, i) => {
    const s0 = r[1 + 2 * i].result, L = r[2 + 2 * i].result || 0n;
    if (!s0 || s0[0] === 0n || L === 0n) return;
    const sq = Number(s0[0]) / 2 ** 96, stockPerEth = sq * sq, poolUsd = ethUsd / stockPerEth;
    const dev = Math.abs(poolUsd / usd - 1);
    const depthEth = 2 * Number(L) / sq / 1e18;
    const row = { fee: t.fee, tickSpacing: t.tickSpacing, poolUsd: +poolUsd.toFixed(2), dev: +dev.toFixed(4), depthEth: +depthEth.toFixed(3) };
    if (dev < 0.05 && (!best || row.depthEth > best.depthEth)) best = row;
  });
  console.log(s.symbol, usd, best ? `${best.fee} dev ${best.dev} depth ${best.depthEth} ETH` : 'NO HEALTHY ETH POOL');
  out.push({ symbol: s.symbol, name: s.name, stock: getAddress(s.stock), feed: s.feed, heartbeat: s.heartbeat, usd, eth: best });
}
fs.writeFileSync('data/pairs.json', JSON.stringify(out, null, 1));
