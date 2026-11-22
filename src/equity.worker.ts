import {simulate, seeded} from './core';
self.onmessage = (e: MessageEvent<{cards:number[], n:number, id:string, seed:number}>) => { try { self.postMessage({id:e.data.id,result:simulate(e.data.cards,e.data.n,seeded(e.data.seed))}); } catch(error) { self.postMessage({id:e.data.id,error:String(error)}); } };
