import {localUrl} from './integration.js';

import {icon} from './icons.js';

export function exactHomeMarkup(){
 return `<section class="mv-hero"><div class="hero-heading"><img class="exact-hero-image" src="${localUrl('/assets/brand/osmanthus-logo.png')}" alt="桂花与高音谱号标志"><h1>Osmanthus MV</h1></div><p>从歌曲开始，把音乐变成画面</p><button class="canvas-shortcut" data-studio-action="empty-canvas">进入自由画布</button></section>
 <section class="mv-composer exact-composer" aria-label="MV 创作"><div class="composer-source" id="composer-source" hidden></div><label for="creative-prompt" class="sr-only">描述你想创作的 MV</label><textarea id="creative-prompt" aria-label="描述你想创作的 MV" maxlength="2000" placeholder="描述你想要的场景、人物、情绪与镜头……"></textarea><div id="music-mode-panel" hidden></div><div class="composer-footer"><span>确认分镜，再生成视频</span><button class="composer-tool" data-studio-action="format" aria-label="选择画面比例">画面比例</button><div id="music-composer-options" hidden><span id="music-settings-label"></span></div><div id="video-composer-options" hidden><span id="composer-format">16:9</span></div><span id="composer-model-label" hidden></span><button id="create-mv-canvas" class="studio-send" data-studio-action="create" title="开始创作" aria-label="开始创作">${icon('arrow-up')}</button></div></section>`;
}
