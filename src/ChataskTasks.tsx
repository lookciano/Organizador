import { useEffect, useRef, useState } from 'react';

type Room = {id:number;name:string};
type Task = {id:number;taskNumber:number;description:string;assignedToName:string;dueDate:string|null;priority:string;status:string;updatedAt:string};
async function request<T>(path:string,body?:unknown,method=body?'POST':'GET'):Promise<T>{
  const response=await fetch(path,{method,credentials:'include',headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await response.json(); if(!response.ok)throw new Error(data.error||'Não foi possível consultar o Chatask.');return data;
}
const errorText=(error:unknown)=>error instanceof Error?error.message:'Não foi possível concluir a operação.';
const displayDate=(value:string|null)=>value?new Date(value).toLocaleDateString('pt-BR',{timeZone:'UTC'}):'Sem prazo';
export function TasksView({projectId,owner=false}:{projectId:string;owner?:boolean}){
  const [connected,setConnected]=useState(false),[account,setAccount]=useState('');
  const [room,setRoom]=useState<Room|null>(null),[rooms,setRooms]=useState<Room[]>([]),[roomId,setRoomId]=useState('');
  const [hasAccess,setHasAccess]=useState(false);
  const [tasks,setTasks]=useState<Task[]>([]),[legacy,setLegacy]=useState(0),[loading,setLoading]=useState(true);
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[description,setDescription]=useState('');
  const [editing,setEditing]=useState<Task|null>(null),[editText,setEditText]=useState(''),[filter,setFilter]=useState('');
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const mounted=useRef(true),locked=useRef(false),generation=useRef(0),operation=useRef<string|null>(null);
  const base=`/api/projects/${projectId}/chatask`;
  async function load(){
    const version=++generation.current; setLoading(true); setError('');
    try{
      const [connection,config]=await Promise.all([request<{connected:boolean;name?:string}>('/api/chatask/connection'),request<{room:Room|null;legacyCount:number}>(base)]);
      if(!mounted.current||version!==generation.current)return;
      setHasAccess(false);setConnected(connection.connected);setAccount(connection.name||'');setRoom(config.room);setRoomId(String(config.room?.id||''));setLegacy(config.legacyCount);setTasks([]);
      if(connection.connected){
        const available=await request<{rooms:Room[]}>('/api/chatask/rooms');
        if(!mounted.current||version!==generation.current)return;setRooms(available.rooms);
        if(config.room){
          const data=await request<{tasks:Task[];room:Room}>(`${base}/tasks`);
          if(!mounted.current||version!==generation.current)return;setTasks(data.tasks);setRoom(data.room);setHasAccess(true);
        }
      }else setRooms([]);
    }catch(cause){if(mounted.current&&version===generation.current){setHasAccess(false);setTasks([]);setError(errorText(cause));}}
    finally{if(mounted.current&&version===generation.current)setLoading(false);}
  }
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;generation.current++;};},[projectId]);
  useEffect(()=>{const timer=window.setInterval(()=>{if(!document.hidden&&!locked.current&&!editing&&!description)void load();},60000);return()=>window.clearInterval(timer);},[projectId,editing,description]);
  async function act(action:()=>Promise<void>){
    if(locked.current)return;locked.current=true;setBusy(true);setError('');setMessage('');
    try{await action();}catch(cause){if(mounted.current)setError(errorText(cause));}finally{locked.current=false;if(mounted.current)setBusy(false);}
  }
  const visible=tasks.filter(t=>`${t.description} ${t.assignedToName}`.toLocaleLowerCase('pt-BR').includes(filter.toLocaleLowerCase('pt-BR')));
  return <section className="panel task-panel chatask-tasks"><div className="task-heading"><div><h1>Tarefas</h1><p>{room?`Sala ${room.name} · mesma lista do Chatask`:'Vincule uma sala do Chatask para acompanhar as tarefas deste projeto.'}</p></div><button className="button ghost" disabled={busy||loading||!!editing} onClick={()=>void load()}>Atualizar</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {loading&&<p role="status">Consultando Chatask…</p>}
    {!loading&&!connected&&<form className="chatask-connect" onSubmit={e=>{e.preventDefault();void act(async()=>{try{await request('/api/chatask/connection',{email,password});await load();}finally{if(mounted.current)setPassword('');}});}}><h2>Conectar minha conta do Chatask</h2><p>Use seu acesso ao Chatask. A senha é enviada para autenticar e não é armazenada. A conexão vale para esta sessão do Organizador e respeita as salas às quais você tem acesso.</p><label>E-mail do Chatask<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Senha do Chatask<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="button primary" disabled={busy}>Conectar ao Chatask</button></form>}
    {connected&&<p className="connection-info">Conectado como {account}. <button className="text-link" disabled={busy} onClick={()=>void act(async()=>{await request('/api/chatask/connection',{},'DELETE');setEditing(null);setDescription('');operation.current=null;await load();})}>Desconectar</button></p>}
    {connected&&owner&&<details className="room-settings" open={!room}><summary>{room?'Configurar sala vinculada':'Vincular sala a este projeto'}</summary><form onSubmit={e=>{e.preventDefault();void act(async()=>{await request(base,{roomId:Number(roomId)},'PUT');setDescription('');setEditing(null);operation.current=null;await load();setMessage('Sala vinculada. As tarefas permanecem no Chatask.');});}}><label>Sala do Chatask<select required value={roomId} onChange={e=>setRoomId(e.target.value)}><option value="">Selecione uma sala</option>{rooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label><button className="button primary" disabled={busy||loading||!roomId||!!editing}>Vincular sala</button></form></details>}
    {connected&&!owner&&!room&&<p>O responsável pelo projeto precisa vincular uma sala do Chatask.</p>}
    {legacy>0&&<p className="muted-text">Há {legacy} tarefa(s) local(is) da versão anterior preservada(s). Elas não foram enviadas automaticamente ao Chatask.</p>}
    {connected&&room&&hasAccess&&!loading&&<>
      <form className="task-create" onSubmit={e=>{e.preventDefault();void act(async()=>{operation.current??=crypto.randomUUID();const result=await request<{created:boolean}>(`${base}/tasks`,{description,roomId:room.id,operationId:operation.current});operation.current=null;setDescription('');await load();setMessage(result.created?'Tarefa criada no Chatask. Confira responsável, prazo e prioridade interpretados pela IA.':'O Chatask não identificou uma tarefa. Escreva a ação de forma mais explícita.');});}}><label>Nova tarefa<textarea required maxLength={5000} rows={3} placeholder="Ex.: Maria deve revisar o projeto até 15/11/2026, com prioridade alta." value={description} onChange={e=>setDescription(e.target.value)} disabled={busy||!!operation.current}/></label><p className="muted-text">O Chatask interpreta o texto com IA para definir a tarefa e o responsável. Nenhuma mensagem será publicada na conversa.</p><button className="button primary" disabled={busy||!!editing||!!operation.current}>Criar tarefa no Chatask</button>{operation.current&&<button type="button" className="button ghost" disabled={busy} onClick={()=>{operation.current=null;setDescription('');setMessage('Antes de enviar uma nova tarefa, confira se a tentativa anterior aparece na lista.');}}>Já conferi a lista; iniciar outra tarefa</button>}</form>
      <label>Buscar tarefas<input type="search" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Descrição ou responsável"/></label>
      {!visible.length&&<p className="muted-text">{tasks.length?'Nenhuma tarefa corresponde à busca.':'Nenhuma tarefa nesta sala.'}</p>}
      {visible.map(task=><article className="chatask-task" key={task.id}><header><strong>Tarefa #{task.taskNumber||task.id}</strong><span>{task.status==='completed'?'Concluída':task.status==='pending'?'Pendente':task.status}</span></header>{editing?.id===task.id?<form onSubmit={e=>{e.preventDefault();void act(async()=>{await request(`${base}/tasks/${task.id}`,{description:editText,roomId:room.id,updatedAt:editing.updatedAt},'PATCH');setEditing(null);await load();setMessage('Descrição atualizada no Chatask.');});}}><label>Descrição da tarefa<textarea required maxLength={8000} rows={4} value={editText} onChange={e=>setEditText(e.target.value)}/></label><button className="button primary" disabled={busy}>Salvar descrição</button><button type="button" className="button ghost" disabled={busy} onClick={()=>setEditing(null)}>Cancelar</button></form>:<p className="task-description">{task.description}</p>}<p className="muted-text">{task.assignedToName||'Sem responsável'} · {displayDate(task.dueDate)} · Prioridade {({low:'baixa',medium:'média',high:'alta'} as Record<string,string>)[task.priority]||task.priority}</p><div className="task-actions"><button className="button ghost" disabled={busy||!!editing} onClick={()=>{setEditing(task);setEditText(task.description);}}>Editar descrição</button>{['pending','completed'].includes(task.status)&&<button className="button ghost" disabled={busy||!!editing} onClick={()=>void act(async()=>{await request(`${base}/tasks/${task.id}`,{status:task.status==='completed'?'pending':'completed',roomId:room.id,updatedAt:task.updatedAt},'PATCH');await load();setMessage('Situação atualizada no Chatask.');})}>{task.status==='completed'?'Reabrir':'Concluir'}</button>}</div></article>)}
    </>}
    <p className="muted-text">Somente tarefas da sala vinculada. “Minhas tarefas” permanece exclusivamente no Chatask. Prazo, prioridade e responsável são exibidos para consulta; a integração atual permite editar descrição e conclusão.</p>
  </section>;
}
