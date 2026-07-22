import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";

describe("saved session actions", () => {
  it("adds and lists a saved action from the session tabs menu", async () => {
    render(<App />);
    const newButtons = await screen.findAllByRole("button", { name: /new connection/i });
    await userEvent.click(newButtons[0]!);
    await userEvent.type(screen.getByLabelText(/display name/i), "Actions host");
    await userEvent.type(screen.getByLabelText(/^host$/i), "actions.example.com");
    await userEvent.type(screen.getByLabelText(/username/i), "deploy");
    await userEvent.click(screen.getByRole("button", { name: "SSH agent" }));
    await userEvent.click(screen.getByRole("button", { name: /save & connect/i }));
    await waitFor(() => expect(document.querySelector(".session-tabs")).toHaveClass("visible"));

    await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /add new/i }));
    const dialog = screen.getByRole("dialog", { name: /add action/i });
    expect(dialog).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText(/^name$/i), "Open both project dirs");
    await userEvent.selectOptions(within(dialog).getByLabelText(/action type/i), "open_both");
    await userEvent.clear(within(dialog).getByLabelText(/local directory/i));
    await userEvent.type(
      within(dialog).getByLabelText(/local directory/i),
      "/Users/alex/Projects/my-website",
    );
    await userEvent.clear(within(dialog).getByLabelText(/remote directory/i));
    await userEvent.type(within(dialog).getByLabelText(/remote directory/i), "/var/www/html");
    await userEvent.click(within(dialog).getByRole("button", { name: /save action/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /add action/i })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: /open both project dirs/i })).toBeInTheDocument();
  });

  it("lets package actions choose archive format", async () => {
    render(<App />);
    const newButtons = await screen.findAllByRole("button", { name: /new connection/i });
    await userEvent.click(newButtons[0]!);
    await userEvent.type(screen.getByLabelText(/display name/i), "Package host");
    await userEvent.type(screen.getByLabelText(/^host$/i), "package.example.com");
    await userEvent.type(screen.getByLabelText(/username/i), "deploy");
    await userEvent.click(screen.getByRole("button", { name: "SSH agent" }));
    await userEvent.click(screen.getByRole("button", { name: /save & connect/i }));
    await waitFor(() => expect(document.querySelector(".session-tabs")).toHaveClass("visible"));

    await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /add new/i }));
    const dialog = screen.getByRole("dialog", { name: /add action/i });

    await userEvent.type(within(dialog).getByLabelText(/^name$/i), "Bundle and fetch");
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/action type/i),
      "package_and_download",
    );
    expect(within(dialog).getByLabelText(/archive format/i)).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText(/archive format/i), "zip");
    await userEvent.clear(within(dialog).getByLabelText(/local directory/i));
    await userEvent.type(within(dialog).getByLabelText(/local directory/i), "/Users/alex/Downloads");
    await userEvent.clear(within(dialog).getByLabelText(/remote directory/i));
    await userEvent.type(within(dialog).getByLabelText(/remote directory/i), "/var/www/html");
    await userEvent.click(within(dialog).getByRole("button", { name: /save action/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /add action/i })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: /bundle and fetch/i })).toBeInTheDocument();
  });
});
