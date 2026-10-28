import { useCallback, useEffect, useRef, useState } from "react";
import { mountHarness, parkHarness } from "../harness/mount";
import { getPluginAsset, hostVersion, loader, onLoaderRetry, rpc, usePluginI18n } from "../host/runtime";
import { useScreenReady } from "../host/ready";

/** `ui/runtime.json`: whether the harness is up. The POM proxy knows where it runs. */
type InstallStep = "runtime" | "package" | "launch";
type RuntimeStatus =
  | { status: "ready" }
  | { status: "starting"; step?: InstallStep }
  | { status: "installing"; step: InstallStep; mode: "install" | "update"; progress: number }
  | { status: "error"; error: string };

// The loader's line for each install step of `ui/runtime.json`.
const STEP_MESSAGE = { runtime: "step.runtime", package: "step.package", launch: "step.launch" } as const;

type Phase = { kind: "starting" } | { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

const POLL_MS = 1000;
// The first start installs the harness from npm (about 200 MB).
const START_TIMEOUT_MS = 15 * 60_000;

async function waitUntilReady(signal: AbortSignal, report: (runtime: RuntimeStatus) => void): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const runtime = await getPluginAsset<RuntimeStatus>("ui/runtime.json");
    if (runtime.status === "ready") return;
    if (runtime.status === "error") throw new Error(runtime.error);
    if (!signal.aborted) report(runtime);
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
  // POM's loader covers the screen while the harness installs and starts (host version 7).
  const covered = hostVersion() >= 7;
  // `t` is a new function on every render; the start effect must not run on renders.
  const say = useRef(t);
  say.current = t;
  // An install ran in this mount: the end is a success, not a plain opening.
  const installed = useRef(false);

  // "Try again" on the loader: start the harness again, then wait for it.
  useEffect(() => onLoaderRetry(() => void rpc("retry").catch(() => undefined).then(retry)), [retry]);

  useEffect(() => {
    const controller = new AbortController();
    setPhase({ kind: "starting" });
    if (covered) void loader.show();
    const report = (runtime: RuntimeStatus) => {
      if (!covered) return;
      const text = say.current;
      if (runtime.status === "installing") {
        installed.current = true;
        void loader.progress({
          title: text(runtime.mode === "update" ? "loader.updating" : "loader.installing"),
          progress: runtime.progress,
          message: text(STEP_MESSAGE[runtime.step]),
        });
      } else if (runtime.status === "starting") {
        void (installed.current
          ? loader.progress({ progress: 100, message: text("starting") })
          : loader.show({ message: text("starting") }));
      }
    };
    waitUntilReady(controller.signal, report)
      .then(() => {
        if (controller.signal.aborted || !slot.current) return;
        setPhase({ kind: "loading" });
        if (covered && !installed.current) void loader.show({ message: say.current("loading") });
        return mountHarness(slot.current).then(() => {
          if (controller.signal.aborted) return;
          setPhase({ kind: "ready" });
          if (covered) void (installed.current ? loader.success() : loader.hide());
          installed.current = false;
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setPhase({ kind: "error", message });
        if (covered) void loader.error({ message });
      });
    return () => {
      controller.abort();
      parkHarness();
    };
  }, [attempt, covered]);

  // The mounted harness client is the content of this screen: the host opens
  // it when the client is on screen (or its failure is), not over the
  // starting/loading spinner.
  useScreenReady(phase.kind === "ready" || phase.kind === "error");

  return (
    <div className="pb-page">
      {/* On host version 7 POM's loader draws the start and its failure. */}
      {phase.kind !== "ready" && !covered && (
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
