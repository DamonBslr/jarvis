/**
 * Mouse/keyboard injection and window listing via JXA (osascript -l JavaScript) calling
 * CoreGraphics directly. No native module and no compiler needed: osascript ships with macOS.
 * Because Jarvis spawns osascript, macOS attributes the Accessibility permission to Jarvis.
 *
 * All coordinates here are global screen points (origin top-left of the main display), the
 * same space as Electron's `screen` module.
 */
import { execFile } from 'node:child_process'

export type InputOp =
  | { op: 'info' }
  | { op: 'windows' }
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; clicks: number; flags: number }
  | { op: 'drag'; x1: number; y1: number; x2: number; y2: number; flags: number }
  | { op: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { op: 'keys'; presses: { code: number; flags: number }[]; repeat: number }
  | { op: 'type'; text: string }

// Numeric CGEvent constants (bridged constants come back as strings in JXA, numbers are safer).
const SCRIPT = String.raw`
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*', 'unsigned long', 'void*']]);
var TAP = 0; // kCGHIDEventTap
var BTN = { left: [0, 1, 2, 6], right: [1, 3, 4, 7], middle: [2, 25, 26, 27] }; // button, down, up, dragged
function pt(x, y) { return $.CGPointMake(x, y); }
function post(e, flags) { if (flags) $.CGEventSetFlags(e, flags); $.CGEventPost(TAP, e); }
function mouse(type, x, y, button, flags) { post($.CGEventCreateMouseEvent(null, type, pt(x, y), button), flags); }
function key(code, down, flags) { post($.CGEventCreateKeyboardEvent(null, code, down), flags || 0); }
function press(code, flags) { key(code, true, flags); delay(0.012); key(code, false, flags); delay(0.012); }
function uni(s) {
  var data = $(s).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
  var n = Number(data.length) / 2;
  [true, false].forEach(function (down) {
    var e = $.CGEventCreateKeyboardEvent(null, 0, down);
    $.CGEventKeyboardSetUnicodeString(e, n, data.bytes);
    $.CGEventPost(TAP, e);
  });
  delay(0.01);
}
function typeText(text) {
  var chunk = '';
  var flush = function () { if (chunk) { uni(chunk); chunk = ''; } };
  for (var ch of text) { // iterates code points, so surrogate pairs stay together
    if (ch === '\n') { flush(); press(36, 0); continue; }
    if (ch === '\r') continue;
    if (ch === '\t') { flush(); press(48, 0); continue; }
    if (chunk.length + ch.length > 16) flush();
    chunk += ch;
  }
  flush();
}
function cursor() { var p = $.CGEventGetLocation($.CGEventCreate(null)); return { x: p.x, y: p.y }; }
function run(argv) {
  var a = JSON.parse(argv[0]);
  switch (a.op) {
    case 'info': {
      var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      return JSON.stringify({ frontmost: app.isNil() ? null : app.localizedName.js, cursor: cursor() });
    }
    case 'windows': {
      var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
      var app2 = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      return JSON.stringify({
        frontmost: app2.isNil() ? null : app2.localizedName.js,
        windows: list.filter(function (w) { return w.kCGWindowLayer === 0 && w.kCGWindowAlpha !== 0; }).map(function (w) {
          var b = w.kCGWindowBounds || {};
          return { app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '', x: b.X, y: b.Y, width: b.Width, height: b.Height };
        })
      });
    }
    case 'move': mouse(5, a.x, a.y, 0, 0); return 'ok';
    case 'click': {
      var b = BTN[a.button];
      mouse(5, a.x, a.y, 0, a.flags); delay(0.04);
      for (var i = 1; i <= a.clicks; i++) {
        var down = $.CGEventCreateMouseEvent(null, b[1], pt(a.x, a.y), b[0]);
        var up = $.CGEventCreateMouseEvent(null, b[2], pt(a.x, a.y), b[0]);
        $.CGEventSetIntegerValueField(down, 1, i); $.CGEventSetIntegerValueField(up, 1, i); // kCGMouseEventClickState
        post(down, a.flags); delay(0.02); post(up, a.flags); delay(0.05);
      }
      return 'ok';
    }
    case 'drag': {
      mouse(5, a.x1, a.y1, 0, a.flags); delay(0.05);
      mouse(1, a.x1, a.y1, 0, a.flags); delay(0.08);
      var steps = 20;
      for (var s = 1; s <= steps; s++) {
        mouse(6, a.x1 + (a.x2 - a.x1) * s / steps, a.y1 + (a.y2 - a.y1) * s / steps, 0, a.flags); delay(0.015);
      }
      delay(0.05); mouse(2, a.x2, a.y2, 0, a.flags);
      return 'ok';
    }
    case 'scroll': {
      mouse(5, a.x, a.y, 0, 0); delay(0.04);
      // One event per line feels like a real wheel and works in apps that ignore large deltas.
      var n2 = Math.max(Math.abs(a.dy), Math.abs(a.dx));
      for (var j = 0; j < n2; j++) {
        $.CGEventPost(TAP, $.CGEventCreateScrollWheelEvent2(null, 1, 2, j < Math.abs(a.dy) ? Math.sign(a.dy) : 0, j < Math.abs(a.dx) ? Math.sign(a.dx) : 0, 0));
        delay(0.01);
      }
      return 'ok';
    }
    case 'keys':
      for (var r = 0; r < a.repeat; r++) a.presses.forEach(function (p) { press(p.code, p.flags); delay(0.03); });
      return 'ok';
    case 'type': typeText(a.text); return 'ok';
  }
  throw new Error('unknown op ' + a.op);
}
`

/** Run one input op. Rejects with osascript's error text (e.g. when a call times out). */
export function runInput<T = string>(op: InputOp, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(op)],
      { timeout: timeoutMs, maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().replace(/^.*execution error: /, '')))
        const out = stdout.trim()
        if (op.op === 'info' || op.op === 'windows') {
          try {
            return resolve(JSON.parse(out) as T)
          } catch {
            return reject(new Error(`unexpected osascript output: ${out.slice(0, 200)}`))
          }
        }
        resolve(out as T)
      }
    )
  })
}
