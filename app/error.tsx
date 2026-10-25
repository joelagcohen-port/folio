"use client";

import { useEffect } from "react";
import { safeClientError } from "./client-error-diagnostics";

export default function FolioRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    try {
      const details = safeClientError(error, window.location.origin);
      const payload = {
        event: "client_error",
        clientBuild: document.querySelector('meta[name="folio-build-id"]')?.getAttribute("content") || "",
        clientGeneration: Number(document.querySelector('meta[name="folio-api-generation"]')?.getAttribute("content") || 0),
        ...details,
      };
      void fetch("/api/folio-telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => undefined);
    } catch { /* Diagnostics must never block the recovery screen. */ }
  }, [error]);

  return <main className="center-state">
    <img className="folio-mark" src="/brand/folio-icon.svg" alt="Folio" />
    <h1>Folio couldn’t finish opening</h1>
    <p>Please try again. Your saved data and preferences are unchanged.</p>
    <button type="button" onClick={reset}>Try again</button>
  </main>;
}
