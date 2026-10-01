import { useCallback, useEffect, useRef, useState } from "react";
import { mountHarness, parkHarness } from "../harness/mount";
import { getPluginAsset, usePluginI18n } from "../host/runtime";

/** `ui/runtime.json`: whether the harness is up. The POM proxy knows where it runs. */
type RuntimeStatus = { status: "ready" } | { status: "starting" } | { status: "error"; error: string };

type Phase = { kind: "starting" } | { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

const POLL_MS = 1000;
// The first start installs the harness from npm (about 200 MB).
const START_TIMEOUT_MS = 15 * 60_000;

async function waitUntilReady(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const runtime = await getPluginAsset<RuntimeStatus>("ui/runtime.json");
    if (runtime.status === "ready") return;
    if (runtime.status === "error") throw new Error(runtime.error);
    if (Date.now() > deadline) throw new Error("timed out waiting for the harness runtime");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
}

export function Harness() {
  const { t } = usePluginI18n();
  const slot = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase({ kind: "starting" });
    waitUntilReady(controller.signal)
      .then(() => {
        if (controller.signal.aborted || !slot.current) return;
        setPhase({ kind: "loading" });
        return mountHarness(slot.current).then(() => {
          if (!controller.signal.aborted) setPhase({ kind: "ready" });
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      controller.abort();
      parkHarness();
    };
  }, [attempt]);

  return (
    <div className="pb-page">
      {phase.kind !== "ready" && (
        <div className="pb-status" role={phase.kind === "error" ? "alert" : "status"}>
          {phase.kind === "error" ? (
            <>
              <p className="pb-status-title">{t("failed")}</p>
              <p className="pb-status-detail">{phase.message}</p>
              <button type="button" className="pb-retry" onClick={retry}>
                {t("retry")}
              </button>
            </>
          ) : (
            <>
              <span className="pb-spinner" aria-hidden="true" />
              <p className="pb-status-title">{t(phase.kind === "starting" ? "starting" : "loading")}</p>
              {phase.kind === "starting" && <p className="pb-status-detail">{t("startingDetail")}</p>}
            </>
          )}
        </div>
      )}
      <div ref={slot} className="pb-slot" />
    </div>
  );
}
