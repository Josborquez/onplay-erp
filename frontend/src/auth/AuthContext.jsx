import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { apiFetch, configureClient } from "../api/client.js";

// Estado de sesión del cliente: token + datos del usuario + bloqueo de pantalla.
// Persistido en localStorage para sobrevivir recargas. Con la pantalla bloqueada
// el backend responde 423 a /me, así que guardamos {id,name,email,role} aquí para
// que la lock screen pueda saludar por nombre sin pegarle a /me.

const TOKEN_KEY = "onplay.token";
const USER_KEY = "onplay.user";

const AuthContext = createContext(null);

function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(loadUser);
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(false);

  // Espejo del token para que el cliente fetch lo lea de forma síncrona.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    tokenRef.current = null;
    setToken(null);
    setUser(null);
    setLocked(false);
  }, []);

  const persist = useCallback((tok, usr) => {
    localStorage.setItem(TOKEN_KEY, tok);
    localStorage.setItem(USER_KEY, JSON.stringify(usr));
    tokenRef.current = tok;
    setToken(tok);
    setUser(usr);
    setLocked(false);
  }, []);

  // Configura el cliente y hace bootstrap una sola vez al montar.
  useEffect(() => {
    configureClient({
      tokenGetter: () => tokenRef.current,
      onUnauthorized: clearSession,
      onLocked: () => setLocked(true),
    });

    async function bootstrap() {
      if (!tokenRef.current) {
        setReady(true);
        return;
      }
      const { status, data } = await apiFetch("/api/auth/me");
      if (status === 200) {
        setUser(data);
        localStorage.setItem(USER_KEY, JSON.stringify(data));
        setLocked(false);
      } else if (status === 423) {
        setLocked(true); // autenticado pero bloqueado
      } else {
        clearSession();
      }
      setReady(true);
    }
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tras obtener el token, pedimos /me para guardar los datos del usuario.
  const completeLogin = useCallback(
    async (tok) => {
      tokenRef.current = tok;
      const me = await apiFetch("/api/auth/me");
      if (me.status !== 200) {
        clearSession();
        return { ok: false };
      }
      persist(tok, me.data);
      return { ok: true };
    },
    [clearSession, persist]
  );

  const login = useCallback(
    async (email, password) => {
      const { status, data } = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      if (status !== 200 || !data?.token) return { ok: false };
      return completeLogin(data.token);
    },
    [completeLogin]
  );

  const loginGoogle = useCallback(
    async (idToken) => {
      const { status, data } = await apiFetch("/api/auth/google", {
        method: "POST",
        body: { idToken },
      });
      if (status !== 200 || !data?.token) return { ok: false };
      return completeLogin(data.token);
    },
    [completeLogin]
  );

  const unlock = useCallback(async (pin) => {
    const { status } = await apiFetch("/api/auth/unlock", {
      method: "POST",
      body: { pin },
    });
    if (status === 200) {
      setLocked(false);
      return { ok: true };
    }
    return { ok: false }; // 423 → onLocked mantiene locked=true
  }, []);

  const logout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    clearSession();
  }, [clearSession]);

  const lock = useCallback(() => setLocked(true), []);

  // Heartbeat: refresca lastActivityAt en el servidor mientras el usuario activo.
  const heartbeat = useCallback(async () => {
    await apiFetch("/api/auth/me");
  }, []);

  const value = {
    token,
    user,
    locked,
    ready,
    authed: !!token,
    login,
    loginGoogle,
    unlock,
    logout,
    lock,
    heartbeat,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
