/**
 * Capture README feature screenshots from the browser demo.
 *
 * Prerequisites:
 *   pnpm exec vite --host 127.0.0.1 --port 5173
 *   npx playwright install chromium
 *
 * Usage:
 *   pnpm exec vite --host 127.0.0.1 --port 5173
 *   pnpm screenshots:readme
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "images");
const BASE = "http://127.0.0.1:5173/?demo=1";
const VIEWPORT = { width: 1680, height: 960 };
// 1x captures keep README previews reliable; width must fit the sync toolbar.

async function shot(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.waitForTimeout(options.settle ?? 250);
  await page.screenshot({
    path: file,
    type: name.endsWith(".jpg") ? "jpeg" : "png",
    quality: name.endsWith(".jpg") ? 92 : undefined,
    animations: "disabled",
  });
  console.log("wrote", path.relative(ROOT, file));
}

async function expandSidebar(page) {
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  if (await expand.count()) await expand.click();
}

function compareButton(page) {
  return page.getByRole("button", { name: "Compare directories", exact: true });
}

async function connectProduction(page) {
  // Demo auto-opens the first session; wait for the dual pane.
  await compareButton(page).waitFor({ timeout: 15_000 });
  await expandSidebar(page);
}

async function openSettings(page, category) {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: category }).click();
  await page.waitForTimeout(200);
}

async function closeSettings(page) {
  const back = page.getByRole("button", { name: /Back|Close settings|Return/i }).first();
  if (await back.count()) {
    await back.click();
  } else {
    await page.keyboard.press("Escape");
  }
  await compareButton(page).waitFor({ timeout: 10_000 });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const page = await context.newPage();

  // --- Hero / main dual-pane ---
  await page.goto(BASE, { waitUntil: "networkidle" });
  await connectProduction(page);
  await shot(page, "siftlane-app.png", { settle: 400 });

  // --- Profile organization (sidebar folders/tags) ---
  await expandSidebar(page);
  await page.getByPlaceholder("Search profiles").fill("");
  await shot(page, "profile-organization.png");

  // --- Directory comparison ---
  await compareButton(page).click();
  await page.getByText("differences", { exact: false }).waitFor();
  await shot(page, "directory-comparison.png");

  // --- Sync review ---
  await page.getByRole("button", { name: "Synchronize…", exact: true }).click();
  await page.getByRole("dialog", { name: "Review synchronization" }).waitFor();
  await shot(page, "sync-review.png");
  await page.getByRole("dialog", { name: "Review synchronization" }).getByRole("button", { name: "Close" }).click();

  // --- Multi-selection + queue ---
  // Cmd-click a few local files
  const localRows = page.locator('[data-pane-side="local"] .file-row');
  await localRows.nth(5).click(); // .gitignore
  await localRows.nth(6).click({ modifiers: ["Meta"] }); // about.html
  await localRows.nth(7).click({ modifiers: ["Meta"] }); // contact.html
  await shot(page, "multi-selection-queue.png");

  // --- Transfer queue details ---
  await page.locator('.transfer-row button[title="Details"]').first().click();
  await page.getByLabel("Transfer details").waitFor();
  await shot(page, "transfer-queue-details.png");
  await page.getByRole("button", { name: "Close details" }).click();

  // Turn comparison off for cleaner later shots
  await page.getByRole("button", { name: "Comparison on" }).click();

  // --- Native file drop preview ---
  await page.goto(`${BASE}&dropPreview=1`, { waitUntil: "networkidle" });
  await connectProduction(page);
  await page.getByText("Drop 2 items from your computer").waitFor();
  // Collapse sidebar so the drop target is the focus
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  if (await collapse.count()) await collapse.click();
  await shot(page, "native-file-drop.png");

  // --- External editor review ---
  await page.goto(BASE, { waitUntil: "networkidle" });
  await connectProduction(page);
  const remoteFile = page.locator('[data-pane-side="remote"] .file-row').filter({ hasText: "about.html" });
  await remoteFile.click({ button: "right" });
  await page.getByRole("button", { name: "Edit in external editor" }).click();
  await page.getByRole("dialog", { name: "Review external edit" }).waitFor({ timeout: 10_000 });
  await shot(page, "native-external-edit-review.png");
  await page.locator("button.secondary", { hasText: "Keep editing" }).click();

  // --- Remote-to-remote: open second session ---
  await expandSidebar(page);
  await page.locator("button.connection-open", { hasText: "Staging" }).click();
  await page.locator("button.session-tab", { hasText: "Staging" }).waitFor({ timeout: 10_000 });
  // Switch back to Production
  await page.locator("button.session-tab", { hasText: "Production" }).click();
  await page.waitForTimeout(300);
  const remoteFile2 = page.locator('[data-pane-side="remote"] .file-row').filter({ hasText: "index.html" });
  await remoteFile2.click();
  await page.getByRole("button", { name: "Copy to session…", exact: true }).click();
  await page.getByRole("dialog", { name: /Copy between remote sessions/i }).waitFor();
  await shot(page, "remote-to-remote-route.jpg");
  await page.getByRole("button", { name: "Start remote copy" }).click();
  await page.waitForTimeout(500);
  await shot(page, "remote-to-remote-queue.jpg");

  // --- Enterprise SSH profile (Staging has ProxyJump) ---
  await expandSidebar(page);
  await page.getByRole("button", { name: "Edit Staging" }).click();
  await page.getByText("ProxyJump").waitFor();
  await page.locator("text=ProxyJump / bastion").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await shot(page, "enterprise-ssh-profile.png");
  await page.locator("button.secondary", { hasText: "Cancel" }).click();

  // --- Settings: bandwidth ---
  await openSettings(page, "Transfers");
  await page.locator("#settings-upload-limit").fill("512");
  await page.locator("#settings-download-limit").fill("1024");
  const addSchedule = page.getByRole("button", { name: /Add .*unlimited/i });
  if (await addSchedule.count()) await addSchedule.click();
  await page.locator("#settings-upload-limit").blur();
  await shot(page, "bandwidth-settings.png");

  // --- Trusted hosts ---
  await page.getByRole("button", { name: "Trusted hosts" }).click();
  await page.waitForTimeout(200);
  await shot(page, "trusted-host-management.png");

  // --- Portable configuration ---
  await page.getByRole("button", { name: "Profiles & data" }).click();
  await page.waitForTimeout(200);
  await shot(page, "portable-configuration.png");

  // --- Encrypted export passphrase ---
  await page.getByRole("button", { name: /Export encrypted/i }).click();
  await page.locator(".configuration-passphrase-dialog, [role='dialog']").first().waitFor();
  await shot(page, "encrypted-configuration-export.png");

  await browser.close();
  console.log("done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
