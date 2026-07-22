import { ArrowLeft } from "lucide-react";
import appIcon from "../../../src-tauri/icons/128x128.png";
import { SETTINGS_CATEGORIES, type SettingsCategoryId } from "./categories";

export function SettingsSidebar({
  activeId,
  onSelect,
  onBack,
}: {
  activeId: SettingsCategoryId;
  onSelect: (id: SettingsCategoryId) => void;
  onBack: () => void;
}) {
  return (
    <aside className="settings-sidebar">
      <div className="settings-brand">
        <img src={appIcon} alt="" width={28} height={28} />
        <strong>Siftlane</strong>
      </div>
      <nav className="settings-nav" aria-label="Settings categories">
        {SETTINGS_CATEGORIES.map((category) => {
          const Icon = category.icon;
          const active = category.id === activeId;
          return (
            <button
              key={category.id}
              type="button"
              className={`settings-nav-item${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(category.id)}
            >
              <Icon size={16} />
              <span>{category.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="settings-sidebar-footer">
        <button type="button" className="settings-back" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>
      </div>
    </aside>
  );
}
