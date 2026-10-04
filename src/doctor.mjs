import {CodexRpc} from './rpc.mjs';
const rpc=new CodexRpc();
try{await rpc.start();console.log(JSON.stringify({codexConnected:rpc.ready,codexLoggedIn:rpc.authenticated,availableModels:rpc.models.map(x=>x.id)},null,2));}
catch(e){console.error(e.message);process.exitCode=1;}
finally{rpc.stop();}
