/** Only launched by check.ts inside its freshly-created synthetic directory. */
import { basename, isAbsolute, join } from 'node:path';
import { LocalOrgExecutionBackend } from '../../apps/desktop/src/main/org-execution-local.ts';
import { FIXTURE_WORKFLOW, FixtureEffects, FixtureWorker, fixtureWorkflow } from '../../apps/desktop/src/main/org-fixture-worker.ts';

const dir = process.argv[2];
if (!dir || !isAbsolute(dir) || !basename(dir).startsWith('ac-org-crash-proof-') || !process.send) throw Error('Private IPC fixture directory required');
const effects = new FixtureEffects(join(dir,'effects'));
const backend = new LocalOrgExecutionBackend(join(dir,'queue.json'),new Map([[FIXTURE_WORKFLOW,fixtureWorkflow(effects)]]));
backend.enqueue({id:'factory',payload:{teamId:'fixture-team',botId:'factory',prompt:'CRASH_FIXTURE_OK',cwd:effects.root,kind:'start'},maxParallel:1,maxAttempts:3,resumePreauthorized:true},FIXTURE_WORKFLOW);
const worker = new FixtureWorker(backend,effects,join(dir,'worker.json'),'crash-fixture-worker',{
  afterEffect:async () => {process.send!({phase:'effect_published'});await new Promise<void>(() => {});},
});
process.on('disconnect',()=>process.exit(0));
void worker.step().catch(()=>process.exit(1));
