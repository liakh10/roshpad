/* Roshpad data layer: markets from the launchpad, prices from the Uniswap v4 StateView and Chainlink, uncollected fees
   from position fee growth, 24h volume from PoolManager Swap logs, the wallet's balances and rewards, and every action.
   Loaded as an ES module next to wallet.js. */
import { pub, state as wallet, send } from './wallet.js';
import { erc20Abi, maxUint256, parseUnits, parseEther, parseAbi, encodeAbiParameters, keccak256 } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

export const LAUNCHPAD = /^0x[0-9a-fA-F]{40}$/.test(window.ROSH_LAUNCHPAD || '') ? window.ROSH_LAUNCHPAD : null;
export const ROUTER = /^0x[0-9a-fA-F]{40}$/.test(window.ROSH_ROUTER || '') ? window.ROSH_ROUTER : null;
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const SV = parseAbi([
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
  'function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)',
  'function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128,uint256,uint256)'
]);
const SWAP = parseAbi(['event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'])[0];
const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0];
const ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const Q128 = 1n << 128n, M256 = 1n << 256n;
const CURVE_TICKS = 19440;

let A = null;
export async function abis() {
  if (A) return A;
  const get = async n => { for (let i = 0; i < 3; i++) { try { const r = await fetch('/lib/' + n + '?v=1'); if (r.ok) return r.json(); } catch {} await new Promise(r => setTimeout(r, 400 * (i + 1))); } throw Error('Could not load ' + n); };
  const [T, L, R, P, C] = await Promise.all(['abi/RoshToken.json', 'abi/RoshLaunchpad.json', 'abi/RoshRouter.json', 'pairs.json', 'chain.json'].map(get));
  A = { T: T.abi, L: L.abi, R: R.abi, pairs: P, chain: C, pairBy: Object.fromEntries(P.map(p => [p.coin.toLowerCase(), p])) };
  return A;
}

export const poolId = k => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const nowSec = () => Math.floor(Date.now() / 1000);

/* Chainlink USD prices for every listed Stock Token and ETH */
export async function prices() {
  const { pairs } = await abis();
  const r = await pub.multicall({ allowFailure: true, contracts: [{ address: ETH_USD, abi: FEED, functionName: 'latestRoundData' }, ...pairs.map(p => ({ address: p.feed, abi: FEED, functionName: 'latestRoundData' }))] });
  const out = { ETH: r[0].result ? Number(r[0].result[1]) / 1e8 : null, updated: {} };
  pairs.forEach((p, i) => { const x = r[i + 1].result; out[p.coin.toLowerCase()] = x ? Number(x[1]) / 1e8 : null; out.updated[p.coin.toLowerCase()] = x ? Number(x[3]) : 0; out['raw:' + p.coin.toLowerCase()] = x ? x[1] : 0n; });
  return out;
}

