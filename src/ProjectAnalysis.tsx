import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type Coverage = {snapshot_at:string; scope:string; counts:Record<string,number>; original_documents:number; originals_included:boolean; history_included?:boolean; issues:{kind:string;id:string;title:string;message:string}[]; task_status:string; task_count:number|null; task_room:string; task_message?:string; tasks_read_at:string; chunks_read?:number;chunks_total?:number;comparison_requested?:boolean;comparison_complete?:boolean};
export type Comparison = {id:number;action:string;location:string;equipment:string;responsible:string;due_date:string;source_numbers:number[];classification:string;matches:{task_id:number;relation:string;reason:string;task?:{taskNumber:number;description:string;status:string;assignedToName:string;dueDate:string}}[]};
type Progress={phase:string;completed:number;total:number;comparisons_completed?:number;comparisons_total?:number;error?:string;notice?:string;coverage?:Coverage};
type Job<T>={id:string;question:string;state:string;progress:Progress;result:T|null};
async function request<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{credentials:"include",signal,...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||"Não foi possível consultar a análise.");return data;
}
export function useProjectAnalysis<T>(projectId:string,onResult:(question:string,result:T)=>void) {
  const [job,setJob]=useState<Job<T>|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const callback=useRef(onResult);callback.current=onResult;
  const delivered=useRef(new Set<string>()),creating=useRef(false),mounted=useRef(true),creationId=useRef<string|null>(null);
  const base=`/api/projects/${projectId}/knowledge/analyses`;
  useEffect(()=>{mounted.current=true;const abort=new AbortController();
    request<{analysis:Job<T>|null}>(`${base}/latest`,undefined,abort.signal).then(data=>{if(mounted.current)setJob(data.analysis);}).catch(cause=>{if(!abort.signal.aborted)setError(cause.message);}).finally(()=>{if(mounted.current)setLoading(false);});
    return()=>{mounted.current=false;abort.abort();};
  },[base]);
  useEffect(()=>{
    if(!job)return;
    if(job.state==='complete'&&job.result){if(!delivered.current.has(job.id)){delivered.current.add(job.id);callback.current(job.question,job.result);}return;}
    if(!['ready','working'].includes(job.state))return;
    const abort=new AbortController();
    const poll=async()=>{try{
      if(job.state==='ready')await request(`${base}/${job.id}/advance`,{},abort.signal);
      const next=await request<Job<T>>(`${base}/${job.id}`,undefined,abort.signal);
      if(!abort.signal.aborted){setError("");setJob(next);}
    }catch(cause){if(!abort.signal.aborted){setError(cause instanceof Error?cause.message:"A conexão foi interrompida. Retome para continuar.");setJob(old=>old?{...old,state:'paused'}:old);}}};
    const timer=setTimeout(()=>void poll(),job.state==='ready'?500:2000);
    return()=>{clearTimeout(timer);abort.abort();};
  },[job,base]);
  const start=async(body:unknown)=>{
    if(creating.current)return;creating.current=true;setLoading(true);setError("");
    creationId.current ||= crypto.randomUUID();
    try{const next=await request<Job<T>>(base,{...(body as object),id:creationId.current});creationId.current=null;if(mounted.current)setJob(next);}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:"Não foi possível iniciar. Tente novamente.");}
    finally{creating.current=false;if(mounted.current)setLoading(false);}
  };
  const resume=async()=>{if(!job)return;setError("");try{setJob(await request<Job<T>>(`${base}/${job.id}/advance`,{}));}catch(cause){setError(cause instanceof Error?cause.message:"Não foi possível retomar.");}};
  const cancel=async()=>{if(!job)return;try{await request(`${base}/${job.id}/cancel`,{});setJob(null);setError("");}catch(cause){setError(cause instanceof Error?cause.message:"Não foi possível encerrar.");}};
  return {job,loading,error,start,resume,cancel,busy:loading||Boolean(job&&['ready','working'].includes(job.state)),pending:Boolean(job&&!['complete','cancelled'].includes(job.state))};
}
const phases:Record<string,string>={prepare:"Reunindo a estrutura, o contexto e o Relatório vivo",plan:"Entendendo seu pedido",context:"Considerando a estrutura e o contexto",support_reduce:"Organizando o contexto para interpretar as sínteses",review:"Lendo as sínteses e os resumos atuais",gather:"Reunindo evidências e propostas",compare:"Comparando propostas com todas as tarefas da sala",reduce:"Consolidando as informações lidas",answer:"Organizando a resposta",complete:"Análise concluída"};
export function AnalysisProgress({progress,paused,onResume,onCancel}:{progress:Progress;paused:boolean;onResume:()=>void;onCancel:()=>void}){
  return <div className="panel analysis-progress"><div role="status"><strong>{paused?"Análise pausada":phases[progress.phase]||"Preparando análise"}</strong>{progress.total>0&&<><progress value={progress.completed} max={progress.total}/><p>{progress.completed} de {progress.total} trechos lidos</p></>}{Boolean(progress.comparisons_total)&&<p>{progress.comparisons_completed} de {progress.comparisons_total} lotes de comparação concluídos</p>}{progress.notice&&<p>{progress.notice}</p>}{progress.error&&<p>{progress.error}</p>}</div><p className="muted-text">O progresso fica salvo. Se sair desta tela, a leitura continua quando você voltar. Nenhuma tarefa é alterada.</p><div className="analysis-actions">{paused&&<button className="button primary" onClick={onResume}>Retomar análise</button>}<button className="button secondary" onClick={onCancel}>Encerrar análise</button></div></div>;
}
const kinds:Record<string,string>={projeto:'Projeto',estrutura:'Tópicos da estrutura',contexto:'Entradas de contexto',assunto:'Assuntos atuais',historico:'Atualizações do histórico',sintese:'Sínteses',resumo:'Resumos executivos',fonte:'Documentos originais'};
export function AnalysisCoverage({coverage:c}:{coverage:Coverage}){
  return <details className="analysis-coverage"><summary>{c.issues.length?'Leitura concluída com pendências':'Leitura do conteúdo selecionado concluída'} · conferir cobertura</summary><p>Retrato do projeto em {new Date(c.snapshot_at).toLocaleString('pt-BR')}. {c.chunks_read} de {c.chunks_total} trechos revisados em etapas.</p><ul>{Object.entries(c.counts).map(([kind,n])=><li key={kind}>{kinds[kind]||kind}: {n}</li>)}</ul><p>{c.scope==='living_report'?'Base da resposta: todas as sínteses e resumos ativos salvos, considerando a estrutura e o contexto do projeto.':''} {c.history_included?'Histórico detalhado incluído conforme o pedido.':c.history_included===false?'O histórico detalhado não foi relido nesta consulta.':''}</p><p>{c.originals_included?'Documentos originais incluídos quando foi possível extrair o texto.':'A resposta prioriza o conteúdo compilado. Documentos originais não foram relidos nesta consulta.'}</p><p>{c.task_status==='read'?`Sala ${c.task_room}: ${c.task_count} tarefa(s), consultadas em ${new Date(c.tasks_read_at).toLocaleString('pt-BR')}.`:c.task_status==='not_requested'?'As tarefas da sala não foram necessárias para este pedido.':c.task_message||'Tarefas da sala indisponíveis.'}</p>{c.comparison_requested&&<p>{c.comparison_complete?'Todos os lotes de propostas foram comparados com toda a lista recebida da sala.':'Comparação incompleta: não é possível afirmar quais tarefas faltam.'}</p>}{c.issues.length>0&&<ul>{c.issues.map((issue,i)=><li key={i}><strong>{issue.title}</strong>: {issue.message}</li>)}</ul>}<p className="muted-text">Leitura em etapas não garante que todos os fatos estejam atualizados. Confira as fontes; anexos sem texto e informações ainda não organizadas estão indicados acima.</p></details>;
}
const classifications:Record<string,string>={existing:'Já existe',update:'Possível atualização',review:'Precisa conferir',possible_new:'Possível nova tarefa',not_compared:'Proposta sem comparação'};
export const comparisonText=(rows:Comparison[])=>rows.map(c=>[`${classifications[c.classification]} — ${c.action}`,`Local: ${c.location||'não informado'} · Equipamento: ${c.equipment||'não informado'}`,`Responsável: ${c.responsible||'não informado'} · Prazo: ${c.due_date||'não informado'}`,...c.matches.map(m=>`Tarefa ${m.task?.taskNumber||m.task_id}: ${m.task?.description||''} — ${m.reason}`),`Fontes: ${c.source_numbers.map(n=>`[${n}]`).join(' ')}`].join('\n')).join('\n\n');
export function AnalysisComparisons({rows,citations}:{rows:Comparison[];citations:(numbers:number[])=>ReactNode}){
  const [visible,setVisible]=useState(20);
  if(!rows.length)return null;
  return <section className="analysis-comparisons"><h2>Propostas e tarefas da sala</h2><p>{rows.length} proposta(s) identificada(s). Revise correspondências e possíveis repetições antes de cadastrar.</p>{rows.slice(0,visible).map(c=><article key={c.id} className="analysis-candidate"><span className={`analysis-classification ${c.classification}`}>{classifications[c.classification]}</span><h3>{c.action}</h3><p>{[c.location&&`Local: ${c.location}`,c.equipment&&`Equipamento: ${c.equipment}`].filter(Boolean).join(' · ')}</p><p>Responsável: {c.responsible||'não informado'} · Prazo: {c.due_date||'não informado'}</p>{c.matches.map((m,i)=><div key={i} className="analysis-match"><strong>Tarefa {m.task?.taskNumber||m.task_id}: {m.task?.description}</strong><p>{m.reason}</p><small>Estado no Chatask: {{pending:'Pendente',in_progress:'Em andamento',completed:'Concluída'}[m.task?.status || ''] || m.task?.status || 'não informado'}</small></div>)}{citations(c.source_numbers)}</article>)}{visible<rows.length&&<button className="button secondary" onClick={()=>setVisible(v=>v+20)}>Mostrar mais propostas ({rows.length-visible} restantes)</button>}</section>;
}
