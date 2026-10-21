# Miteng

Miteng is a privacy-first meeting assistant. It records your microphone and system audio, transcribes meetings on your own computer, and writes summaries with local models or bring-your-own-key cloud models. Your recordings, transcripts, and notes stay on your machine.

Built with Tauri v2 (Rust) and Next.js; the app lives in `frontend/`.

## What's new in Miteng

Compared with Meetily, Miteng adds:

- **Transcription language switcher.** Pick the spoken language (Indonesian, English, Auto, and more) right beside the mic toggle on the record card, also while recording. Auto-translate to English switches to a Whisper model that can actually translate (large-v3-turbo cannot).
- **Linked meetings (Part 1 → 2 → 3).** Mark a meeting as the continuation of an earlier one, before or while recording or afterwards from the meeting page. Use it for a meeting split by a break or carried over to another day. Parts get "Part N of M" navigation and badges in the meeting list. When a later part is summarized, the earlier part's summary is passed as context.
- **Multiple custom AI servers.** Save any number of OpenAI-compatible servers (vLLM, LM Studio, LiteLLM, OpenRouter, 9router…), each with its own endpoint, API key and model list. Fetch models from `/models` with their display names, add them one by one or all at once, and test the connection. Pick one server and model for summaries.
- **Separate model for Ask AI.** Ask AI (meeting, contact and live) can use a different provider or model than summaries, or follow the summary model.
- **Echo cancellation (Labs).** WebRTC AEC3 removes speaker echo from the mic track, so remote speech is not transcribed twice. A muted mic stays silent, which stops phantom phrases.
- **Per-app recording on macOS.** Capture only chosen apps (for example Microsoft Teams or Edge), including their helper processes.
- **Reliable long recordings.** System audio is no longer lost after an audio stall, and capture follows output device changes (monitor ↔ built-in speakers). The live transcript keeps scrolling when one speaker talks for a long time.
- **Import from Meetily.** A previous Meetily install is imported once, read-only.
- **Log file.** `~/Library/Logs/Miteng/miteng.log` (rotates at 20 MB). It records transcript sizes, never meeting content.

## Build (macOS, Apple Silicon)

```sh
cd frontend
./scripts/build-macos-apple-silicon.sh
```

## Data locations (macOS)

- App data (database, models, templates): `~/Library/Application Support/Miteng`
- Recordings: `~/Movies/miteng-recordings` (configurable)
- Logs: `~/Library/Logs/Miteng/miteng.log`
- Bundle identifier: `com.miteng.app`

## Maintainer

Akram

## License

MIT — see [LICENSE.md](LICENSE.md). Miteng is based on Meetily by Zackriya Solutions (MIT).
