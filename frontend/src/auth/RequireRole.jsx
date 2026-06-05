import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";

// Guarda por rol: rol insuficiente → /403. El backend además responde 403 real.
export function RequireRole({ role, children }) {
  const { user } = useAuth();
  if (!user || user.role !== role) return <Navigate to="/403" replace />;
  return children;
}
