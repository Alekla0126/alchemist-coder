import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createDashboardProof} from '../out/dashboard-receiver/examples/dashboard-consumer/proof.js';
const monacoVs=resolve(dirname(createRequire(import.meta.url).resolve('monaco-editor')),'..','..','esm','vs');
const proof=await createDashboardProof();
const handler=async(req,res)=>{res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');try{if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:5181')throw Error('Origin denied');if(req.method==='GET'&&req.url==='/projection'){res.end(JSON.stringify(await proof.load()));return;}if(req.method==='POST'&&req.url==='/dispatch'){await proof.dispatch();res.end(JSON.stringify(proof.status()));return;}if(req.method==='POST'&&req.url==='/restart'){await proof.restart();res.end(JSON.stringify(proof.status()));return;}res.statusCode=404;res.end('{"error":"fixture_route_not_found"}');}catch{res.statusCode=503;res.end('{"error":"fixture_unavailable"}');}};
let server;try{server=await createServer({configFile:false,root:resolve('apps/desktop/test/fixtures'),cacheDir:resolve('output/playwright/qa-cache'),plugins:[react(),{name:'isolated-dashboard-proof',configureServer(s){s.middlewares.use('/__proof',handler);}}],resolve:{alias:[{find:'@shared',replacement:resolve('apps/desktop/src/shared')},{find:/^monaco-editor\/esm\/vs\/(.+)$/,replacement:monacoVs+'/$1.js'}]},server:{host:'127.0.0.1',port:5181,strictPort:true,fs:{allow:[process.cwd()]}}});await server.listen();}catch(e){await proof.close();throw e;}
const stop=async()=>{await server.close();await proof.close();process.exit(0);};process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
server.printUrls();
