const fs=require('fs');
const path=require('path');

function createHandJobRunner({directory,fetch=globalThis.fetch,onComplete=()=>{},delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),setTimer=setTimeout,now=Date.now}){
  fs.mkdirSync(directory,{recursive:true});
  const running=new Set(),retryTimers=new Map();
  function file(id){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error('Invalid hand job ID');return path.join(directory,id+'.json');}
  function read(id){const target=file(id);return fs.existsSync(target)?JSON.parse(fs.readFileSync(target,'utf8')):null;}
  function write(job,create=false){
    const target=file(job.requestId);if(!create&&!fs.existsSync(target))return false;
    fs.writeFileSync(target+'.tmp',JSON.stringify(job));fs.renameSync(target+'.tmp',target);return true;
  }
  function jobs(){return fs.readdirSync(directory).filter(name=>name.endsWith('.json')).map(name=>{try{return read(name.slice(0,-5));}catch{return null;}}).filter(Boolean);}
  async function post(job,route,payload){
    const response=await fetch(job.apiBase+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    return {status:response.status,body:await response.json()};
  }
  async function complete(job){
    if(!write(job))return;
    if(!job.notified){job.notified=true;write(job);await onComplete(job,true);}
    else await onComplete(job,false);
  }
  async function run(id){
    if(running.has(id))return;
    running.add(id);
    try{
      const job=read(id);if(!job)return;
      if(job.status!=='pending'){await complete(job);return;}
      if(now()-job.createdAt>=24*60*60_000){
        job.status='failed';job.error={message:'This background request expired. Your hand is saved; open it to retry.'};job.completedAt=now();await complete(job);return;
      }
      if(!job.serverJobId){
        const response=await post(job,'/hand-jobs/start',{requestId:id,kind:job.kind,payload:job.payload});
        if(response.status>=500||response.status===429)throw new Error('Hand processing service unavailable');
        if(response.status>=400){job.status='failed';job.error={message:response.body.message||response.body.error};await complete(job);return;}
        if(!response.body.jobId)throw new Error('Missing hand job ID');
        job.serverJobId=response.body.jobId;if(!write(job))return;
      }
      const deadline=now()+8*60_000;
      do{
        if(!read(id))return;
        const response=await post(job,'/hand-jobs/poll',{jobId:job.serverJobId});
        if(response.status>=500||response.status===429)throw new Error('Hand processing service unavailable');
        if(response.status>=400){job.status='failed';job.error={message:response.body.message||response.body.error};await complete(job);return;}
        if(['complete','failed'].includes(response.body.status)){
          Object.assign(job,{status:response.body.status,result:response.body.result,error:response.body.error,completedAt:now()});
          await complete(job);return;
        }
        await delay(2500);
      }while(now()<deadline);
      throw new Error('Hand job still processing');
    }catch{
      if(read(id))retryTimers.set(id,setTimer(()=>{retryTimers.delete(id);run(id);},15000));
    }finally{running.delete(id);}
  }
  return {
    enqueue(input){
      if(!['analysis','reconstruction','solve'].includes(input?.kind)||!input.handId||!input.payload)throw new Error('Invalid hand job');
      const id=input.requestId;
      if(!read(id))write({...input,apiBase:String(input.apiBase||'https://inner-game-production.up.railway.app').replace(/\/+$/,''),status:'pending',createdAt:now()},true);
      run(id);return {accepted:true};
    },
    ack({requestId}){if(fs.existsSync(file(requestId)))fs.unlinkSync(file(requestId));const timer=retryTimers.get(requestId);if(timer)clearTimeout(timer);retryTimers.delete(requestId);},
    cancel({requestIds=[],all=false}){(all?jobs().map(job=>job.requestId):requestIds).forEach(requestId=>this.ack({requestId}));},
    restore(){jobs().forEach(job=>run(job.requestId));},
    async deliver(){for(const job of jobs())if(job.status!=='pending')await onComplete(job,false);}
  };
}
module.exports={createHandJobRunner};
