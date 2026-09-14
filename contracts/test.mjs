/* Runs Roshpad against a fork of Robinhood Chain mainnet (ethereumjs VM + RPCStateManager): the real Uniswap v4
   PoolManager, Uniswap v3 WETH/USDG and USDG/Stock Token pools, USDG, WETH, Stock Tokens and Chainlink feeds.
   Calls go through evm.runCall from arbitrary callers, so no keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes, bigIntToBytes, setLengthLeft } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, encodeDeployData, encodeAbiParameters, keccak256, parseAbi, formatUnits, formatEther, getAddress } from 'viem';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
/* the public RPC throttles bursts: the fork's state loader sees an error body as a missing account, so retry here */
const realFetch = globalThis.fetch;
let rpcRetries = 0;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(RPC)) return realFetch(url, opts);
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const text = await (await realFetch(url, opts)).text();
      const j = JSON.parse(text);
      if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
      last = JSON.stringify(j.error || j);
    } catch (e) { last = e.message; }
    rpcRetries++;
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed after retries: ' + last);
};

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const TOKEN = art('RoshToken'), LP = art('RoshLaunchpad'), ROUTER = art('RoshRouter');
const ALL = [...TOKEN.abi, ...LP.abi, ...ROUTER.abi].filter((x, i, a) => x.type !== 'event' || a.findIndex(y => y.type === 'event' && y.name === x.name) === i);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const SV = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
const C = JSON.parse(fs.readFileSync(path.join(dir, '..', 'lib', 'chain.json'), 'utf8'));
const PAIRS = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, '..', 'lib', 'pairs.json'), 'utf8')).map(p => [p.symbol, p]));
const DEAD = '0x000000000000000000000000000000000000dEaD';

const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const head = await rpc('eth_getBlockByNumber', ['latest', false]);
const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
/* RPCStateManager 2.x clears the whole code cache on any revert and never commits storage checkpoints: keep a stack of
   code snapshots and balance the storage journal. Robinhood nodes keep only recent state, so read at latest. */
class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}
const stateManager = new ForkState({ provider: RPC, blockTag: BigInt(head.number) });
stateManager._blockTag = 'latest';
const vm = await VM.create({ common, stateManager });
let now = BigInt(Math.floor(Date.now() / 1000)) + 600n;
const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL', label, extra); } };
const near = (a, b, bps, label) => { const d = a > b ? a - b : b - a; const base = b < 0n ? -b : b; ok(d * 10000n <= base * BigInt(bps) || d <= 10n, label, `${a} vs ${b} (±${bps}bps)`); };
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));

