"use client";

import React, { useState } from "react";
import { AVATAR_GROUPS, avatarEmoji } from "@/lib/avatar";

type EmojiPickerProps = {
  value: string | null | undefined;
  onChange: (emoji: string) => void;
  disabled?: boolean;
  label?: string;
};

export function EmojiPicker({ value, onChange, disabled = false, label = "Choose your Basecamp avatar" }: EmojiPickerProps) {
  const selected = avatarEmoji(value);
  const [category, setCategory] = useState<string>(AVATAR_GROUPS[0].label);
  const group = AVATAR_GROUPS.find((candidate) => candidate.label === category) ?? AVATAR_GROUPS[0];
  return <fieldset className="emoji-picker" aria-label={label} disabled={disabled}>
    <legend>{label}</legend>
    <p aria-live="polite" className="muted small">Selected avatar: <span aria-hidden="true">{selected}</span></p>
    <div className="emoji-picker-tabs" role="tablist" aria-label="Emoji categories">{AVATAR_GROUPS.map((candidate) => <button aria-selected={candidate.label === group.label} className="emoji-picker-tab" key={candidate.label} onClick={() => setCategory(candidate.label)} role="tab" type="button">{candidate.label}</button>)}</div>
    <div className="emoji-picker-scroll"><div className="emoji-picker-group" key={group.label}>
      <span className="emoji-picker-label">{group.label}</span>
      <div className="emoji-picker-options" role="group" aria-label={`${group.label} emoji choices`}>
        {group.choices.map((choice) => <button
          aria-label={`Choose ${choice.label} emoji`}
          aria-pressed={selected === choice.emoji}
          className="emoji-choice"
          key={choice.emoji}
          onClick={() => onChange(choice.emoji)}
          type="button"
        >{choice.emoji}<span className="sr-only">{selected === choice.emoji ? ", selected" : ""}</span></button>)}
      </div>
    </div></div>
  </fieldset>;
}
