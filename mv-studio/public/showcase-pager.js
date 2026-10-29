export function showcaseWindow(total,width,page=0){
 const size=width<=750?4:8,pages=Math.max(1,Math.ceil(total/size));
 const current=Math.max(0,Math.min(pages-1,page));
 return{page:current,pages,start:current*size,end:Math.min(total,(current+1)*size),size};
}
export function mountShowcasePager(root){
 const cards=[...root.querySelectorAll('.showcase-card')];let page=0;
 const previous=root.querySelector('[data-showcase-page="-1"]'),next=root.querySelector('[data-showcase-page="1"]');
 function render(){const view=showcaseWindow(cards.length,window.innerWidth,page);page=view.page;
  cards.forEach((card,index)=>{card.hidden=index<view.start||index>=view.end;});
  previous.disabled=page===0;next.disabled=page===view.pages-1;
  root.querySelector('#showcase-page-count').textContent=`${page+1} / ${view.pages}`;
 }
 previous.onclick=()=>{page--;render();};next.onclick=()=>{page++;render();};
 window.addEventListener('resize',render);render();
 return()=>window.removeEventListener('resize',render);
}
