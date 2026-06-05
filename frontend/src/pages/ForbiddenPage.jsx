import { Link } from "react-router-dom";

// Vista 403: rol insuficiente.
export function ForbiddenPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4">
      <div className="text-center">
        <h1 className="text-5xl font-bold text-slate-800">403</h1>
        <p className="mt-2 text-slate-600">No tienes permiso para ver esto.</p>
        <Link to="/" className="mt-6 inline-block text-slate-700 underline">
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