async function exec(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 30_000_000n, value, block: block() });
  const e = r.execResult;
  let reason = null;
  if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue); } }
  const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: ALL, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
  return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed, created: r.createdAddress ? getAddress(r.createdAddress.toString()) : null };
}
async function tx(from, to, abi, functionName, args = [], value = 0n) {
  const r = await exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
  if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
  return r;
}
async function must(from, to, abi, fn, args = [], label = fn, value = 0n) {
  const r = await tx(from, to, abi, fn, args, value);
  ok(!r.reverted, label, r.reason || '');
  if (r.reverted) console.log('  ', label, 'reverted:', r.reason);
  return r;
}
async function reverts(from, to, abi, fn, args, expect, label, value = 0n) {
  const r = await tx(from, to, abi, fn, args, value);
  ok(r.reverted && (!expect || String(r.reason).includes(expect)), label, `reverted=${r.reverted} reason=${r.reason}`);
}
const view = async (to, abi, fn, args = []) => {
  const r = await tx(addr(1), to, abi, fn, args);
  if (r.reverted) throw Error(`${fn} reverted: ${r.reason}`);
  return r.result;
};
const bal = (token, who) => view(token, ERC20, 'balanceOf', [who]);
const ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;
async function giveEth(who, wei) {
  const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account();
  acct.balance = wei;
  await vm.stateManager.putAccount(a, acct);
}
async function deploy(from, a, args = []) {
  const r = await exec(from, null, args.length ? encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) : a.bytecode);
  if (r.reverted) throw Error('deploy failed ' + a.contractName + ' ' + r.reason);
  /* runCall does not bump the creator nonce like a real tx would */
  const who = Address.fromString(from), acct = (await vm.stateManager.getAccount(who)) ?? new Account();
  acct.nonce += 1n;
  await vm.stateManager.putAccount(who, acct);
  return { address: r.created, gas: r.gas };
}
async function fund(token, donor, to, amount) {
  const have = await bal(token, donor);
  if (amount * 20n > have) throw Error(`donor ${donor} too thin for ${amount} of ${token} (has ${have})`);
  const r = await tx(donor, token, ERC20, 'transfer', [to, amount]);
  if (r.reverted) throw Error('fund failed ' + r.reason);
}
/* USDG is a proxy: find its balances mapping slot once and write balances directly */
let usdgSlot = null;
async function mintUsdg(to, amount) {
  const token = Address.fromString(C.usdg), want = (await bal(C.usdg, to)) + amount;
  const key = i => hexToBytes(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, BigInt(i)])));
  const val = setLengthLeft(bigIntToBytes(want), 32);
  for (let i = usdgSlot ?? 0; i < 120; i++) {
    const k = key(i), old = await vm.stateManager.getContractStorage(token, k);
    await vm.stateManager.putContractStorage(token, k, val);
    if ((await bal(C.usdg, to)) === want) { usdgSlot = i; return; }
    await vm.stateManager.putContractStorage(token, k, setLengthLeft(old, 32));
  }
  throw Error('USDG balance slot not found');
}
const poolId = k => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
/* price tick of a $5,000 opening market cap: pair coin per token = 500 / answer, rounded down to 60 */
async function priceTick(pair) {
  const [, a] = await view(pair.feed, FEED, 'latestRoundData');
  const t = Math.floor(Math.log(500 / Number(a)) / Math.log(1.0001));
  return { tick: Math.floor(t / 60) * 60, answer: a };
}
/* market cap in USD from the pool price and the Chainlink stock price */
async function mcapUsd(token) {
  const key = await view(L, LP.abi, 'poolKeyOf', [token]);
  const m = await view(L, LP.abi, 'marketOf', [token]);
  const [sqrt, tick] = await view(C.stateView, SV, 'getSlot0', [poolId(key)]);
  const s = Number(sqrt) / 2 ** 96, raw = s * s;
  const coinPerToken = m.tokenIs0 ? raw : 1 / raw;
  const [, a] = await view(PAIRS[symbolOf(m.pairCoin)].feed, FEED, 'latestRoundData');
  return { usd: coinPerToken * 1e9 * Number(a) / 1e8, tick, m };
}
const symbolOf = coin => Object.values(PAIRS).find(p => p.coin.toLowerCase() === coin.toLowerCase()).symbol;

// ------------------------------------------------------------------ deploy
const deployer = addr(0xd0), treasury = addr(0x7e), buyback = addr(0xbb), creator = addr(0xc4), alice = addr(0xa1), bob = addr(0xb0), carol = addr(0xc0), dave = addr(0xda), eve = addr(0xee), whale = addr(0x3a1e);
const impl = await deploy(deployer, TOKEN);
const lp = await deploy(deployer, LP, [C.poolManager, impl.address]);
const L = lp.address;
const rt = await deploy(deployer, ROUTER, [C.poolManager, L, C.weth, C.usdg, C.wethUsdgPool]);
const R = rt.address;
console.log(`fork block ${Number(head.number)} · gas: token impl ${impl.gas}, launchpad ${lp.gas}, router ${rt.gas}`);
const pairInit = p => ({ coin: p.coin, feed: p.feed, stockPool: p.stockPool, enabled: true });
await reverts(alice, L, LP.abi, 'setPairs', [[pairInit(PAIRS.NVDA)]], 'owner', 'setPairs only owner');
await must(deployer, L, LP.abi, 'setPairs', [[pairInit(PAIRS.NVDA), pairInit(PAIRS.GOOGL), pairInit(PAIRS.TSLA)]], 'setPairs x3');
ok((await view(L, LP.abi, 'pairList')).length === 3, 'pair list');
{
  const { tick } = await priceTick(PAIRS.NVDA);
  await reverts(creator, L, LP.abi, 'launch', ['Early', 'EARLY', 'ipfs://x', PAIRS.NVDA.coin, 20000, tick], 'no router', 'launch needs a router set');
}
await must(deployer, L, LP.abi, 'setRouter', [R]);
await must(deployer, L, LP.abi, 'setRecipients', [treasury, buyback]);

