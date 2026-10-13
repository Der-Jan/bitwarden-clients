# Status macOS mTLS

Stand: 13. Oktober 2026. Das Konzept und ein isolierter Machbarkeitsprototyp sind umgesetzt. Zertifikatsauswahl und Fehlerdiagnose funktionieren; eine erfolgreiche mTLS-Authentifizierung mit der vorhandenen Client-Identität wurde noch nicht erreicht. Die Integration in die produktive Bitwarden-Desktop-App steht aus.

## Ziel und Arbeitsstand

Die macOS-App soll beim Einrichten eines Self-hosted-Servers eine bestehende Keychain-Identität auswählen und die tatsächliche TLS-Verbindung prüfen. Private Schlüssel bleiben im Schlüsselbund. Lokale Signaturfehler sollen bereits bei der Einrichtung verständlich erscheinen.

- Repository: `/Users/riechers/Documents/src/bitwarden-clients`.
- Aktueller Branch: `docs/macos-keychain-mtls`, auf Basis von `main` angelegt.
- Konzept-Commit: `4980e92a26` — `docs(desktop): design macOS Keychain mTLS with shared Flatpak architecture`.
- Prototyp-Commit: `8394686c39` — `feat(desktop): prototype macOS Keychain mTLS selection and diagnostics`.
- Die Commits sind lokal; der Branch wurde in dieser Sitzung nicht gepusht.
- Diese Zusammenfassung ist eine zusätzliche Datei nach den beiden Commits.

## Dokumentation und Quellcode

- [Konzept](apps/desktop/mtls-macos-concept.md): Architektur, Keychain-Zugriffskontrolle, gemeinsame Flatpak-Bausteine, Sicherheitsanforderungen und Abnahmekriterien.
- [Prototyp-Bericht](apps/desktop/mtls-macos-prototype-report.md): gemessene Ergebnisse, zusätzliche API-Befunde und verbleibende Grenzen.
- [Startanleitung](scripts/macos-mtls-prototype/README.md): interaktiver und automatischer Betrieb sowie native Inventarabfrage.
- [Electron-Prototyp](scripts/macos-mtls-prototype/main.ts): isolierte Session, Zertifikatsauswahl, IPC-Prüfungen und TLS-Diagnose.
- [Native Inventarabfrage](scripts/macos-mtls-prototype/keychain-identities.swift): lesender Zugriff auf Identitäten, Schlüsselreferenzen und Keychain-Namen mit öffentlichen Apple-APIs.
- [Gemeinsame Desktop-Bausteine](apps/desktop/src/platform/main/mtls/selection.ts): Fingerprint-Auswahl; daneben Endpoint-Normalisierung, Fehlerklassifikation und Callback-Kompatibilität.
- [Tests](scripts/macos-mtls-prototype/policy.test.ts): gemeinsame Auswahlregeln und Fehlerverhalten.

## Gemeinsame Basis mit Flatpak

