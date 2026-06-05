import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

// Dashboard: saluda con nombre + rol. Link a /admin solo para SUPER_ADMIN.
export function DashboardPage() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="max-w-2xl mx-auto bg-white rounded-xl shadow p-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">
              Hola, {user?.name}
            </h1>
            <p className="text-sm text-slate-500 mt-1">Rol: {user?.role}</p>
          </div>
          <button
            onClick={logout}
            className="bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-700"
          >
            Cerrar sesión
          </button>
        </div>

        {user?.role === "SUPER_ADMIN" && (
          <div className="mt-8">
            <Link
              to="/admin"
              className="inline-block text-slate-700 underline hover:text-slate-900"
            >
              Ir al panel de administración
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
