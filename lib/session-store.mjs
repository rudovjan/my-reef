import {mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync,existsSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

// This vault is outside the repository and web root. No account passwords are saved.
export function createSessionStore({path,keyPath}) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(!existsSync(keyPath)){
    if(existsSync(path))throw Error('Reef session encryption key is missing.');
    writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
  }
  chmodSync(keyPath,0o600);
  const key=readFileSync(keyPath);
  if(key.length!==32)throw Error('Invalid reef session encryption key.');
  let records={};
  if(existsSync(path)){
    try{
      if(statSync(path).size>64*1024*1024)throw Error('Vault too large');
      const data=JSON.parse(readFileSync(path,'utf8'));
      if(data.version!==1)throw Error('Unsupported vault');
      const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(data.iv,'base64'));
      decipher.setAAD(Buffer.from('my-reef-sessions-v1'));
      decipher.setAuthTag(Buffer.from(data.tag,'base64'));
      records=JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data,'base64')),decipher.final()]).toString('utf8'));
      if(!records||typeof records!=='object'||Array.isArray(records))throw Error('Invalid vault');
      chmodSync(path,0o600);
    }catch{throw Error('Saved reef sessions could not be decrypted.');}
  }
  const id=(vendor,session)=>createHash('sha256').update(vendor+'\0'+session).digest('hex');
  function save(){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from('my-reef-sessions-v1'));
    const data=Buffer.concat([cipher.update(JSON.stringify(records),'utf8'),cipher.final()]);
    const temporary=path+'.'+process.pid+'.tmp';
    writeFileSync(temporary,JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600});
    chmodSync(temporary,0o600);renameSync(temporary,path);chmodSync(path,0o600);
  }
  return {
    get(vendor,session){const record=records[id(vendor,session)];return record?structuredClone(record):null;},
    set(vendor,session,record){records[id(vendor,session)]=structuredClone(record);save();},
    delete(vendor,session){const k=id(vendor,session);if(Object.hasOwn(records,k)){delete records[k];save();}},
    promote(vendor,scope,sessions){
      // Migrate legacy browser-scoped connections to the instance owner.
      const destination=id(vendor,scope);
      if(Object.hasOwn(records,destination))return;
      const candidates=[...sessions.keys()].map(session=>records[id(vendor,session)]).filter(Boolean);
      candidates.sort((a,b)=>(Date.parse(b.lastAttempt||b.snapshot?.at)||b.expires||0)-(Date.parse(a.lastAttempt||a.snapshot?.at)||a.expires||0));
      if(candidates.length){records[destination]=structuredClone(candidates[0]);save();}
    },
    prune(vendor,sessions){
      // Preserve records from the other vendor; only authenticated sessions may restore them.
      const allowed=new Set([...sessions.keys()].map(s=>id(vendor,s)));let changed=false;
      for(const [k,record] of Object.entries(records))if(record.vendor===vendor&&!allowed.has(k)){delete records[k];changed=true;}
      if(changed)save();
    }
  };
}
