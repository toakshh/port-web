const fs = require('fs');
const path = require('path');
const fsx = require('./lib/fsx');
const tc = require('./lib/toolchain');
const P = require('./lib/paths');

tc.setupEnv({log: console.log});
const tauri = tc.ensureTauriCli({log: console.log});

const testSlot = '/tmp/test-slot';
const distDir = path.join(testSlot, 'dist');
const iconsDir = path.join(testSlot, 'icons');
const srcTauri = path.join(testSlot, 'src-tauri');
const genAndroid = path.join(srcTauri, 'gen', 'android');
const logoSource = path.join(P.ROOT, 'dist', 'logo512.png');

fsx.emptyDir(testSlot);
fsx.ensureDir(distDir);
fsx.ensureDir(srcTauri);
// simulate slot sync for icons
fsx.syncDir(path.join(P.SRC_TAURI, 'icons'), path.join(srcTauri, 'icons'));
fs.copyFileSync(path.join(P.SRC_TAURI, 'tauri.conf.json'), path.join(srcTauri, 'tauri.conf.json'));

const outDir = fsx.emptyDir(iconsDir);

console.log('Running tauri icon...');
const res = tc.run([ ...tauri, 'icon', logoSource, '-o', outDir ], { cwd: testSlot });
console.log('Tauri icon ok?', res.ok);

if (fs.existsSync(outDir)) {
  console.log('outDir contains:', fs.readdirSync(outDir));
  if (fs.existsSync(path.join(outDir, 'android'))) {
    console.log('outDir/android contains:', fs.readdirSync(path.join(outDir, 'android')));
  } else {
    console.log('NO ANDROID DIR inside outDir!');
  }
}
