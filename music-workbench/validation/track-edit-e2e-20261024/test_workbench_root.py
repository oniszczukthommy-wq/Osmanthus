"""Check root propagation without starting services, models or network calls."""
from pathlib import Path
import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import uuid


APP = Path(__file__).resolve().parent
FIXTURE = APP.parent / 'track-edit-recheck-20261025'
SCORE_SCRIPT = APP.parent / 'vocal-score-20261024/build_review_score.py'


def child(code, module_dir=APP, root=None):
    run_env = dict(os.environ)
    run_env.pop('MUSIC_WORKBENCH_ROOT', None)
    if root is not None:
        run_env['MUSIC_WORKBENCH_ROOT'] = str(root)
    run_env.update(OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
    process = subprocess.run(
        [sys.executable, '-B', '-c',
         'import sys;sys.path.insert(0,' + repr(str(module_dir)) + ');' + code],
        env=run_env, capture_output=True, text=True, check=True, timeout=20,
    )
    return json.loads(process.stdout)


def main():
    checks = {}
    root_code = 'import project;print(__import__("json").dumps({"root":str(project.ROOT),"data":str(project.DATA)}))'
    value = child(root_code)
    checks['default_main_root_unchanged'] = value == {'root': str(APP), 'data': str(APP / 'data')}
    value = child(root_code, root=FIXTURE)
    checks['main_module_honors_fixture_root'] = value == {'root': str(FIXTURE), 'data': str(FIXTURE / 'data')}
    value = child(root_code, module_dir=FIXTURE)
    checks['fixture_module_default_root_unchanged'] = value['root'] == str(FIXTURE)

    # Execute only the environment declaration from server.py: importing the
    # actual server would load full user audio and initialize shared managers.
    server_tree = ast.parse((APP / 'server.py').read_text())
    declaration = next(node for node in server_tree.body
                       if isinstance(node, ast.Expr)
                       and isinstance(node.value, ast.Call)
                       and ast.unparse(node.value.func) == 'os.environ.setdefault'
                       and node.value.args[0].value == 'MUSIC_WORKBENCH_ROOT')
    declaration_text = ast.unparse(declaration)
    code = ('import os,subprocess;from project import ROOT;'
            + declaration_text + ';'
            + 'p=subprocess.run([sys.executable,"-B","-c",'
            + repr('import sys;sys.path.insert(0,' + repr(str(APP))
                   + ');from project import ROOT;print(ROOT)')
            + '],capture_output=True,text=True,check=True);'
            + 'print(__import__("json").dumps({"parent":str(ROOT),"child":p.stdout.strip()}))')
    value = child(code)
    checks['server_propagates_default_root_to_child'] = value == {'parent': str(APP), 'child': str(APP)}
    value = child(code, module_dir=FIXTURE)
    checks['fixture_server_propagates_root_across_main_module_import'] = value == {'parent': str(FIXTURE), 'child': str(FIXTURE)}
    value = child(code, root=FIXTURE)
    checks['server_preserves_explicit_root'] = value == {'parent': str(FIXTURE), 'child': str(FIXTURE)}

    with tempfile.TemporaryDirectory(prefix='music-root-check-') as temporary:
        workbench = (Path(temporary) / 'isolated-workbench').resolve()
        identifier = str(uuid.uuid4())
        generation_dir = workbench / 'workflow/runs' / identifier
        generation_dir.mkdir(parents=True)
        lyrics = '[Verse]\n独立工作台的专用测试歌词'
        (generation_dir / 'state.json').write_text(json.dumps({'lyrics': lyrics}, ensure_ascii=False))
        data = workbench / 'data'
        data.mkdir()
        meta = {'generation_job_id': identifier, 'project_id': identifier,
                'source_sha256': 'isolated-source-hash',
                'tracks': [{'id': 'vocals', 'file': 'vocals.wav', 'sha256': 'isolated-vocal-hash'}]}
        (data / 'preparation.json').write_text(json.dumps(meta))
        code = ('from scores import source_context;'
                + 'context,lyrics=source_context(__import__("pathlib").Path(' + repr(str(data)) + '));'
                + 'print(__import__("json").dumps({"context":context,"lyrics":lyrics}))')
        value = child(code, root=workbench)
        checks['source_context_reads_isolated_generation_lyrics'] = (
            value['lyrics'] == lyrics
            and value['context']['project_id'] == identifier
            and value['context']['lyrics_sha256'] == hashlib.sha256(lyrics.encode()).hexdigest()
            and not (APP / 'workflow/runs' / identifier).exists()
        )

        # Check the real expressions in canonical() and engrave(), without
        # calling notation, a synth, MuseScore, alignment or any neural model.
        tree = ast.parse(SCORE_SCRIPT.read_text())
        expressions = [node.value for node in ast.walk(tree)
                       if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == 'workbench'
                               for target in node.targets)]
        checks['two_score_workbench_resolvers_present'] = len(expressions) == 2
        previous = os.environ.pop('MUSIC_WORKBENCH_ROOT', None)
        try:
            namespace = {'Path': Path, 'os': os, 'ROOT': SCORE_SCRIPT.parent}
            defaults = [eval(compile(ast.Expression(node), str(SCORE_SCRIPT), 'eval'), namespace)
                        for node in expressions]
            checks['canonical_and_engrave_default_paths_unchanged'] = defaults == [APP, APP]
            os.environ['MUSIC_WORKBENCH_ROOT'] = str(workbench)
            configured = [eval(compile(ast.Expression(node), str(SCORE_SCRIPT), 'eval'), namespace)
                          for node in expressions]
            checks['canonical_and_engrave_honor_isolated_root'] = configured == [workbench, workbench]
        finally:
            os.environ.pop('MUSIC_WORKBENCH_ROOT', None)
            if previous is not None:
                os.environ['MUSIC_WORKBENCH_ROOT'] = previous

    checks['fixture_project_and_server_synced'] = all(
        (APP / name).read_bytes() == (FIXTURE / name).read_bytes()
        for name in ('project.py', 'server.py')
    )
    result = {'status': 'passed' if all(checks.values()) else 'failed', 'checks': checks,
              'scope': 'Configuration and source-context routing only; no service/model/network calls.'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    assert all(checks.values()), result


if __name__ == '__main__':
    main()
