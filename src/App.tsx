import { useEffect, useRef, useState } from "react";
import { createCityScene, type CityScene } from "./scene/createCityScene";
import { LoadingOverlay } from "./ui/LoadingOverlay";

type Status =
  | { phase: "loading"; label: string; fraction: number | null }
  | { phase: "ready" }
  | { phase: "error"; message: string };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<CityScene | null>(null);
  const [status, setStatus] = useState<Status>({
    phase: "loading",
    label: "Starting engine",
    fraction: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    createCityScene(canvas, (fraction, label) => {
      if (!cancelled) setStatus({ phase: "loading", label, fraction });
    })
      .then((city) => {
        if (cancelled) {
          city.dispose();
          return;
        }
        sceneRef.current = city;
        setStatus({ phase: "ready" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        setStatus({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  return (
    <div className="app">
      <canvas ref={canvasRef} className="viewport" />
      <LoadingOverlay
        visible={status.phase !== "ready"}
        label={status.phase === "loading" ? status.label : "Could not load the city"}
        detail={status.phase === "error" ? status.message : undefined}
        fraction={status.phase === "loading" ? status.fraction : 1}
        failed={status.phase === "error"}
      />
    </div>
  );
}
