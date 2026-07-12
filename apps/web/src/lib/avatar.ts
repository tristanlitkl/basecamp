export const DEFAULT_AVATAR_EMOJI = "🧭";

export const AVATAR_GROUPS = [
  { label: "Adventure", choices: [{ emoji: "🧭", label: "compass" }, { emoji: "⛺", label: "tent" }, { emoji: "🗺️", label: "map" }, { emoji: "🥾", label: "hiking boot" }] },
  { label: "Nature", choices: [{ emoji: "🌲", label: "evergreen tree" }, { emoji: "🏔️", label: "mountain" }, { emoji: "🌊", label: "wave" }, { emoji: "🌙", label: "moon" }] },
  { label: "Animals", choices: [{ emoji: "🦊", label: "fox" }, { emoji: "🐻", label: "bear" }, { emoji: "🦉", label: "owl" }, { emoji: "🐕", label: "dog" }] },
  { label: "Fun", choices: [{ emoji: "🎒", label: "backpack" }, { emoji: "🔥", label: "campfire" }, { emoji: "✨", label: "sparkles" }, { emoji: "🚐", label: "camper van" }] }
] as const;

export function avatarEmoji(value: string | null | undefined) {
  return value || DEFAULT_AVATAR_EMOJI;
}