// ------------------------------------------------------------------ launch guards
{
  const { tick } = await priceTick(PAIRS.NVDA);
  await reverts(creator, L, LP.abi, 'launch', ['Bad', 'BAD', 'u', PAIRS.NVDA.coin, 20000, tick + 120], 'open tick', 'launch refuses a tick off the Chainlink price');
  await reverts(creator, L, LP.abi, 'launch', ['Bad', 'BAD', 'u', PAIRS.NVDA.coin, 5000, tick], 'fee', 'launch refuses other fees');
  await reverts(creator, L, LP.abi, 'launch', ['Bad', 'B', 'u', PAIRS.NVDA.coin, 20000, tick], 'text', 'launch refuses a 1 letter ticker');
  await reverts(creator, L, LP.abi, 'launch', ['Bad', 'BAD', 'u', PAIRS.AAPL.coin, 20000, tick], 'pair', 'launch refuses unlisted pair');
  await reverts(creator, L, LP.abi, 'launch', ['Bad', 'BAD', 'u', PAIRS.NVDA.coin, 20000, tick + 30], 'spacing', 'launch refuses off-spacing tick');
  await reverts(creator, L, LP.abi, 'launchFor', [alice, 'Bad', 'BAD', 'u', PAIRS.NVDA.coin, 20000, tick], 'router', 'launchFor only router');
}

// ------------------------------------------------------------------ launch with first buy
await giveEth(creator, 10n ** 18n); await giveEth(alice, 5n * 10n ** 18n); await giveEth(dave, 10n ** 17n); await giveEth(eve, 10n ** 17n);
const { tick: nvTick } = await priceTick(PAIRS.NVDA);
const la = await must(creator, R, ROUTER.abi, 'launchAndBuy', ['Rosh Cat', 'RCAT', 'https://roshpad.example/meta/1', PAIRS.NVDA.coin, 20000, nvTick, 0n], 'launchAndBuy 0.05 ETH', 5n * 10n ** 16n);
const launched = la.logs.find(l => l.eventName === 'MarketLaunched');
const T = launched.args.token;
console.log(`  launchAndBuy gas ${la.gas} · token ${T} · tokenIs0 ${(await view(L, LP.abi, 'marketOf', [T])).tokenIs0}`);
ok((await view(L, LP.abi, 'marketCount')) === 1n, 'market registered');
const m0 = await view(L, LP.abi, 'marketOf', [T]);
ok(m0.creator === creator && m0.pairCoin === PAIRS.NVDA.coin && m0.fee === 20000, 'market fields');
ok(Math.abs(m0.capTick - m0.openTick) === 19440, 'curve spans 19440 ticks (7x)');
const createdBal = await bal(T, creator);
ok(createdBal > 0n, 'creator got tokens from the first buy', formatEther(createdBal));
ok((await view(T, TOKEN.abi, 'symbol')) === 'RCAT' && (await view(T, TOKEN.abi, 'metadataURI')) === 'https://roshpad.example/meta/1', 'token metadata');
ok((await view(T, TOKEN.abi, 'eligibleSupply')) === createdBal, 'eligible supply = holder balances');
ok((await bal(T, DEAD)) < 10n ** 9n, 'only rounding dust (under 1e-9 tokens) left over at launch', String(await bal(T, DEAD)));
ok((await bal(T, L)) === 0n, 'launchpad keeps no tokens');
ok((await bal(T, C.poolManager)) + createdBal + (await bal(T, DEAD)) === 10n ** 27n, 'all supply sits in the pool or with holders');
await reverts(alice, T, TOKEN.abi, 'addRewards', [1n], 'launchpad', 'addRewards only launchpad');
await reverts(alice, T, TOKEN.abi, 'initialize', ['x', 'XX', '', PAIRS.NVDA.coin, C.poolManager, R, alice], 'init', 'token cannot be re-initialized');