/* every market with live price, market cap, curve progress, rewards totals and uncollected fees */
export async function loadMarkets() {
  if (!LAUNCHPAD) return [];
  const { T, L, chain, pairBy } = await abis();
  const n = Number(await pub.readContract({ address: LAUNCHPAD, abi: L, functionName: 'marketCount' }));
  if (!n) return [];
  let list = [];
  for (let i = 0; i < n; i += 200) list = list.concat(await pub.readContract({ address: LAUNCHPAD, abi: L, functionName: 'markets', args: [BigInt(i), 200n] }));
  const px = await prices();
  const rows = list.map(m => {
    const key = { currency0: m.tokenIs0 ? m.token : m.pairCoin, currency1: m.tokenIs0 ? m.pairCoin : m.token, fee: m.fee, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' };
    const [cLo, cHi, rLo, rHi] = m.tokenIs0 ? [m.openTick, m.capTick, m.capTick, 887220] : [m.capTick, m.openTick, -887220, m.capTick];
    const pair = pairBy[m.pairCoin.toLowerCase()] || { symbol: '?', name: 'Unknown' };
    return { ...m, key, id: poolId(key), ranges: [[cLo, cHi], [rLo, rHi]], pair, coinUsd: px[m.pairCoin.toLowerCase()], createdAt: Number(m.createdAt) };
  });
  const calls = rows.flatMap(r => [
    { address: r.token, abi: T, functionName: 'name' }, { address: r.token, abi: T, functionName: 'symbol' }, { address: r.token, abi: T, functionName: 'metadataURI' },
    { address: r.token, abi: T, functionName: 'eligibleSupply' }, { address: r.token, abi: T, functionName: 'totalRewards' }, { address: r.token, abi: T, functionName: 'totalClaimed' },
    { address: chain.stateView, abi: SV, functionName: 'getSlot0', args: [r.id] },
    ...r.ranges.flatMap(([lo, hi]) => [
      { address: chain.stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [r.id, lo, hi] },
      { address: chain.stateView, abi: SV, functionName: 'getPositionInfo', args: [r.id, LAUNCHPAD, lo, hi, '0x' + '0'.repeat(64)] }
    ])
  ]);
  const res = await pub.multicall({ allowFailure: true, contracts: calls });
  const W = 11;
  rows.forEach((r, i) => {
    const g = k => res[i * W + k].result;
    r.name = g(0) || ''; r.symbol = g(1) || ''; r.uri = g(2) || ''; r.eligible = g(3) || 0n; r.totalRewards = g(4) || 0n; r.totalClaimed = g(5) || 0n;
    const s0 = g(6);
    r.tick = s0 ? s0[1] : r.openTick;
    const s = s0 ? Number(s0[0]) / 2 ** 96 : 0, raw = s * s;
    r.priceCoin = s0 ? (r.tokenIs0 ? raw : 1 / raw) : 0;
    r.priceUsd = r.coinUsd ? r.priceCoin * r.coinUsd : null;
    r.mcapUsd = r.priceUsd != null ? r.priceUsd * 1e9 : null;
    const moved = r.tokenIs0 ? r.tick - r.openTick : r.openTick - r.tick;
    r.progress = Math.max(0, moved / CURVE_TICKS);
    let unc0 = 0n, unc1 = 0n;
    for (let k = 0; k < 2; k++) {
      const inside = g(7 + k * 2), pos = g(8 + k * 2);
      if (!inside || !pos) continue;
      unc0 += pos[0] * ((inside[0] - pos[1] + M256) % M256) / Q128;
      unc1 += pos[0] * ((inside[1] - pos[2] + M256) % M256) / Q128;
    }
    r.uncollectedCoin = r.tokenIs0 ? unc1 : unc0;
    r.uncollectedToken = r.tokenIs0 ? unc0 : unc1;
    r.pairFeesTotal = r.pairFees + r.uncollectedCoin;
    r.holderPaidUsd = r.coinUsd ? Number(r.holderRewards) / 1e18 * r.coinUsd : 0;
    r.pendingHoldersUsd = r.coinUsd ? Number(r.uncollectedCoin) * 0.4 / 1e18 * r.coinUsd : 0;
  });
  return rows;
}

/* token metadata JSON (cached) */
const metaCache = new Map();
export async function meta(uri) {
  if (!uri || !/^https?:\/\//.test(uri)) return null;
  if (!metaCache.has(uri)) metaCache.set(uri, fetch(uri).then(r => r.ok ? r.json() : null).catch(() => null));
  return metaCache.get(uri);
}

/* adaptive getLogs: the Robinhood RPC returns at most 10,000 logs per query */
async function logs(q) {
  const out = [];
  let from = q.fromBlock, span = 200000n;
  while (from <= q.toBlock) {
    const to = from + span - 1n > q.toBlock ? q.toBlock : from + span - 1n;
    try { out.push(...await pub.getLogs({ ...q, fromBlock: from, toBlock: to })); from = to + 1n; if (span < 200000n) span *= 2n; }
    catch (e) { if (span > 16n) { span /= 2n; continue; } throw e; }
  }
  return out;
}
let rate = null;
export async function blockAt(secondsAgo) {
  const head = await pub.getBlock();
  if (!rate) { const past = await pub.getBlock({ blockNumber: head.number - 400000n }); rate = 400000 / Math.max(1, Number(head.timestamp - past.timestamp)); }
  const back = BigInt(Math.ceil(Math.max(0, secondsAgo) * rate));
  return { head: head.number, headTime: Number(head.timestamp), from: head.number > back ? head.number - back : 0n, rate };
}

/* 24h volume per market and recent trades (buy = token leaves the pool) */
export async function activity(rows, seconds = 86400) {
  if (!rows.length) return {};
  const { chain } = await abis();
  const { head, headTime, from, rate: r } = await blockAt(seconds);
  const found = await logs({ address: chain.poolManager, event: SWAP, args: { id: rows.map(x => x.id) }, fromBlock: from, toBlock: head });
  const out = Object.fromEntries(rows.map(x => [x.id, { volumeUsd: 0, trades: [] }]));
  for (const l of found) {
    const row = rows.find(x => x.id === l.args.id); if (!row) continue;
    const a0 = l.args.amount0, a1 = l.args.amount1;
    const tokenDelta = row.tokenIs0 ? a0 : a1, coinDelta = row.tokenIs0 ? a1 : a0;
    const coin = Number(coinDelta < 0n ? -coinDelta : coinDelta) / 1e18;
    const usd = row.coinUsd ? coin * row.coinUsd : 0;
    out[row.id].volumeUsd += usd;
    out[row.id].trades.push({ side: tokenDelta > 0n ? 'buy' : 'sell', tokens: Number(tokenDelta < 0n ? -tokenDelta : tokenDelta) / 1e18, coin, usd, sender: l.args.sender, block: l.blockNumber, time: headTime - Number(head - l.blockNumber) / r, tx: l.transactionHash });
  }
  for (const k in out) out[k].trades.reverse();
  return out;
}

/* holders of a token from Transfer logs, largest first */
export async function holders(row) {
  const { T } = await abis();
  const { head, from } = await blockAt(nowSec() - row.createdAt + 600);
  const found = await logs({ address: row.token, event: TRANSFER, fromBlock: from, toBlock: head });
  const set = new Set();
  for (const l of found) { set.add(l.args.to); set.add(l.args.from); }
  const list = [...set].filter(a => !/^0x0+$/.test(a));
  if (!list.length) return [];
  const res = await pub.multicall({ allowFailure: true, contracts: list.flatMap(a => [{ address: row.token, abi: T, functionName: 'balanceOf', args: [a] }, { address: row.token, abi: T, functionName: 'claimable', args: [a] }, { address: row.token, abi: T, functionName: 'excluded', args: [a] }]) });
  return list.map((a, i) => ({ address: a, balance: res[3 * i].result || 0n, claimable: res[3 * i + 1].result || 0n, excluded: !!res[3 * i + 2].result }))
    .filter(h => !h.excluded && (h.balance > 0n || h.claimable > 0n)).sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0));
}

