"""Offline navigation contracts; no service, paid request or model is started."""
from pathlib import Path
from copy import deepcopy
import hashlib, json, os, shutil, subprocess, tempfile, unittest
from sections import Sections,build_sections,resolve_reference,score_grid,digest

LYRICS='[INTRO]\n[VERSE]\n清晨带来新希望\n脚步走向远地方\n[CHORUS]\n让风吹过我的肩\n把梦写在蓝天边\n[BREAK]\n[VERSE]\n街灯照着归来人\n晚风仍旧很温柔\n[CHORUS]\n让风吹过我的肩\n把梦写在蓝天边\n[OUTRO]'
TIMES=[(4,8),(9,13),(16,20),(21,25),(33,37),(38,42),(46,50),(51,55)]

def inputs():
    plain=[v for v in LYRICS.splitlines() if v and not v.startswith('[')]
    context={'project_id':'11111111-1111-4111-8111-111111111111','source_sha256':'a'*64,'vocal_sha256':'b'*64,
             'lyrics_sha256':hashlib.sha256(LYRICS.encode()).hexdigest(),'basis':'original_complete_lead_vocal'}
    return {'context':context,'lyrics':LYRICS,'duration':60.,'timing':{'status':'ready','job_id':'fixture'},
            'aligned_lines':[{'index':i,'text':text,'start':TIMES[i][0],'end':TIMES[i][1]} for i,text in enumerate(plain)],
            'grid':score_grid(None)}

def view(data=None):
    data=data or inputs();manager=Sections(lambda _:data)
    return manager._view(data,{'schema_version':1,'project_id':data['context']['project_id'],'revision':0,'contexts':{},'history':[]})