// second market without a buy: opening market cap
const { tick: gTick } = await priceTick(PAIRS.GOOGL);
const g = await must(creator, L, LP.abi, 'launch', ['Rosh Dog', 'RDOG', 'u', PAIRS.GOOGL.coin, 10000, gTick], 'launch GOOGL market');
const G = g.logs.find(l => l.eventName === 'MarketLaunched').args.token;
const gm = await mcapUsd(G);
ok(gm.usd >= 4940 && gm.usd <= 5035, 'opening market cap within one tick spacing of $5,000', gm.usd.toFixed(2));
const { tick: tTick } = await priceTick(PAIRS.TSLA);
const t3 = await must(creator, L, LP.abi, 'launch', ['Rosh Car', 'RCAR', 'u', PAIRS.TSLA.coin, 30000, tTick], 'launch TSLA market');
const T3 = t3.logs.find(l => l.eventName === 'MarketLaunched').args.token;
const t3m = await mcapUsd(T3);
ok(t3m.usd >= 4940 && t3m.usd <= 5035, 'opening market cap within one tick spacing of $5,000 (TSLA)', t3m.usd.toFixed(2));
const orient = [m0.tokenIs0, gm.m.tokenIs0, t3m.m.tokenIs0];
console.log('  orientations tokenIs0:', orient.join(' '));

// ------------------------------------------------------------------ buys
const coin = PAIRS.NVDA.coin;
const b1 = await must(alice, R, ROUTER.abi, 'buyWithEth', [T, 0n, alice], 'alice buys with 0.3 ETH', 3n * 10n ** 17n);
console.log(`  buyWithEth gas ${b1.gas}`);
const aliceTok = await bal(T, alice);
ok(aliceTok > 0n, 'alice received tokens');
await mintUsdg(bob, 2_000_000000n);
await must(bob, C.usdg, ERC20, 'approve', [R, (1n << 256n) - 1n]);
await reverts(bob, R, ROUTER.abi, 'buyWithUsd', [T, 2_000_000000n, 10n ** 30n, bob], 'min out', 'minOut guard on buys');
await must(bob, R, ROUTER.abi, 'buyWithUsd', [T, 2_000_000000n, 0n, bob], 'bob buys with 2,000 USDG');
await fund(coin, PAIRS.NVDA.stockPool, carol, 5n * 10n ** 17n);
await must(carol, coin, ERC20, 'approve', [R, (1n << 256n) - 1n]);
const cb = await must(carol, R, ROUTER.abi, 'buyWithCoin', [T, 5n * 10n ** 17n, 0n, carol], 'carol buys with 0.5 NVDA');
const carolIn = 5n * 10n ** 17n;
ok((await view(T, TOKEN.abi, 'eligibleSupply')) === (await bal(T, creator)) + (await bal(T, alice)) + (await bal(T, bob)) + (await bal(T, carol)), 'eligible supply tracks buyers');
await reverts(alice, R, ROUTER.abi, 'buyWithEth', [addr(0x1234), 0n, alice], 'market', 'router refuses unknown tokens', 10n ** 15n);

// ------------------------------------------------------------------ fees to holders
{
  const tb = await bal(coin, treasury), bb = await bal(coin, buyback);
  const c1 = await must(eve, L, LP.abi, 'collectFees', [T], 'collectFees by anyone');
  console.log(`  collectFees gas ${c1.gas}`);
  const f = c1.logs.find(l => l.eventName === 'FeesCollected').args;
  ok(f.pairFees > 0n && f.tokenBurned === 0n, 'buy fees arrive in NVDA, none in token yet', `${formatEther(f.pairFees)} NVDA`);
  ok(f.toHolders === f.pairFees * 4000n / 10000n && f.toBuyback === f.pairFees * 3000n / 10000n && f.toProtocol === f.pairFees - f.toHolders - f.toBuyback, 'split 40 / 30 / 30');
  ok((await bal(coin, T)) === f.toHolders, 'holder share sits in the token contract');
  ok((await bal(coin, treasury)) - tb === f.toProtocol && (await bal(coin, buyback)) - bb === f.toBuyback, 'treasury and buyback paid');
  const holders = [creator, alice, bob, carol];
  const cl = await Promise.all(holders.map(h => view(T, TOKEN.abi, 'claimable', [h])));
  const bals = await Promise.all(holders.map(h => bal(T, h)));
  const sum = cl.reduce((s, x) => s + x, 0n);
  ok(sum <= f.toHolders && f.toHolders - sum <= 4n, 'claimable adds up to the holder share', `${sum} vs ${f.toHolders}`);
  const elig = bals.reduce((s, x) => s + x, 0n);
  holders.forEach((h, i) => near(cl[i], f.toHolders * bals[i] / elig, 1, 'claimable pro-rata ' + i));
  ok((await view(T, TOKEN.abi, 'claimable', [C.poolManager])) === 0n, 'pool manager earns nothing');
  await must(eve, L, LP.abi, 'collectFees', [T], 'second collect with nothing new');
}

