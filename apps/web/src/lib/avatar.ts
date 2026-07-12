export const DEFAULT_AVATAR_EMOJI = "🧭";

export const AVATAR_GROUPS = [
  { label: "Expressions", choices: "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😋 😎 🤓 🧐 🤨 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤠 🤑 😈 👿 👻 👽 🤖 💀".split(" ").map((emoji) => ({ emoji, label: `expression ${emoji}` })) },
  { label: "Adventure", choices: "🧭 🗺️ ⛰️ 🏔️ 🏕️ ⛺ 🥾 🎒 🚐 ✈️ 🚗 🚙 🚲 🛶 ⛵ 🚤 🌋 🏝️".split(" ").map((emoji) => ({ emoji, label: `adventure ${emoji}` })) },
  { label: "Nature", choices: "🌲 🌳 🌴 🌵 🌊 🌙 ⭐ ☀️ 🌈 🔥 ❄️ 🍂 🌸 🌻 🍄 ✨".split(" ").map((emoji) => ({ emoji, label: `nature ${emoji}` })) },
  { label: "Animals", choices: "🐻 🦊 🐺 🐼 🐸 🐵 🐯 🦁 🐧 🦅 🦉 🐙 🦈 🐬 🐢 🐕".split(" ").map((emoji) => ({ emoji, label: emoji === "🦊" ? "fox" : `animal ${emoji}` })) },
  { label: "Food and fun", choices: "🍜 🍣 🍕 🌮 🍔 🍓 ☕ 🧋 🎉 🎮 🎸 🏀 ⚽ 🎯 🎲".split(" ").map((emoji) => ({ emoji, label: `food or fun ${emoji}` })) }
] as const;

export function avatarEmoji(value: string | null | undefined) {
  return value || DEFAULT_AVATAR_EMOJI;
}
