// Run on the VPS as root. Only sanitized search metadata is returned.
import http from 'node:http';
import {CONTROL_SOCKET} from './vk-browser-driver.mjs';
const args=process.argv.slice(2);let userId,query='Queen',status=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--user-id')userId=Number(args[++i]);
  else if(args[i]==='--query')query=args[++i];
  else if(args[i]==='--status')status=true;
  else{console.error('Неизвестный параметр.');process.exit(1);}
}
if(!status&&(!Number.isSafeInteger(userId)||userId<=0||typeof query!=='string'||!query.trim()||query.length>200)){
  console.error('Использование: node scripts/check-vk-browser.mjs --user-id ЧИСЛОВОЙ_ID [--query Queen]');process.exit(1);
}
const body=JSON.stringify({query,user_id:userId});
try{
  const result=await new Promise((resolve,reject)=>{
    const request=http.request({socketPath:CONTROL_SOCKET,path:status?'/status':'/probe',method:status?'GET':'POST',timeout:23000,
      headers:status?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
      const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>32768){request.destroy(new Error());return;}chunks.push(chunk);});
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error());}});response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(new Error()));request.on('error',reject);request.end(status?undefined:body);
  });
  console.log(JSON.stringify(result,null,2));if(result.ok===false)process.exitCode=1;
}catch{console.error('Канал браузера недоступен. Проверьте запуск scripts/vk-browser.py и открытую страницу музыки VK. Секреты не выводились.');process.exitCode=1;}
