"""An honest empty workspace: no synthetic song, audio, stems or files."""
from pathlib import Path

EMPTY_ID = '00000000-0000-4000-8000-000000000000'


class EmptyProject:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.state = {'id': EMPTY_ID, 'revision': 0, 'title': '', 'tracks': {}, 'history': [], 'cursor': 0}
        self.meta = {'duration_seconds': 0, 'sample_rate': 44100, 'frames': 0, 'tracks': []}

    def view(self):
        return {**self.state, 'empty': True, 'tracks': [], 'fingerprint': '', 'source_sha256': '',
                'duration': 0, 'frames': 0, 'sample_rate': 44100, 'master_gain': 1,
                'can_undo': False, 'can_redo': False, 'preparation_seconds': 0,
                'piano_available': False, 'piano_added': False, 'guitar_available': False,
                'guitar_added': False, 'piano_cleanup_levels': [], 'available_parts': [],
                'vocal_candidates': [], 'instrument_routing': [], 'instrument_presence': {},
                'removed_track_ids': [], 'original_audio_url': None, 'generation_job_id': None,
                'instrumental': False}

    def check_revision(self, revision):
        if revision != 0:
            raise RuntimeError('工程已变化，请刷新后重试')

    def unavailable(self, *args, **kwargs):
        raise ValueError('请先创作歌曲并准备音轨，再进行编辑或导出')

    audio_snapshot = apply = move_history = restore_history = unavailable
