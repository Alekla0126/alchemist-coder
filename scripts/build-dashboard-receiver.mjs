import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const output = resolve('out/dashboard-receiver');
mkdirSync(output,{recursive:true});
execFileSync(process.execPath,[fileURLToPath(new URL('./bin/tsc',import.meta.resolve('typescript/package.json'))), 'examples/dashboard-receiver/serve.ts','examples/dashboard-receiver/benchmark.ts','examples/dashboard-consumer/proof.ts','examples/org-execution/check.ts','examples/org-execution/crash-worker.ts','--module','ESNext','--moduleResolution','Bundler','--target','ES2023','--outDir',output,'--rewriteRelativeImportExtensions','--skipLibCheck','--strict','--types','node'],{stdio:'inherit'});
writeFileSync(resolve(output,'package.json'),JSON.stringify({type:'module',private:true,license:'AGPL-3.0-only'}));
copyFileSync('LICENSE',resolve(output,'LICENSE'));
process.stdout.write('Built reference adapter: '+resolve(output,'examples/dashboard-receiver/serve.js')+'\n');
