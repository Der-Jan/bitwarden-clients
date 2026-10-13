const status = document.getElementById("status");
const result = document.getElementById("result");
const candidates = document.getElementById("candidates");
let controller;
document.getElementById("start").addEventListener("click", async () => {
  try {
    await window.probe.start(document.getElementById("url").value);
    document.getElementById("start").disabled = true;
    status.textContent = "TLS-Verbindung wird geprüft …";
  } catch {
    status.textContent = "Ungültige Adresse oder Test bereits gestartet. Bitte App neu starten.";
  }
});
document.getElementById("cancel").addEventListener("click", () => window.probe.cancel());
window.probe.onCandidates((rows) => {
  candidates.replaceChildren();
  status.textContent = rows.length
    ? "Client-Identität auswählen. macOS kann separat den Schlüsselzugriff anfragen."
    : "Keine passende Client-Identität angeboten.";
  for (const row of rows) {
    const item = document.createElement("li");
    const description = document.createElement("div");
    description.textContent = `${row.subject}\nAussteller: ${row.issuer}\nGültig: ${row.notBefore} – ${row.notAfter}\nSHA-256: ${row.fingerprint}`;
    description.style.whiteSpace = "pre-wrap";
    const button = document.createElement("button");
    button.textContent = "Diese Identität verwenden";
    button.addEventListener("click", async () => {
      try {
        await window.probe.choose(row.id);
        candidates.replaceChildren();
        status.textContent = "TLS-Signatur und Serverantwort werden geprüft …";
      } catch {
        status.textContent = "Auswahl nicht mehr gültig. Bitte App neu starten.";
      }
    });
    item.append(description, button);
    candidates.append(item);
  }
});
window.probe.onResult((report) => {
  controller?.abort();
  candidates.replaceChildren();
  const labels = {
    "local-signing-failed":
      "Lokale TLS-Signatur fehlgeschlagen. Keychain-Zugriffsrechte prüfen; ein Partition-Konflikt ist damit allein nicht bewiesen.",
    "private-key-access-denied": "Zugriff auf den privaten Schlüssel verweigert.",
    "config-received": "TLS erfolgreich; Bitwarden-Konfiguration empfangen.",
    "server-trust-failed": "Serverzertifikat konnte nicht validiert werden.",
    cancelled: "Test abgebrochen.",
    timeout: "Zeitlimit erreicht.",
  };
  status.textContent = labels[report.outcome] ?? `Ergebnis: ${report.outcome}`;
  result.textContent = JSON.stringify(report, null, 2);
});
window.probe.onFetch(async ({ url, probeId }) => {
  controller = new AbortController();
  let outcome = "connection-failed";
  let httpStatus;
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      outcome = "http-error";
      await response.body?.cancel();
    } else {
      const reader = response.body?.getReader();
      const chunks = [];
      let total = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          total += value.length;
          if (total > 65536) {
            outcome = "response-too-large";
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
      if (outcome !== "response-too-large") {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        outcome = "unexpected-response";
        try {
          const config = JSON.parse(new TextDecoder().decode(body));
          if (
            config &&
            typeof config === "object" &&
            typeof config.version === "string" &&
            config.environment &&
            typeof config.environment === "object"
          ) {
            outcome = "config-received";
          }
        } catch {
          /* Never forward raw response content. */
        }
      }
    }
  } catch {
    /* Main-process network error gives the more precise cause. */
  }
  await window.probe.response({ probeId, outcome, httpStatus });
});
