# Third-party notices

The original application code is MIT; the following components retain their upstream terms.

| Component | Files / reference | License and notice |
| --- | --- | --- |
| Three.js | mv-studio/public/assets/vendor/three/ | MIT; full LICENSE and PROVENANCE.json are preserved in that directory. |
| Lucide icons, v1.17.0 | music-workbench/validation/track-edit-e2e-20261024/studio-icons.js | ISC, including Feather icon attribution under MIT; full upstream notice: licenses/lucide-ISC.txt. Source: https://github.com/lucide-icons/lucide/tree/1.17.0 |
| chords-db guitar chord data | music-workbench/validation/track-edit-e2e-20261024/resources/chords-db/guitar.json | MIT, Copyright 2016 David Rubert; LICENSE and source-receipt.json are preserved beside the data. Source: https://github.com/tombatossals/chords-db |

## Optional integrations, not redistributed models

Demucs, Basic Pitch, music21, Mido, FluidSynth, GeneralUser GS, MuseScore, Seed-VC, Amphion, DiffSinger and other optional tools/models are integrations or research references. Install only the tools needed for your use case; their code, checkpoints, voice banks, fonts and samples have separate terms. A framework's license does not automatically license its model weights or a singer voice bank. Seed-VC reference directories contain upstream license/documentation notices, not a bundled model.

MiniMax/YinChao/DeepSeek/Aliyun services require your own accounts, keys and quota. This repository does not provide access to those services or authorize reuse of their voice previews. No archived voice-preview library is included.

External OiiOii media and prompt catalogs are not distributed. Legacy catalog module names remain as empty compatibility interfaces; the current core MV interface does not load preset catalogs. The compilation/helpers around user-provided data remain original software.

The composition knowledge collection and book-reference archive used during private research are not included in this public snapshot. For optional upstream skills, evaluate the upstream license and exclusions yourself: https://github.com/jtydhr88/music-composition-skills .
