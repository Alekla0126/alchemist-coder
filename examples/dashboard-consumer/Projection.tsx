import { useEffect, useState } from 'react';
import { DASHBOARD_PROTOCOL, dashboardRef, validDashboardBatch } from '../../apps/desktop/src/shared/dashboard-protocol';
import type { DashboardProjection } from '../../apps/desktop/src/shared/dashboard-protocol';

export interface ProjectProjection { version: 'ac.dashboard.v1'; orgRef: string; projectRef: string; streams: { streamId: string; sequence: number; data: DashboardProjection }[] }
function valid(value: unknown): value is ProjectProjection {
  if (!value || typeof value !== 'object') return false;
  const v=value as ProjectProjection;
  return Object.keys(v).length===4 && ['version','orgRef','projectRef','streams'].every(k=>Object.hasOwn(v,k)) && v.version===DASHBOARD_PROTOCOL && dashboardRef(v.orgRef) && dashboardRef(v.projectRef) && Array.isArray(v.streams) && v.streams.length<=4 && v.streams.every(s=>s && Object.keys(s).length===3 && ['streamId','sequence','data'].every(k=>Object.hasOwn(s,k)) && validDashboardBatch({message:{version:DASHBOARD_PROTOCOL,orgRef:v.orgRef,projectRef:v.projectRef,streamId:s.streamId,sequence:s.sequence,messageId:'read-validation',createdAt:0,kind:'snapshot',data:s.data},digest:'0'.repeat(64)}));
}
/** Reusable read-only consumer. load belongs to the Dashboard BFF; no token goes to the browser. */
export function Projection({load,expectedScope,interval=5000,labels={}}:{load:()=>Promise<unknown>;expectedScope:{orgRef:string;projectRef:string};interval?:number;labels?:Record<string,string>}) {
  const scopeKey=expectedScope.orgRef+':'+expectedScope.projectRef;
  const [stored,setStored]=useState<{key:string;loader:()=>Promise<unknown>;data:ProjectProjection}|null>(null),[error,setError]=useState(false);
  // Hide old scopes synchronously, before the effect runs or a replacement request settles.
  const view=stored?.key===scopeKey&&stored.loader===load?stored.data:null;
  useEffect(()=>{let live=true,busy=false;setStored(null);setError(false);const refresh=async()=>{if(busy)return;busy=true;try{const next=await load();if(!valid(next)||next.orgRef!==expectedScope.orgRef||next.projectRef!==expectedScope.projectRef)throw Error('Invalid projection scope');if(live){setStored({key:scopeKey,loader:load,data:next});setError(false);}}catch{if(live)setError(true);}finally{busy=false;}};void refresh();const timer=setInterval(()=>void refresh(),interval);return()=>{live=false;clearInterval(timer);};},[load,interval,scopeKey,expectedScope.orgRef,expectedScope.projectRef]);
  return <section aria-label="Proyección de Organización" style={{padding:24,color:'var(--fg)',background:'var(--bg)',border:'1px solid var(--line-2)',borderRadius:12}}>
    <h1>Organización · resultados del Coder</h1>
    <p>{error?'Lectura no disponible; los datos anteriores pueden estar desactualizados.':view?'Proyección recibida del inbox persistente':'Esperando proyección; estado desconocido'}</p>
    {view?.streams.length===0&&<p>No hay una proyección confirmada para este ámbito.</p>}
    {view?.streams.map(s=><div key={s.streamId}>
      <p>Secuencia confirmada: <strong>{s.sequence}</strong> · Cobertura histórica: parcial</p>
      {!s.data.available?<p role="alert">Cola no disponible; cantidad de tareas desconocida.</p>:<>
        <p>Tareas verificadas: <strong>{s.data.jobs!.filter(j=>j.state==='completed'&&j.verification==='verified').length}</strong> · Bloqueadas: <strong>{s.data.jobs!.filter(j=>j.state==='blocked'||j.state==='interrupted').length}</strong></p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:12}}>{s.data.jobs!.map(j=><article key={j.taskRef} style={{padding:16,border:'1px solid var(--line-2)',borderRadius:10,background:'var(--bg-input)'}}>
          <h2 style={{fontSize:16}}>{labels[j.taskRef]??'Tarea '+j.taskRef.slice(0,8)}</h2><p>Estado: {j.state}</p><p>Verificación: {j.verification}</p>{j.reason&&<p>Bloqueo: {j.reason}</p>}
        </article>)}</div>
      </>}
      <p>Agentes observados: {s.data.agents.length}. Un turno reportado no acredita el objetivo comercial.</p>
    </div>)}
  </section>;
}
