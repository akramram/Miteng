# Miteng

Miteng is a privacy-first meeting assistant. It records your microphone and system audio, transcribes meetings on your own computer, and writes summaries with local models or bring-your-own-key cloud models. Your recordings, transcripts, and notes stay on your machine.

Built with Tauri v2 (Rust) and Next.js; the app lives in `frontend/`.

## Build (macOS, Apple Silicon)

```sh
cd frontend
./scripts/build-macos-apple-silicon.sh
```

## Data locations (macOS)

- App data (database, models, templates): `~/Library/Application Support/Miteng`
- Bundle identifier: `com.miteng.app`

## Maintainer

Akram

## License

MIT — see [LICENSE.md](LICENSE.md). Miteng is based on Meetily by Zackriya Solutions (MIT).
