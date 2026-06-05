import { Routes, Route } from "react-router-dom";
import { config } from "./config.js";
import { useAuth } from "./auth/AuthContext.jsx";
import { useIdleTimer } from "./auth/useIdleTimer.js";
import { RequireAuth } from "./auth/RequireAuth.jsx";
import { RequireRole } from "./auth/RequireRole.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { AdminPage } from "./pages/AdminPage.jsx";
import { ForbiddenPage } from "./pages/ForbiddenPage.jsx";
import { LockScreen } from "./components/LockScreen.jsx";
import { IdleWarningModal } from "./components/IdleWarningModal.jsx";

export function App() {
  const { authed, locked, ready, lock, heartbeat } = useAuth();

  // El idle timer solo corre con sesión activa y pantalla desbloqueada.
  const { warningActive, remainingMs, dismiss } = useIdleTimer({
    enabled: authed && !locked,
    inactivityMs: config.inactivityMs,
    idleWarningMs: config.idleWarningMs,
    onLock: lock,
    onHeartbeat: heartbeat,
  });

  // Hasta terminar el bootstrap no decidimos qué mostrar (evita parpadeos).
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 text-slate-500">
        Cargando…
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireRole role="SUPER_ADMIN">
                <AdminPage />
              </RequireRole>
            </RequireAuth>
          }
        />
        <Route path="/403" element={<ForbiddenPage />} />
      </Routes>

      {/* Overlay de bloqueo, cubre cualquier ruta cuando hay sesión bloqueada. */}
      {authed && locked && <LockScreen />}

      {/* Aviso previo, solo con sesión activa y desbloqueada. */}
      {authed && !locked && warningActive && (
        <IdleWarningModal remainingMs={remainingMs} onStayActive={dismiss} />
      )}
    </>
  );
}