Grundlage ist `origin/feat/linux-flatpak-mtls`, untersucht bei `1a11ec63838379e6be41317eac02550509fa1700`, mit [Linux-PR 23638](https://github.com/bitwarden/clients/pull/23638).

Endpoint-Normalisierung und Fingerprint-Auswahl wurden aus diesem Branch übernommen und für den Prototyp von NSS-spezifischen Zustandsdaten getrennt. Ungültige Gültigkeitsdaten werden zusätzlich abgewiesen. Die spätere Integration soll Auswahlregeln, Main-Prozess-Koordination, IPC, öffentliche Metadaten, Bindungsverwaltung und Angular-Oberfläche gemeinsam verwenden.

NSS-Import, Schlüsselablage, Löschung und Cleanup-Journal bleiben im Flatpak-Backend. macOS verwendet vorhandene Keychain-Identitäten und darf beim Entfernen einer App-Zuordnung keine Systemschlüssel löschen. Der Flatpak-Branch selbst wurde nicht geändert; gemeinsame Änderungen müssen mit dessen Implementierung und Tests abgeglichen werden.

## Diagnose des Nutzers

Safari konnte authentifizieren; Chrome scheiterte nach der Zertifikatsauswahl mit `ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED`. NetLog zeigte einen `SecKey`-Signaturversuch mit `rsa_pss_rsae_sha256` und Fehler `-141`. macOS meldete einen ACL-Partition-Konflikt und `-25293` / `CSSMERR_CSP_OPERATION_AUTH_DENIED`.

Der Schlüssel war durch separate Signaturtests als intakt bestätigt. Neuausstellung und erneuter PKCS#12-Import lösten die Berechtigungssperre nicht. Die sichtbare Einstellung, allen Programmen Zugriff zu erlauben, genügte ebenfalls nicht. Eine gezielte lokale Ergänzung der Partition List beseitigte die beobachtete Sperre für die dort freigegebenen Browser; vorhandene Regeln blieben erhalten.

Für Bitwarden war `client teamid:LTZ2PFU5D6` im Partition-Konflikt protokolliert. Die lesende Prüfung von `/Applications/Bitwarden.app` bestätigte diese Team-ID für das installierte Bundle. Andere Builds und tatsächlich signierende Helper-Prozesse müssen separat geprüft werden.

Vaultwarden war gesund. Traefik erzwingt mTLS vor HTTP für `bitwarden.jans.space`; Authentik ForwardAuth ist in dieser Route nicht beteiligt. Die lokale Signaturstörung ist daher nicht durch Änderungen an dieser Middleware zu beheben.

## Praktisch geprüfte Ergebnisse

Testumgebung: macOS 26.6.2, Build 25G83, arm64 und Electron 43.5.0. Das Test-Electron ist ad-hoc signiert und besitzt keine Team-ID. Es verwendet ein temporäres Profil und eine eigene Session; produktive Bitwarden-Daten werden nicht geöffnet.

| Prüfung                                                  | Ergebnis                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native Inventarabfrage                                   | `mbp.jans.space` liegt mit identischem Zertifikat-Fingerprint in `login.keychain-db` und `JansClientCerts.keychain-db`. Schlüsselreferenzen sind lesbar; das beweist keine Signaturberechtigung. |
| TLS gegen `bitwarden.jans.space` mit gewählter Identität | Insgesamt zwei Zertifikatskandidaten, genau einer mit dem gewünschten Fingerprint. Nach Auswahl folgt lokale Signaturverweigerung mit `-25293` und `-141`.                                       |
| TLS ohne Zertifikatsauswahl                              | Client-Authentifizierung schlägt fehl; keine automatische Auswahl des ersten Zertifikats.                                                                                                        |
| Öffentliche Bitwarden-Konfiguration                      | `https://api.bitwarden.eu/config` liefert HTTP 200 und erkennbare Konfiguration.                                                                                                                 |
| Ungültiges Serverzertifikat                              | `https://expired.badssl.com/` liefert `ERR_CERT_DATE_INVALID`, separat als Serververtrauensfehler klassifiziert.                                                                                 |
| Gemeinsame Policy-Tests                                  | Vier Tests bestanden; prüfen mehrere Endpoint-, Fingerprint-, Gültigkeits-, Fehler- und Callback-Fälle.                                                                                          |
| TypeScript und Formatierung                              | Strenge eigenständige TypeScript-Prüfung, Prettier und Git-Diff-Prüfung bestanden. Kein vollständiger Monorepo-Build.                                                                            |
| Oberfläche                                               | Ergebnisanzeige des lokalen Signaturfehlers gerendert und visuell geprüft.                                                                                                                       |

Keychain-Berechtigungen wurden nicht verändert. Private Schlüssel wurden nicht exportiert. Es gab keinen Account-Login, Tokenabruf oder Vault-Sync.

## Wichtige technische Grenzen

1. **Fingerprint ist keine Schlüsselkopie.** Native APIs sehen beide Keychain-Kopien; Electron bietet nur einen passenden Eintrag. Sein Callback ordnet anhand der Zertifikatsbytes zu. Die tatsächlich verwendete Schlüsselkopie ist damit nicht eindeutig bestimmbar. Ein nativer Auswahldialog allein löst diese Transportgrenze nicht.
2. **`-141` beweist keinen Partition-Konflikt.** Er bezeichnet eine fehlgeschlagene lokale TLS-Signatur. Eine konkrete ACL-Diagnose benötigt zusätzliche, korrelierte Evidenz. OSStatus erschien im nativen stderr, nicht als strukturiertes Electron-Ereignis.
3. **Auch lesende Native-Aufrufe können fragen.** Der erste Versuch mit `SecKeyCopyPublicKey` auf einer privaten Schlüsselreferenz blockierte in der ACL-Prüfung und öffnete SecurityAgent. Der Prozess wurde ohne Freigabe beendet. Die endgültige Inventarabfrage lässt diesen Aufruf aus und besitzt ein Zeitlimit.
4. **Callback-Kompatibilität.** Im getesteten Electron 43.5 schlugen explizites `undefined` und ein Aufruf ohne Argument fehl. Explizites `null` funktionierte. Die Konvertierung ist in `certificate-callback.ts` isoliert; Linux muss separat geprüft werden.
5. **Keine nachgewiesene Produktreparatur.** `SecKeychainItemSetAccessWithPassword` funktionierte im lokalen Reparaturverfahren des Nutzers, ist aber eine private Apple-API und bleibt ausgeschlossen. Ein unterstützter Ablauf für die eindeutige Schlüsselkopie ist noch nicht etabliert.
6. **Standalone-Prototyp.** Die produktive Angular-Oberfläche, dauerhafte Serverbindungen, Aktivierung nach Zertifikatswechsel und echte Desktop-Sync-/WebSocket-Pfade sind noch nicht implementiert oder validiert.

## Sicherheitsanforderungen

Die beiden Aikido-Kommentare aus dem Linux-PR betreffen den Pfadaufbau der `registry.json`: [Kommentar 1](https://github.com/bitwarden/clients/pull/23638#discussion_r4173553287), [Kommentar 2](https://github.com/bitwarden/clients/pull/23638#discussion_r4173553357).

Der untersuchte Pfad kommt aus dem Main-Prozess und nicht unmittelbar aus Renderer-IPC. Trotzdem beweist JSON-Validierung nach dem Lesen weder einen sicheren Dateipfad noch Schutz vor Symlinks oder unbegrenztem Lesen. Das Konzept verlangt geprüfte Pfadherkunft, sichere Eigentümer/Rechte, Dateitypprüfung, begrenzte Reads über geprüfte Deskriptoren sowie Schutz vor Pfadsubstitution und Rennen. Der Prototyp implementiert keine Registry-Dateiabfrage und schließt den Linux-Befund damit nicht.

Für eine spätere Berechtigungsänderung gelten: explizite Zustimmung, eindeutig bestimmte Schlüsselkopie, tatsächliche Codesignatur des zugreifenden Prozesses, Erhalt sämtlicher vorhandener Regeln und ausschließlich unterstützte APIs. Eine Team-ID-Regel berechtigt Apps desselben Entwicklerteams, nicht nur Bitwarden. Keychain-Passwörter dürfen weder in Logs noch in Kommandozeilenargumenten, Renderer-IPC oder persistenten Einstellungen landen.

## Prototyp starten

Die isolierten Abhängigkeiten wurden lokal unter `/tmp/bitwarden-macos-mtls-runtime` installiert. Wenn dieses temporäre Verzeichnis fehlt, zunächst aus dem Repository-Root installieren:

```sh
npm install --prefix /tmp/bitwarden-macos-mtls-runtime --no-audit --no-fund electron@43.5.0 esbuild@0.25.12
NODE_PATH=/tmp/bitwarden-macos-mtls-runtime/node_modules node scripts/macos-mtls-prototype/run.cjs
```

Jede Instanz führt genau einen Verbindungstest aus; für den nächsten Test neu starten. Automatischer Betrieb benötigt einen expliziten Fingerprint, wenn ein Client-Zertifikat verwendet werden soll. Prozess-Exitcode null bedeutet einen abgeschlossenen Probe-Lauf; der Erfolg steht im Feld `outcome`.

## Nächste Schritte

1. Gemeinsame Fähigkeiten und Ergebnistypen mit dem Flatpak-Branch abstimmen; die bestehende Main-Koordination von NSS-spezifischen Operationen trennen.
2. Den realen Self-hosted-/Einstellungsdialog anschließen und sichere Bindungspersistenz mit konsistentem Save/Cancel-Verhalten implementieren.
3. Mit signierten Developer-ID- und Mac-App-Store-Builds testen. Eine erfolgreiche mTLS-Verbindung mit einer ausdrücklich freigegebenen Identität nachweisen.
4. Die konkrete Schlüsselkopie und den signierenden Prozess bestimmen; erst danach über einen unterstützten Freigabe-/Reparaturablauf entscheiden. Ohne diesen Nachweis keine automatische Berechtigungsänderung.
5. Aktivierung und Chromium-Zertifikat-Caches bei Austausch/Entfernen prüfen; bei fehlendem Nachweis einer sicheren Live-Aktivierung einen Neustart vorsehen.
6. Login, Sync, Icons, Identity-Endpunkte, Downloads und Notifications/WebSockets in der produktiven App sowie IPC-, Konkurrenz- und Dateisicherheitsfälle prüfen.

Machbarkeitsentscheidung: mit gemeinsamer Zertifikatsauswahl und Diagnose fortfahren. Eindeutige Auswahl doppelter Schlüsselkopien und Berechtigungsreparatur bleiben eigenständige offene Prüfungen; sie dürfen nicht als bereits gelöst dargestellt werden.
