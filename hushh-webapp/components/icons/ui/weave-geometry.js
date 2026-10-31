/**
 * Approved connector-creative-motion/icon-engine.js Weave renderer.
 * Geometry, crossings, stagger and easing are preserved from the supplied kit.
 * Only loop colour grouping and the module boundary are adapted here.
 */
export const WEAVE_DURATION_MS = 1040;

  const PI=Math.PI;
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
  const mix=(a,b,t)=>a+(b-a)*t;
  const ease=t=>{t=clamp(t);return t*t*(3-2*t);};
  const easeOut=t=>1-Math.pow(1-clamp(t),3);
  const fmt=x=>Number(x.toFixed(3));
  const rad=d=>d*PI/180;
  function wave(t){
    if(t<=0||t>=1)return 0;
    if(t<.26)return easeOut(t/.26);
    if(t<.36)return 1;
    return 1-ease((t-.36)/.52);
  }
  function rotateZ(p,d){const c=Math.cos(rad(d)),s=Math.sin(rad(d));return {x:p.x*c-p.y*s,y:p.x*s+p.y*c,z:p.z||0};}
  function roundedRect(w,h,r,steps=12){
    const a=[];
    for(const [cx,cy,start] of [[w/2-r,-h/2+r,-90],[w/2-r,h/2-r,0],[-w/2+r,h/2-r,90],[-w/2+r,-h/2+r,180]]){
      for(let i=0;i<=steps;i++){const t=rad(start+i*90/steps);a.push({x:cx+r*Math.cos(t),y:cy+r*Math.sin(t),z:0});}
    }
    return a;
  }
  function path(points,closed=true){return points.map((p,i)=>(i?'L':'M')+fmt(p.x)+' '+fmt(p.y)).join(' ')+(closed?' Z':'');}
  function crossing(a,b,c,d){
    const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y;
    const denominator=rx*sy-ry*sx;
    if(Math.abs(denominator)<1e-8)return null;
    const qx=c.x-a.x,qy=c.y-a.y;
    const t=(qx*sy-qy*sx)/denominator,u=(qx*ry-qy*rx)/denominator;
    if(t<=0||t>=1||u<=0||u>=1)return null;
    return {x:a.x+t*rx,y:a.y+t*ry,za:mix(a.z,b.z,t),zb:mix(c.z,d.z,u),t,u,sine:Math.abs(denominator)/(Math.hypot(rx,ry)*Math.hypot(sx,sy))};
  }
  function proximity(a,b,c,d,limit){
    if(Math.min(a.x,b.x)>Math.max(c.x,d.x)+limit||Math.min(c.x,d.x)>Math.max(a.x,b.x)+limit||Math.min(a.y,b.y)>Math.max(c.y,d.y)+limit||Math.min(c.y,d.y)>Math.max(a.y,b.y)+limit)return null;
    const cross=crossing(a,b,c,d);if(cross)return {...cross,distance:0};
    const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y,rr=rx*rx+ry*ry,ss=sx*sx+sy*sy;
    const candidates=[[0,clamp(((a.x-c.x)*sx+(a.y-c.y)*sy)/ss)],[1,clamp(((b.x-c.x)*sx+(b.y-c.y)*sy)/ss)],[clamp(((c.x-a.x)*rx+(c.y-a.y)*ry)/rr),0],[clamp(((d.x-a.x)*rx+(d.y-a.y)*ry)/rr),1]];
    let best=null;
    for(const [t,u] of candidates){
      const ax=a.x+t*rx,ay=a.y+t*ry,bx=c.x+u*sx,by=c.y+u*sy,distance=Math.hypot(ax-bx,ay-by);
      if(distance<limit&&(!best||distance<best.distance))best={t,u,distance,za:mix(a.z,b.z,t),zb:mix(c.z,d.z,u),sine:Math.abs(rx*sy-ry*sx)/Math.sqrt(rr*ss)};
    }
    return best;
  }
  function ribbons(lines,phase,stroke=2.2){
    const holes=lines.map(()=>[]);
    const metrics=lines.map(points=>{
      const lengths=[],starts=[0];
      for(let i=0;i<points.length;i++){
        const a=points[i],b=points[(i+1)%points.length];
        lengths.push(Math.hypot(b.x-a.x,b.y-a.y));starts.push(starts[i]+lengths[i]);
      }
      return {lengths,starts,total:starts[starts.length-1]};
    });
    for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
      const a=lines[i],b=lines[j];
      for(let m=0;m<a.length;m++)for(let n=0;n<b.length;n++){
        const q=proximity(a[m],a[(m+1)%a.length],b[n],b[(n+1)%b.length],stroke*1.42);
        if(q){
          // A cyclic over/under order preserves the four-loop weave.
          const under=j===i+1?j:i,k=under===i?m:n,u=under===i?q.t:q.u;
          const strength=easeOut(1-q.distance/(stroke*1.42));
          const half=Math.min(3.7,stroke/(2*Math.max(.42,q.sine))+.9+stroke/2)*strength;
          if(half>.18)holes[under].push({s:metrics[under].starts[k]+metrics[under].lengths[k]*u,half});
        }
      }
    }
    const draw=(d)=>`<path d="${d}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const groups=lines.map((points,i)=>{
      const wrap = markup => `<g data-weave-loop="${i}" style="color:var(--ios-account-${(i+phase)%2===0?'accent':'label'})">${markup}</g>`;
      if(!holes[i].length)return wrap(draw(path(points)));
      const m=metrics[i],L=m.total,intervals=[];
      for(const h of holes[i]){
        for(const shift of [-L,0,L]){
          const a=Math.max(0,h.s-h.half+shift),b=Math.min(L,h.s+h.half+shift);
          if(b>a)intervals.push([a,b]);
        }
      }
      intervals.sort((a,b)=>a[0]-b[0]);
      const merged=[];
      for(const v of intervals){const last=merged[merged.length-1];if(last&&v[0]<=last[1])last[1]=Math.max(last[1],v[1]);else merged.push(v.slice());}
      function at(s){s=((s%L)+L)%L;let j=0;while(j<m.lengths.length-1&&m.starts[j+1]<s)j++;const a=points[j],b=points[(j+1)%points.length],u=(s-m.starts[j])/m.lengths[j];return {x:mix(a.x,b.x,u),y:mix(a.y,b.y,u)};}
      const runs=[];
      for(let j=0;j<merged.length;j++){
        const start=merged[j][1],end=(j+1<merged.length?merged[j+1][0]:merged[0][0]+L);
        if(end-start<stroke*1.85)continue;
        const part=[at(start)];
        for(const shift of [0,L])for(let k=0;k<points.length;k++){const s=m.starts[k]+shift;if(s>start&&s<end)part.push(points[k]);}
        part.push(at(end));runs.push(draw(path(part,false)));
      }
      return wrap(runs.join(''));
    });
    // Carry paint order with the quarter-turn as well as colour. Even crossing
    // edge antialiasing then matches exactly at completion and the next replay.
    const offset=((phase%4)+4)%4;
    return groups.slice(offset).concat(groups.slice(0,offset)).join('');
  }
  export function weaveFrame(t=0,phase=0){
    t=clamp(t);
    const lines=[];
    for(let i=0;i<4;i++){
      const u=clamp((t-i*.028)/.916),g=wave(u);
      const orbit=90*ease((u-.27)/.55);
      const theta=-90+i*90+orbit;
      const radius=8+3.1*g;
      lines.push(roundedRect(11+2*g,9-.5*g,3+g).map(p=>{
        const depth=Math.sin(4*Math.atan2(p.y,p.x))*(1-g);
        const v=rotateZ(p,i*90+orbit+18*g+25*(1-g));
        return {x:16+v.x+radius*Math.cos(rad(theta)),y:16+v.y+radius*Math.sin(rad(theta)),z:depth};
      }));
    }
    return ribbons(lines,phase,2.05);
  }