// ------------------------------------------------------------------ transfers keep past rewards with the sender
{
  const before = await view(T, TOKEN.abi, 'claimable', [alice]);
  const half = (await bal(T, alice)) / 2n;
  await must(alice, T, TOKEN.abi, 'transfer', [dave, half], 'alice sends half to dave');
  ok((await view(T, TOKEN.abi, 'claimable', [alice])) === before, 'sender keeps accrued rewards');
  ok((await view(T, TOKEN.abi, 'claimable', [dave])) === 0n, 'receiver does not inherit past rewards');
}

// ------------------------------------------------------------------ sells (no approval needed)
{
  const e0 = await ethBal(alice), aTok = await bal(T, alice);
  await reverts(alice, R, ROUTER.abi, 'sellForEth', [T, aTok, 10n ** 30n, alice], 'min out', 'minOut guard on sells');
  const s1 = await must(alice, R, ROUTER.abi, 'sellForEth', [T, aTok, 0n, alice], 'alice sells for ETH without approval');
  console.log(`  sellForEth gas ${s1.gas}`);
  ok((await ethBal(alice)) > e0 && (await bal(T, alice)) === 0n, 'alice got ETH back', formatEther((await ethBal(alice)) - e0));
  const u0 = await bal(C.usdg, bob);
  await must(bob, R, ROUTER.abi, 'sellForUsd', [T, (await bal(T, bob)) / 2n, 0n, bob], 'bob sells half for USDG');
  ok((await bal(C.usdg, bob)) > u0, 'bob got USDG', formatUnits((await bal(C.usdg, bob)) - u0, 6));
  const n0 = await bal(coin, carol);
  await must(carol, R, ROUTER.abi, 'sellForCoin', [T, (await bal(T, carol)) / 3n, 0n, carol], 'carol sells a third for NVDA');
  ok((await bal(coin, carol)) > n0, 'carol got NVDA');
  await reverts(eve, R, ROUTER.abi, 'sellForCoin', [T, 10n ** 18n, 0n, eve], 'transferFrom', 'cannot sell tokens you do not hold');
  const dead0 = await bal(T, DEAD);
  const c2 = await must(eve, L, LP.abi, 'collectFees', [T], 'collect after sells');
  const f2 = c2.logs.find(l => l.eventName === 'FeesCollected').args;
  ok(f2.tokenBurned > 0n && (await bal(T, DEAD)) - dead0 === f2.tokenBurned, 'sell fees in the token are burned', formatEther(f2.tokenBurned));
  const mk = await view(L, LP.abi, 'marketOf', [T]);
  ok(mk.tokenBurned === f2.tokenBurned && mk.pairFees > 0n, 'market ledger updated');
}

