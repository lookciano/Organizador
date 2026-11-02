import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from './db.mjs';

const BASE = 'https://chataskweb.onrender.com/api/trpc/';
const methods = { 'auth.login':'POST', 'chat.rooms':'GET', 'chat.getParticipants':'GET', 'tasks.list':'GET', 'tasks.extractFromMessage':'POST', 'tasks.updateDescription':'POST', 'tasks.updateStatus':'POST' };
const fault = (status, message) => Object.assign(new Error(message), {status});
const digest = value => createHash('sha256').update(value).digest();
export function sealSession(token, session, userId) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', digest(`organizador:chatask:${session}`), iv);
  cipher.setAAD(Buffer.from(userId));
  const data = Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function openSession(value, session, userId) {
  const bytes = Buffer.from(value,'base64'), decipher = createDecipheriv('aes-256-gcm',digest(`organizador:chatask:${session}`),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(userId)); decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
export async function chataskCall(method, input, token, transport = fetch) {
  if(!Object.hasOwn(methods,method)) throw fault(400,'Operação não disponível.');
  const verb=methods[method], payload=JSON.stringify({json:input ?? null});
  let response;
  try {
    response=await transport(BASE+method+(verb==='GET'?`?input=${encodeURIComponent(payload)}`:''),{
      method:verb, redirect:'error', signal:AbortSignal.timeout(90000),
      headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
      ...(verb==='POST'?{body:payload}:{})
    });
  } catch { throw fault(502,'O Chatask não respondeu. Atualize a lista antes de tentar novamente.'); }
  let value; try {value=await response.json();}catch{throw fault(502,'Resposta inválida do Chatask.');}
  if(!response.ok || value.error) {
    if(response.status===401) throw fault(401,'Conecte novamente sua conta do Chatask.');
    if(response.status===403) throw fault(403,'Sua conta do Chatask não tem acesso a esta sala.');
    if(response.status===429) throw fault(429,'O Chatask pediu para aguardar antes de tentar novamente.');
    throw fault(502,'Não foi possível concluir a operação no Chatask. Confira sua conta e tente novamente.');
  }
  return value.result?.data?.json ?? value.result?.data;
}
export function publicTask(t) {
  return {id:t.id,taskNumber:t.taskNumber,chatRoomId:t.chatRoomId,description:t.description,assignedToName:t.assignedToName || '',dueDate:t.dueDate,status:t.status,priority:t.priority,updatedAt:t.updatedAt};
}
const positive = n => Number.isSafeInteger(n) && n > 0;
export function registerChataskRoutes(app, requireUser, membership, ownerOnly, readCookie) {
  const safe = handler => async(req,res,next)=>{try{await handler(req,res);}catch(error){if(error.status)res.status(error.status).json({error:error.message});else next(error);}};
  const session = req => readCookie(req,'organizador_session');
  const key = req => digest(session(req)).toString('hex');
  async function connection(req) {
    const [[row]] = await db().execute('SELECT c.* FROM chatask_connections c JOIN sessions s ON s.token_hash=c.session_hash WHERE c.session_hash=? AND c.user_id=? AND s.expires_at>?',[key(req),req.user.id,new Date().toISOString()]);
    if(!row) throw fault(401,'Conecte sua conta do Chatask para acessar as tarefas.');
    try{return {...row,token:openSession(row.encrypted_token,session(req),req.user.id)};}catch{throw fault(401,'Conecte novamente sua conta do Chatask.');}
  }
  async function linked(req) {
    const [[link]] = await db().execute('SELECT room_id,room_name FROM chatask_project_rooms WHERE project_id=?',[req.params.projectId]);
    if(!link) throw fault(409,'Vincule uma sala do Chatask a este projeto.');
    return link;
  }
  const attempts=new Map();
  app.get('/api/chatask/connection',requireUser,safe(async(req,res)=>{
    try{const c=await connection(req);res.json({connected:true,name:c.account_name});}catch(error){if(error.status===401)res.json({connected:false});else throw error;}
  }));
  app.post('/api/chatask/connection',requireUser,safe(async(req,res)=>{
    const now=Date.now(), old=attempts.get(req.user.id), entry=old&&old.until>now?old:{count:0,until:now+15*60000};
    if(entry.count>=5)throw fault(429,'Aguarde 15 minutos antes de tentar conectar novamente.');
    entry.count++;attempts.set(req.user.id,entry);
    if(attempts.size>1000)for(const [id,v] of attempts)if(v.until<now)attempts.delete(id);
    const {email,password}=req.body;
    if(typeof email!=='string'||email.length>320||!email.includes('@')||typeof password!=='string'||password.length<6||password.length>1024)throw fault(400,'Informe o e-mail e a senha da sua conta do Chatask.');
    const account=await chataskCall('auth.login',{email:email.trim(),password});
    if(typeof account?.sessionToken!=='string'||!positive(account.id))throw fault(502,'O Chatask não confirmou a conexão.');
    const encrypted=sealSession(account.sessionToken,session(req),req.user.id);
    await db().execute('INSERT INTO chatask_connections (session_hash,user_id,account_id,account_name,encrypted_token) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id),account_name=VALUES(account_name),encrypted_token=VALUES(encrypted_token)',[key(req),req.user.id,account.id,String(account.displayName||account.name||email).slice(0,320),encrypted]);
    attempts.delete(req.user.id); res.json({connected:true});
  }));
  app.delete('/api/chatask/connection',requireUser,safe(async(req,res)=>{await db().execute('DELETE FROM chatask_connections WHERE session_hash=? AND user_id=?',[key(req),req.user.id]);res.json({ok:true});}));
  app.get('/api/chatask/rooms',requireUser,safe(async(req,res)=>{
    const c=await connection(req),rooms=await chataskCall('chat.rooms',null,c.token);
    if(!Array.isArray(rooms))throw fault(502,'Não foi possível listar as salas.');
    res.json({rooms:rooms.map(r=>({id:r.id,name:r.name}))});
  }));
  const guard=[requireUser,membership];
  app.get('/api/projects/:projectId/chatask',...guard,safe(async(req,res)=>{
    const [[link]]=await db().execute('SELECT room_id,room_name FROM chatask_project_rooms WHERE project_id=?',[req.params.projectId]);
    const [[legacy]]=await db().execute('SELECT COUNT(*) AS total FROM second_brain_tasks WHERE project_id=?',[req.params.projectId]);
    res.json({room:link?{id:link.room_id,name:link.room_name}:null,legacyCount:legacy.total});
  }));
  app.put('/api/projects/:projectId/chatask',...guard,ownerOnly,safe(async(req,res)=>{
    if(!positive(req.body.roomId))throw fault(400,'Selecione uma sala.');
    const c=await connection(req),rooms=await chataskCall('chat.rooms',null,c.token),room=rooms?.find(r=>r.id===req.body.roomId);
    if(!room)throw fault(403,'Sua conta não participa desta sala.');
    await chataskCall('tasks.list',{chatRoomId:room.id},c.token);
    const sql=await db().getConnection();
    try{
      await sql.beginTransaction();
      await sql.execute('SELECT id FROM projects WHERE id=? FOR UPDATE',[req.params.projectId]);
      const [[existing]]=await sql.execute('SELECT project_id FROM chatask_project_rooms WHERE project_id=?',[req.params.projectId]);
      if(existing)await sql.execute('UPDATE chatask_project_rooms SET room_id=?,room_name=? WHERE project_id=?',[room.id,String(room.name).slice(0,255),req.params.projectId]);
      else await sql.execute('INSERT INTO chatask_project_rooms (project_id,room_id,room_name) VALUES (?,?,?)',[req.params.projectId,room.id,String(room.name).slice(0,255)]);
      await sql.commit();
    }catch(error){await sql.rollback();if(error.code==='ER_DUP_ENTRY')throw fault(409,'Esta sala já está vinculada a outro projeto.');throw error;}
    finally{sql.release();}
    res.json({room:{id:room.id,name:room.name}});
  }));
  app.get('/api/projects/:projectId/chatask/tasks',...guard,safe(async(req,res)=>{
    const c=await connection(req),link=await linked(req),tasks=await chataskCall('tasks.list',{chatRoomId:link.room_id},c.token);
    if(!Array.isArray(tasks))throw fault(502,'Não foi possível listar as tarefas.');
    res.json({room:{id:link.room_id,name:link.room_name},tasks:tasks.map(publicTask)});
  }));
  app.post('/api/projects/:projectId/chatask/tasks',...guard,safe(async(req,res)=>{
    const {description,operationId,roomId}=req.body;
    if(typeof description!=='string'||!description.trim()||description.length>5000||typeof operationId!=='string'||! /^[a-f0-9-]{36}$/i.test(operationId))throw fault(400,'Escreva a tarefa em até 5.000 caracteres.');
    const c=await connection(req),link=await linked(req);
    if(roomId!==link.room_id)throw fault(409,'A sala vinculada mudou. Atualize a tela.');
    // Check membership before reserving the creation; no message is posted to the room.
    await chataskCall('tasks.list',{chatRoomId:link.room_id},c.token);
    try{await db().execute('INSERT INTO chatask_operations (id,project_id,user_id,room_id,state,created_at) VALUES (?,?,?,?,?,?)',[operationId,req.params.projectId,req.user.id,roomId,'pending',new Date().toISOString()]);}
    catch(error){if(error.code==='ER_DUP_ENTRY')throw fault(409,'Esta tentativa já foi enviada. Atualize a lista antes de criar outra tarefa.');throw error;}
    let result;
    try{result=await chataskCall('tasks.extractFromMessage',{chatRoomId:roomId,messageContent:description.trim()},c.token);}
    catch{await db().execute("UPDATE chatask_operations SET state='uncertain' WHERE id=?",[operationId]);throw fault(502,'Não foi possível confirmar a criação. Ela pode ter sido concluída no Chatask. Atualize a lista antes de criar outra tarefa.');}
    await db().execute("UPDATE chatask_operations SET state='done' WHERE id=?",[operationId]);
    res.json({created:Array.isArray(result)&&result.length>0});
  }));
  app.patch('/api/projects/:projectId/chatask/tasks/:taskId',...guard,safe(async(req,res)=>{
    const {description,status,roomId,updatedAt}=req.body, id=Number(req.params.taskId);
    if(!positive(id)||((description===undefined)===(status===undefined))||Object.keys(req.body).some(k=>!['description','status','roomId','updatedAt'].includes(k)))throw fault(400,'Altere a descrição ou a situação da tarefa.');
    if(description!==undefined&&(typeof description!=='string'||!description.trim()||description.length>8000))throw fault(400,'Descrição inválida.');
    if(status!==undefined&&!['pending','completed'].includes(status))throw fault(400,'Situação inválida.');
    const c=await connection(req),link=await linked(req);
    if(roomId!==link.room_id)throw fault(409,'A sala vinculada mudou. Atualize a tela.');
    const tasks=await chataskCall('tasks.list',{chatRoomId:link.room_id},c.token), task=tasks?.find(t=>t.id===id);
    if(!task)throw fault(404,'Tarefa não encontrada nesta sala.');
    if(typeof updatedAt!=='string'||updatedAt!==task.updatedAt)throw fault(409,'A tarefa mudou no Chatask. Atualize a lista antes de editar.');
    await chataskCall(description!==undefined?'tasks.updateDescription':'tasks.updateStatus',{taskId:id,...(description!==undefined?{description:description.trim()}:{status})},c.token);
    res.json({ok:true});
  }));
}
