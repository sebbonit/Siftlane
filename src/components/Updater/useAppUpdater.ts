import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { desktop } from "../../lib/ipc";

/** Packaged apps only — never auto-update from `tauri dev`. */
export const updatesEnabled = desktop && import.meta.env.PROD;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "downloading"
  | "restarting"
  | "error";

export type AppUpdaterState = {
  phase: UpdatePhase;
  update: Update | null;
  progress: number | null;
  error: string | null;
  checkForUpdates: (manual?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
};

function errorMessage(reason: unknown) {
  const raw =
    reason instanceof Error
      ? reason.message
      : String((reason as { message?: string }).message ?? reason);
  if (/valid release json|successful status code|404|not found/i.test(raw)) {
    return "No updater manifest on the latest GitHub Release yet. Publish a new release with the updated workflow to enable updates.";
  }
  return raw;
}

export function useAppUpdater(checkOnLaunch = true): AppUpdaterState {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const launched = useRef(false);

  async function checkForUpdates(manual = false) {
    if (!updatesEnabled) {
      if (manual) {
        setPhase("error");
        setError("Updates are only available in packaged release builds.");
      }
      return;
    }
    setPhase("checking");
    setError(null);
    try {
      const next = await check();
      if (next) {
        setUpdate(next);
        setPhase("available");
        return;
      }
      setUpdate(null);
      setPhase(manual ? "up_to_date" : "idle");
    } catch (reason) {
      setUpdate(null);
      // Launch-time misses (no latest.json yet, offline, etc.) stay quiet.
      // Manual checks from Settings → About still surface the error.
      if (!manual) {
        setPhase("idle");
        setError(null);
        return;
      }
      setPhase("error");
      setError(errorMessage(reason));
    }
  }

  async function installUpdate() {
    if (!updatesEnabled || !update) return;
    setPhase("downloading");
    setError(null);
    setProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          downloaded = 0;
          setProgress(total > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setPhase("restarting");
      await relaunch();
    } catch (reason) {
      setPhase("error");
      setError(errorMessage(reason));
    }
  }

  function dismiss() {
    if (phase === "downloading" || phase === "restarting") return;
    setPhase("idle");
    setUpdate(null);
    setProgress(null);
    setError(null);
  }

  useEffect(() => {
    if (!checkOnLaunch || !updatesEnabled || launched.current) return;
    launched.current = true;
    void checkForUpdates(false);
  }, [checkOnLaunch]);

  return {
    phase,
    update,
    progress,
    error,
    checkForUpdates,
    installUpdate,
    dismiss,
  };
}
