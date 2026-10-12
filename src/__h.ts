import { decodeSharing, sharingConfigPda } from "./lib/rewards/pump-sharing";
const R="https://api.mainnet-beta.solana.com";
const rpc=async(m:string,p:unknown[])=>{for(let i=0;i<5;i++){try{const r=await fetch(R,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});if(r.status===429){await Bun.sleep(2500);continue;}return (await r.json()).result;}catch{await Bun.sleep(1500);}}return null;};
for (const mint of process.argv.slice(2)) {
  const sc=await sharingConfigPda(mint); const sigs=await rpc("getSignaturesForAddress",[sc,{limit:60,commitment:"finalized"}])??[];
  console.log(mint.slice(0,6),"config",sc,"sigs",sigs.length); let shown=0;
  for (const s of sigs) { if (s.err||shown>=2) continue; const tx=await rpc("getTransaction",[s.signature,{encoding:"json",maxSupportedTransactionVersion:1,commitment:"finalized"}]); const d=await decodeSharing(tx);
    if(d.kind==="UNKNOWN") console.log(" UNKNOWN",d.reason,s.signature.slice(0,10));
    if(d.kind==="OK") for(const x of d.distributions) if(x.distributed>0n && x.receipts.length>=2){ shown++; console.log(" NONZERO",x.signature,x.slot,"dist",x.distributed,x.receipts.map(r=>`${r.address}:${r.shareBps}:${r.lamports}`).join(" ")); await Bun.write(`/tmp/p5/multi_${x.signature.slice(0,8)}.json`,JSON.stringify(tx)); } }
}
