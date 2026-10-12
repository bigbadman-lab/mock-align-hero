import { decodeSharing } from "./lib/rewards/pump-sharing";
const R="https://api.mainnet-beta.solana.com";
const rpc=async(m:string,p:unknown[])=>{for(let i=0;i<4;i++){try{const r=await fetch(R,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});if(r.status===429){await Bun.sleep(2500);continue;}return (await r.json()).result;}catch{await Bun.sleep(1500);}}return null;};
let slot=(await rpc("getSlot",[{commitment:"finalized"}])) - Number(process.argv[2]); const t0=Date.now(); let blocks=0, dists=0, sweeps=0;
while(Date.now()-t0<50000){
  const b=await rpc("getBlock",[slot--,{encoding:"json",maxSupportedTransactionVersion:1,transactionDetails:"full",rewards:false,commitment:"finalized"}]); if(!b) continue; blocks++;
  for(const tx of b.transactions){ const L=(tx.meta?.logMessages??[]).join(" "); if(!L.includes("DistributeCreatorFees")) continue;
    const d=await decodeSharing({...tx,slot:slot+1,blockTime:b.blockTime}); if(d.kind!=="OK") { if(d.kind==="UNKNOWN") console.log("UNKNOWN",d.reason,tx.transaction.signatures[0]); continue; }
    dists+=d.distributions.length; sweeps+=d.sweeps.length;
    for(const x of d.distributions) if(x.receipts.length>=2 && x.distributed>0n){ console.log("MULTI",x.signature,x.slot,x.mint,x.receipts.map(r=>`${r.address}:${r.shareBps}:${r.lamports}`).join(" "),"dist",x.distributed); await Bun.write(`/tmp/p5/multi_${x.signature.slice(0,8)}.json`,JSON.stringify({...tx,slot:slot+1,blockTime:b.blockTime})); }
  }
}
console.log("blocks",blocks,"distributions",dists,"amm sweeps",sweeps);
