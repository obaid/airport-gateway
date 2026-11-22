import {mkdir,open,chmod,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
const dir=process.env.AIRPORT_DATA_DIR || path.join(homedir(),'Library','Application Support','Airport','live');
await mkdir(dir,{recursive:true,mode:0o700});
const filename=path.join(dir,'platform.env');
try {
  const file=await open(filename,'wx',0o600);
  try{await file.writeFile('# Airport server configuration on this Mac.\nCOMPOSIO_API_KEY=\n');}
  finally{await file.close();}
}catch(err){if(err.code!=='EEXIST')throw err;}
if(!(await lstat(filename)).isFile())throw Error('Expected a private local configuration file.');
await chmod(filename,0o600);
if(process.platform==='darwin') {
  const editor=spawn('/usr/bin/open',['-a','TextEdit',filename],{stdio:'ignore'});
  editor.on('exit',code=>{if(code)process.exitCode=code;});
}else console.log('Set COMPOSIO_API_KEY in '+filename+' or your server environment.');
