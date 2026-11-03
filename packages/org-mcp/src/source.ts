import { validProjectProjection } from '../../../apps/desktop/src/shared/dashboard-protocol.ts';
import type { ProjectProjection } from '../../../apps/desktop/src/shared/dashboard-protocol.ts';
import { PublicError } from './policy.ts';
import type { Project } from './policy.ts';

export interface ProjectionSource { load(project: Project, signal?: AbortSignal): Promise<unknown> }
// Receiver: at most four streams, each accepted through a <=1 MB batch, plus read envelope.
export const MAX_PROJECTION_BYTES = 4_100_000;
export function checkedProjection(value: unknown, project: Project): ProjectProjection {
  if (!validProjectProjection(value) || value.orgRef !== project.orgRef || value.projectRef !== project.projectRef) throw new PublicError('projection_invalid');
  return value;
}
/** Same read endpoint as the Dashboard BFF; no remote execution API or arbitrary tool URL. */
export function httpProjectionSource(env: NodeJS.ProcessEnv = process.env): ProjectionSource {
  return {async load(project,signal) {
    if (!project.connection) throw new PublicError('backend_not_configured');
    const token = env[project.connection.tokenEnv];
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new PublicError('credential_unavailable');
    const u = new URL(`/api/coder-sync/v1/projects/${project.orgRef}/${project.projectRef}`,project.connection.origin);
    try {
      const timeout=AbortSignal.timeout(5000);
      const response = await fetch(u,{headers:{authorization:'Bearer '+token,accept:'application/json'},redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if (!response.ok) throw new PublicError([401,403].includes(response.status)?'backend_access_denied':'backend_unavailable');
      if (!response.body) throw new PublicError('projection_invalid');
      const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      try {for (;;) {const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>MAX_PROJECTION_BYTES)throw new PublicError('projection_too_large');chunks.push(next.value);}}
      finally {await reader.cancel().catch(()=>{});}
      return checkedProjection(JSON.parse(Buffer.concat(chunks).toString('utf8')),project);
    } catch(e) {if(e instanceof PublicError)throw e;throw new PublicError('backend_unavailable');}
  }};
}
