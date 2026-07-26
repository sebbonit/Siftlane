import { Cable, HardDriveDownload, Info, Palette, ShieldCheck, type LucideIcon } from "lucide-react";

export type SettingsCategoryId = "general" | "transfers" | "connection" | "trusted_hosts" | "about";

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
    id: "trusted_hosts",
    label: "Trusted hosts",
    description: "SSH fingerprints and known_hosts import",
    icon: ShieldCheck,
  },
  {
    id: "about",
    label: "About",
    description: "Version and project information",
    icon: Info,
  },
];
