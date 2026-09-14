/* Wallet connection for Robinhood Chain mainnet. Discovers injected wallets through EIP-6963
   (MetaMask, Rabby, Coinbase Wallet, OKX, Phantom EVM…), falls back to window.ethereum,
   switches or adds chain 4663 and exposes viem clients. Loaded as an ES module by the page. */
import { createPublicClient, createWalletClient, custom, http, fallback } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'] } },
  blockExplorers: { default: { name: 'Robinscan', url: 'https://robinscan.io' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } }
};
export const pub = createPublicClient({ chain: CHAIN, transport: fallback(CHAIN.rpcUrls.default.http.map(u => http(u))) });

const found = new Map();
addEventListener('eip6963:announceProvider', e => { const d = e.detail; if (d && d.info && d.provider) found.set(d.info.uuid, d); });
dispatchEvent(new Event('eip6963:requestProvider'));

const W = { provider: null, info: null, address: null, chainId: null, client: null, listeners: new Set() };
const emit = () => W.listeners.forEach(fn => { try { fn(state()); } catch {} });
export const state = () => ({ address: W.address, chainId: W.chainId, onChain: W.chainId === CHAIN.id, wallet: W.info ? W.info.name : null });
export const onChange = fn => { W.listeners.add(fn); return () => W.listeners.delete(fn); };

export function wallets() {
  const list = [...found.values()].map(d => ({ id: d.info.uuid, name: d.info.name, icon: d.info.icon, rdns: d.info.rdns }));
  if (!list.length && window.ethereum) list.push({ id: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '', rdns: 'injected' });
  return list;
}

function bind(provider, info) {
  if (W.provider && W.provider.removeListener) { W.provider.removeListener('accountsChanged', onAccounts); W.provider.removeListener('chainChanged', onChain); }
  W.provider = provider; W.info = info;
  W.client = createWalletClient({ chain: CHAIN, transport: custom(provider) });
  if (provider.on) { provider.on('accountsChanged', onAccounts); provider.on('chainChanged', onChain); }
}
function onAccounts(a) { W.address = a && a[0] ? a[0] : null; if (!W.address) { try { localStorage.removeItem('rosh:wallet'); } catch {} } emit(); }
function onChain(id) { W.chainId = Number(id); emit(); }

export async function connect(id) {
  const d = id && id !== 'injected' ? found.get(id) : [...found.values()][0];
  const provider = d ? d.provider : window.ethereum;
  if (!provider) throw Error('No wallet found. Install MetaMask or Rabby, or open this page in your wallet app browser.');
  bind(provider, d ? d.info : { name: 'Browser wallet', uuid: 'injected' });
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  W.address = accounts[0] || null;
  W.chainId = Number(await provider.request({ method: 'eth_chainId' }));
  try { localStorage.setItem('rosh:wallet', d ? d.info.rdns : 'injected'); } catch {}
  if (W.chainId !== CHAIN.id) await switchChain();
  emit();
  return state();
}

/* reconnect silently if the wallet already authorised this site */
export async function restore() {
  let rdns = null; try { rdns = localStorage.getItem('rosh:wallet'); } catch {}
  if (!rdns) return state();
  await new Promise(r => setTimeout(r, 250));
  const d = [...found.values()].find(x => x.info.rdns === rdns);
  const provider = d ? d.provider : rdns === 'injected' ? window.ethereum : null;
  if (!provider) return state();
  bind(provider, d ? d.info : { name: 'Browser wallet', uuid: 'injected' });
  const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  W.address = accounts[0] || null;
  W.chainId = Number(await provider.request({ method: 'eth_chainId' }).catch(() => 0));
  emit();
  return state();
}

export function disconnect() {
  W.address = null; try { localStorage.removeItem('rosh:wallet'); } catch {}
  try { W.provider && W.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch {}
  emit();
}

export async function switchChain() {
  const hex = '0x' + CHAIN.id.toString(16);
  try {
    await W.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e && (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || ''))) {
      await W.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: CHAIN.name, nativeCurrency: CHAIN.nativeCurrency, rpcUrls: CHAIN.rpcUrls.default.http, blockExplorerUrls: [CHAIN.blockExplorers.default.url] }] });
    } else throw e;
  }
  W.chainId = CHAIN.id; emit();
}

/* sends a contract call from the connected wallet after simulating it, returns the receipt */
export async function send({ address, abi, functionName, args = [], value = 0n }) {
  if (!W.address) throw Error('Connect a wallet first.');
  if (W.chainId !== CHAIN.id) await switchChain();
  const { request } = await pub.simulateContract({ account: W.address, address, abi, functionName, args, value });
  const hash = await W.client.writeContract({ ...request, account: W.address });
  return { hash, wait: () => pub.waitForTransactionReceipt({ hash }) };
}

export async function sendValue(to, value) {
  if (!W.address) throw Error('Connect a wallet first.');
  if (W.chainId !== CHAIN.id) await switchChain();
  const hash = await W.client.sendTransaction({ account: W.address, to, value });
  return { hash, wait: () => pub.waitForTransactionReceipt({ hash }) };
}

/* contract creation from the connected wallet (used by /deploy) */
export async function sendDeploy(data) {
  if (!W.address) throw Error('Connect a wallet first.');
  if (W.chainId !== CHAIN.id) await switchChain();
  const hash = await W.client.sendTransaction({ account: W.address, data, to: null });
  return { hash, wait: () => pub.waitForTransactionReceipt({ hash }) };
}

export async function sign(message) {
  if (!W.address) throw Error('Connect a wallet first.');
  return W.client.signMessage({ account: W.address, message });
}
export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const explorer = (kind, v) => CHAIN.blockExplorers.default.url + '/' + kind + '/' + v;