/* wallet balances: ETH, USDG, pair coins, market tokens and claimable rewards */
export async function loadUser(rows, me) {
  const { T, pairs, chain } = await abis();
  const coins = pairs.map(p => p.coin);
  const res = await pub.multicall({ allowFailure: true, contracts: [
    { address: chain.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [me] },
    ...coins.map(c => ({ address: c, abi: erc20Abi, functionName: 'balanceOf', args: [me] })),
    ...rows.flatMap(r => [{ address: r.token, abi: T, functionName: 'balanceOf', args: [me] }, { address: r.token, abi: T, functionName: 'claimable', args: [me] }])
  ] });
  const eth = await pub.getBalance({ address: me }).catch(() => 0n);
  const u = { eth, usdg: res[0].result || 0n, coins: {}, tokens: {}, claimable: {}, rewardsUsd: 0, holdingsUsd: 0 };
  coins.forEach((c, i) => u.coins[c.toLowerCase()] = res[1 + i].result || 0n);
  rows.forEach((r, i) => {
    const b = res[1 + coins.length + 2 * i].result || 0n, c = res[2 + coins.length + 2 * i].result || 0n;
    u.tokens[r.token] = b; u.claimable[r.token] = c;
    if (r.coinUsd) u.rewardsUsd += Number(c) / 1e18 * r.coinUsd;
    if (r.priceUsd) u.holdingsUsd += Number(b) / 1e18 * r.priceUsd;
  });
  return u;
}

