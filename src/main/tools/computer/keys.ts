/**
 * Key-combo parsing for the `key` tool: "cmd+shift+t" -> macOS virtual key code + CGEvent flags.
 * Key codes are physical positions on an ANSI (US) keyboard; on other layouts letter shortcuts
 * hit the key at the US position.
 */

export const FLAGS = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000, fn: 0x800000 } as const

const MODIFIER_ALIASES: Record<string, keyof typeof FLAGS> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  fn: 'fn'
}

const KEYS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  return: 36, enter: 36, tab: 48, space: 49, ' ': 49, backspace: 51, delete: 51, escape: 53, esc: 53,
  forwarddelete: 117, del: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, kpenter: 76, keypadenter: 76, capslock: 57,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  plus: 24, equal: 24, equals: 24, minus: 27, comma: 43, period: 47, slash: 44, backslash: 42,
  semicolon: 41, quote: 39, apostrophe: 39, grave: 50, backtick: 50, bracketleft: 33, bracketright: 30,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126
}

export interface KeyPress {
  code: number
  flags: number
  label: string
}

/** Parse "cmd+a cmd+c" into key presses. Throws with a helpful message on unknown keys. */
export function parseKeys(input: string): KeyPress[] {
  const combos = input.trim().split(/\s+/).filter(Boolean)
  if (!combos.length) throw new Error('keys is empty')
  if (combos.length > 20) throw new Error('at most 20 key combos per call')
  return combos.map((combo) => {
    // Allow a literal "+" as the key: "cmd++" -> ["cmd", "+"].
    const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), 'plus'] : combo.split('+')
    let flags = 0
    let code: number | undefined
    for (const raw of parts) {
      const p = raw.toLowerCase().replace(/_/g, '')
      if (!p) throw new Error(`bad key combo "${combo}"`)
      const mod = MODIFIER_ALIASES[p]
      if (mod) {
        flags |= FLAGS[mod]
        continue
      }
      if (code !== undefined) throw new Error(`"${combo}" has more than one non-modifier key`)
      code = KEYS[p] ?? KEYS[raw]
      if (code === undefined) throw new Error(`unknown key "${raw}" in "${combo}"`)
    }
    // A bare modifier ("shift") is pressed as that modifier key.
    if (code === undefined) {
      const MOD_CODES: Record<number, number> = { [FLAGS.cmd]: 55, [FLAGS.shift]: 56, [FLAGS.alt]: 58, [FLAGS.ctrl]: 59, [FLAGS.fn]: 63 }
      code = MOD_CODES[flags]
      if (code === undefined) throw new Error(`"${combo}" has no key to press`)
    }
    return { code, flags, label: combo }
  })
}

/** Modifier list for mouse actions ("cmd+shift") -> CGEvent flags. */
export function parseModifiers(input: unknown): number {
  if (input === undefined || input === null || input === '') return 0
  if (typeof input !== 'string') throw new Error('modifiers must be a string like "cmd+shift"')
  let flags = 0
  for (const raw of input.split(/[+\s,]+/).filter(Boolean)) {
    const mod = MODIFIER_ALIASES[raw.toLowerCase()]
    if (!mod) throw new Error(`unknown modifier "${raw}" (use cmd, ctrl, alt/option, shift, fn)`)
    flags |= FLAGS[mod]
  }
  return flags
}
