# Miteng

Miteng is a privacy-first meeting assistant. It records your microphone and system audio, transcribes meetings on your own computer, and writes summaries with local models or bring-your-own-key cloud models. Your recordings, transcripts, and notes stay on your machine.

Built with Tauri v2 (Rust) and Next.js; the app lives in `frontend/`.

## What's new in Miteng

Compared with Meetily, Miteng adds:

- **Transcription language switcher.** Pick the spoken language (Indonesian, English, Auto, and more) right beside the mic toggle on the record card, also while recording. Pin the languages you use; they appear as one-click chips and at the top of the list. Auto-translate to English switches to a Whisper model that can actually translate (large-v3-turbo cannot).
- **Linked meetings (Part 1 → 2 → 3).** Mark a meeting as the continuation of an earlier one, before or while recording or afterwards from the meeting page. Use it for a meeting split by a break or carried over to another day. Parts get "Part N of M" navigation and badges in the meeting list. When a later part is summarized, the earlier part's summary is passed as context.
- **Multiple custom AI servers.** Save any number of OpenAI-compatible servers (vLLM, LM Studio, LiteLLM, OpenRouter, 9router…), each with its own endpoint, API key and model list. Fetch the server's full model list from `/models` with display names, then check the ones to use; only checked models appear when picking a model. Add models by hand and test the connection.
- **Separate model for Ask AI.** Ask AI (meeting, contact and live) can use a different provider or model than summaries, or follow the summary model. Switch it right from the Ask AI tab on a meeting.
- **Automatic recording from microphone use (Labs).** When another app (Teams, Zoom, a browser call…) has been using the microphone for a few seconds, Miteng starts recording; when that app lets go, it stops and saves. Separate from meeting detection, which only spots meeting apps and asks. macOS 14+ and Windows.
- **Settings locked while recording.** Recording, transcription, meeting detection and Labs settings cannot change mid-recording, so a session is never broken by a model or capture switch.
- **Echo cancellation (Labs).** WebRTC AEC3 removes speaker echo from the mic track, so remote speech is not transcribed twice. A muted mic stays silent, which stops phantom phrases.
- **Per-app recording on macOS.** Capture only chosen apps (for example Microsoft Teams or Edge), including their helper processes.
- **Reliable long recordings.** System audio is no longer lost after an audio stall, and capture follows output device changes (monitor ↔ built-in speakers). The live transcript keeps scrolling when one speaker talks for a long time.
- **Import from Meetily.** A previous Meetily install is imported once, read-only.
- **Log file.** `~/Library/Logs/Miteng/miteng.log` (rotates at 20 MB). It records transcript sizes, never meeting content.

## Download

Get the latest macOS (Apple Silicon) DMG from [Releases](https://github.com/akramram/Miteng/releases). The app is ad-hoc signed, not notarized, so macOS may call it damaged after download. Drag it to Applications, then run once:

```sh
xattr -dr com.apple.quarantine /Applications/Miteng.app
```

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
