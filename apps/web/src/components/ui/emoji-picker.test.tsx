import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmojiPicker } from "@/components/ui/emoji-picker";

describe("EmojiPicker", () => {
  afterEach(cleanup);

  it("labels choices accessibly and announces the selected supported emoji", () => {
    const onChange = vi.fn();
    render(<EmojiPicker onChange={onChange} value="🧭" />);

    fireEvent.click(screen.getByRole("tab", { name: "Animals" }));
    const fox = screen.getByRole("button", { name: "Choose fox emoji" });
    expect(screen.getByText(/Selected avatar:/)).toBeTruthy();
    fireEvent.click(fox);
    expect(onChange).toHaveBeenCalledWith("🦊");
  });

  it("selects an expression emoji from the curated Expressions category", () => {
    const onChange = vi.fn();
    render(<EmojiPicker onChange={onChange} value="🧭" />);

    expect(screen.getByRole("tab", { name: "Expressions" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Choose expression 😎 emoji" }));
    expect(onChange).toHaveBeenCalledWith("😎");
  });

  it("renders inclusive people options and selects a supported multi-codepoint avatar", () => {
    const onChange = vi.fn();
    render(<EmojiPicker onChange={onChange} value="🧭" />);

    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByRole("button", { name: "Choose person 👨🏾 emoji" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose person 🧑‍💻 emoji" }));
    expect(onChange).toHaveBeenCalledWith("🧑‍💻");
  });
});
