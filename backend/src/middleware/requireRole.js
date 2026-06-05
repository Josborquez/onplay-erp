// Guard por rol. Se monta DESPUÉS de requireAuth, así que req.auth.user existe.
// Rol insuficiente → 403 (R: §3.5).
export function requireRole(...allowed) {
  return (req, res, next) => {
    const user = req.auth && req.auth.user;
    if (!user || !allowed.includes(user.role)) {
      return res.status(403).json({ error: "permiso insuficiente" });
    }
    next();
  };
}
