// Hosted installs inject the secret into the server environment. This file is
// the single-owner Mac fallback, outside the repository and the HTTP asset map.
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';

export async function localPlatformKey(stateDir) {
  const configured=process.env.COMPOSIO_API_KEY?.trim();
  if(configured)return configured;
  let file;
  try {
    file=await open(path.join(stateDir,'platform.env'),constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await file.stat();
    if(!info.isFile() || info.size>16384 || (process.getuid && info.uid!==process.getuid()))throw Error('Invalid Airport server configuration file.');
    if((info.mode & 0o077)!==0)await file.chmod(0o600);
    const value=parseEnv(await file.readFile('utf8')).COMPOSIO_API_KEY?.trim();
    if(!value)return undefined;
    if(value.length<12||value.length>1000||/[\r\n]/.test(value))throw Error('Invalid COMPOSIO_API_KEY in platform.env.');
    return value;
  }catch(err){if(err.code==='ENOENT')return undefined;throw err;}
  finally{await file?.close();}
}
