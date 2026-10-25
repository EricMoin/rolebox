import { serve } from "../../helpers/http-server.ts";

/**
 * The local site the gated `browse_*` live suite drives.
 *
 * It is a real HTTP server on an ephemeral 127.0.0.1 port rather than a `data:`
 * URL, because the live suite must exercise what a browser only does over the
 * network: a failing request and a 404 in the network buffer, a download that
 * lands in `.rolebox/browse/downloads`, and a second document reached by a link
 * so history has somewhere to go back to.
 *
 * Everything the tools must observe is on one page so a single navigation fills
 * the console and network buffers:
 *
 * - a heading and an intro paragraph (snapshot/read material);
 * - a form with a labelled text input and a submit button (type + Enter submit);
 * - a labelled `<select>` (browse_select);
 * - a button that changes the DOM (browse_click) and a `confirm()` button
 *   (browse_dialog);
 * - a download link and a file input (browse_downloads / browse_upload);
 * - a `target="_blank"` link, present as a documented gap: the family does not
 *   adopt popup pages, so no test clicks it;
 * - `console.log`/`console.error` at parse time and two fetches — one to a 404
 *   path and one to a closed port — whose outcomes are written into the DOM so
 *   `browse_wait` can await them before the buffers are read.
 */

/** A running fixture site. */
export interface FixtureSite {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** The path of the second document. */
export const FIXTURE_SECOND_PATH = "/second";

/** The path the page fetches to record a 404 response. */
export const FIXTURE_MISSING_PATH = "/missing";

/** The path whose link downloads a file. */
export const FIXTURE_DOWNLOAD_PATH = "/file.txt";

/** A port nothing listens on, so the page's fetch fails at the transport layer. */
export const FIXTURE_CLOSED_URL = "http://127.0.0.1:45999/closed";

const HOME_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture home</title></head>
<body>
  <h1>Fixture home</h1>
  <p id="intro">A local page for the browse live suite.</p>
  <p><a id="second-link" href="${FIXTURE_SECOND_PATH}">Second page</a></p>
  <form id="form" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted:'+document.getElementById('name').value;">
    <label for="name">Name</label>
    <input id="name" name="name" placeholder="Your name">
    <button id="apply" type="submit">Apply</button>
  </form>
  <p><output id="out">idle</output></p>
  <label for="plan">Plan</label>
  <select id="plan" aria-label="Plan">
    <option value="free">Free</option>
    <option value="pro">Pro</option>
  </select>
  <p><button id="clicker" onclick="document.getElementById('out').textContent='clicked'">Click me</button></p>
  <p><button id="confirm" onclick="window.confirm('Proceed?')">Confirm</button></p>
  <p><a id="download" href="${FIXTURE_DOWNLOAD_PATH}" download="fixture.txt">Download</a></p>
  <p><input id="upload" type="file" aria-label="Attachment"></p>
  <p><a id="popup" href="${FIXTURE_SECOND_PATH}" target="_blank">Open the second page in a new window</a></p>
  <div id="fetch-status">fetch-pending</div>
  <div id="closed-status">closed-pending</div>
  <script>
    console.log('fixture-log');
    console.error('fixture-error');
    fetch('${FIXTURE_MISSING_PATH}')
      .then(function (response) {
        document.getElementById('fetch-status').textContent = 'missing:' + response.status;
      })
      .catch(function () {
        document.getElementById('fetch-status').textContent = 'missing:failed';
      });
    fetch('${FIXTURE_CLOSED_URL}')
      .catch(function () {
        document.getElementById('closed-status').textContent = 'closed:failed';
      });
  </script>
</body>
</html>`;

const SECOND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Second page</title></head>
<body>
  <h1>Second page</h1>
  <p><a id="back" href="/">Back home</a></p>
</body>
</html>`;

/** The bytes the download link serves. */
export const FIXTURE_DOWNLOAD_BODY = "rolebox fixture download\n";

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Start the fixture server on an ephemeral loopback port. */
export async function startFixtureSite(): Promise<FixtureSite> {
  const server = await serve((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/") return htmlResponse(HOME_HTML);
      if (path === FIXTURE_SECOND_PATH) return htmlResponse(SECOND_HTML);
      if (path === FIXTURE_DOWNLOAD_PATH) {
        return new Response(FIXTURE_DOWNLOAD_BODY, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": 'attachment; filename="fixture.txt"',
          },
        });
      }
      return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    async close() {
      await server.stop(true);
    },
  };
}
