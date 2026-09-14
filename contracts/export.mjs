/* Copies ABIs and bytecode for the site and /deploy, and writes lib/pairs.json: every Stock Token that has a Chainlink
   feed and a Uniswap v3 USDG pool on Robinhood Chain. */
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(dir, '..', 'lib', 'abi');
fs.mkdirSync(out, { recursive: true });
for (const n of ['RoshToken', 'RoshLaunchpad', 'RoshRouter']) {
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
  fs.writeFileSync(path.join(out, n + '.json'), JSON.stringify({ contractName: n, compiler: a.compiler, abi: a.abi, bytecode: a.bytecode }));
}
const pairs = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'stocks_v3.json'), 'utf8'))
  .map(m => ({ symbol: m.symbol, name: m.name, coin: m.stock, feed: m.feed, heartbeat: m.heartbeat, stockPool: m.pool, stockPoolFee: m.fee }))
  .sort((a, b) => a.symbol.localeCompare(b.symbol));
fs.writeFileSync(path.join(dir, '..', 'lib', 'pairs.json'), JSON.stringify(pairs, null, 1));
fs.writeFileSync(path.join(dir, '..', 'lib', 'chain.json'), JSON.stringify({
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', wethUsdgPool: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca'
}, null, 1));
console.log('exported', pairs.length, 'pairs');
