import { useEffect, useRef, useState } from "react";

// Detecta inactividad real (mousemove, keydown, mousedown, touchstart, scroll).
// A (N - aviso) muestra el aviso previo; a N dispara onLock. Cada actividad
// reinicia el contador. Heartbeat throttled: ante actividad, si pasó > N/2 desde
// el último, llama onHeartbeat para refrescar lastActivityAt en el servidor.

export function useIdleTimer({
  enabled,
  inactivityMs,
  idleWarningMs,
  onLock,
  onHeartbeat,
}) {
  const [warningActive, setWarningActive] = useState(false);
  const [remainingMs, setRemainingMs] = useState(idleWarningMs);

  const warnTimer = useRef(null);
  const lockTimer = useRef(null);
  const countdownTimer = useRef(null);
  const lastHeartbeat = useRef(0);

  const onLockRef = useRef(onLock);
  const onHeartbeatRef = useRef(onHeartbeat);
  onLockRef.current = onLock;
  onHeartbeatRef.current = onHeartbeat;

  useEffect(() => {
    if (!enabled) return undefined;

    const warnDelay = Math.max(0, inactivityMs - idleWarningMs);

    const clearTimers = () => {
      clearTimeout(warnTimer.current);
      clearTimeout(lockTimer.current);
      clearInterval(countdownTimer.current);
    };

    const startWarning = () => {
      setWarningActive(true);
      const start = Date.now();
      setRemainingMs(idleWarningMs);
      countdownTimer.current = setInterval(() => {
        const left = idleWarningMs - (Date.now() - start);
        setRemainingMs(left > 0 ? left : 0);
      }, 250);
    };

    const arm = () => {
      clearTimers();
      setWarningActive(false);
      warnTimer.current = setTimeout(startWarning, warnDelay);
      lockTimer.current = setTimeout(() => {
        clearTimers();
        setWarningActive(false);
        onLockRef.current?.();
      }, inactivityMs);
    };

    const onActivity = () => {
      const now = Date.now();
      if (now - lastHeartbeat.current > inactivityMs / 2) {
        lastHeartbeat.current = now;
        onHeartbeatRef.current?.();
      }
      arm();
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true })
    );
    arm();

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearTimers();
    };
  }, [enabled, inactivityMs, idleWarningMs]);

  // "Seguir conectado": re-arma el contador disparando un evento de actividad.
  const dismiss = () => window.dispatchEvent(new Event("mousemove"));

  return { warningActive, remainingMs, dismiss };
}
