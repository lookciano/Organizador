import test from 'node:test';
import assert from 'node:assert/strict';
import {sealSession,openSession,chataskCall,publicTask} from './chatask.mjs';
test('Chatask credentials are encrypted, tamper resistant and bound to the current session and user',()=>{
  const encrypted=sealSession('private-token','random-session','user-a');
  assert.equal(openSession(encrypted,'random-session','user-a'),'private-token');
  assert.throws(()=>openSession(encrypted,'other-session','user-a'));assert.throws(()=>openSession(encrypted,'random-session','user-b'));
  const bytes=Buffer.from(encrypted,'base64');bytes[30]^=1;assert.throws(()=>openSession(bytes.toString('base64'),'random-session','user-a'));
});
test('Chatask adapter uses fixed authenticated routes and excludes personal tasks and arbitrary endpoints',async()=>{
  const calls=[];const transport=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({result:{data:{json:[{id:1}]}}}));};
  assert.deepEqual(await chataskCall('tasks.list',{chatRoomId:11},'secret',transport),[{id:1}]);
  assert.match(calls[0].url,/^https:\/\/chataskweb.onrender.com\/api\/trpc\/tasks.list\?/);assert.equal(calls[0].options.headers.Authorization,'Bearer secret');
  for(const route of ['personalTasks.list','tasks.allTasks','messages.send','https://example.com'])await assert.rejects(chataskCall(route,null,'secret',transport));
  assert.equal(calls.length,1);
});
test('upstream errors are sanitized and mutations are not automatically retried',async()=>{
  let attempts=0;await assert.rejects(chataskCall('tasks.extractFromMessage',{},'secret',async()=>{attempts++;return new Response('SECRET',{status:500});}),/Resposta inválida/);assert.equal(attempts,1);
  await assert.rejects(chataskCall('tasks.list',{},'secret',async()=>new Response('{}',{status:403})),/não tem acesso/);
  assert.equal(publicTask({id:1,description:'Tarefa',secret:'do not leak'}).secret,undefined);
});
