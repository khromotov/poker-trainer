export type Card = number;
export const deck = (): Card[] => Array.from({length:52}, (_,i)=>i);
export function validate(cards: Card[]) { if(cards.some(c=>!Number.isInteger(c)||c<0||c>=52)||new Set(cards).size!==cards.length) throw new Error('Некорректные или повторяющиеся карты'); }
export const rank = (c: Card) => Math.floor(c / 4) + 2;
export const suit = (c: Card) => c % 4;
export function evaluate(cards: Card[]): number[] {
 if(cards.length!==7) throw new Error('Нужно семь карт'); validate(cards);
 const counts=Array(15).fill(0) as number[]; for(const c of cards) counts[rank(c)]++;
 const straight=(rs:number[])=>{const s=new Set(rs); if(s.has(14)) s.add(1); for(let h=14;h>=5;h--) if([0,1,2,3,4].every(i=>s.has(h-i))) return h; return 0};
 const flushSuit=[0,1,2,3].find(s=>cards.filter(c=>suit(c)===s).length>=5);
 if(flushSuit!==undefined){const f=cards.filter(c=>suit(c)===flushSuit).map(rank).sort((a,b)=>b-a); const sf=straight(f); if(sf) return [8,sf];}
 const groups=Array.from({length:13},(_,i)=>14-i).filter(r=>counts[r]>0);
 const quad=groups.find(r=>counts[r]===4); if(quad) return [7,quad,groups.find(r=>r!==quad)!];
 const trips=groups.filter(r=>counts[r]>=3); if(trips.length){const pair=groups.find(r=>r!==trips[0]&&counts[r]>=2); if(pair) return [6,trips[0],pair];}
 if(flushSuit!==undefined) return [5,...cards.filter(c=>suit(c)===flushSuit).map(rank).sort((a,b)=>b-a).slice(0,5)];
 const st=straight(groups); if(st) return [4,st];
 if(trips.length) return [3,trips[0],...groups.filter(r=>r!==trips[0]).slice(0,2)];
 const pairs=groups.filter(r=>counts[r]>=2); if(pairs.length>=2) return [2,pairs[0],pairs[1],groups.find(r=>r!==pairs[0]&&r!==pairs[1])!];
 if(pairs.length) return [1,pairs[0],...groups.filter(r=>r!==pairs[0]).slice(0,3)]; return [0,...groups.slice(0,5)];
}
export function compare(a:number[],b:number[]) { for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]??0)-(b[i]??0); if(d) return Math.sign(d);} return 0; }
export function seeded(seed:number) { return ()=>{seed=(seed+0x6D2B79F5)|0; let t=Math.imul(seed^(seed>>>15),1|seed); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296;}; }
export function simulate(hands:Card[], n:number, random:()=>number=Math.random) { validate(hands); if(hands.length!==4||!Number.isInteger(n)||n<1) throw new Error('Неверные параметры'); const remaining=deck().filter(c=>!hands.includes(c)); let wins=0,losses=0,ties=0; for(let i=0;i<n;i++){const d=remaining.slice(); for(let j=0;j<5;j++){const k=j+Math.floor(random()*(48-j)); [d[j],d[k]]=[d[k],d[j]];} const board=d.slice(0,5); const result=compare(evaluate([...hands.slice(0,2),...board]),evaluate([...hands.slice(2),...board])); if(result>0)wins++;else if(result<0)losses++;else ties++;} return {wins,losses,ties,simulations:n,equity:(wins+ties/2)/n,win:wins/n,tie:ties/n}; }
