// Test-only preload; production never imports this file or configures a remote override.
const original=globalThis.fetch;
const tasks=[{id:101,taskNumber:1,chatRoomId:11,description:'Tarefa da sala 11',status:'pending',assignedToName:'Participante',priority:'medium',dueDate:null,updatedAt:'2026-11-01T00:00:00.000Z'}];
globalThis.fetch=async(url,options={})=>{
  if(!String(url).startsWith('https://chataskweb.onrender.com/api/trpc/'))return original(url,options);
  const parsed=new URL(url),method=parsed.pathname.split('/').at(-1),input=JSON.parse(options.body||parsed.searchParams.get('input')||'{"json":null}').json;
  const response=data=>new Response(JSON.stringify({result:{data:{json:data}}}),{headers:{'Content-Type':'application/json'}});
  if(method==='auth.login')return response({id:7,name:'Conta sintética',sessionToken:'fixture-token'});
  if(options.headers?.Authorization!=='Bearer fixture-token')return new Response('{}',{status:401});
  if(method==='chat.rooms')return response([{id:11,name:'Grande Sertão sintético'},{id:12,name:'Guaporé sintético'}]);
  if(method==='tasks.list')return response(tasks.filter(t=>t.chatRoomId===input.chatRoomId));
  if(method==='tasks.extractFromMessage'){
    if(input.messageContent==='simulate-timeout')throw Error('Simulated timeout');
    tasks.push({...tasks[0],id:102,taskNumber:2,description:input.messageContent,status:'pending'});return response([{insertId:102}]);
  }
  if(method==='tasks.updateDescription'||method==='tasks.updateStatus'){
    const task=tasks.find(t=>t.id===input.taskId);Object.assign(task,input,{updatedAt:new Date().toISOString()});return response({success:true});
  }
  throw Error(`Unexpected upstream operation: ${method}`);
};
