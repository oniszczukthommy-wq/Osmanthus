"""Core constraints and optional sample-level replay of the accepted local clip.

Run with existing vocal-score or audio-separation Python; no package installation.
The equivalence fixture is intentionally external to the deployable app module.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import argparse
import copy
import hashlib
import json
import sys
import unittest

import music21
import numpy as np
import soundfile as sf

from arrangement_authoring import AuthoringResources, CODE_ROOT, build_notes, export_result, render_part


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fixture_chords():
    return [
        {"start_seconds":40,"end_seconds":42,"label":"C","root_pc":0,"bass_pc":0,"pitch_classes":[0,4,7]},
        {"start_seconds":42,"end_seconds":44,"label":"Fmaj7","root_pc":5,"bass_pc":5,"pitch_classes":[0,4,5,9]},
        {"start_seconds":44.5,"end_seconds":46,"label":"C/E","root_pc":0,"bass_pc":4,"pitch_classes":[0,4,7]},
    ]


class CoreChecks(unittest.TestCase):
    def test_analyzer_flat_roots_and_slash_bass(self):
        from arrangement_authoring import _normalize_segments
        for label, pcs, root, bass in [
            ('Ab', [8, 0, 3], 8, 8), ('Bbm', [10, 1, 5], 10, 10),
            ('Eb/Bb', [3, 7, 10], 3, 10),
            ('B♭7', [10, 2, 5, 8], 10, 10),
            ('B-7', [10, 2, 5, 8], 10, 10),
        ]:
            segment = dict(start=0, end=2, label=label, pitch_classes=pcs,
                           root_pc=root, bass_pc=bass)
            parsed = _normalize_segments([segment], 0, 2)[0]
            self.assertEqual(parsed['pitch_classes'], sorted(pcs))
            self.assertEqual(parsed['label'], label)

    def test_voice_count_and_inversion_with_gap(self):
        chords=fixture_chords(); before=copy.deepcopy(chords)
        beats=[40+i*.5 for i in range(13)]
        piano=build_notes(chords,beats,40,46,"piano")
        guitar=build_notes(chords,beats,40,46,"acoustic_guitar")
        self.assertEqual([v["voice_count"] for v in piano["voicings"]],[3,4,3])
        self.assertEqual(chords,before)
        self.assertTrue(all(piano["checks"].values()))
        self.assertTrue(all(guitar["checks"].values()))
        for result in (piano,guitar):
            self.assertFalse(any(n["start_seconds"]<44.5 and n["end_seconds"]>44 for n in result["notes"]))
        first=min((n for n in guitar["notes"] if n["chord_index"]==2),key=lambda n:n["start_seconds"])
        self.assertEqual(first["pitch"]%12,4)
        self.assertNotEqual(piano["notes"],guitar["notes"])

    def test_explicit_bad_harmony_is_rejected(self):
        chords=fixture_chords(); chords[0]["pitch_classes"].append(11)
        with self.assertRaises(ValueError):
            build_notes(chords,[40,40.5,41],40,46,"piano")

    def test_output_cannot_escape_job_or_follow_source_symlink(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp); job=root/"jobs/job1"; job.mkdir(parents=True)
            source=root/"source"; source.mkdir(); (source/"project.json").write_text("immutable")
            link=job/"link"; link.symlink_to(source,target_is_directory=True)
            cfg=AuthoringResources(root=root/"workbench")
            for path in (job/"../escape",link):
                with self.assertRaises(ValueError):
                    export_result({},path,"test",job_root=job,resources=cfg)
            self.assertEqual((source/"project.json").read_text(),"immutable")
            self.assertFalse((source/"test.json").exists())

    def test_song_directory_and_explicit_protected_root_rejected(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp); song=root/"outside-song"; song.mkdir(); (song/"preparation.json").write_text("{}")
            cfg=AuthoringResources(root=root/"workbench",protected_roots=(root/"protected",))
            for job in (cfg.root, cfg.root/"data/out", cfg.root/"projects/x/out", song/"job",root/"protected/job"):
                with self.assertRaises(ValueError):
                    export_result({},job,"test",job_root=job,resources=cfg)

    def test_existing_output_is_never_overwritten(self):
        with TemporaryDirectory() as tmp:
            job=Path(tmp)/"jobs/job1"; cfg=AuthoringResources(root=Path(tmp)/"workbench")
            path=export_result({"original":True},job,"candidate",job_root=job,resources=cfg)
            before=path.read_bytes()
            with self.assertRaises(FileExistsError):
                export_result({"original":False},job,"candidate",job_root=job,resources=cfg)
            self.assertEqual(path.read_bytes(),before)

    def test_resource_path_can_be_parameterized_without_global_mutation(self):
        beats=[40+i*.5 for i in range(13)]
        baseline=build_notes(fixture_chords(),beats,40,46,"acoustic_guitar")
        with TemporaryDirectory() as tmp:
            copied=Path(tmp)/"guitar.json"; copied.write_bytes(AuthoringResources().chords_db.read_bytes())
            cfg=AuthoringResources(root=Path(tmp)/"workbench",chords_db=copied)
            custom=build_notes(fixture_chords(),beats,40,46,"acoustic_guitar",resources=cfg)
            self.assertEqual(custom["notes"],baseline["notes"])
            self.assertEqual(custom["voicings"],baseline["voicings"])


def equivalence(output_dir, evidence_root=None):
    evidence=Path(evidence_root) if evidence_root else CODE_ROOT.parent/"arrangement-evidence-20261026/real-arrangement-test"
    harmony_path=evidence/"harmony/conservative-harmony.json"
    vocal_path=evidence/"vocal-context.json"
    frozen=evidence/"authoring/real-output"
    helper=evidence/"authoring/arrangement_helper.py"
    inputs=[harmony_path,vocal_path,helper]
    for name in ("new-light-piano","new-reorchestrated-guitar"):
        inputs.extend([frozen/(name+".json"),frozen/(name+"-part.wav")])
    before={str(p):digest(p) for p in inputs}
    harmony=json.loads(harmony_path.read_text()); vocal=json.loads(vocal_path.read_text())
    output_dir=Path(output_dir).resolve()
    cfg=AuthoringResources(protected_roots=(evidence,))
    results={}
    for instrument,stem in (("piano","new-light-piano"),("acoustic_guitar","new-reorchestrated-guitar")):
        expected=json.loads((frozen/(stem+".json")).read_text())
        result=build_notes(harmony["harmony_segments"],harmony["beat_times_seconds"],40,56,instrument,vocal,resources=cfg)
        rendered=render_part(result,output_dir,stem,job_root=output_dir,resources=cfg)
        actual,rate=sf.read(rendered["part_path"],dtype="float32",always_2d=True)
        accepted,oldrate=sf.read(frozen/(stem+"-part.wav"),dtype="float32",always_2d=True)
        checks={"notes_exact":result["notes"]==expected["notes"],
                "voicings_exact":result["voicings"]==expected["voicings"],
                "sample_rate_same":rate==oldrate,"shape_same":actual.shape==accepted.shape,
                "audio_samples_bit_identical":np.array_equal(actual,accepted),
                "midi_roundtrip_within_one_tick":rendered["midi_roundtrip"]["within_one_tick"],
                "all_symbolic_checks":all(result["checks"].values())}
        results[instrument]={"checks":checks,"part_path":rendered["part_path"],
                             "source_part_path":str(frozen/(stem+"-part.wav")),
                             "max_absolute_sample_difference":float(np.max(np.abs(actual-accepted))) if actual.shape==accepted.shape else None,
                             "decoded_float32_sample_sha256":hashlib.sha256(actual.tobytes()).hexdigest(),
                             "source_decoded_float32_sample_sha256":hashlib.sha256(accepted.tobytes()).hexdigest(),
                             "render":rendered}
    unchanged=all(digest(path)==sha for path,sha in before.items())
    passed=unchanged and all(all(x["checks"].values()) for x in results.values())
    report={"status":"passed" if passed else "failed","runtime":{"python":sys.executable,"music21":music21.__version__,"numpy":np.__version__,"soundfile":sf.__version__},
            "accepted_scope":"reproduces the accepted 40–56s piano/guitar part; does not accept new songs/harmony/downbeats",
            "source_files_unchanged":unchanged,"source_hashes":before,"results":results,
            "metadata_note":"Compare decoded samples and authored notes, not JSON or WAV metadata headers.",
            "no_new_package_installation":True}
    export_result(report,output_dir,"equivalence-report",job_root=output_dir,resources=cfg)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if not passed:
        raise AssertionError("Integrated core differs from accepted reference")
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--equivalence-dir",type=Path)
    parser.add_argument("--evidence-root",type=Path)
    args,unknown=parser.parse_known_args()
    if args.equivalence_dir:
        if unknown:parser.error("Unknown arguments: "+" ".join(unknown))
        equivalence(args.equivalence_dir,args.evidence_root)
    else:
        unittest.main(argv=[sys.argv[0],*unknown])
