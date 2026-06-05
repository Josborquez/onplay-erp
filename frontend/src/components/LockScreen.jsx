import { useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";

// Overlay de bloqueo. Lee el nombre del usuario guardado (no /me, que da 423).
// Desbloqueo por PIN; PIN incorrecto → sigue bloqueado. También permite logout.
export function LockScreen() {
  const { user, unlock, logout } = useAuth();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { ok } = await unlock(pin);
    setBusy(false);
    setPin("");
    if (!ok) setError("PIN incorrecto");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur px-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl p-8 text-center">
        <h1 className="text-xl font-bold text-slate-800">Pantalla bloqueada</h1>
        <p className="text-sm text-slate-500 mt-1">
          {user?.name ? `${user.name}, ingresa tu PIN` : "Ingresa tu PIN"}
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-slate-400"
            placeholder="PIN"
          />

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-slate-800 text-white rounded-lg py-2 font-medium hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Verificando…" : "Desbloquear"}
          </button>
        </form>

        <button
          onClick={logout}
          className="mt-4 text-sm text-slate-500 underline"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
