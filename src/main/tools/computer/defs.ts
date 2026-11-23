/**
 * Computer-use tool definitions, shared by the stdio bridge (tools/list) and the Jarvis main
 * process (allowedTools + execution). Pure data: no Electron imports, the bridge bundles this.
 *
 * Coordinates are always in pixels of the most recent full screenshot taken in the same run;
 * the main process maps them back to screen points.
 */

export interface ComputerToolDef {
  name: string
  description: string
  inputSchema: object
  /** Pure reads (no input injected, nothing launched): pre-approved for Claude, available in every autonomy. */
  readOnly: boolean
}

const num = (description: string) => ({ type: 'number', description })
const XY = { x: num('X in screenshot pixels'), y: num('Y in screenshot pixels') }
const MODIFIERS = {
  type: 'string',
  description: 'Modifier keys held during the action, joined with "+", e.g. "cmd" or "cmd+shift"'
}

export const COMPUTER_TOOLS: ComputerToolDef[] = [
  {
    name: 'screenshot',
    readOnly: true,
    description:
      "Take a screenshot of the user's screen. Always do this before clicking or typing, and again after acting to check the result. " +
      'All x/y coordinates for other computer tools refer to pixels in the most recent full screenshot. ' +
      'Pass `region` (in screenshot pixels) to get a zoomed-in, higher-detail view of part of the screen; zoomed views do not change the coordinate space.',
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'integer', description: 'Display number (1 = main display). Defaults to the last one used.' },
        region: {
          type: 'object',
          description: 'Optional area to zoom into, in pixels of the last full screenshot',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height']
        }
      }
    }
  },
  {
    name: 'list_windows',
    readOnly: true,
    description:
      'List visible windows (app, title, bounds in screenshot pixels when on the current display) and the frontmost app.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'click',
    readOnly: false,
    description: 'Move the mouse to a point and click. Use clicks=2 for a double-click, button="right" for a context menu.',
    inputSchema: {
      type: 'object',
      properties: {
        ...XY,
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, description: 'Defaults to 1' },
        modifiers: MODIFIERS
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'move',
    readOnly: false,
    description: 'Move the mouse pointer without clicking (e.g. to reveal a hover menu or tooltip).',
    inputSchema: { type: 'object', properties: XY, required: ['x', 'y'] }
  },
  {
    name: 'drag',
    readOnly: false,
    description: 'Press the left mouse button at one point, drag to another and release.',
    inputSchema: {
      type: 'object',
      properties: {
        from_x: num('Start X in screenshot pixels'),
        from_y: num('Start Y in screenshot pixels'),
        to_x: num('End X in screenshot pixels'),
        to_y: num('End Y in screenshot pixels'),
        modifiers: MODIFIERS
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y']
    }
  },
  {
    name: 'scroll',
    readOnly: false,
    description: 'Scroll at a point (the content under that point scrolls).',
    inputSchema: {
      type: 'object',
      properties: {
        ...XY,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 50, description: 'Lines to scroll, defaults to 5' }
      },
      required: ['x', 'y', 'direction']
    }
  },
  {
    name: 'type_text',
    readOnly: false,
    description:
      'Type text into the focused app as if from the keyboard (any Unicode; "\\n" presses Return). Click the target field first.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'key',
    readOnly: false,
    description:
      'Press a key or key combination, e.g. "return", "esc", "tab", "cmd+c", "cmd+shift+t", "down". ' +
      'Several combos separated by spaces are pressed in order ("cmd+a cmd+c").',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string' },
        repeat: { type: 'integer', minimum: 1, maximum: 50, description: 'Press the whole sequence this many times (default 1)' }
      },
      required: ['keys']
    }
  },
  {
    name: 'open_app',
    readOnly: false,
    description: 'Launch an app, or bring it to the front if it is already running (name like "Safari" or a bundle id).',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] }
  }
]

export const COMPUTER_SERVER = 'computer'

export const computerTool = (name: string) => COMPUTER_TOOLS.find((t) => t.name === name)

/**
 * How a run may use computer actions (enforced in the main process, not just by tool listing):
 *  - read:    screenshots / window list only
 *  - prompt:  actions allowed; the agent CLI asks the user first (Claude --permission-prompt-tool)
 *  - confirm: actions allowed after Jarvis itself shows an approval popup (Codex has no prompt hook)
 *  - free:    actions run without asking ("Full access" autonomy)
 */
export type ComputerMode = 'read' | 'prompt' | 'confirm' | 'free'
