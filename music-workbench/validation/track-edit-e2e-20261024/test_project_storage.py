"""Isolated synthetic project regressions; no user media or model requests."""
from copy import deepcopy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import threading
import http.client
from http.server import ThreadingHTTPServer
import unittest
from unittest.mock import patch
import uuid

import numpy as np
import soundfile as sf
from project import Project, save_json
from preview_cache import open_media


def fixture(directory):
    directory.mkdir(parents=True, exist_ok=True)
    sr=1000;frames=2000;tracks=[]
    for index,name in enumerate(('vocals','drums','bass','other')):
        samples=np.repeat((.03*np.sin(np.arange(frames)*(index+1)*.05))[:,None],2,axis=1)
        file=directory/(name+'.wav');sf.write(file,samples,sr,subtype='FLOAT')
        tracks.append({'id':name,'file':file.name,'label':name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
    save_json(directory/'preparation.json',{'project_id':str(uuid.uuid4()),'source_sha256':'synthetic',
        'song_title':'Temporary storage regression','sample_rate':sr,'frames':frames,
        'duration_seconds':2.,'master_gain':.8,'separation_seconds':0,'tracks':tracks})
    return Project(directory)


def cache_bytes(directory):
    return sum(p.stat().st_size for p in directory.iterdir() if '-' in p.name and p.suffix in ('.wav','.json'))


class ProjectStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='osmanthus-storage-')
        self.addCleanup(self.temp.cleanup)
        self.project=fixture(Path(self.temp.name)/'data')

    def test_failed_edit_keeps_memory_disk_audio_and_revision(self):
        p=self.project;p.view()
        before=deepcopy(p.state);audio=p.mix().copy();disk=p.file.read_bytes();cached=deepcopy(p._preview_cache)
        with patch('project.os.replace',side_effect=OSError('simulated full disk')):
            with self.assertRaises(OSError):
                p.apply({'type':'track_enabled','track_id':'vocals','enabled':False},'test',0,compact=True)
        self.assertEqual(p.state,before)
        self.assertEqual(p.file.read_bytes(),disk)
        self.assertTrue(np.array_equal(p.mix(),audio))
        self.assertEqual(p._preview_cache,cached)
        self.assertEqual(Project(p.directory).state,before)

    def test_write_flush_and_replace_failures_preserve_undo_redo_restore(self):
        for failure in ('json.dump','os.fsync','os.replace'):
            for operation in ('apply','undo','redo','restore'):
                with self.subTest(failure=failure,operation=operation):
                    p=fixture(Path(self.temp.name)/(failure+'-'+operation))
                    for db in (-1,-2):
                        p.apply({'type':'track_mix','track_id':'bass','gain_db':db},'test',p.state['revision'],compact=True)
                    if operation in ('redo','apply'):p.move_history('undo',p.state['revision'])
                    p.view();before=deepcopy(p.state);mix=p.mix().copy();disk=p.file.read_bytes()
                    cache=deepcopy(p._preview_cache);fingerprint=p.fingerprint()
                    def change():
                        if operation=='apply':return p.apply({'type':'track_enabled','track_id':'vocals','enabled':False},'test',before['revision'],compact=True)
                        if operation=='restore':return p.restore_history(0,before['revision'])
                        return p.move_history(operation,before['revision'])
                    with patch('project.'+failure,side_effect=OSError('simulated storage failure')):
                        with self.assertRaises(OSError):change()
                    self.assertEqual(p.state,before);self.assertEqual(p.file.read_bytes(),disk)
                    self.assertEqual(p.fingerprint(),fingerprint);self.assertEqual(p._preview_cache,cache)
                    self.assertTrue(np.array_equal(p.mix(),mix))
                    self.assertFalse(list(p.directory.glob('.*.tmp')))
                    change()  # The same expected revision is still valid after recovery.
                    self.assertEqual(p.state['revision'],before['revision']+1)
                    self.assertEqual(Project(p.directory).state,p.state)

    def test_cache_housekeeping_error_does_not_reject_committed_edit(self):
        p=self.project
        with patch('preview_cache.PreviewCache.entries',side_effect=PermissionError('cache directory denied')):
            p.apply({'type':'track_enabled','track_id':'vocals','enabled':False},'test',0,compact=True)
        self.assertEqual(p.state,json.loads(p.file.read_text()))
        self.assertEqual(p.state['revision'],1)
        self.assertIn('cleanup_error',p._preview_disk.last_status)

    def test_many_edits_bound_rebuildable_cache(self):
        p=self.project;p.view();limit=cache_bytes(p.directory)+2000
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':str(limit)}):
            for index in range(12):
                p.apply({'type':'segment_gain','track_id':'bass','mode':'gain','gain_db':-index-1,
                         'start_seconds':.2,'end_seconds':1.8},'test',p.state['revision'])
            self.assertLessEqual(cache_bytes(p.directory),limit)
            for track in p.view()['tracks']:
                self.assertTrue((p.directory/track['audio_url'].rsplit('/',1)[-1]).is_file())

    def edit_bass(self,db):
        p=self.project
        p.apply({'type':'segment_gain','track_id':'bass','mode':'gain','gain_db':db,
                 'start_seconds':.2,'end_seconds':1.8},'test',p.state['revision'])
        return p.directory/f'bass-{p.track_digest("bass")}.wav'

    def test_lru_prefers_recent_reads_and_reopens_with_current_version_pinned(self):
        p=self.project;p.view();a=p.directory/f'bass-{p.track_digest("bass")}.wav'
        b=self.edit_bass(-1);c=self.edit_bass(-2)
        with open_media(a) as reader:self.assertEqual(reader.read(4),b'RIFF')
        old_size=b.stat().st_size+b.with_suffix('.peaks.json').stat().st_size
        limit=cache_bytes(p.directory)-old_size
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':str(limit)}):
            p._preview_disk.prune()
        self.assertTrue(a.exists());self.assertFalse(b.exists());self.assertTrue(c.exists())
        frozen=p.audio_snapshot();expected=frozen.mix().copy()
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0'}):
            reopened=Project(p.directory)
            view=reopened.view()
        self.assertFalse(a.exists());self.assertTrue(c.exists())
        self.assertTrue(view['preview_cache']['over_target'])
        self.assertEqual(view['preview_cache']['bytes'],view['preview_cache']['protected_bytes'])
        self.assertTrue(np.array_equal(frozen.mix(),expected))

    def test_zero_target_protects_open_audio_and_removes_it_after_close(self):
        p=self.project;p.view();old=p.directory/f'bass-{p.track_digest("bass")}.wav'
        content=old.read_bytes()
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0'}):
            with open_media(old) as reader:
                self.edit_bass(-2)
                self.assertTrue(old.exists())
                self.assertEqual(reader.read(),content)
                self.assertTrue(p._preview_disk.last_status['over_target'])
            self.assertFalse(old.exists())

    def test_fresh_process_reclaims_old_cache_without_losing_current_audio(self):
        p=self.project;p.view();old=p.directory/f'bass-{p.track_digest("bass")}.wav'
        current=self.edit_bass(-5);self.assertTrue(old.exists())
        program='from project import Project; import sys,json; p=Project(sys.argv[1]); print(json.dumps(p.view()["preview_cache"]))'
        child=subprocess.run([sys.executable,'-c',program,str(p.directory)],
            cwd=Path(__file__).resolve().parent,
            env={**os.environ,'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0','PYTHONUTF8':'1'},
            capture_output=True,text=True,check=True,timeout=15)
        status=json.loads(child.stdout)
        self.assertFalse(old.exists());self.assertTrue(current.exists())
        self.assertEqual(status['bytes'],status['protected_bytes'])

    def test_undo_regenerates_evicted_audio_exactly(self):
        p=self.project;p.view();expected=p.mix().copy();old=p.directory/f'bass-{p.track_digest("bass")}.wav'
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0'}):
            self.edit_bass(-6);self.assertFalse(old.exists())
            p.move_history('undo',p.state['revision'])
            self.assertTrue(old.exists())
            self.assertTrue(np.array_equal(p.mix(),expected))

    def test_sources_exports_unknown_and_symlink_files_are_never_swept(self):
        p=self.project;p.view()
        kept={p.directory/t['file'] for t in p.meta['tracks']}
        for name in ('original.wav','piano_add_0123456789.wav','vocal_0123456789ab.wav',
                     'bass-1111111111111111.wav','other-2222222222222222.wav'):
            file=p.directory/name;file.write_bytes(b'non-cache material');kept.add(file)
        (p.directory/'other-2222222222222222.peaks.json').write_text('{bad-json')
        exports=p.directory/'exports';exports.mkdir();export=exports/'bass-3333333333333333.wav'
        export.write_bytes(b'keep export');kept.add(export)
        # A source explicitly recorded in preparation.json is protected even
        # if a filename and apparently valid peaks metadata resemble a preview.
        source=p.directory/'bass-4444444444444444.wav';source.write_bytes(b'keep registered source')
        p._preview_disk.source_names.add(source.name);kept.add(source)
        stat=source.stat();save_json(source.with_suffix('.peaks.json'),{'schema_version':1,
            'audio_key':'4444444444444444','audio_stat':[stat.st_size,stat.st_mtime_ns],'peaks':[0]*1000})
        outside=Path(self.temp.name)/'outside.wav';outside.write_bytes(b'keep linked target')
        linked=p.directory/'bass-5555555555555555.wav'
        try:linked.symlink_to(outside);kept.add(linked)
        except OSError:pass  # Windows may not grant symlink creation.
        before={file:file.read_bytes() for file in kept}
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0'}):
            self.edit_bass(-3)
        self.assertEqual({file:file.read_bytes() for file in kept},before)

    def test_real_http_transfer_is_leased_during_concurrent_edit(self):
        from test_media_paths import handler_class
        p=self.project;p.view();file=p.directory/f'bass-{p.track_digest("bass")}.wav';content=file.read_bytes()
        handler=handler_class(Path(self.temp.name))
        entered=threading.Event();release=threading.Event()
        def send(connection,data):
            entered.set()
            if not release.wait(5):raise AssertionError('transfer not released')
            connection.sendall(data);return True
        handler.serve.__globals__['send_file_chunk']=send
        handler.do_GET=lambda request:request.serve(file)
        with ThreadingHTTPServer(('127.0.0.1',0),handler) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0'}):
                    client.request('GET','/preview',headers={'Range':'bytes=0-'})
                    response=client.getresponse();self.assertEqual(response.status,206)
                    self.assertTrue(entered.wait(3));self.edit_bass(-4)
                    self.assertTrue(file.exists());release.set()
                    self.assertEqual(response.read(),content)
            finally:
                release.set();client.close();server.shutdown();thread.join(timeout=3)
        # Closing the HTTP response releases the lease, allowing the old file
        # to be reclaimed without requiring another edit or a cleanup thread.
        with patch.dict(os.environ,{'MUSIC_PREVIEW_CACHE_MAX_BYTES':'0'}):p._preview_disk.prune()
        self.assertFalse(file.exists())


if __name__=='__main__':unittest.main()
