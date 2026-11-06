import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=await readFile(new URL('./index.html',import.meta.url),'utf8');
const studio=await readFile(new URL('./studio.html',import.meta.url),'utf8');
const editor=html=>html.match(/<section class="segment-audition"[\s\S]*?<\/section>/)?.[0];

test('both editor shells expose the same bounded preview control',()=>{
  const visible=editor(source);
  assert.ok(visible);
  assert.equal(editor(studio).replaceAll('\r\n','\n'),visible.replaceAll('\r\n','\n'));
  assert.match(visible,/<input id="segment-volume" type="range" min="0" max="100" step="1" value="50"[^>]*disabled>/);
  assert.match(visible,/<button id="segment-preview"[^>]*disabled>试听修改前后<\/button>/);
  assert.match(visible,/试听不会保存修改/);
  assert.match(visible,/0% 为静音；100% 恢复此段原始音量/);
});

test('older direct mutation controls remain hidden in both shells',()=>{
  for(const html of [source,studio]){
    const legacy=html.match(/<div hidden><input id="segment-db"[\s\S]*?<\/div>/)?.[0];
    assert.ok(legacy);
    for(const id of ['segment-db','apply-gain','mute-selection','restore-selection']){
      assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1);
      assert.ok(legacy.includes(`id="${id}"`));
    }
  }
});
