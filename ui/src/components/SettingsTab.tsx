import type { Act, SettingsState } from "../api";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../routes";
import { SectionNav } from "./SectionNav";
import { Skeleton } from "./Skeleton";
import { TunnelSection } from "./settings/TunnelSection";
import { NetworkSection } from "./settings/NetworkSection";
import { FilesSection } from "./settings/FilesSection";
import { ShellSection } from "./settings/ShellSection";
import { NotifySection } from "./settings/NotifySection";
import { LocksSection } from "./settings/LocksSection";

interface Props {
  settings: SettingsState | null;
  act: Act;
  /** Invalid-input feedback: shows a toast instead of failing silently. */
  notify?: (text: string, isError?: boolean) => void;
  /** Which settings sub-page is open — the URL is the source of truth. */
  section: SettingsSectionId;
  /** Sub-page switch: App turns this into a history entry, not a scroll. */
  onSectionChange: (id: SettingsSectionId) => void;
}

/**
 * The settings shell: the section strip plus one card per sub-page. The shared
 * `settings` state and the `act` runner come from App; each section component
 * owns its own busy/draft state and its own rendering, so the shell stays a
 * router-sized piece of code.
 */
export function SettingsTab({ settings, act, notify, section, onSectionChange }: Props) {
  if (!settings) return <div className="card"><Skeleton lines={4} /></div>;
  return (
    <>
      {/* One card per sub-page: the strip switches the route, the URL and the
          rendered card move together, and a reload lands where you were. */}
      <SectionNav
        items={SETTINGS_SECTIONS.map(({ id, label }) => ({ id, label: label() }))}
        active={section}
        onSelect={onSectionChange}
      />

      {section === "tunnel" && <TunnelSection settings={settings} act={act} />}
      {section === "network" && <NetworkSection settings={settings} act={act} notify={notify} />}
      {section === "files" && <FilesSection settings={settings} act={act} />}
      {section === "shell" && <ShellSection settings={settings} act={act} />}
      {section === "notify" && <NotifySection settings={settings} act={act} notify={notify} />}
      {section === "locks" && <LocksSection settings={settings} act={act} notify={notify} />}
    </>
  );
}
