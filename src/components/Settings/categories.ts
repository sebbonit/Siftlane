import { Cable, HardDriveDownload, Info, Palette, type LucideIcon } from "lucide-react";

export type SettingsCategoryId = "general" | "transfers" | "connection" | "about";

export interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: "general",
    label: "General",
    description: "Appearance, layout, and browser defaults",
    icon: Palette,
  },
  {
    id: "transfers",
    label: "Transfers",
    description: "Parallel upload and download limits",
    icon: HardDriveDownload,
  },
  {
    id: "connection",
    label: "Connection",
    description: "Timeouts and keepalive for remote sessions",
    icon: Cable,
  },
  {
    id: "about",
    label: "About",
    description: "Version and project information",
    icon: Info,
  },
];
