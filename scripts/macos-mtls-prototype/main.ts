/** Isolated feasibility harness. Production Bitwarden state and Keychain ACLs are untouched. */
import { app, BrowserWindow, ipcMain, session, type Certificate } from "electron";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  normalizeEndpoint,
  normalizeChallengeEndpoint,
} from "../../apps/desktop/src/platform/main/mtls/endpoint";
import { selectOfferedIdentity } from "../../apps/desktop/src/platform/main/mtls/selection";
import { classifyMtlsError } from "../../apps/desktop/src/platform/main/mtls/diagnosis";
import { completeCertificateSelection } from "../../apps/desktop/src/platform/main/mtls/certificate-callback";

const args = process.argv.slice(2);
function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const automatic = args.includes("--automatic");
const expectedFingerprint = argument("--fingerprint");
if (expectedFingerprint && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
  throw new Error("invalid-fingerprint");
}
const uiUrl = pathToFileURL(join(__dirname, "index.html")).href;
process.on("uncaughtException", () => {
  // Avoid an OS modal dialog that prevents the automatic probe deadline.
  console.error("probe-uncaught-exception");
  app.exit(1);
});
app.setPath("userData", mkdtempSync(join(tmpdir(), "bw-mtls-probe-")));
app.setName("Bitwarden mTLS feasibility probe");

let win: BrowserWindow;
let active:
  | {
      endpoint: string;
      probeId: string;
      started: number;
      offered: number;
      matchingOffers?: number;
      selected?: string;
      networkError?: string;
      selectionError?: string;
    }
  | undefined;
let pending:
  { choices: Map<string, Certificate>; complete: (cert?: Certificate) => void } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let completed = false;

function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  return (
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url === uiUrl
  );
}
function finish(result: Record<string, unknown>): void {
  if (!active || completed) {
    return;
  }
  completed = true;
  clearTimeout(timer);
  pending?.complete();
  pending = undefined;
  const report = {
    ...active,
    ...result,
    elapsedMs: Date.now() - active.started,
    privateKeyExported: false,
    permissionsChanged: false,
  };
  win.webContents.send("probe.result", report);
  // Only public fingerprint, destination and bounded typed statuses, never raw response/URL.
  console.log(JSON.stringify(report));
  if (automatic) {
    setTimeout(async () => {
      if (args.includes("--screenshot")) {
        const screenshot = join(app.getPath("userData"), "result.png");
        writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG(), { mode: 0o600 });
        console.log(JSON.stringify({ screenshot }));
      }
      await win.webContents.session.closeAllConnections();
      app.quit();
    }, 200);
  }
}

app.on("select-client-certificate", (event, contents, url, offered, callback) => {
  event.preventDefault();
  let called = false;
  const complete = (cert?: Certificate) => {
    if (!called) {
      called = true;
      completeCertificateSelection(callback, cert);
    }
    if (pending?.complete === complete) {
      pending = undefined;
    }
  };
  let endpoint: string;
  try {
    endpoint = normalizeChallengeEndpoint(String(url));
  } catch {
    complete();
    return;
  }
  if (
    !active ||
    completed ||
    contents !== win.webContents ||
    endpoint !== active.endpoint ||
    pending
  ) {
    complete();
    return;
  }
  active.offered = offered.length;
  const choices = new Map<string, Certificate>();
  const rows: Record<string, unknown>[] = [];
  for (const candidate of offered.slice(0, 128)) {
    try {
      const cert = new X509Certificate(candidate.data);
      const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
      const id = randomUUID();
      choices.set(id, candidate);
      rows.push({
        id,
        fingerprint,
        subject: cert.subject.slice(0, 512),
        issuer: cert.issuer.slice(0, 512),
        notBefore: cert.validFrom,
        notAfter: cert.validTo,
      });
    } catch {
      /* Malformed candidates cannot become selections. */
    }
  }
  pending = { choices, complete };
  active.matchingOffers = expectedFingerprint
    ? rows.filter((row) => row.fingerprint === expectedFingerprint).length
    : undefined;
  win.webContents.send("probe.candidates", rows);
  if (automatic) {
    const entry = rows.find((row) => row.fingerprint === expectedFingerprint);
    if (entry) {
      choose(String(entry.id));
    } else {
      active.selectionError = expectedFingerprint
        ? "identity-not-offered"
        : "no-certificate-selected";
      complete();
    }
  } else if (choices.size === 0) {
    active.selectionError = "no-offered-identity";
    complete();
  }
});

