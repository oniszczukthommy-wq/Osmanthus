// Curated text descriptions and original CSS gradients. These are creative
// directions, not claims about the source song or guaranteed model output.
export const MV_VISUAL_STYLES=Object.freeze([
  Object.freeze({id:'auto',name:'自动',description:'',gradient:'linear-gradient(145deg,#dbe9ef,#9caebd)'}),
  Object.freeze({id:'cinematic',name:'电影写实',description:'电影写实画面，自然肤色，真实环境材质，讲究光影、景深与镜头叙事。',gradient:'linear-gradient(145deg,#75919e,#263b46 55%,#c89570)'}),
  Object.freeze({id:'3d',name:'超写实 3D',description:'高品质三维渲染，细腻材质和真实光照，角色造型与空间细节统一。',gradient:'linear-gradient(145deg,#c3b6db,#6d648a 55%,#354056)'}),
  Object.freeze({id:'kawaii',name:'可爱 3D',description:'柔和可爱的三维动画风格，圆润造型，明快的色彩与温暖灯光。',gradient:'linear-gradient(145deg,#f7d6ce,#e3a9c4 55%,#b2a4da)'}),
  Object.freeze({id:'y2k',name:'Y2K 影棚',description:'Y2K 时尚摄影风格，闪亮质感，活泼色彩，具有现代影棚灯光的视觉表现。',gradient:'linear-gradient(145deg,#c8e6f3,#bfa9ea 52%,#e89eb8)'})
]);
export function findVisualStyle(id){return MV_VISUAL_STYLES.find(style=>style.id===id);}