// ------------------------------------------------------------------ claims
{
  const n0 = await bal(coin, alice), c0 = await view(T, TOKEN.abi, 'claimable', [alice]);
  ok(c0 > 0n, 'alice still has rewards after selling everything');
  await must(alice, T, TOKEN.abi, 'claim', [], 'alice claims');
  ok((await bal(coin, alice)) - n0 === c0 && (await view(T, TOKEN.abi, 'claimable', [alice])) === 0n, 'claim pays exactly the accrued NVDA');
  const cb0 = await view(T, TOKEN.abi, 'claimable', [bob]), cc0 = await view(T, TOKEN.abi, 'claimable', [carol]);
  const nb = await bal(coin, bob), nc = await bal(coin, carol);
  await must(eve, T, TOKEN.abi, 'claimFor', [[bob, carol, C.poolManager, eve]], 'eve pushes claims to others');
  ok((await bal(coin, bob)) - nb === cb0 && (await bal(coin, carol)) - nc === cc0, 'pushed claims landed');
  ok((await view(T, TOKEN.abi, 'totalClaimed')) === c0 + cb0 + cc0, 'total claimed');
}

// ------------------------------------------------------------------ through the curve into the reserve range
{
  await mintUsdg(whale, 40_000_000000n);
  await must(whale, C.usdg, ERC20, 'approve', [R, (1n << 256n) - 1n]);
  const before = await mcapUsd(T);
  const w = await must(whale, R, ROUTER.abi, 'buyWithUsd', [T, 20_000_000000n, 0n, whale], 'whale buys 20,000 USDG');
  const after = await mcapUsd(T);
  console.log(`  market cap $${before.usd.toFixed(0)} -> $${after.usd.toFixed(0)} · tick ${before.tick} -> ${after.tick} · gas ${w.gas}`);
  const pastCap = before.m.tokenIs0 ? after.tick >= before.m.capTick : after.tick < before.m.capTick;
  ok(after.usd > 35000 && pastCap, 'price passed the $35,000 cap into the reserve range', after.usd.toFixed(0));
  const wt = await bal(T, whale);
  await must(whale, R, ROUTER.abi, 'sellForUsd', [T, wt, 0n, whale], 'whale sells everything back');
  const c3 = await must(eve, L, LP.abi, 'collectFees', [T], 'collect after the whale');
  const f3 = c3.logs.find(l => l.eventName === 'FeesCollected').args;
  ok(f3.pairFees > 0n && f3.tokenBurned > 0n, 'whale fees collected on both sides');
  ok((await view(T, TOKEN.abi, 'claimable', [dave])) > 0n, 'dave now earns on the tokens he received');
}

// ------------------------------------------------------------------ other orientation markets trade too
for (const [tok, sym] of [[G, 'GOOGL'], [T3, 'TSLA']]) {
  await must(alice, R, ROUTER.abi, 'buyWithEth', [tok, 0n, alice], `buy ${sym} market with ETH`, 10n ** 17n);
  const tb = await bal(tok, alice);
  await must(alice, R, ROUTER.abi, 'sellForEth', [tok, tb / 2n, 0n, alice], `sell ${sym} market for ETH`);
  const c = await must(eve, L, LP.abi, 'collectFees', [tok], `collect ${sym} market`);
  ok(c.logs.find(l => l.eventName === 'FeesCollected').args.toHolders > 0n, `${sym} holders earn`);
}

// ------------------------------------------------------------------ admin
await reverts(alice, R, ROUTER.abi, 'uniswapV3SwapCallback', [1n, 0n, encodeAbiParameters([{ type: 'address' }], [C.usdg])], 'pool', 'v3 callback only from the active pool');
await reverts(alice, R, ROUTER.abi, 'unlockCallback', ['0x'], 'pool manager', 'router unlock callback only from PoolManager');
await reverts(alice, L, LP.abi, 'unlockCallback', ['0x'], 'pool manager', 'launchpad unlock callback only from PoolManager');
await reverts(alice, L, LP.abi, 'setRecipients', [alice, alice], 'owner', 'recipients only owner');
await must(deployer, L, LP.abi, 'transferOwnership', [alice]);
await reverts(bob, L, LP.abi, 'acceptOwnership', [], 'pending', 'only pending owner accepts');
await must(alice, L, LP.abi, 'acceptOwnership', []);
ok((await view(L, LP.abi, 'owner')) === alice, 'ownership moved');
ok(!LP.abi.some(x => x.type === 'function' && /remove|withdraw|decrease|burn/i.test(x.name)), 'launchpad has no function that removes liquidity');

console.log(`\n${pass} passed, ${fail} failed · rpc retries ${rpcRetries}`);
process.exit(fail ? 1 : 0);