/* the price tick of a $5,000 opening market cap: pair coin per token = 500 / Chainlink answer, rounded down to 60 */
export async function priceTick(coin) {
  const { pairBy } = await abis();
  const p = pairBy[coin.toLowerCase()];
  const [, a] = await pub.readContract({ address: p.feed, abi: FEED, functionName: 'latestRoundData' });
  const t = Math.floor(Math.log(500 / Number(a)) / Math.log(1.0001));
  return Math.floor(t / 60) * 60;
}

// ---------------------------------------------------------------- actions

const me = () => { const w = wallet(); if (!w.address) throw Error('Connect a wallet first'); return w.address; };
const DUMMY = '0x000000000000000000000000000000000000beef';

async function approve(token, amount, onStep) {
  const a = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me(), ROUTER] });
  if (a >= amount) return;
  onStep && onStep('Approve in wallet');
  const t = await send({ address: token, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] });
  onStep && onStep('Approving');
  await t.wait();
}
async function run(call, onStep) {
  onStep && onStep('Confirm in wallet');
  const t = await send(call);
  onStep && onStep('Waiting for Robinhood Chain');
  const rc = await t.wait();
  if (rc.status !== 'success') throw Error('Transaction reverted');
  return rc;
}

/* asset: 'eth' | 'usd' | 'coin'. Amount is a decimal string in that asset. */
export const parseAsset = (asset, text) => asset === 'usd' ? parseUnits(String(text), 6) : parseEther(String(text));
const BUY_FN = { eth: 'buyWithEth', usd: 'buyWithUsd', coin: 'buyWithCoin' };
const SELL_FN = { eth: 'sellForEth', usd: 'sellForUsd', coin: 'sellForCoin' };

/* quote by simulating the router. ETH buys simulate from any account with a balance override; USDG and coin buys from
   the connected wallet when it already has balance and allowance, otherwise through the ETH route at Chainlink prices */
export async function quoteBuy(row, asset, amount, px) {
  const { R, chain } = await abis();
  const w = wallet().address;
  const simEth = async (value, from) => (await pub.simulateContract({ account: from, address: ROUTER, abi: R, functionName: 'buyWithEth', args: [row.token, 0n, from], value, stateOverride: [{ address: from, balance: value * 2n + parseEther('1') }] })).result;
  if (asset === 'eth') return { out: await simEth(amount, w || DUMMY), exact: true };
  const token = asset === 'usd' ? chain.usdg : row.pairCoin;
  if (w) {
    const [b, a] = await Promise.all([pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w] }), pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [w, ROUTER] })]);
    if (b >= amount && a >= amount) return { out: (await pub.simulateContract({ account: w, address: ROUTER, abi: R, functionName: BUY_FN[asset], args: [row.token, amount, 0n, w] })).result, exact: true };
  }
  const usd = asset === 'usd' ? Number(amount) / 1e6 : Number(amount) / 1e18 * row.coinUsd;
  if (!px.ETH) throw Error('No ETH price');
  return { out: await simEth(parseEther((usd / px.ETH).toFixed(18)), w || DUMMY), exact: false };
}

