// Aviso previo al bloqueo, con cuenta regresiva. Cualquier actividad (o el botón)
// lo descarta y reinicia el contador.
export function IdleWarningModal({ remainingMs, onStayActive }) {
  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl p-6 text-center">
        <h2 className="text-lg font-semibold text-slate-800">
          ¿Sigues ahí?
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          La pantalla se bloqueará en {seconds} segundo{seconds === 1 ? "" : "s"}.
        </p>
        <button
          onClick={onStayActive}
          className="mt-5 bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700"
        >
          Seguir conectado
        </button>
      </div>
    </div>
  );
}
