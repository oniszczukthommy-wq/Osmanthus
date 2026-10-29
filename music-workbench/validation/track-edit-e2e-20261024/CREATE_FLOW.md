# Lyric approval before song creation

Current product contract (2026-10-29):

- Simple: idea → AI lyric draft → user reviews/edits and confirms → two songs.
- Advanced: exact user-written lyrics → user reviews and confirms → two songs. No automatic lyric rewrite.
- POST `/api/generation/drafts` accepts the Simple/Advanced form through `create_flow.fields`. Draft preparation never launches music.
- POST `/api/generation/drafts/{id}/save` saves the edited title/lyrics against the current version.
- POST `/api/generation/drafts/{id}/confirm` must carry that saved version and fingerprint. Approval is durable before the pair engine is called; retries use the same deterministic batch ID.
- The UI persists its draft request before submission and exposes the lyric review dialog before any music confirmation action.
- The old POST `/api/creation/jobs` only replays already-recorded requests. New IDs receive 422 and must use the lyric confirmation flow.
- Stream playback does not wait for local full-file download. Covers start after the lyrics/title are known and before the provider stream worker; binding the downloaded audio hash reuses the same artwork job.

## Legacy direct-flow internals

The following documents old records and their recovery only. It is not the current UI contract.


`CreationFlow` remains available to read and recover historical direct-creation requests. New requests go through `GenerationDrafts`.

## Server binding

```python
from create_flow import CreationFlow

CREATE_FLOW = CreationFlow(GENERATION_PAIRS, GENERATION_DRAFTS)
```

Bind these methods to the new routes selected by the main server:

| Action | Method | Response |
| --- | --- | --- |
| Generate two songs | `CREATE_FLOW.start(body)` | Creation request with nested `batch` |
| List creation requests | `CREATE_FLOW.list()` | List; server may wrap in `{"requests": ...}` |
| Read one | `CREATE_FLOW.public(CREATE_FLOW.read(id))` | Creation request |
| Explicitly resume | `CREATE_FLOW.resume(id)` | Same request / same batch IDs |
| Cancel only before acceptance | `CREATE_FLOW.cancel_unaccepted(id)` | `{cancelled: true}` or existing `creation` |
| Optional AI lyrics | `CREATE_FLOW.write_lyrics(body)` | Existing lyric-draft public object |

At startup, call `CREATE_FLOW.recover()` **after** the existing workflow, pair and lyric-draft recovery. Pair recovery alone restores provider tasks; creation recovery only binds existing batches and resumes durable intents that had not yet created a batch. No new server routes are installed by this module itself.

## Music requests

Simple:

```json
{
  "request_id": "fresh canonical UUID",
  "mode": "simple",
  "prompt": "雨停后的第一班车，温暖、轻盈的中文 R&B，自然女声"
}
```

Advanced:

```json
{
  "request_id": "fresh canonical UUID",
  "mode": "advanced",
  "lyrics": "[VERSE]\n用户填写的歌词\n[CHORUS]\n保留用户每一句歌词",
  "style": "温暖的中文流行，电钢琴、轻鼓和贝斯",
  "voice": "自然清楚的男声，不要明显电音",
  "title": "可选歌名"
}
```

- `prompt` and `brief` are aliases. Supply one; different simultaneous values are rejected.
- Simple requires 3–2000 characters of creative direction. It invokes the existing DeepSeek writer and then the real two-candidate music engine, without creating a fabricated confirmed draft.
- Advanced requires nonempty lyrics, 1–5000 characters. Empty lyrics are rejected with `请填写歌词，或使用 AI 写词后再生成`. Empty lyrics do not silently request generated vocals or pretend to request instrumental music.
- An explicit `instrumental: true` is rejected because that provider path has not been validated.
- Style supports 1–1000 characters; voice supports 1–240; optional title supports 1–120. The final music prompt must still fit the provider's existing 3000-character cap. Combined overlong input fails before any writer/provider call.
- Blank style uses a common-style keyword inferred from the description, otherwise Chinese pop. Blank voice asks for clear natural singing following the description, rather than overriding a requested female voice with a fixed male default.
- Manual lyrics are not sent through the writer. Interior punctuation, spaces and line breaks remain intact; outer whitespace is normalized by the existing request compiler. Both candidates receive the same lyrics. A missing Advanced title uses the first lyric line. Explicit titles survive automatic lyric writing.

The response contains `id`, `request_id`, `mode`, `stage`, `batch_id`, `batch`, `input`, `created_at`, `policy`, `error`, and `can_resume`. `batch_id == request_id`. The nested batch keeps the established candidate/media/select/retry contract and adds `creation_request_id` / `creation_mode`. Existing batch, job and media endpoints can continue to be polled by the client.

## Optional AI writing

`write_lyrics` accepts a fresh `request_id`, `prompt` or `brief`, optional `style`, `voice`, `title`, `instruction`, and reference `lyrics`. Reference text is included in the writing brief, not mistaken for a completed manual lyric. The combined brief, instruction and reference text is limited to 2000 characters and is never silently truncated.

The helper creates a new full lyric draft. It is not a selected-word replacement/cowriter API. It never launches music. Poll the existing draft detail endpoint by its returned `id`; when `stage == "ready"`, the UI may display or adopt the returned lyrics. The UI should guard against a late result overwriting text the user edited after starting the helper. A future music request must use a **different request ID**.

## Submission safety

- The explicit Generate action is persisted to `workflow/creation-requests/<id>/state.json` before music work starts. Request mode and normalized payload are fingerprinted together.
- Identical retries reuse one intent and batch; changing mode, lyrics, voice, style or title under the same ID is rejected. Existing legacy job/draft/batch namespaces cannot be claimed as new requests.
- A failed initial intent write starts no work. A failed pair write leaves no in-memory fake-success batch. The request remains reviewable and can be explicitly resumed.
- A crash after intent but before batch creation recovers the exact authorized request. A crash after batch persistence links to the existing batch; it does not launch a second batch.
- Existing provider task IDs, ambiguous submission guards, candidate retry IDs, explicit stem selection, waveform/media handling, and artwork hooks remain in use. Neither refreshed views nor intent reads create new provider tasks.
- A missing accepted batch or corrupt intent is shown as an error and blocks automatic regeneration, rather than risking duplicate charges.

The creation UI persists an uncertain request ID before submitting. Reload only checks that ID with GET, never generates another song. Once absence is confirmed, the user can explicitly continue the original request (same ID and payload), or cancel it through `POST /api/creation/jobs/{id}/cancel`. Cancellation uses the same workflow lock as admission and writes `cancelled.json` before returning success. A delayed POST with the canceled ID is rejected, including after a restart. If a batch has already been accepted, cancellation instead returns the existing `creation`; it never hides or deletes accepted work. Accepted-but-missing or corrupt records cannot be canceled as if they were absent. Creation reads distinguish missing records (404) from corrupt records (409).

Song generation is disabled during optional AI lyric rewriting. An empty-candidate planning failure exposes an explicit recovery button using the existing creation/batch ID.

## Verification

```sh
../audio-separation/.venv/bin/python -m unittest test_create_flow test_creation_http_routes test_generation_pairs test_generation_drafts -q
node test_studio_creation_request.mjs
```

50 offline tests pass (20 new direct-flow cases plus 30 existing pair/draft cases). They use real managers and isolated durable state with mocked writers/provider launches; they are not new song/audio-quality evidence and incur no API charge.
