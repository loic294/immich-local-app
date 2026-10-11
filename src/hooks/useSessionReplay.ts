import { useEffect } from "react";
import { getMediaPreferences, type MediaPreferences } from "../api/media";

const ANALYTICS = "https://analytics.loicbellemarealford.ca";
const WEBSITE = "d905c3e7-0c82-42fc-9e06-c30f478bda13";
type ReplayWindow = Window & { umami?: { track: (payload: object) => Promise<void> } };

/** Recorder has no stop API. Reloading its JS realm on opt-out stops observers and timers. */
export function useSessionReplay(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let started = false;
    let consentVersion = 0;
    let observer: MutationObserver | undefined;
    const scripts: HTMLScriptElement[] = [];
    const load = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${ANALYTICS}/${name}.js`;
        script.dataset.websiteId = WEBSITE;
        script.dataset.autoTrack = "false";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Session replay script unavailable: ${name}`));
        scripts.push(script);
        document.head.appendChild(script);
      });
    const apply = async (preferences: MediaPreferences) => {
      if (!active) return;
      if (!preferences.sessionReplayEnabled) {
        consentVersion += 1;
        if (started) {
          console.info("[telemetry:replay] opt-out; stopping recorder realm");
          observer?.disconnect();
          scripts.forEach((script) => script.remove());
          window.location.reload();
        }
        return;
      }
      if (started) return;
      const version = ++consentVersion;
      started = true;
      console.info("[telemetry:replay] opt-in; loading masked recorder");
      // rrweb honors these classes for snapshots, including descendants added later.
      document.documentElement.classList.add("rr-mask");
      const blockMedia = () =>
        document
          .querySelectorAll("img, video, canvas, svg, [data-replay-block]")
          .forEach((node) => node.classList.add("rr-block"));
      blockMedia();
      observer = new MutationObserver(blockMedia);
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        await load("script");
        if (!active || version !== consentVersion) return;
        await (window as ReplayWindow).umami?.track({
          website: WEBSITE,
          hostname: location.hostname || "immich-local-app",
          url: "/desktop",
          language: navigator.language,
          screen: `${screen.width}x${screen.height}`,
          name: "session-replay",
        });
        if (!active || version !== consentVersion) return;
        await load("recorder");
        console.info("[telemetry:replay] recorder loaded; server sampling configuration applies");
      } catch (error) {
        console.error("[telemetry:replay] initialization failed", error);
      }
    };
    void getMediaPreferences()
      .then((preferences) => {
        if (consentVersion === 0) return apply(preferences);
      })
      .catch((error) => console.error("[telemetry:replay] preferences unavailable", error));
    const changed = (event: Event) => {
      if (event instanceof CustomEvent) void apply(event.detail as MediaPreferences);
    };
    window.addEventListener("media:preferences-changed", changed);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("media:preferences-changed", changed);
      scripts.forEach((script) => script.remove());
      if (started) window.location.reload();
    };
  }, [enabled]);
}
