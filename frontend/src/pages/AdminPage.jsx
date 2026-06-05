import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client.js";

// Panel admin: pega a /api/admin/ping para demostrar el guard por rol del backend.
export function AdminPage() {
  const [result, setResult] = useState("");

  async function ping() {
    const { status, data } = await apiFetch("/api/admin/ping");
    if (status === 200 && data?.pong) setResult("pong ✓ (acceso autorizado)");
    else if (status === 403) setResult("403 — rol insuficiente");
    else setResult(`error (${status})`);
  }

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="max-w-2xl mx-auto bg-white rounded-xl shadow p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-800">Administración</h1>
          <Link to="/" className="text-sm text-slate-600 underline">
            Volver
          </Link>
        </div>

        <button
          onClick={ping}
          className="mt-6 bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700"
        >
          Probar /api/admin/ping
        </button>

        {result && <p className="mt-4 text-slate-700">{result}</p>}
      </div>
    </div>
  );
}
