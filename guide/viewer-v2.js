(() => {
  "use strict";
  const PAGE_COUNT=36, PAGE_PATH="./pages", PAGE_EXT="webp", MOBILE_BREAKPOINT=800, TURN_MS=640, BUILD_ID="20260810-1615";
  const book=document.getElementById("book"), leftSlot=document.getElementById("leftSlot"), rightSlot=document.getElementById("rightSlot"), singleSlot=document.getElementById("singleSlot"), prevButton=document.getElementById("prevButton"), nextButton=document.getElementById("nextButton"), stagePrev=document.getElementById("stagePrev"), stageNext=document.getElementById("stageNext"), fullscreenButton=document.getElementById("fullscreenButton"), viewerStage=document.getElementById("viewerStage"), pageStatus=document.getElementById("pageStatus"), progressBar=document.getElementById("progressBar");

  const flipSheet=document.createElement("div");
  flipSheet.className="flip-sheet";
  flipSheet.innerHTML='<div class="flip-face flip-front"></div><div class="flip-face flip-back"></div>';
  book.appendChild(flipSheet);
  const flipFront=flipSheet.querySelector(".flip-front"), flipBack=flipSheet.querySelector(".flip-back");

  let currentView=0, touchStartX=null, touchStartY=null, busy=false;
  const isMobile=()=>matchMedia(`(max-width:${MOBILE_BREAKPOINT}px)`).matches;
  const DESKTOP_VIEWS=(()=>{const v=[[1]];for(let p=2;p<=PAGE_COUNT-1;p+=2)v.push([p,p+1]);v.push([PAGE_COUNT]);return v})();
  const totalViews=()=>isMobile()?PAGE_COUNT:DESKTOP_VIEWS.length;
  const currentPages=()=>isMobile()?[currentView+1]:DESKTOP_VIEWS[currentView];
  const pageFile=p=>`${PAGE_PATH}/page-${String(p).padStart(2,"0")}.${PAGE_EXT}?v=${BUILD_ID}`;

  function makePage(page){
    const img=new Image(); img.className="page-image"; img.alt=`101cruise Digital Guide page ${page}`; img.decoding="async"; img.draggable=false;
    const wrap=document.createElement("div"); wrap.className="page-art";
    const loading=document.createElement("div"); loading.className="page-loading"; loading.textContent=`Loading page ${page}…`; wrap.appendChild(loading);
    img.onload=()=>wrap.replaceChildren(img);
    img.onerror=()=>{const e=document.createElement("div");e.className="page-error";e.textContent=`Page ${page} could not be loaded.`;wrap.replaceChildren(e)};
    img.src=pageFile(page); return wrap;
  }
  const setPage=(slot,page)=>slot.replaceChildren(makePage(page));
  const clearSlots=()=>{leftSlot.replaceChildren();rightSlot.replaceChildren();singleSlot.replaceChildren()};
  function renderSingle(page){book.classList.add("single-mode");clearSlots();setPage(singleSlot,page)}
  function renderSpread(l,r){book.classList.remove("single-mode");clearSlots();setPage(leftSlot,l);setPage(rightSlot,r)}
  function setBookMode(){const p=currentPages(); if(!isMobile()&&p.length===2)book.dataset.mode="spread"; else if(p[0]===1)book.dataset.mode="cover"; else if(p[p.length-1]===PAGE_COUNT)book.dataset.mode="back"; else book.dataset.mode="single"}
  function updateBookEdges(){if(isMobile())return;const max=Math.max(1,totalViews()-1),progress=currentView/max,left=1.5+progress*2.5,right=4-progress*2.5;book.style.setProperty("--left-stack",`${left.toFixed(1)}px`);book.style.setProperty("--right-stack",`${right.toFixed(1)}px`)}
  function updateStatus(){const p=currentPages();pageStatus.textContent=isMobile()?`Page ${p[0]} / ${PAGE_COUNT}`:(p.length===1&&p[0]===1)?"Cover":(p.length===1&&p[0]===PAGE_COUNT)?"Back cover":`Pages ${p[0]}–${p[1]}`;const max=totalViews()-1;progressBar.style.width=`${max?(currentView/max)*100:100}%`;const start=currentView===0,end=currentView===max;prevButton.disabled=start;nextButton.disabled=end;stagePrev.disabled=start;stageNext.disabled=end;updateBookEdges()}
  function preload(page){if(page<1||page>PAGE_COUNT)return;const img=new Image();img.src=pageFile(page)}
  function preloadNearby(){const p=currentPages(),first=p[0],last=p[p.length-1];for(let o=1;o<=4;o++){preload(first-o);preload(last+o)}}
  function resetFlip(){flipSheet.className="flip-sheet";flipFront.replaceChildren();flipBack.replaceChildren();book.classList.remove("is-turning")}
  function fallback(dir){const cls=dir>0?"is-forward":"is-back";book.classList.remove("is-forward","is-back");void book.offsetWidth;book.classList.add(cls);setTimeout(()=>book.classList.remove(cls),300)}
  function render(dir=0){resetFlip();const p=currentPages();if(isMobile()||p.length===1)renderSingle(p[0]);else renderSpread(p[0],p[1]);setBookMode();updateStatus();preloadNearby();if(dir)fallback(dir)}

  function flipForward(oldPages,newPages){
    busy=true;
    setPage(leftSlot,oldPages[0]); setPage(rightSlot,newPages[1]);
    flipFront.replaceChildren(makePage(oldPages[1])); flipBack.replaceChildren(makePage(newPages[0]));
    flipSheet.className="flip-sheet active from-right"; book.classList.add("is-turning"); void flipSheet.offsetWidth;
    requestAnimationFrame(()=>flipSheet.classList.add("turning"));
    setTimeout(()=>{currentView+=1;resetFlip();renderSpread(newPages[0],newPages[1]);setBookMode();updateStatus();preloadNearby();busy=false},TURN_MS+40);
  }
  function flipBackward(oldPages,newPages){
    busy=true;
    setPage(leftSlot,newPages[0]); setPage(rightSlot,oldPages[1]);
    flipFront.replaceChildren(makePage(oldPages[0])); flipBack.replaceChildren(makePage(newPages[1]));
    flipSheet.className="flip-sheet active from-left"; book.classList.add("is-turning"); void flipSheet.offsetWidth;
    requestAnimationFrame(()=>flipSheet.classList.add("turning"));
    setTimeout(()=>{currentView-=1;resetFlip();renderSpread(newPages[0],newPages[1]);setBookMode();updateStatus();preloadNearby();busy=false},TURN_MS+40);
  }
  function openCover(){busy=true;book.classList.add("cover-opening");setTimeout(()=>{book.classList.remove("cover-opening");currentView=1;render();fallback(1);busy=false},500)}
  function move(dir){
    if(busy)return;const nextView=currentView+dir;if(nextView<0||nextView>=totalViews())return;
    if(isMobile()){currentView=nextView;render(dir);return}
    const oldPages=DESKTOP_VIEWS[currentView],newPages=DESKTOP_VIEWS[nextView];
    if(dir>0&&currentView===0){openCover();return}
    if(oldPages.length===2&&newPages.length===2){dir>0?flipForward(oldPages,newPages):flipBackward(oldPages,newPages);return}
    currentView=nextView;render(dir);
  }

  prevButton.onclick=()=>move(-1); nextButton.onclick=()=>move(1); stagePrev.onclick=()=>move(-1); stageNext.onclick=()=>move(1);
  document.addEventListener("keydown",e=>{if(["ArrowRight","PageDown"," "].includes(e.key)){e.preventDefault();move(1)}else if(["ArrowLeft","PageUp"].includes(e.key)){e.preventDefault();move(-1)}else if(e.key==="Home"&&!busy){currentView=0;render(-1)}else if(e.key==="End"&&!busy){currentView=totalViews()-1;render(1)}});
  viewerStage.addEventListener("touchstart",e=>{const t=e.changedTouches[0];touchStartX=t.clientX;touchStartY=t.clientY},{passive:true});
  viewerStage.addEventListener("touchend",e=>{if(touchStartX===null)return;const t=e.changedTouches[0],dx=t.clientX-touchStartX,dy=t.clientY-touchStartY;touchStartX=touchStartY=null;if(Math.abs(dx)>=48&&Math.abs(dx)>Math.abs(dy))move(dx<0?1:-1)},{passive:true});
  fullscreenButton.onclick=async()=>{try{document.fullscreenElement?await document.exitFullscreen():await document.documentElement.requestFullscreen()}catch(_){}};
  document.addEventListener("fullscreenchange",()=>{fullscreenButton.textContent=document.fullscreenElement?"Exit full screen":"Full screen"});
  document.addEventListener("contextmenu",e=>{if(e.target.closest(".viewer-stage"))e.preventDefault()});
  document.addEventListener("dragstart",e=>{if(e.target.closest(".viewer-stage"))e.preventDefault()});

  let wasMobile=isMobile(),resizeTimer;
  addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{const now=isMobile();if(now===wasMobile){updateBookEdges();return}const oldPages=wasMobile?[currentView+1]:DESKTOP_VIEWS[currentView],page=oldPages[0];currentView=now?page-1:page===1?0:page===PAGE_COUNT?DESKTOP_VIEWS.length-1:Math.ceil((page-1)/2);wasMobile=now;render()},100)});
  render();
})();