export async function quoteSell(row, asset, amount) {
  const { R } = await abis();
  const w = me();
  return (await pub.simulateContract({ account: w, address: ROUTER, abi: R, functionName: SELL_FN[asset], args: [row.token, amount, 0n, w] })).result;
}

export async function buy(row, asset, amount, slippageBps, onStep) {
  const { R, chain } = await abis();
  const w = me();
  if (asset !== 'eth') await approve(asset === 'usd' ? chain.usdg : row.pairCoin, amount, onStep);
  onStep && onStep('Quoting');
  const sim = await pub.simulateContract({ account: w, address: ROUTER, abi: R, functionName: BUY_FN[asset], args: asset === 'eth' ? [row.token, 0n, w] : [row.token, amount, 0n, w], value: asset === 'eth' ? amount : 0n });
  const minOut = sim.result * BigInt(10000 - slippageBps) / 10000n;
  return run({ address: ROUTER, abi: R, functionName: BUY_FN[asset], args: asset === 'eth' ? [row.token, minOut, w] : [row.token, amount, minOut, w], value: asset === 'eth' ? amount : 0n }, onStep);
}

export async function sell(row, asset, amount, slippageBps, onStep) {
  const { R } = await abis();
  const w = me();
  onStep && onStep('Quoting');
  const out = await quoteSell(row, asset, amount);
  const minOut = out * BigInt(10000 - slippageBps) / 10000n;
  return run({ address: ROUTER, abi: R, functionName: SELL_FN[asset], args: [row.token, amount, minOut, w] }, onStep);
}

/* launch with an optional first buy in ETH; returns the receipt and the new token address */
export async function launch({ name, symbol, uri, coin, fee, ethAmount }, onStep) {
  const { R, L } = await abis();
  const w = me();
  onStep && onStep('Reading Chainlink');
  let tick = await priceTick(coin), sim = null, lastErr = null;
  for (const t of [tick, tick - 60, tick + 60]) {
    try { sim = await pub.simulateContract({ account: w, address: ROUTER, abi: R, functionName: 'launchAndBuy', args: [name, symbol, uri, coin, fee, t, 0n], value: ethAmount }); tick = t; break; }
    catch (e) { lastErr = e; if (!/open tick/.test(String(e.shortMessage || e.message))) throw e; }
  }
  if (!sim) throw lastErr;
  const minOut = sim.result[1] * 95n / 100n;
  const rc = await run({ address: ROUTER, abi: R, functionName: 'launchAndBuy', args: [name, symbol, uri, coin, fee, tick, minOut], value: ethAmount }, onStep);
  const ev = parseAbi(['event MarketLaunched(address indexed token, address indexed pairCoin, address indexed creator, uint24 fee, int24 openTick, int24 capTick, string name, string symbol, string metadataURI)'])[0];
  const topic = keccak256(new TextEncoder().encode('MarketLaunched(address,address,address,uint24,int24,int24,string,string,string)'));
  const log = rc.logs.find(l => l.address.toLowerCase() === LAUNCHPAD.toLowerCase() && l.topics[0] === topic);
  const token = log ? '0x' + log.topics[1].slice(26) : null;
  return { rc, token, ev };
}

export const collectFees = async (row, onStep) => run({ address: LAUNCHPAD, abi: (await abis()).L, functionName: 'collectFees', args: [row.token] }, onStep);
export const claim = async (row, onStep) => run({ address: row.token, abi: (await abis()).T, functionName: 'claim' }, onStep);
export async function pushClaims(row, list, onStep) {
  const { T } = await abis();
  const who = list.filter(h => h.claimable > 0n).map(h => h.address).slice(0, 120);
  if (!who.length) throw Error('Nobody has rewards to push right now');
  return run({ address: row.token, abi: T, functionName: 'claimFor', args: [who] }, onStep);
}

export async function uploadMeta(fields) {
  const r = await fetch('/api/meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Upload failed');
  return j;
}
