import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),output=resolve(root,'out/org-mcp');
mkdirSync(output,{recursive:true});
execFileSync(process.execPath,[fileURLToPath(new URL('./bin/tsc',import.meta.resolve('typescript/package.json'))),'packages/org-mcp/src/stdio.ts','packages/org-mcp/test/check.ts','--module','ESNext','--moduleResolution','Bundler','--target','ES2023','--rootDir','.', '--outDir',output,'--rewriteRelativeImportExtensions','--skipLibCheck','--strict','--types','node'],{cwd:root,stdio:'inherit'});
writeFileSync(resolve(output,'package.json'),JSON.stringify({type:'module',private:true,license:'AGPL-3.0-only'}));copyFileSync(resolve(root,'LICENSE'),resolve(output,'LICENSE'));
process.stdout.write('Built local MCP: '+resolve(output,'packages/org-mcp/src/stdio.js')+'\n');
