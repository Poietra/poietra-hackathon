import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('cargo', ['build', '--manifest-path', 'core/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: root, stdio: 'inherit' });
mkdirSync(new URL('../public/wasm/', import.meta.url), { recursive: true });
copyFileSync(new URL('../core/target/wasm32-unknown-unknown/release/poietra_core.wasm', import.meta.url), new URL('../public/wasm/poietra_core.wasm', import.meta.url));
console.log('Built the Poietra motion core for WebAssembly.');
