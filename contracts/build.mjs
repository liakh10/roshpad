/* Compiles src/*.sol with solc 0.8.28 (optimizer 200 runs) into artifacts/<Name>.json { abi, bytecode, deployedSize }. */
import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
/* src/ holds the deployable contracts; test/ holds helpers used only by test.mjs. Imports resolve relative to src/. */
const sources = {};
for (const sub of ['src', 'test']) for (const f of fs.readdirSync(path.join(dir, sub)).filter(f => f.endsWith('.sol'))) sources[sub === 'src' ? f : 'test/' + f] = { content: fs.readFileSync(path.join(dir, sub, f), 'utf8') };
const input = {
  language: 'Solidity',
  sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } }
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
let failed = false;
for (const e of out.errors || []) {
  if (e.severity === 'error') failed = true;
  console.log(e.severity.toUpperCase(), e.formattedMessage.trim());
}
if (failed) process.exit(1);
fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue;
    const art = { contractName: name, compiler: solc.version(), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedSize: c.evm.deployedBytecode.object.length / 2 };
    fs.writeFileSync(path.join(dir, 'artifacts', name + '.json'), JSON.stringify(art, null, 2));
    console.log(name, 'runtime', art.deployedSize, 'bytes', art.deployedSize > 24576 ? 'OVER 24KB LIMIT' : 'ok');
  }
}
