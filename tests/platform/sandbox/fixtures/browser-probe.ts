const { chromium } = await import(process.argv[2]!);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<title>worker-browser-ok</title><h1>Browser works</h1>");
  await page.screenshot({ path: "screenshot.png" });
  console.log(await page.title());
} finally {
  await browser.close();
}
console.log("browser-closed");

export {};
