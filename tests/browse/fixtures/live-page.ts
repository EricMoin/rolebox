/**
 * The data: URL page the gated live suite drives.
 *
 * It is a string fixture on purpose: the live test must not depend on a file
 * server or the network, and a data: URL renders identically in every Playwright
 * browser. The page contains one of each control the smoke test needs — a
 * heading, a button that changes the DOM, a labelled text input and a select.
 */

export const LIVE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Browse live</title></head>
<body>
  <h1>Live page</h1>
  <button id="go" onclick="document.getElementById('out').textContent='clicked'">Run</button>
  <output id="out">waiting</output>
  <label for="name">Name</label>
  <input id="name" placeholder="Your name">
  <select aria-label="Pick" id="pick">
    <option value="a">Alpha</option>
    <option value="b">Beta</option>
  </select>
  <div id="editor" contenteditable="true" tabindex="0">Editable text</div>
  <a href="/docs">Docs</a>
  <iframe title="frame" src="about:blank"></iframe>
  <input type="hidden" value="hidden-value">
  <div style="display:none">invisible text</div>
  <span style="visibility:hidden">hidden span</span>
  <div aria-hidden="true"><button>hidden button</button></div>
</body>
</html>`;

/** The page above as a data: URL Playwright can navigate to without a network. */
export function livePageUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(LIVE_PAGE_HTML)}`;
}

/** A page whose button opens a native confirm() dialog. */
export const LIVE_DIALOG_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Browse dialog</title></head>
<body>
  <h1>Dialog page</h1>
  <button id="confirm" onclick="window.confirm('Proceed?')">Confirm</button>
</body>
</html>`;

/** The dialog page above as a data: URL. */
export function liveDialogUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(LIVE_DIALOG_HTML)}`;
}
