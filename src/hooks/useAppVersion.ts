import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { desktop } from "../lib/ipc";
import packageJson from "../../package.json";

/** Running app version from Tauri, falling back to package.json in the browser. */
export function useAppVersion() {
  const [version, setVersion] = useState(packageJson.version);

  useEffect(() => {
    if (!desktop) {
      return;
    }

    void getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  return version;
}