function choose(id: string): void {
  if (!active || !pending || completed) {
    throw new Error("no-live-challenge");
  }
  const candidate = pending.choices.get(id);
  if (!candidate) {
    throw new Error("invalid-candidate");
  }
  const cert = new X509Certificate(candidate.data);
  const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
  const configuration = {
    bindings: { [active.endpoint]: fingerprint },
    identities: { [fingerprint]: { notBefore: cert.validFrom, notAfter: cert.validTo } },
  };
  const selection = selectOfferedIdentity(configuration, `https://${active.endpoint}`, [candidate]);
  active.selected = selection.certificate ? fingerprint : undefined;
  active.selectionError = selection.error;
  pending.complete(selection.certificate);
}

function start(input: unknown): void {
  if (active) {
    throw new Error("restart-probe-for-new-connection");
  }
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("invalid-endpoint");
  }
  const url = new URL(input);
  const endpoint = normalizeEndpoint(input);
  if (url.protocol !== "https:" || url.search || url.hash) {
    throw new Error("invalid-endpoint");
  }
  active = { endpoint, probeId: randomUUID(), started: Date.now(), offered: 0 };
  timer = setTimeout(() => finish({ outcome: "timeout" }), 20_000);
  win.webContents.send("probe.fetch", { url: url.href, probeId: active.probeId });
}

app
  .whenReady()
  .then(async () => {
    const managed = session.fromPartition(`probe-${randomUUID()}`, { cache: false });
    managed.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    managed.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.startsWith("file:")) {
        callback({
          cancel: !["index.html", "renderer.js"].some(
            (name) => details.url === pathToFileURL(join(__dirname, name)).href,
          ),
        });
        return;
      }
      let allowed = false;
      try {
        allowed =
          !!active &&
          !completed &&
          normalizeEndpoint(details.url) === active.endpoint &&
          details.webContentsId === win.webContents.id;
      } catch {
        /* Unsupported destination. */
      }
      callback({ cancel: !allowed });
    });
    managed.webRequest.onErrorOccurred((details) => {
      if (
        !active ||
        completed ||
        details.webContentsId !== win.webContents.id ||
        details.resourceType !== "xhr"
      ) {
        return;
      }
      try {
        if (normalizeEndpoint(details.url) === active.endpoint) {
          active.networkError = details.error.slice(0, 128);
          finish({ outcome: classifyMtlsError(details.error) });
        }
      } catch {
        /* Local UI and refused redirects do not establish a TLS cause. */
      }
    });
    win = new BrowserWindow({
      width: 850,
      height: 700,
      show: !automatic,
      webPreferences: {
        session: managed,
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("closed", () => {
      clearTimeout(timer);
      pending?.complete();
      app.quit();
    });
    ipcMain.handle("probe.start", (event, url) => {
      if (!trusted(event)) {
        throw new Error("untrusted-sender");
      }
      start(url);
    });
    ipcMain.handle("probe.choose", (event, id) => {
      if (!trusted(event) || typeof id !== "string") {
        throw new Error("invalid-selection");
      }
      choose(id);
    });
    ipcMain.handle("probe.cancel", (event) => {
      if (!trusted(event)) {
        throw new Error("untrusted-sender");
      }
      finish({ outcome: "cancelled" });
    });
    ipcMain.handle("probe.response", (event, result) => {
      if (!trusted(event) || !active || !result || result.probeId !== active.probeId) {
        throw new Error("invalid-result");
      }
      const allowed = [
        "config-received",
        "unexpected-response",
        "response-too-large",
        "http-error",
        "connection-failed",
      ];
      if (!allowed.includes(result.outcome)) {
        throw new Error("invalid-outcome");
      }
      // Give Chromium's concrete error event precedence over generic renderer failures.
      if (result.outcome === "connection-failed") {
        setTimeout(
          () =>
            finish({
              outcome: active?.networkError
                ? classifyMtlsError(active.networkError)
                : "connection-failed",
            }),
          100,
        );
      } else {
        finish({
          outcome: result.outcome,
          httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : undefined,
        });
      }
    });
    await win.loadURL(uiUrl);
    if (automatic) {
      start(argument("--url") ?? "https://bitwarden.jans.space/api/config");
    }
  })
  .catch(() => {
    console.error("probe-startup-failed");
    app.exit(1);
  });
