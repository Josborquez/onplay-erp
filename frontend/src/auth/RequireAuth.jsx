import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";

// Guarda: sin sesión, redirige a /login.
export function RequireAuth({ children }) {
  const { authed } = useAuth();
  if (!authed) return <Navigate to="/login" replace />;
  return children;
}
