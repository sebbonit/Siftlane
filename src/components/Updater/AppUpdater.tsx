import { UpdateDialog } from "./UpdateDialog";
import { useAppUpdater } from "./useAppUpdater";

export function AppUpdater() {
  const updater = useAppUpdater(true);
  return <UpdateDialog updater={updater} />;
}

export function useManualUpdater() {
  return useAppUpdater(false);
}
