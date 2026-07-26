import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { FileEntry, SessionTab } from "../types";
import { RemoteTransferDialog } from "./RemoteTransferDialog";

const source: SessionTab = {
  id: "source-session",
  profileId: "source-profile",
  label: "Production",
  host: "prod.example.com",
  protocol: "sftp",
  localPath: "/tmp",
  remotePath: "/var/www",
  layout: "dual_pane",
  connected: true,
};
const destination: SessionTab = {
  ...source,
  id: "destination-session",
  profileId: "destination-profile",
  label: "Staging",
  host: "staging.example.com",
  remotePath: "/srv/staging",
};
const entry: FileEntry = {
  path: "/var/www/app.js",
  name: "app.js",
  kind: "file",
  size: 1024,
  modified_at: null,
  permissions: 0o644,
  symlink_target: null,
  hidden: false,
};

it("confirms an explicit source and destination route", async () => {
  const confirm = vi.fn().mockResolvedValue(undefined);
  render(
    <RemoteTransferDialog
      source={source}
      destinations={[destination]}
      entries={[entry]}
      onClose={() => undefined}
      onConfirm={confirm}
    />,
  );

  expect(screen.getByText(/256 KB chunks/i)).toBeInTheDocument();
  expect(screen.getByText("Production:/var/www/app.js")).toBeInTheDocument();
  expect(screen.getByText("Staging:/srv/staging/app.js")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /start remote copy/i }));

  expect(confirm).toHaveBeenCalledWith(
    destination,
    [{ sourcePath: "/var/www/app.js", destinationPath: "/srv/staging/app.js" }],
    "ask",
  );
});
