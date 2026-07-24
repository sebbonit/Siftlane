import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders styled markdown content", () => {
    const content = ["# Hello", "", "A **bold** note."].join("\n");
    render(<MarkdownPreview content={content} />);
    expect(screen.getByRole("heading", { level: 1, name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });

  it("shows an empty state for blank files", () => {
    render(<MarkdownPreview content="   " />);
    expect(screen.getByText("This file is empty.")).toBeInTheDocument();
  });

  it("renders nothing when empty and emptyLabel is null", () => {
    const { container } = render(<MarkdownPreview content="   " emptyLabel={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
