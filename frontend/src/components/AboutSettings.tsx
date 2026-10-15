"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { Shield, Cpu, Heart } from "lucide-react"

/**
 * About panel for Miteng. Shows version and a short description. Purely informational.
 */
export function AboutSettings() {
  const [version, setVersion] = useState('0.0.1');

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setVersion(await getVersion());
      } catch {
        // Not in a Tauri context; keep the default.
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      {/* Identity card */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="flex items-center gap-4">
          <Image src="/logo-collapsed.png" alt="Miteng" width={56} height={56} className="h-14 w-14 shrink-0 rounded-2xl shadow-sm" />
          <div>
            <h3 className="text-lg font-semibold text-af-text">Miteng</h3>
            <p className="text-sm text-af-text-2">
              Version {version} · Privacy-first, on-device meeting assistant
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-af-text-2 leading-relaxed">
          Miteng captures, transcribes and summarizes your meetings entirely on your own
          machine — with GPU acceleration, bring-your-own-key cloud models, and local-first
          data ownership.
        </p>
      </div>

      {/* Highlights */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Cpu className="w-5 h-5 text-af-accent mb-2" />
          <div className="text-sm font-medium text-af-text">On-device</div>
          <div className="text-xs text-af-text-3">Local transcription &amp; summaries</div>
        </div>
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Shield className="w-5 h-5 text-af-success mb-2" />
          <div className="text-sm font-medium text-af-text">Private</div>
          <div className="text-xs text-af-text-3">No telemetry, nothing leaves your PC</div>
        </div>
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Heart className="w-5 h-5 text-pink-500 mb-2" />
          <div className="text-sm font-medium text-af-text">Free</div>
          <div className="text-xs text-af-text-3">Every feature, no paywall</div>
        </div>
      </div>

      <div className="text-center text-xs text-af-text-4 space-y-1">
        <p>Miteng by Akram · MIT licensed</p>
        <p>Based on the open-source Meetily project (MIT)</p>
      </div>
    </div>
  );
}
