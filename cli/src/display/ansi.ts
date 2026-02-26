/** Zero-dependency ANSI escape code helpers */

// Cursor
export const cursorTo = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;
export const cursorUp = (n: number) => `\x1b[${n}A`;
export const cursorHide = "\x1b[?25l";
export const cursorShow = "\x1b[?25h";
export const cursorSave = "\x1b7";
export const cursorRestore = "\x1b8";

// Screen
export const clearScreen = "\x1b[2J";
export const clearLine = "\x1b[2K";
export const clearToEol = "\x1b[K";
export const clearDown = "\x1b[J";

// Colors (foreground)
export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const dim = "\x1b[2m";
export const white = "\x1b[37m";
export const gray = "\x1b[90m";
export const green = "\x1b[32m";
export const yellow = "\x1b[33m";
export const cyan = "\x1b[36m";
export const red = "\x1b[31m";
export const magenta = "\x1b[35m";
export const blue = "\x1b[34m";
export const brightWhite = "\x1b[97m";
export const brightCyan = "\x1b[96m";
export const brightGreen = "\x1b[92m";
export const brightYellow = "\x1b[93m";

// Background
export const bgBlack = "\x1b[40m";

// Helpers
export const color = (fg: string, text: string) => `${fg}${text}${reset}`;