class NavigationTests(unittest.TestCase):
    def test_repeated_sections_have_stable_distinct_identity_and_times(self):
        v=view();choruses=[s for s in v['sections'] if s['tag']=='chorus']
        self.assertEqual([(x['id'],x['start_seconds'],x['end_seconds']) for x in choruses],[('chorus-1',16.,25.),('chorus-2',46.,55.)])
        self.assertTrue(all(not x['confirmed'] and not x['manual'] for x in choruses))
        self.assertEqual(v['lines'][6]['section_id'],'chorus-2')
    def test_actual_instrumental_gaps_are_candidates_not_even_splits(self):
        s={x['id']:x for x in view()['sections']}
        self.assertEqual((s['intro-1']['start_seconds'],s['intro-1']['end_seconds']),(0.,4.))
        self.assertEqual((s['break-1']['start_seconds'],s['break-1']['end_seconds']),(25.,33.))
        self.assertEqual((s['outro-1']['start_seconds'],s['outro-1']['end_seconds']),(55.,60.))
        self.assertEqual(s['break-1']['boundary_source'],'lyric_gap_candidate')
    def test_missing_alignment_never_divides_duration_by_tags(self):
        d=inputs();d['aligned_lines']=[];v=view(d)
        self.assertEqual(v['stage'],'awaiting_alignment');self.assertTrue(all(s['start_seconds'] is None for s in v['sections']))
        self.assertEqual(resolve_reference('第二遍副歌鼓轻一点',v)['status'],'unavailable')
    def test_wrong_lyrics_or_out_of_order_line_invalidates_timing(self):
        for mutate in [lambda d:d['aligned_lines'][1].update(text='错的歌词'),lambda d:d['aligned_lines'].reverse(),lambda d:d['aligned_lines'].pop()]:
            with self.subTest(mutate=mutate):
                d=inputs();mutate(d);v=view(d);self.assertTrue(v['warnings']);self.assertTrue(all(s['start_seconds'] is None for s in v['sections']))
    def test_multiple_consecutive_empty_tags_not_given_same_guessed_gap(self):
        d=inputs();d['lyrics']=d['lyrics'].replace('[BREAK]','[BREAK]\n[SOLO]');d['context']['lyrics_sha256']=hashlib.sha256(d['lyrics'].encode()).hexdigest();v=view(d)
        self.assertTrue(all(s['start_seconds'] is None for s in v['sections'] if s['tag'] in ('break','solo')))
    def test_second_chorus_chinese_arabic_and_last(self):
        for message in ['第二遍副歌把贝斯调小','第2次副歌删鼓','副歌第二遍更亮','副歌2更亮','最后一遍副歌保留人声']:
            with self.subTest(message=message):
                r=resolve_reference(message,view());self.assertEqual((r['status'],r['section_id'],r['start_seconds'],r['end_seconds']),('resolved','chorus-2',46.,55.))
    def test_pre_chorus_is_not_accidentally_chorus(self):
        d=inputs();d['lyrics']=d['lyrics'].replace('[VERSE]','[PRE CHORUS]',1);d['context']['lyrics_sha256']=hashlib.sha256(d['lyrics'].encode()).hexdigest();r=resolve_reference('预副歌音量大一点',view(d));self.assertEqual(r['section_id'],'pre_chorus-1')
    def test_unqualified_or_multiple_sections_require_clarification(self):
        self.assertEqual(resolve_reference('副歌加一点钢琴',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('第二遍副歌和第一遍主歌去鼓',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('第三遍副歌不要贝斯',view())['status'],'unavailable')
        self.assertEqual(resolve_reference('倒数第二遍副歌',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('第一遍、第二遍副歌加钢琴',view())['status'],'ambiguous')
    def test_repeated_lyric_requires_occurrence_or_context(self):
        self.assertEqual(resolve_reference('“让风吹过我的肩”这句声音大一点',view())['status'],'ambiguous')
        r=resolve_reference('第二遍副歌“让风吹过我的肩”这句去鼓',view());self.assertEqual((r['line_index'],r['start_seconds'],r['end_seconds']),(6,46.,50.))
        r=resolve_reference('第二次唱“让风吹过我的肩”去鼓',view());self.assertEqual(r['line_index'],6)
    def test_lyric_index_and_unknown_quote(self):
        r=resolve_reference('第二句歌词加大人声',view());self.assertEqual((r['line_index'],r['start_seconds']),(1,9.))
        self.assertEqual(resolve_reference('“不是这首歌的歌词”',view())['status'],'unavailable')
    def test_sentence_within_section_is_not_expanded_to_whole_section(self):
        r=resolve_reference('第二遍副歌第一句去掉鼓',view());self.assertEqual((r['line_index'],r['start_seconds'],r['end_seconds']),(6,46.,50.))
        r=resolve_reference('第二遍副歌最后一句',view());self.assertEqual(r['line_index'],7)
        self.assertEqual(resolve_reference('第二遍副歌前两句',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('倒数第二句',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('第二拍重一点',view())['status'],'unavailable')
    def test_positions_outside_a_lyric_never_return_the_lyric_itself(self):
        for text in ['最后一句后面加钢琴','第二句之后把鼓关掉','“让风吹过我的肩”后面去鼓']:
            with self.subTest(text=text):self.assertIn(resolve_reference(text,view())['status'],('ambiguous','unavailable'))
    def test_unsupported_subrange_never_expands_to_entire_chorus(self):
        for text in ['第二遍副歌前4小节去掉贝斯','第二遍副歌后两小节加钢琴','第二遍副歌后半段去鼓']:
            with self.subTest(text=text):self.assertIn(resolve_reference(text,view())['status'],('ambiguous','unavailable'))
    def test_only_explicit_whole_song_can_select_full_duration(self):
        r=resolve_reference('整首贝斯调小',view());self.assertEqual((r['start_seconds'],r['end_seconds']),(0.,60.))
        self.assertEqual(resolve_reference('稍微轻一点',view())['status'],'not_found')
    def test_excerpt_acceptance_does_not_enable_bar_resolution(self):
        g=score_grid({'bpm':74,'meter':'4/4','notation_origin_seconds':1.3,'tempo_meter_key_accepted':False,
                      'rhythm_review':{'confirmed_by':'user','confirmation_scope':'selected_excerpt_beat_and_downbeat'}})
        self.assertEqual(g['status'],'candidate');self.assertFalse(g['confirmed'])
        v=view();v['grid']=g;self.assertEqual(resolve_reference('第二遍副歌前4小节',v)['status'],'unavailable')
    def test_confirmed_four_four_bar_ranges_and_unsupported_meter(self):
        v=view();v['grid']={'confirmed':True,'meter':'4/4','bpm':120,'first_downbeat_seconds':0}
        r=resolve_reference('第3到第4小节鼓轻一点',v);self.assertEqual((r['start_seconds'],r['end_seconds']),(4.,8.))
        v['grid']['meter']='3/4';self.assertEqual(resolve_reference('第3小节',v)['status'],'unavailable')
    def test_unconfirmed_section_start_cannot_become_bar_start(self):
        v=view();v['grid']={'confirmed':True,'meter':'4/4','bpm':120,'first_downbeat_seconds':0}
        self.assertEqual(resolve_reference('第二遍副歌前两小节',v)['status'],'unavailable')
        s=next(s for s in v['sections'] if s['id']=='chorus-2');s.update(confirmed=True,start_seconds=46.,end_seconds=56.)
        r=resolve_reference('第二遍副歌前两小节',v);self.assertEqual((r['start_seconds'],r['end_seconds']),(46.,50.))
        s['end_seconds']=55.5;self.assertEqual(resolve_reference('第二遍副歌后两小节',v)['status'],'unavailable')
    def test_explicit_seconds_in_music_reference_are_not_ignored(self):
        r=resolve_reference('第二遍副歌47~49秒去掉鼓',view());self.assertEqual((r['kind'],r['start_seconds'],r['end_seconds']),('seconds',47.,49.))
        self.assertEqual(resolve_reference('第二遍副歌30~45秒去掉鼓',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('第二遍副歌“让风吹过我的肩”30~45秒',view())['status'],'ambiguous')
        self.assertEqual(resolve_reference('30~45秒去掉贝斯',view())['status'],'not_found')
    def test_unknown_structural_reference_is_not_freeform_guess(self):
        for text in ['第二段加点钢琴','高潮去掉鼓','后半首提速']:
            with self.subTest(text=text):self.assertEqual(resolve_reference(text,view())['status'],'ambiguous')
    def test_result_carries_revision_source_guard(self):
        v=view();r=resolve_reference('第二遍副歌',v);self.assertEqual(r['selection_guard']['navigation_fingerprint'],v['navigation_fingerprint']);self.assertEqual(r['selection_guard']['sections_revision'],0)

class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='sections-test-');self.addCleanup(self.tmp.cleanup);self.dir=Path(self.tmp.name);self.data=inputs();self.manager=Sections(lambda _:self.data)
        (self.dir/'project.json').write_bytes(b'original mixer revision and history');(self.dir/'original.wav').write_bytes(b'immutable original audio')
        self.original={p.name:p.read_bytes() for p in self.dir.iterdir()}
    def body(self,**changes):
        v=self.manager.get(self.dir);return {'project_id':v['project_id'],'sections_revision':v['sections_revision'],'source_fingerprint':v['source_fingerprint'],'section_id':'chorus-2','start_seconds':45.,'end_seconds':56.,'confirmed':True,**changes}
    def test_boundary_persists_without_changing_audio_or_project(self):
        v=self.manager.update(self.dir,self.body());s=next(s for s in v['sections'] if s['id']=='chorus-2');self.assertEqual((s['start_seconds'],s['end_seconds']),(45.,56.));self.assertTrue(s['confirmed']);self.assertEqual(v['sections_revision'],1)
        fresh=Sections(lambda _:self.data).get(self.dir);self.assertEqual(fresh['navigation_fingerprint'],v['navigation_fingerprint'])
        for name,data in self.original.items():self.assertEqual((self.dir/name).read_bytes(),data)
    def test_stale_revision_source_and_wrong_project_rejected(self):
        old=self.body();self.manager.update(self.dir,old)
        for body in [old,self.body(source_fingerprint='wrong'),self.body(project_id='other')]:
            with self.subTest(body=body):
                before=(self.dir/'section-boundaries.json').read_bytes()
                with self.assertRaises(RuntimeError):self.manager.update(self.dir,body)
                self.assertEqual((self.dir/'section-boundaries.json').read_bytes(),before)
    def test_alignment_update_changes_guard_but_preserves_manual_boundaries(self):
        old=self.body();v=self.manager.update(self.dir,old);a=v['source_fingerprint'];self.data['aligned_lines'][6]['start']=46.2
        current=self.manager.get(self.dir);self.assertNotEqual(current['source_fingerprint'],a);s=next(x for x in current['sections'] if x['id']=='chorus-2');self.assertEqual(s['start_seconds'],45.)
        with self.assertRaises(RuntimeError):self.manager.update(self.dir,{**old,'sections_revision':1,'source_fingerprint':a})
    def test_voice_change_does_not_reuse_other_voice_boundaries_and_can_return(self):
        self.manager.update(self.dir,self.body());original=self.data['context']['vocal_sha256'];self.data['context']['vocal_sha256']='c'*64
        v=self.manager.get(self.dir);s=next(x for x in v['sections'] if x['id']=='chorus-2');self.assertFalse(s['manual']);self.assertEqual(s['start_seconds'],46.)
        self.data['context']['vocal_sha256']=original;self.assertTrue(next(x for x in self.manager.get(self.dir)['sections'] if x['id']=='chorus-2')['manual'])
    def test_reset_returns_candidate_and_retains_history(self):
        self.manager.update(self.dir,self.body());v=self.manager.update(self.dir,self.body(action='reset'));s=next(x for x in v['sections'] if x['id']=='chorus-2');self.assertFalse(s['confirmed']);self.assertEqual(s['start_seconds'],46.);self.assertEqual(len(json.loads((self.dir/'section-boundaries.json').read_text())['history']),2)
    def test_invalid_ranges_and_unconfirmed_edits_never_saved(self):
        for values in [{'start_seconds':-1},{'end_seconds':99},{'start_seconds':56,'end_seconds':45},{'start_seconds':float('nan')},{'end_seconds':float('inf')},{'start_seconds':True},{'confirmed':False},{'start_seconds':45.00000001,'end_seconds':45.00000002}]:
            with self.subTest(values=values):
                with self.assertRaises(ValueError):self.manager.update(self.dir,self.body(**values))
                self.assertFalse((self.dir/'section-boundaries.json').exists())
    def test_corrupt_annotation_is_not_overwritten(self):
        (self.dir/'section-boundaries.json').write_text('{bad json')
        with self.assertRaises(ValueError):self.manager.get(self.dir)
        self.assertEqual((self.dir/'section-boundaries.json').read_text(),'{bad json')

class ExistingDataAndFrontendTests(unittest.TestCase):
    def test_real_heldout_song_second_chorus_follows_distinct_actual_times_read_only(self):
        root=Path(__file__).resolve().parent.parent/'track-edit-recheck-20261025';generation=root/'workflow/runs/bf5077b8-2f36-4aa1-88a0-48796ce5d57e/state.json';timing=root/'lyric-jobs/54fa642d-8951-4b58-bd9c-8506d8560d07/timing.json'
        if not generation.exists() or not timing.exists():self.skipTest('Local held-out input receipt not distributed with source')
        project=root/'projects/bf5077b8-2f36-4aa1-88a0-48796ce5d57e/data/project.json';before=project.read_bytes();g=json.loads(generation.read_text());t=json.loads(timing.read_text());d=inputs();d.update(lyrics=g['lyrics'],duration=t['duration'],aligned_lines=t['lines']);d['context']['lyrics_sha256']=hashlib.sha256(g['lyrics'].strip().encode()).hexdigest();v=view(d);r=resolve_reference('第二遍副歌把贝斯去掉',v)
        self.assertEqual((r['section_id'],r['start_seconds'],r['end_seconds']),('chorus-2',114.51,139.21));self.assertEqual(project.read_bytes(),before)
    def test_javascript_range_rejects_null_and_cross_identity_key(self):
        node=os.environ.get('MUSIC_TEST_NODE') or shutil.which('node')
        bundled=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
        if not node and bundled.exists():node=str(bundled)
        if not node:self.skipTest('Node runtime unavailable')
        path=Path(__file__).with_name('sections.js')
        code="""import fs from 'node:fs';const m=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(process.argv[1],'utf8')).toString('base64'));const v={project_id:'a',duration:60,source_fingerprint:'s',sections_revision:2,navigation_fingerprint:'n'};if(m.rangeFromEntry(v,{id:'x',start_seconds:null,end_seconds:5})!==null)throw Error('null time accepted');const r=m.rangeFromEntry(v,{id:'chorus-2',start_seconds:46,end_seconds:55});if(r.section_id!=='chorus-2'||r.sections_revision!==2)throw Error('guard lost');if(m.sectionProjectKey({id:'a',source_sha256:'s',vocal_variant:'x'})===m.sectionProjectKey({id:'a',source_sha256:'s',vocal_variant:'original'}))throw Error('voice identity lost');console.log('passed');"""
        result=subprocess.run([node,'--input-type=module','-e',code,str(path)],capture_output=True,text=True,timeout=10);self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
