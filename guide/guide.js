(() => {
  "use strict";
  const PAGE_COUNT=36, PAGE_PATH="./pages", PAGE_EXT="webp", MOBILE_BREAKPOINT=800;
  const book=document.getElementById("book"),leftSlot=document.getElementById("leftSlot"),
  rightSlot=document.getElementById("rightSlot"),singleSlot=document.getElementById("singleSlot"),
  prevButton=document.getElementById("prevButton"),nextButton=document.getElementById("nextButton"),
  stagePrev=document.getElementById("stagePrev"),stageNext=document.getElementById("stageNext"),
  fullscreenButton=document.getElementById("fullscreenButton"),viewerStage=document.getElementById("viewerStage"),
  pageStatus=document.getElementById("pageStatus"),progressBar=document.getElementById("progressBar");
  let currentView=0,touchStartX=null,touchStartY=null;
  const isMobile=()=>matchMedia(`(max-width:${MOBILE_BREAKPOINT}px)`).matches;
  const desktopViews=()=>{const v=[[1]];for(let p=2;p<=PAGE_COUNT-1;p+=2)v.push([p,p+1]);v.push([PAGE_COUNT]);return v};
  const DESKTOP_VIEWS=desktopViews();
  const totalViews=()=>isMobile()?PAGE_COUNT:DESKTOP_VIEWS.length;
  const pageFile=p=>`${PAGE_PATH}/page-${String(p).padStart(2,"0")}.${PAGE_EXT}`;
  const currentPages=()=>isMobile()?[currentView+1]:DESKTOP_VIEWS[currentView];

  function makePage(p){
    const img=new Image();img.className="page-image";img.alt=`101cruise Digital Guide page ${p}`;img.decoding="async";img.draggable=false;
    const wrap=document.createElement("div");wrap.style.position="absolute";wrap.style.inset="0";
    const loading=document.createElement("div");loading.className="page-loading";loading.textContent=`Loading page ${p}…`;wrap.appendChild(loading);
    img.onload=()=>wrap.replaceChildren(img);
    img.onerror=()=>{const e=document.createElement("div");e.className="page-error";e.innerHTML=`Page ${p} artwork is not installed yet.<code>${pageFile(p)}</code>`;wrap.replaceChildren(e)};
    img.src=pageFile(p);return wrap;
  }
  function clear(){leftSlot.replaceChildren();rightSlot.replaceChildren();singleSlot.replaceChildren()}
  function single(p){book.classList.add("single-mode");clear();singleSlot.appendChild(makePage(p))}
  function spread(a,b){book.classList.remove("single-mode");clear();leftSlot.appendChild(makePage(a));rightSlot.appendChild(makePage(b))}
  function status(){
    const p=currentPages();pageStatus.textContent=isMobile()?`Page ${p[0]} / ${PAGE_COUNT}`:
      (p.length===1&&p[0]===1)?"Cover":(p.length===1&&p[0]===PAGE_COUNT)?"Back cover":`Pages ${p[0]}–${p[1]}`;
    const max=totalViews()-1;progressBar.style.width=`${max?currentView/max*100:100}%`;
    prevButton.disabled=currentView===0;nextButton.disabled=currentView===totalViews()-1;
  }
  function preload(p){if(p<1||p>PAGE_COUNT)return;const i=new Image();i.src=pageFile(p)}
  function preloadNearby(){const p=currentPages(),first=p[0],last=p[p.length-1];for(let o=1;o<=3;o++){preload(first-o);preload(last+o)}}
  function animate(dir){const c=dir>0?"is-forward":"is-back";book.classList.remove("is-forward","is-back");void book.offsetWidth;book.classList.add(c);setTimeout(()=>book.classList.remove(c),320)}
  function render(dir=0){const p=currentPages();if(isMobile()||p.length===1)single(p[0]);else spread(p[0],p[1]);status();preloadNearby();if(dir)animate(dir)}
  function next(){if(currentView>=totalViews()-1)return;currentView++;render(1)}
  function prev(){if(currentView<=0)return;currentView--;render(-1)}
  prevButton.onclick=prev;nextButton.onclick=next;stagePrev.onclick=prev;stageNext.onclick=next;
  document.addEventListener("keydown",e=>{if(["ArrowRight","PageDown"," "].includes(e.key)){e.preventDefault();next()}if(["ArrowLeft","PageUp"].includes(e.key)){e.preventDefault();prev()}if(e.key==="Home"){currentView=0;render(-1)}if(e.key==="End"){currentView=totalViews()-1;render(1)}});
  viewerStage.addEventListener("touchstart",e=>{const t=e.changedTouches[0];touchStartX=t.clientX;touchStartY=t.clientY},{passive:true});
  viewerStage.addEventListener("touchend",e=>{if(touchStartX===null)return;const t=e.changedTouches[0],dx=t.clientX-touchStartX,dy=t.clientY-touchStartY;touchStartX=touchStartY=null;if(Math.abs(dx)<48||Math.abs(dx)<Math.abs(dy))return;dx<0?next():prev()},{passive:true});
  fullscreenButton.onclick=async()=>{try{document.fullscreenElement?await document.exitFullscreen():await document.documentElement.requestFullscreen()}catch{}};
  document.addEventListener("fullscreenchange",()=>fullscreenButton.textContent=document.fullscreenElement?"Exit full screen":"Full screen");
  document.addEventListener("contextmenu",e=>{if(e.target.closest(".viewer-stage"))e.preventDefault()});
  document.addEventListener("dragstart",e=>{if(e.target.closest(".viewer-stage"))e.preventDefault()});

  let wasMobile=isMobile(),timer;
  addEventListener("resize",()=>{clearTimeout(timer);timer=setTimeout(()=>{
    const now=isMobile();if(now===wasMobile)return;
    const oldPages=wasMobile?[currentView+1]:DESKTOP_VIEWS[currentView],page=oldPages[0];
    if(now)currentView=page-1;else currentView=page===1?0:page===PAGE_COUNT?DESKTOP_VIEWS.length-1:Math.ceil((page-1)/2);
    wasMobile=now;render();
  },120)});
  render();
})();
